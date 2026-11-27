// The arm64 engine's shim (engine/arm64-shim.py) runs under python3: these tests load it and check
// the memory figure the engine reads in disk mode. The shim is not part of the controller, so the
// tests only run the file; nothing of it is imported.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHIM = fileURLToPath(new URL("../../../engine/arm64-shim.py", import.meta.url));

/** Loads the shim as a module, runs the Python snippet in it, and returns the JSON the snippet prints. */
function runShim(snippet: string): unknown {
  const script = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('shim', sys.argv[1])",
    "shim = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(shim)",
    snippet,
  ].join("\n");
  const out = execFileSync("python3", ["-I", "-B", "-c", script, SHIM], { encoding: "utf8" });
  return JSON.parse(out);
}

describe("arm64 shim, disk mode memory", () => {
  it("caps the memory fields of /proc/meminfo and keeps the other lines", () => {
    const result = runShim(`
real = 'MemTotal:        8146692 kB\\nMemFree:         5000000 kB\\nMemAvailable:    6000000 kB\\nSwapTotal:             0 kB\\n'
print(json.dumps(shim.capped_meminfo(real, 524288)))
`);
    expect(result).toBe(
      "MemTotal: 524288 kB\nMemFree: 524288 kB\nMemAvailable: 524288 kB\nSwapTotal:             0 kB\n",
    );
  });

  it("keeps a memory figure that is already below the cap", () => {
    const result = runShim(`
print(json.dumps(shim.capped_meminfo('MemTotal: 1000 kB\\nMemFree: 500 kB\\n', 524288)))
`);
    expect(result).toBe("MemTotal: 1000 kB\nMemFree: 500 kB\n");
  });

  it("answers every open of /proc/meminfo with the capped text, in text and binary mode", () => {
    const result = runShim(`
import os, tempfile
fd, meminfo = tempfile.mkstemp()
os.write(fd, b'MemTotal: 8146692 kB\\nMemFree: 5000000 kB\\nSwapTotal: 0 kB\\n')
os.close(fd)
fd, other = tempfile.mkstemp()
os.write(fd, b'plain text\\n')
os.close(fd)
shim.MEMINFO = meminfo
shim.show_capped_meminfo(524288)
with open(meminfo) as f:
    text = f.read()
with open(meminfo, 'rb') as f:
    raw = f.read().decode('ascii')
with open(other) as f:
    untouched = f.read()
print(json.dumps({'text': text, 'raw': raw, 'untouched': untouched}))
`);
    const expected = "MemTotal: 524288 kB\nMemFree: 524288 kB\nSwapTotal: 0 kB\n";
    expect(result).toEqual({ text: expected, raw: expected, untouched: "plain text\n" });
  });
});
