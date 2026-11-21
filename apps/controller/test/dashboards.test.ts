import { readFileSync } from "node:fs";
import type { Logger } from "@aceswarm/shared/logger";
import { Registry } from "@prometheus-io/client";
import { expect, test } from "vitest";
import { EngineRuns } from "../src/engine-runs.ts";
import { ControllerMetrics } from "../src/metrics.ts";

interface Panel {
  title: string;
  description?: string;
  /** The panel's least interval ("Min interval"). */
  interval?: string;
  /** A query's own least step also stands in for the scrape interval in `$__rate_interval`. */
  targets?: { expr: string; interval?: string; datasource?: { type: string } }[];
  transformations?: { id: string; options: { includeByName?: Record<string, boolean> } }[];
  fieldConfig?: { defaults: { custom?: { barAlignment?: number; barWidthFactor?: number } } };
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
    expect(targets.filter(({ expr }) => /increase\([^)]*\[\$\{?__interval\}?\]/.test(expr))).toEqual([]);
  }
  const recoveries = dashboard("aceswarm-streams.json").panels.find(({ title }) => title === "Recovery steps");
  expect(recoveries?.interval).toBe("5m");
  // A bar counts the stretch that ends at its time: it is drawn before that time, as wide as the stretch.
  expect(recoveries?.fieldConfig?.defaults.custom).toMatchObject({ barAlignment: -1, barWidthFactor: 1 });
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
    // A label between the name and the id can have any name, such as one with dots or dashes.
    const between = 'name="Example One",pod.name="a-b",service-name="x",stream="s1abc"';
    expect(read(`aceswarm_stream_info{enabled="true",${between}} 1 1763690000000`)).toEqual({
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

/** The lines the controller logs when runs of engines end, as its JSON logger writes them. */
function engineRunLines(): string[] {
  const lines: string[] = [];
  const logger = {
    child: () => logger,
    info: (fields: Record<string, unknown>, msg: string) => {
      lines.push(
        JSON.stringify({ level: "info", time: "2026-11-07T11:00:00.000Z", service: "controller", ...fields, msg }),
      );
    },
  } as unknown as Logger;
  const runs = new EngineRuns({
    observe: () => undefined,
    placeOf: () => ({ role: "playing", path: "direct" }),
    logger,
  });
  const run = {
    engine: "aceswarm-engine-s1abc-1",
    stream: "s1abc",
    sharedPath: null,
    endedAt: Date.parse("2026-11-07T11:00:00Z"),
  };
  runs.end({ ...run, containerId: "c1", startedAt: "2026-11-07T10:00:00Z" }, "moved");
  runs.end({ ...run, containerId: "c2", startedAt: "2026-11-07T10:00:00Z" }, "restart", "manual restart");
  runs.end({ ...run, containerId: "c3", startedAt: "2026-11-07T10:00:00Z" }, "oom-killed");
  return lines;
}

test("the engine tables of both dashboards read the lines the controller logs when an engine's run ends", () => {
  const lines = engineRunLines();
  expect(lines).toHaveLength(3);
  for (const file of ["aceswarm.json", "aceswarm-streams.json"]) {
    const table = dashboard(file).panels.find(({ title }) => title === "Engines restarted or removed");
    const query = table?.targets?.[0];
    expect(query?.datasource?.type).toBe("loki");
    // The lines of the controller whose message says a run ended, then their fields, by stream.
    const filter = /^\{service="controller"\} \|~ `([^`]+)` \| json \| stream=~?"\$stream"$/.exec(query?.expr ?? "");
    expect(filter, query?.expr).not.toBeNull();
    const pattern = new RegExp(filter?.[1] ?? "");
    expect(lines.filter((line) => pattern.test(line))).toEqual(lines);
    // Other lines of the engine manager are not runs that ended.
    expect(pattern.test('{"level":"info","component":"engines","container":"x","msg":"removing engine"}')).toBe(false);
    // Every column is a field of the line, apart from the time, which is the line's own.
    const columns = table?.transformations?.find(({ id }) => id === "organize")?.options.includeByName ?? {};
    const fields = new Set(lines.flatMap((line) => Object.keys(JSON.parse(line) as Record<string, unknown>)));
    expect(Object.keys(columns).filter((column) => column !== "Time" && !fields.has(column))).toEqual([]);
    expect(Object.keys(columns)).toContain("lifetimeSeconds");
  }
});

test("the overview counts the runs of engines that ended from the controller's histogram", () => {
  const exported = controllerMetrics();
  expect(exported.has("aceswarm_engine_lifetime_seconds")).toBe(true);
  const asked = queries("aceswarm.json").filter((query) => query.includes("aceswarm_engine_lifetime_seconds"));
  // By reason, per hour and over the range: count, average and median.
  expect(asked).toHaveLength(4);
  expect(asked.filter((query) => !/by \((?:kind, )?reason(?:, le)?\)/.test(query))).toEqual([]);
});
