import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLogger } from "@aceswarm/shared/logger";
import { createService } from "@aceswarm/shared/service";
import { expect, test } from "vitest";
import { PipelineManager } from "../src/server.ts";
import { fakeSources } from "./fake-source.ts";

interface Panel {
  id: number;
  title: string;
  targets?: { expr: string }[];
  panels?: Panel[];
}

interface Dashboard {
  panels: Panel[];
  annotations: { list: { expr?: string; filter?: { ids: number[] } }[] };
}

const overview = JSON.parse(
  readFileSync(new URL("../../../monitoring/grafana/dashboards/aceswarm.json", import.meta.url), "utf8"),
) as Dashboard;
const panels = overview.panels.flatMap((panel) => [panel, ...(panel.panels ?? [])]);

/** The names of the series the transcoder exports: a histogram's are its buckets, sum and count. */
async function transcoderMetrics(): Promise<Set<string>> {
  const logger = createLogger("test", "silent");
  const service = createService({ name: "test", logger });
  const plan = {
    previewMode: "video" as const,
    previewHeight: 270,
    previewFps: 15,
    previewBitrateKbps: 400,
    fullTranscodeMaxHeight: 1080,
    audioBitrateKbps: 128,
    segmentSeconds: 2,
    playlistSize: 6,
    thumbnailIntervalSeconds: 10,
    inputTimeoutSeconds: 60,
  };
  const settings = { hlsDir: tmpdir(), ffmpegPath: "ffmpeg", handoverTimeoutMs: 120_000, plan };
  const manager = new PipelineManager(service, settings, logger, undefined, undefined, {
    openSource: fakeSources().open,
  });
  await manager.stopAll();
  const names = new Set<string>();
  for (const { name, type } of service.registry.getMetricsAsArray() as unknown as { name: string; type: string }[]) {
    const series = type === "histogram" ? ["_bucket", "_sum", "_count"].map((suffix) => name + suffix) : [name];
    for (const one of series) {
      names.add(one);
    }
  }
  return names;
}

test("the overview only asks for metrics of ffmpeg's runs that the transcoder exports", async () => {
  const exported = await transcoderMetrics();
  const queries = [
    ...panels.flatMap((panel) => panel.targets ?? []).map(({ expr }) => expr),
    ...overview.annotations.list.map(({ expr = "" }) => expr),
  ];
  const asked = new Set(queries.flatMap((query) => query.match(/aceswarm_pipeline_[a-z_]+/g) ?? []));
  expect(asked.size).toBeGreaterThan(5);
  expect([...asked].filter((metric) => !exported.has(metric))).toEqual([]);
});

test("the overview marks each layout change on the timeline of the streams that deliver new frames", () => {
  const delivering = panels.find(({ title }) => title === "Delivering new frames");
  const marks = overview.annotations.list.filter(({ expr = "" }) =>
    expr.includes("aceswarm_pipeline_layout_changes_total"),
  );
  expect(marks).toHaveLength(1);
  expect(marks[0]?.filter?.ids).toEqual([delivering?.id]);
});
