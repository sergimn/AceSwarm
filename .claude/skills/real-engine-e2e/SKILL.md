---
name: real-engine-e2e
description: How AceSwarm's end-to-end tests run with real Acestream engines, and how to read them. Use whenever you start or read an E2E workflow run, decide whether an E2E failure is real, add or change a spec in e2e/tests, or check a real stream by hand.
---

# Real-engine E2E

`e2e/README.md` is the full reference, with diagrams of the runners, the mesh and every spec. This is the short version.

## 1. Rules

- **Real engines only.** No mock engine, no stubbed `getstream`, no fake peers. Tests make failures with real firewall rules, paused containers and stopped broadcasts (`setDirectPathBlocked`, `setVpnServerUnreachable`, `setBroadcastBlocked`, `setBroadcastInput` in `e2e/tests/mesh.ts`).
- **The suite runs in CI only.** It needs four machines joined by a mesh, so there is no local or single-machine run. `npm run check` covers typecheck, lint, format and unit tests, not E2E.
- **Real streams don't load in a cloud sandbox.** The engine starts and its API answers, but its peer-to-peer traffic doesn't get out, so `getstream` answers "failed to load content". That says nothing about the code. Real streams play in CI and on the Testing environment.
- Never skip, disable or loosen a test to get green. `retries: 0` is on purpose.

## 2. Start a run

- Workflow **E2E** (`.github/workflows/e2e.yml`) runs on every pull request and on every push to `main`. A pull request needs nothing extra: push and read its run.
- For a branch without a pull request: Actions, E2E, "Run workflow", and pick the branch. From a session, that is `gh workflow run e2e.yml --ref <branch>`, or the GitHub tool `actions_run_trigger` with `method: run_workflow`, `workflow_id: e2e.yml` and `ref`. The workflow takes no inputs.
- A new run for the same pull request or branch cancels the one in progress.
- **Re-run all jobs, never only the failed one.** The runners only work together, and a single job would wait for runners that are gone.

## 3. Read a run

Four jobs start together:

| Job                                 | Role                                                           | Tells you             |
| ----------------------------------- | -------------------------------------------------------------- | --------------------- |
| WireGuard server                    | `wg`: the VPN server under test                                | infrastructure only   |
| Dummy Acestream broadcast           | `source`: six real broadcasts (`bc1`-`bc6`) and the tracker    | infrastructure only   |
| AceSwarm with real engines          | `stack`: Docker on `ubuntu-24.04`, plays `bc1`-`bc3`           | the result for Docker |
| AceSwarm with real engines (Podman) | `stack-podman`: rootless Podman on `ubuntu-26.04`, `bc4`-`bc6` | the result for Podman |

- The result is the **Run the tests** step of each stack job, about 14 minutes. Playwright stops at 30. The two stack jobs don't cancel each other, and a change is validated only when both are green.
- Specs run in file order with one worker, and each starts from `resetStack`. Most are serial: after a test fails, the rest of that file is skipped, so read the first failure.
- A failed stack job uploads `e2e-results-<docker|podman>-<attempt>`: the Playwright report, traces, videos and `e2e-stack.log` (every service and engine). Each job's **Logs** step prints its own side: the mesh, the WireGuard server, or the tracker, ffmpeg and broadcast engines.
- **Stop AceSwarm** on the Podman job may print "rootless netns: kill network process: permission denied". That step is allowed to fail and is not a test failure.

## 4. Real failure or not

- **The same test fails on both stack jobs.** Real, as long as the `wg` and `source` jobs are healthy: those two runners are all the stack jobs share.
- **A test fails on one stack job.** Often real and specific to that runtime (on Podman the fault rules go into Podman's network namespace, and the host is Ubuntu 26.04 with its AppArmor profiles). Re-run all jobs once. If it fails again, it is real. If it passes, report a flaky test with both run links, don't drop it.
- **A step fails before the tests**: finding the public UDP address, "Join the mesh" ("no connectivity to …"), waiting for the profile or `broadcasts.json`, or `stack.sh check`. Infrastructure: re-run all jobs. "Build the images and start AceSwarm" is the exception, because the change can break a build or a service's health check.
- **Every test times out waiting for "playing".** Read the `source` job's logs first: each engine should announce to the tracker and get its broadcast as a peer. Engines resolve content IDs and infohashes through Acestream's own lookup service, so an outage there fails the whole run. If the announces are there, suspect the change.
- **Known old flake.** In `streams.spec.ts`, "exports the engine's memory cache cap and estimated use, and the peers it uploads to" sometimes saw one uploading peer where it expects none. #19 fixed the count. On a branch without #19, merge `main` instead of investigating. With #19, a non-zero count is a finding: the test attaches "gateway flows of the engine".

No other check is known to be flaky.

## 5. Add or change a spec

- Get broadcasts with `broadcasts(n)` from `e2e/tests/mesh.ts`. Their infohashes and content IDs are new in every run, and each stack runner has three.
- Start from `resetStack(request)` in `beforeAll`, and remove every fault the spec adds.
- Use the helpers (`docker`, `compose`, the fault setters) instead of calling the runtime directly, so the spec passes on Docker and on Podman.
- Real engines are slow to start: `waitForPlaying` allows 180 s. Don't shorten a timeout to make a spec faster.
- Update the spec table and the order diagram in `e2e/README.md`.

## 6. Check a real stream by hand

The suite plays its own broadcasts. To check a public stream against one engine, on the Testing environment:

```sh
ENGINE=http://127.0.0.1:6878 # the engine's HTTP API
curl -s "$ENGINE/ace/getstream?infohash=<40 hex>&format=json&pid=manual-check" # or ?id=<content ID>
# good: {"response": {"playback_url": "...", "stat_url": "...", "command_url": "..."}, "error": null}
curl -L -m 90 -o /dev/null -w '%{size_download}\n' "<playback_url>"
curl -s "<command_url>?method=stop"
```

- **Content ID or infohash.** Both are 40 hex characters, and they are not interchangeable: `id=` takes a content ID, `infohash=` an infohash. The wrong one answers "failed to load content" in about 2 s, so try the other before you call a stream dead. AceSwarm does the same for a bare value: content ID first, then infohash.
- **`playback_url` redirects.** Without `-L` you get about 100 bytes, which looks like a dead stream.
- **What healthy looks like.** Bytes within about 5 s, a burst of 9 to 16 MB, then 3 to 6 Mbit/s: tens of MB in 90 s. Give it the full 90 s.
- **One reader per stream.** A second reader of the same stream on the same engine kicks the first, so don't read a stream that AceSwarm is playing from that engine.
- **Control streams**, live when last checked on 2026-11-04: infohash `6d325cda6ed591647ef5e91edd043147bce8be30`, content ID `b146ee4b6e16c9df58e27bd02ffd6cea840ff212`. Public streams come and go, so check a control before you blame the code.
- **On the Testing environment**, ask before you start engines, run one or two at most, and never while another session is running its own.
