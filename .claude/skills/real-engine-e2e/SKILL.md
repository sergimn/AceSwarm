---
name: real-engine-e2e
description: How AceSwarm's end-to-end tests run with real Acestream engines, and how to read them. Use whenever you start or read an E2E workflow run, decide whether an E2E failure is real, add or change a spec in e2e/tests, or check a real stream by hand.
---

# Real-engine E2E

`e2e/README.md` is the full reference, with diagrams of the runners, the mesh and most specs. This is the short version.

## 1. Rules

- **Real engines only.** No mock engine, no stubbed `getstream`, no fake peers. Tests make failures with real firewall rules, paused containers and stopped broadcasts (`setDirectPathBlocked`, `setVpnServerUnreachable`, `setBroadcastBlocked`, `setBroadcastInput` in `e2e/tests/mesh.ts`).
- **The suite runs in CI only.** It needs four machines joined by a mesh, so there is no local or single-machine run. `npm run check` covers typecheck, lint, format and unit tests, not E2E.
- **No stream loads in a cloud sandbox.** The engine starts and its API answers, but its peer-to-peer traffic doesn't get out, so `getstream` answers "failed to load content". That says nothing about the code. Streams play in CI and on the Testing environment.
- Never skip, disable or loosen a test to get green. `retries: 0` is on purpose.

## 2. Start a run

- Workflow **E2E** (`.github/workflows/e2e.yml`) runs on every pull request and on every push to `main`. A pull request needs nothing extra: push and read its run.
- For a branch without a pull request: Actions, E2E, "Run workflow", and pick the branch. From a session, that is `gh workflow run e2e.yml --ref <branch>`, or the GitHub tool `actions_run_trigger` with `method: run_workflow`, `workflow_id: e2e.yml` and `ref`. The workflow takes no inputs.
- A new run for the same pull request or branch cancels the one in progress.
- **Re-run all jobs, never only the failed one.** The runners only work together, and a single job would wait for runners that are gone. From a session: `gh run rerun <run id>` without `--failed`, or `actions_run_trigger` with `method: rerun_workflow_run`, never `rerun_failed_jobs`.

## 3. Read a run

Four jobs start together:

| Job                                 | Role                                                           | Tells you             |
| ----------------------------------- | -------------------------------------------------------------- | --------------------- |
| WireGuard server                    | `wg`: the VPN server under test                                | no AceSwarm result    |
| Dummy Acestream broadcast           | `source`: six real broadcasts (`bc1`-`bc6`) and the tracker    | no AceSwarm result    |
| AceSwarm with real engines          | `stack`: Docker on `ubuntu-24.04`, plays `bc1`-`bc3`           | the result for Docker |
| AceSwarm with real engines (Podman) | `stack-podman`: rootless Podman on `ubuntu-26.04`, `bc4`-`bc6` | the result for Podman |

- The result is the **Run the tests** step of each stack job, about 14 minutes. Playwright stops at 30. The two stack jobs don't cancel each other, and a change is validated only when both are green.
- Specs run in file order with one worker, and each starts from `resetStack`. Most are serial: after a test fails, the rest of that file is skipped, so read the first failure.
- A failed stack job uploads `e2e-results-<docker|podman>-<attempt>`: the Playwright report, traces, videos and `e2e-stack.log` (every service and engine). Each job's **Logs** step prints the mesh and its own side: the end of `e2e-stack.log`, the WireGuard server, or the tracker, ffmpeg and broadcast engines.
- **Stop AceSwarm** on the Podman job may print "rootless netns: kill network process: permission denied". That step is allowed to fail and is not a test failure.
- **Check that the stack left no engines** runs after it on both jobs and is a real result: it fails when `docker compose down` left an engine container, which the stack's `cleanup` service should have removed. It lists the ones it found.

## 4. Real failure or not

- **The same test fails on both stack jobs.** Real, as long as the `wg` and `source` jobs are healthy.
- **A test fails on one stack job.** Often real and specific to that runtime (on Podman the fault rules go into Podman's network namespace, and the runner is `ubuntu-26.04` with its AppArmor profiles). Re-run all jobs once. If it fails again, it is real. If it passes, report a flaky test with the links to both attempts, don't drop it.
- **A step fails before the tests**: finding the public UDP address, "Join the mesh" ("no connectivity to …"), waiting for the profile or `broadcasts.json`, or `stack.sh check`. Usually infrastructure: re-run all jobs once. It is real if the change touches what that step runs: anything in `e2e/`, the workflow, or for `stack.sh check` the gateway, `compose.yaml` and the netgw stage of the `Dockerfile`. If the same step fails again, compare with the latest E2E run on `main`: only a failure there too makes it an outage. When the wait for the profile or `broadcasts.json` fails, the cause is in the `wg` or `source` job: read its **Logs** step. "Build the images and start AceSwarm" is always suspect, because the change can break a build or a service's health check.
- **Every test times out waiting for "playing".** Read the `source` job's logs first: each engine should announce to the tracker and get its broadcast as a peer. If the announces are there, suspect the change. If they are missing, the engines couldn't resolve the broadcast through Acestream's lookup service, or couldn't get out at all. A change to the gateway, the engine image or the compose files does that too, since `stack.sh check` only pings from the gateway itself. Call it an outage only when E2E on `main` from the same time fails the same way.
- **Known old flake.** In `streams.spec.ts`, "exports the engine's memory cache cap and estimated use, and the peers it uploads to" sometimes saw one uploading peer where it expects none. #19 (`abf2f1e`) fixed the count. A pull request run tests the branch merged into `main`, so it has #19 whatever the branch is based on. Only a run from "Run workflow" or a push tests the branch alone: there, if `git merge-base --is-ancestor abf2f1e <the run's commit>` fails (fetch `main` first in a shallow clone), merge `main` and run again instead of investigating. In every other case a non-zero count is a finding: the test attaches "gateway flows of the engine".

No other check is known to be flaky.

## 5. Add or change a spec

- Get broadcasts with `broadcasts(n)` from `e2e/tests/mesh.ts`. Their infohashes and content IDs are new in every run, and each stack runner has three.
- Start from `resetStack(request)` (`e2e/tests/helpers.ts`) in `beforeAll`, and remove every fault the spec adds.
- Both runtimes have to pass. Use `docker` and `compose` from `helpers.ts` and the fault setters from `mesh.ts`, never iptables or the runtime directly: on Podman the rules go into another chain. Pause and unpause by container ID or name with `docker(...)`, because `compose unpause` finds nothing on Podman (see `paths.spec.ts`). Use `MESH.self`, not a literal address.
- Real engines are slow to start: `waitForPlaying` allows 180 s. Don't shorten a timeout to make a spec faster.
- Update the spec table and the order diagram in `e2e/README.md`.

## 6. Check a real stream by hand

The suite plays its own broadcasts. To check a public stream against one engine, on the Testing environment (if your session can't reach it, ask the maintainer to run the check):

```sh
ENGINE=http://127.0.0.1:6878 # the engine's HTTP API
curl -s -m 90 "$ENGINE/ace/getstream?infohash=<40 hex>&format=json&pid=manual-check" # or ?id=<content ID>
# good: {"response": {"playback_url": "...", "stat_url": "...", "command_url": "..."}, "error": null}
# A live stream never ends, so for the next command exit code 28 (timed out) is expected: read the byte count.
curl -L -m 90 -o /dev/null -w '%{size_download}\n' "<playback_url>"
curl -s "<command_url>?method=stop"
```

- **Content ID or infohash.** Both are 40 hex characters, and they are not interchangeable: `id=` takes a content ID, `infohash=` an infohash. The wrong one answers "failed to load content" in about 2 s, so try the other before you call a stream dead. AceSwarm does the same for a bare value: content ID first, then infohash.
- **`playback_url` redirects.** Without `-L` you get about 100 bytes, which looks like a dead stream.
- **What healthy looks like.** Bytes within about 5 s, a burst of 9 to 16 MB, then 3 to 6 Mbit/s: tens of MB in 90 s. Give it the full 90 s.
- **One reader per session** (`docs/architecture.md`). Use an engine of your own, never one that AceSwarm is playing the stream from.
- **Control streams**, live when last checked on 2026-11-04: infohash `6d325cda6ed591647ef5e91edd043147bce8be30`, content ID `b146ee4b6e16c9df58e27bd02ffd6cea840ff212`. Public streams come and go, so check a control before you blame the code.
- **On the Testing environment**, ask before you start engines, run one or two at most, and never while another session is running its own.
