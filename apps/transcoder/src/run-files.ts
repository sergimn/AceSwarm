import { mkdirSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@aceswarm/shared/logger";

/**
 * The directories a stream's ffmpeg runs write to: one per run under the stream's own, named by
 * the run's number. A stream's next pipeline counts its runs from one again, so it writes where
 * the last one did. Whatever that one left behind (see `removeStreamFiles`) must not pass for the
 * new run's output: an old playlist there would be published before ffmpeg wrote anything, and
 * its old segment numbers would keep the new run's segments out for as long as they are lower.
 * So a run's directory is emptied where it is made.
 */
const VARIANT_DIRECTORIES = ["full", "preview"];

/** Makes a run's directory, with nothing in it. */
export async function makeRunDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  for (const variant of VARIANT_DIRECTORIES) {
    await mkdir(join(directory, variant), { recursive: true });
  }
}

/** As `makeRunDirectory`, but at once: for a run that takes over while its source's reader waits to feed it. */
export function makeRunDirectoryNow(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  for (const variant of VARIANT_DIRECTORIES) {
    mkdirSync(join(directory, variant), { recursive: true });
  }
}

/**
 * Removes all of a stopped stream's files. Its ffmpeg runs were killed just before, and a file
 * one of them wrote as it died can land in a directory that `rm` has just emptied, which then
 * fails to go (ENOTEMPTY): `rm` tries again for that. Files that still can't be removed stay, with
 * a warning: the stream is stopped all the same, and its next pipeline starts every run on an
 * empty directory.
 */
export async function removeStreamFiles(root: string, logger: Logger): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    logger.warn({ err: error }, "could not remove all of the stream's files");
  }
}
