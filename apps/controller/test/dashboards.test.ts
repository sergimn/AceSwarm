import { readFileSync } from "node:fs";
import { Registry } from "@prometheus-io/client";
import { expect, test } from "vitest";
import { ControllerMetrics } from "../src/metrics.ts";

interface Panel {
  title: string;
  description?: string;
  targets?: { expr: string }[];
  panels?: Panel[];
}

interface Dashboard {
  panels: Panel[];
  templating: { list: { name: string; definition?: string }[] };
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
  }
});

test("every panel of the per-stream dashboard says what it shows", () => {
  const { panels } = dashboard("aceswarm-streams.json");
  const silent = panels.filter((panel) => panel.targets !== undefined && (panel.description ?? "").length < 40);
  expect(silent.map(({ title }) => title)).toEqual([]);
});
