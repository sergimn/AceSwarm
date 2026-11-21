import { readFileSync } from "node:fs";
import { Registry } from "@prometheus-io/client";
import { expect, test } from "vitest";
import { ControllerMetrics } from "../src/metrics.ts";

interface Panel {
  title: string;
  description?: string;
  /** The panel's least interval ("Min interval"). */
  interval?: string;
  /** A query's own least step also stands in for the scrape interval in `$__rate_interval`. */
  targets?: { expr: string; interval?: string }[];
  panels?: Panel[];
}

interface Dashboard {
  panels: Panel[];
  templating: { list: { name: string; definition?: string; regex?: string }[] };
}

const DASHBOARDS = new URL("../../../monitoring/grafana/dashboards/", import.meta.url);

function dashboard(file: string): Dashboard {
  return JSON.parse(readFileSync(new URL(file, DASHBOARDS), "utf8")) as Dashboard;
}

/** The queries of a dashboard's panels and variables. */
function queries(file: string): string[] {
  const { panels, templating } = dashboard(file);
  const ofPanels = panels.flatMap((panel) => [panel, ...(panel.panels ?? [])]).flatMap((panel) => panel.targets ?? []);
  return [...ofPanels.map(({ expr }) => expr), ...templating.list.map(({ definition = "" }) => definition)];
}

function controllerMetrics(): Set<string> {
  const registry = new Registry();
  new ControllerMetrics(
    registry,
    () => ({ streams: [], paths: [] }),
    () => [],
  );
  return new Set(registry.getMetricsAsArray().map(({ name }) => name));
}

test("the per-stream dashboard only asks for metrics the controller exports", () => {
  const exported = controllerMetrics();
  const asked = new Set(queries("aceswarm-streams.json").flatMap((query) => query.match(/aceswarm_[a-z_]+/g) ?? []));
  expect(asked.size).toBeGreaterThan(5);
  expect([...asked].filter((metric) => !exported.has(metric))).toEqual([]);
});

test("the dashboards draw engines by their place, never by their container", () => {
  for (const file of ["aceswarm.json", "aceswarm-streams.json"]) {
    const ofEngines = queries(file).filter((query) => /aceswarm_engine_memory(?:_cache)?(?:_limit)?_bytes/.test(query));
    expect(ofEngines.length).toBeGreaterThan(0);
    // Every one aggregates the engine gauges, which leaves the container's name out of the legend.
    expect(ofEngines.filter((query) => !/^(?:max|min|sum|avg|count)(?: by \([a-z, ]+\))? ?\(/.test(query))).toEqual([]);
    expect(ofEngines.filter((query) => /\b(?:by|group_left) ?\([^)]*\bengine\b/.test(query))).toEqual([]);
  }
});

test("bars that count increases look back one scrape more than their width, not four widths", () => {
  for (const file of ["aceswarm.json", "aceswarm-streams.json"]) {
    const targets = dashboard(file)
      .panels.flatMap((panel) => [panel, ...(panel.panels ?? [])])
      .flatMap((panel) => panel.targets ?? []);
    // With a least step of its own, such a query's window is four steps: every increase shows in four bars.
    const counted = targets.filter(({ expr, interval }) => expr.includes("$__rate_interval") && interval !== undefined);
    expect(counted.map(({ expr }) => expr)).toEqual([]);
    // And a window as long as the step misses what happens between two bars.
    expect(targets.filter(({ expr }) => /increase\([^)]*\[\$__interval\]/.test(expr))).toEqual([]);
  }
  const recoveries = dashboard("aceswarm-streams.json").panels.find(({ title }) => title === "Recovery steps");
  expect(recoveries?.interval).toBe("5m");
});

// `query_result` prints a series with its labels in order, and their values as they are.
const printed = (name: string, more = ""): string =>
  `aceswarm_stream_info{ace_id="${"a".repeat(40)}",enabled="true",${more}name="${name}",service="controller",stream="s1abc"} 1 1763690000000`;

test("the stream pickers read a stream's name and id from what Prometheus prints, whatever the name", () => {
  for (const file of ["aceswarm.json", "aceswarm-streams.json"]) {
    const source = dashboard(file).templating.list.find(({ name }) => name === "stream")?.regex ?? "";
    const pattern = new RegExp(source.slice(1, -1));
    const read = (text: string): unknown => pattern.exec(text)?.groups;
    expect(read(printed("Example One"))).toEqual({ text: "Example One", value: "s1abc" });
    expect(read(printed(String.raw`Sports "HD" \ 1`))).toEqual({ text: String.raw`Sports "HD" \ 1`, value: "s1abc" });
    expect(read(printed("Two\nlines"))).toEqual({ text: "Two\nlines", value: "s1abc" });
    // A label of the scrape whose name ends in "name" is not the stream's name.
    expect(read(printed("Example One", 'hostname="box1",instance="controller:8080",job_name="x",'))).toEqual({
      text: "Example One",
      value: "s1abc",
    });
    // The name can be the last label before the id.
    expect(read('aceswarm_stream_info{enabled="true",name="Last",stream="s1abc"} 1 1763690000000')).toEqual({
      text: "Last",
      value: "s1abc",
    });
  }
});

test("every panel of the per-stream dashboard says what it shows", () => {
  const { panels } = dashboard("aceswarm-streams.json");
  const silent = panels.filter((panel) => panel.targets !== undefined && (panel.description ?? "").length < 40);
  expect(silent.map(({ title }) => title)).toEqual([]);
});
