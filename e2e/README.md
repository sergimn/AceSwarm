# End-to-end tests

The end-to-end tests drive the real AceSwarm services (controller, transcoder, network gateway) through the UI and the REST API with Playwright. Nothing is mocked: real Acestream engines play real broadcasts from another machine, directly or through a real WireGuard server on a third machine.

| Runs in                    | Engines                                      | Machines                | When                                           |
| -------------------------- | -------------------------------------------- | ----------------------- | ---------------------------------------------- |
| Workflow "E2E" (`e2e.yml`) | real Acestream engines (`engine/Dockerfile`) | 4 GitHub-hosted runners | every PR and push to `main`, or "Run workflow" |

- **Docker and rootless Podman.** Two stack runners run the whole suite side by side: `stack` on Docker and `stack-podman` on rootless Podman. They share the broadcast runner and the WireGuard server. See [The Podman stack runner](#the-podman-stack-runner).

- **No single-machine run.** The broadcasts and the WireGuard server need their own hosts, joined to AceSwarm's by the mesh, so the suite runs on the CI runners only. To try a branch, push it and start the workflow with "Run workflow".
- **It needs Acestream's lookup service.** Engines resolve both content IDs and infohashes through it, so an Acestream outage fails the whole run.

## Architecture

Each runner plays one part. They reach each other over a private WireGuard network, the **mesh**, on TEST-NET-1 addresses (`192.0.2.0/24`). Nothing on the runners uses that range, and the gateway counts it as internet peers (its peer statistics skip private ranges, and its engine firewall only blocks private ranges).

```mermaid
flowchart TB
  subgraph stack["runner: stack 192.0.2.3 (Docker), or stack-podman 192.0.2.4 (rootless Podman)"]
    PW[Playwright] -- UI, REST --> C[controller]
    C --> T[transcoder]
    C -- paths --> G[netgw]
    C -- "create, via docker-proxy" --> E["real engines<br/>(engine/Dockerfile)"]
    E -- default route --> G
    FW["firewall for container traffic<br/>(DOCKER-USER, or FORWARD in Podman's netns)"]
  end
  subgraph wg["runner: wg 192.0.2.1"]
    V["WireGuard server<br/>(e2e/wg-server) UDP 51820"]
  end
  subgraph source["runner: source 192.0.2.2"]
    F["6 ffmpeg test patterns<br/>HTTP MPEG-TS :18001-18006"] --> S["6 Acestream broadcast sources<br/>(--stream-source) P2P :7764-7769"]
    S -- announce --> K["tracker :7700<br/>(e2e/tracker.ts)"]
  end
  G -- "direct path" --> FW
  FW -- "mesh" --> S
  G -- "WireGuard tunnel, inside the mesh" --> FW
  FW -- "mesh" --> V
  V -- "NAT, over the mesh" --> S
  E -. announce .-> K
```

- **The broadcasts are real.** Real Acestream engines broadcast six test patterns, each with its own colours and tone: `bc1`-`bc3` for the Docker stack runner and `bc4`-`bc6` for the Podman one (`E2E_BROADCASTS`). Players on a stack runner find a broadcast by its infohash or its content ID, through Acestream's own lookup service, which returns the transport file with our tracker in it.
- **The VPN is real.** The WireGuard server writes one client profile per stack runner (`client-stack.conf`, `client-stack-podman.conf`), pointing at its mesh address, and the tests upload it through the UI like a user would. Two clients can't share one key.
- **Failures are made at the stack runner's firewall.** The tests add `DROP` rules to its `DOCKER-USER` chain (on Podman: the `FORWARD` chain of Podman's network namespace), which only sees traffic forwarded for containers. The tests' own requests to the other runners keep working, and so does the other stack runner.
- **The tracker tells the paths apart.** An engine's announces come from its stack runner's address (`192.0.2.3` or `192.0.2.4`) on the direct path and from `192.0.2.1` (the WireGuard server's runner, after NAT) on the VPN path. `GET /stats` on the tracker lists them. Both stack runners' VPN traffic leaves from `192.0.2.1`, which is why each one plays its own broadcasts.
- **Fixed countries.** `GEOIP_STATIC` places the broadcast runner in Spain (`ES`) and the WireGuard runner in Sweden (`SE`).

| Address                          | Port              | What                                       |
| -------------------------------- | ----------------- | ------------------------------------------ |
| every runner                     | UDP 51000         | mesh WireGuard (`wg-mesh`)                 |
| every runner                     | TCP 18999         | files shared on the mesh (`mesh.sh share`) |
| `192.0.2.1`                      | UDP 51820         | WireGuard server under test                |
| `192.0.2.2`                      | TCP+UDP 7764-7769 | broadcast sources (P2P)                    |
| `192.0.2.2`                      | TCP 7700          | tracker (`/announce`, `/stats`, `/inputs`) |
| `127.0.0.1` on the source runner | TCP 18001-18006   | ffmpeg's HTTP MPEG-TS inputs               |
| `127.0.0.1` on a stack runner    | TCP 18080         | AceSwarm UI and API                        |

### Real failures instead of mocks

```mermaid
flowchart LR
  subgraph stack["stack runner"]
    G[netgw] --> FW{"DOCKER-USER"}
  end
  FW -- "to 192.0.2.2<br/>setDirectPathBlocked" --x S["broadcasts<br/>(source runner)"]
  FW -- "UDP to 192.0.2.1:51820<br/>setVpnServerUnreachable" --x V["WireGuard server<br/>(wg runner)"]
  FW -- "to one broadcast's P2P port<br/>setBroadcastBlocked" --x S
```

| Condition                          | How the tests make it                                                                      | Used by                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| a swarm that dries up              | `setDirectPathBlocked(true)` while there is no WireGuard profile, so no path can help      | stall recovery                                          |
| a broadcast that stops             | `setBroadcastInput(broadcast, false)`: the tracker stops that broadcast's ffmpeg input     | waiting for the source, never publishing its old window |
| an ISP that blocks Acestream peers | `setDirectPathBlocked(true)` with a WireGuard path up                                      | moving to the VPN, fail closed after a gateway restart  |
| a VPN provider that went away      | `setVpnServerUnreachable(true)`: the tunnel stops carrying anything and its path goes down | WireGuard only: streams wait instead of going direct    |
| an engine that crashes             | `docker restart` of one engine container                                                   | the other streams are left alone                        |
| one swarm that dries up            | `setBroadcastBlocked(broadcast, true)`: only that broadcast's P2P port on `192.0.2.2`      | one engine per path: the other stream keeps playing     |

The direct-path block only drops traffic to the broadcast runner, so the direct path keeps answering the gateway's pings (they go to the WireGuard server's runner) and keeps its better probe score. That is what a connection that blocks Acestream peers looks like, and a stream still has to leave it.

## Why a mesh, and how it forms

GitHub-hosted runners can't accept connections from the internet. Each one sits behind Azure's NAT, which only lets a packet in from an address and port the runner has already sent to. The runners have no IPv6 either. The NAT keeps one public port per local port, whatever the destination (endpoint-independent mapping). So if two runners know each other's public address and port, and both send at the same time, each one's first packets open its own NAT for the other. This is UDP hole punching.

The only missing piece is the public port, which the NAT picks at random. A runner can't see it locally. It learns it by sending a packet from that exact port to a STUN server, which answers with the address and port the packet came from. `e2e/stun.ts` asks two public servers (Google and Cloudflare, no account needed). They always agreed in testing, which confirms the endpoint-independent mapping.

```mermaid
sequenceDiagram
  autonumber
  participant A as wg runner
  participant B as source runner
  participant C as stack runner
  participant S as STUN servers
  participant GH as GitHub (run artifacts)
  par every runner
    A->>S: Binding request from UDP 51000
    S-->>A: your public address is ip:port
    A->>GH: upload mesh-N-wg (mesh IP, public key, ip:port)
  and
    B->>S: Binding request from UDP 51000
    S-->>B: your public address is ip:port
    B->>GH: upload mesh-N-source
  and
    C->>S: Binding request from UDP 51000
    S-->>C: your public address is ip:port
    C->>GH: upload mesh-N-stack
  end
  Note over A,C: STUN keeps refreshing the mapping every 10 s until WireGuard takes the port over
  A->>GH: poll the run's artifacts, download the other two
  B->>GH: same
  C->>GH: same
  A->>C: WireGuard handshake (opens A's NAT for C)
  C->>A: WireGuard handshake (opens C's NAT for A, and passes A's)
  Note over A,C: every pair does the same, and keepalives every 5 s hold the mappings open
  C->>A: ping 192.0.2.1
  C->>B: ping 192.0.2.2
```

Artifact names include the run attempt (`mesh-N-…` above), so a re-run never picks up the addresses of runners from an earlier attempt.

The runners can't ping the internet either: Azure drops ICMP to and from outside addresses. The gateway's path probes ping `1.1.1.1` and `9.9.9.9` by default, so on a runner every path would stay down and, with the gateway failing closed, engines would reach nothing. `e2e/compose.e2e.yaml` points `PROBE_TARGETS` at the WireGuard server's runner (`192.0.2.1`) instead, which answers both directly over the mesh and through the tunnel.

## Workflow

The jobs start together and have no `needs`, so they run side by side. Once the mesh is up, the WireGuard server and the broadcasts start in parallel on their own runners while the stack runners build the images. The diagram shows one stack job; `stack-podman` (the same job in a matrix) does the same with its own profile, broadcasts and `done`.

```mermaid
flowchart TB
  subgraph wgjob["job: wg"]
    direction TB
    a1[mesh.sh prepare wg] --> a2[upload artifact] --> a3[mesh.sh join] --> a4["vpn.sh build + start<br/>share client-ROLE.conf"] --> a5["wait for 'done'<br/>from both stacks"] --> a6[logs]
  end
  subgraph sourcejob["job: source"]
    direction TB
    b1[mesh.sh prepare source] --> b2[upload artifact] --> b3[mesh.sh join] --> b4["broadcast.sh start + wait<br/>share broadcasts.json"] --> b5["wait for 'done'<br/>from both stacks"] --> b6[logs]
  end
  subgraph stackjob["job: stack"]
    direction TB
    c1[mesh.sh prepare stack] --> c2[upload artifact] --> c3[mesh.sh join] --> c4["npm ci, Playwright,<br/>stack.sh build + up"] --> c5["wait for client-ROLE.conf<br/>and broadcasts.json"] --> c6["npm run e2e"] --> c7["share 'done', wait until<br/>both runners fetched it"] --> c8["logs, artifacts on failure,<br/>stack.sh down"]
  end
  a4 -. "client-ROLE.conf over the mesh" .-> c5
  b4 -. "broadcasts.json over the mesh" .-> c5
  c7 -. "done" .-> a5 & b5
```

- **Sharing files.** Each runner serves `$RUNNER_TEMP/mesh/share` on its mesh address, port 18999. `mesh.sh share` publishes a file, and `mesh.sh wait-file` polls a peer for one.
- **Finishing.** Each stack job shares `done` even when it fails. The WireGuard and broadcast jobs wait for it from every stack runner that joined (`mesh.sh wait-all`), so one stack finishing early never takes the VPN or the broadcasts away from the other. A stack job keeps serving `done` until both have fetched it (`mesh.sh wait-fetched`, at most two minutes), because its file server stops with the job. If a stack runner disappears (cancelled or crashed), they stop waiting for it after it hasn't answered pings for about five minutes.
- **A stack runner that is late or never shows up** holds nobody up: the WireGuard and broadcast jobs join the stacks as optional peers (`stack?` in `mesh.sh join`) and add each one as soon as its artifact appears, while the other stack's handshakes already get answers. A stack that hasn't appeared after ten minutes, or whose job ended without publishing its address, is left out, and until then the shared runners don't start their servers, so its absence delays the other stack by up to ten minutes but doesn't fail it.
- **Time limits.** Every setup and test step has a limit of a few times its usual length, so a step that hangs fails within minutes instead of at the job's limit (50 minutes for a stack job, 60 for the two that serve them, which wait for both stacks). The tests usually take about 14 minutes; in CI Playwright stops them at 30 (`globalTimeout`), before the step's 35-minute limit, so the report still gets uploaded.
- **Slow setup.** `mesh.sh prepare` usually takes 10-15 s, but apt once hung for a whole one-hour job while installing wireguard-tools. Installing now gets three tries of at most a minute each (`MESH_TRIES`, `MESH_APT_SECONDS`), and STUN gets three tries of at most 20 s.
- **A runner that fails early.** While `mesh.sh join` waits for a peer's artifact, it also checks every 15 s or so whether that peer's job has ended. If it has, a required peer fails the join at once and an optional one is left out, instead of waiting out ten minutes for a runner that will never publish its address. A stack job that fails before joining doesn't wait for anyone to fetch its `done`.
- **Re-runs.** Use "Re-run all jobs". Re-running a single job can't work, because it would wait for runners that are gone.

## The broadcasts

```mermaid
flowchart LR
  FF["ffmpeg (static build), one per broadcast<br/>testsrc2 960x540 25 fps, own hue and tone<br/>H.264 + AAC, about 1.3 Mbit/s"] -- "HTTP MPEG-TS<br/>127.0.0.1:1800N" --> SRC["acestreamengine --stream-source<br/>--skip-internal-tracker<br/>--tracker http://192.0.2.2:7700/announce<br/>--port 776(3+N)"]
  SRC -- "writes" --> ACE["N/publish/bcN.acelive +<br/>N/cache/live.INFOHASH.0"]
  ACE -- "--get-file-info-with-id" --> CID[content ID]
  SRC -- announce --> TR[tracker]
  ACE & CID -- "broadcasts.json on the mesh" --> TESTS[stack runner]
```

`e2e/broadcast.sh start HOST 6` runs the parts, and `broadcast.sh wait` prints `broadcasts.json`: a name, an infohash and a content ID per broadcast. The engine's cache file is named after the infohash, and `acestreamengine --get-file-info-with-id` prints the content ID of a transport file. A fresh engine resolves either one through Acestream's lookup service.

Two quirks of the 3.2.11 Linux engine shape it:

- **Its built-in tracker refuses every announce** ("Requested download is not authorized for use with this tracker"). The sources skip it and announce to `e2e/tracker.ts`, a minimal BitTorrent HTTP tracker, and players use that one too.
- **Its RSA key generation crashes with pycryptodome 4**, which the image ships: it relies on negative intermediate values. `PYCRYPTODOME_INTEGER=native` switches pycryptodome to its pure Python integers, which allow them.

The engine only reads HTTP sources (`--source -` for stdin isn't supported). ffmpeg's HTTP server serves one client and exits, so Docker restarts it for each reconnect.

## Tests

The specs share one stack, so they run one after the other, in file order. Each starts from an empty stack (`resetStack`: no streams, no WireGuard profile, WireGuard only, engine sharing and hot standby off, so each stream has one engine).

```mermaid
flowchart LR
  I[isolation] --> N[navigation] --> P[paths] --> R[recovery] --> SE[shared-engines] --> SB[standby] --> S[streams] --> W[wireguard-only]
```

| Spec                     | Engines | Checks                                                                                                                                                                                                                                                                 |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolation.spec.ts`      | 1       | engines can't reach the gateway, controller or transcoder APIs; the gateway drops engine connections to private addresses                                                                                                                                              |
| `navigation.spec.ts`     | 3       | arrow key navigation for TV remotes, the full screen player and Back, previews and thumbnails                                                                                                                                                                          |
| `paths.spec.ts`          | 1       | the direct path, profiles with hooks rejected, a profile from another machine, moving to the VPN, fail closed after a gateway restart, sticky paths, back to direct on removal                                                                                         |
| `recovery.spec.ts`       | 1, 2    | stall recovery where no path can help, an engine restart that leaves the other streams alone, a broadcast that stops and comes back: "stale-source", nothing old published, slow retries, fresh video after                                                            |
| `shared-engines.spec.ts` | 1, 2    | one engine per path: turning it on and off moves streams without a gap, one stream failing leaves the shared engine alone, the watched stream failing replaces it, throwaway viewer ids                                                                                |
| `standby.spec.ts`        | 2       | hot standby: a hot standby on the VPN, failing over within seconds when the engine hangs, without a new engine or the ladder, sticky afterwards, standby sessions on shared engines, turning it off, a broadcast that stops while both its engines hold its old window |
| `streams.spec.ts`        | 3       | adding from the UI, live stats, content ID and infohash detection, magnet links, persistence across a controller restart, removal                                                                                                                                      |
| `wireguard-only.spec.ts` | 3       | WireGuard only: greyed out without a profile, moves streams off the direct path, enforced by the gateway, streams wait while no VPN is up, the last profile stays                                                                                                      |

### Content IDs and infohashes

Both are 40 hex characters, so the controller tries a bare value as a content ID first and falls back to an infohash, then remembers what worked.

```mermaid
sequenceDiagram
  autonumber
  participant T as Playwright
  participant C as controller
  participant E as real engine
  participant L as Acestream lookup service
  T->>C: add acestream://CONTENT_ID (UI)
  C->>E: getstream?id=CONTENT_ID
  E->>L: resolve the content ID
  L-->>E: transport file (our tracker)
  E-->>C: playback URL
  C-->>T: playing, kind "content-id"
  T->>C: add a bare INFOHASH (API)
  C->>E: getstream?id=INFOHASH
  E-->>C: "failed to load content"
  C->>E: getstream?infohash=INFOHASH
  E-->>C: playback URL
  C-->>T: playing, kind "infohash"
```

### Stall recovery

```mermaid
sequenceDiagram
  autonumber
  participant T as Playwright
  participant FW as host firewall
  participant AS as AceSwarm
  participant SRC as broadcasts
  T->>AS: add a broadcast (no WireGuard profile)
  AS->>SRC: direct path, playing
  T->>FW: DROP container traffic to 192.0.2.2
  AS->>AS: no new frames: restart pipeline, restart engine, ...
  T->>AS: recoveries went up, not playing
  T->>FW: remove the DROP rule
  AS->>SRC: the next recovery step plays again
  T->>AS: playing on the direct path
```

### A broadcast that stops

The tracker on the broadcast runner stops and starts a broadcast's ffmpeg input (`POST /inputs/bcN/stop|start`). Its source engine keeps running with the window it has, so the stream's engine keeps its connection and its peers, and each new session still gets that old window: data comes, but the live edge stops. That is what a broadcast that stops looks like, and what a firewall rule can't make.

```mermaid
sequenceDiagram
  autonumber
  participant T as Playwright
  participant SRC as broadcast runner (tracker)
  participant AS as AceSwarm
  T->>AS: add a broadcast, playing, live edge "live"
  T->>SRC: POST /inputs/bcN/stop
  AS->>AS: no new video: restart the session, which only gets the old window
  AS->>AS: live edge unchanged for STALE_SOURCE_SECONDS (30): "stale-source"
  T->>AS: playlist and thumbnail 404 for 30 s, never "playing", at most a few tries
  T->>SRC: POST /inputs/bcN/start
  AS->>AS: the next new session's live edge moves
  T->>AS: playing, live edge "live" and moving, newest segment is MPEG-TS
```

### Network paths

`paths.spec.ts` runs these in order, on one stream:

```mermaid
sequenceDiagram
  autonumber
  participant T as Playwright
  participant AS as AceSwarm (stack runner)
  participant FW as host firewall
  participant WG as wg runner
  participant SRC as source runner (tracker)
  T->>AS: add a broadcast by its infohash
  AS->>SRC: direct path: announce from 192.0.2.3, P2P data
  T->>AS: playing, peers in ES, HLS segment is MPEG-TS
  T->>AS: a profile with PostUp is refused
  T->>AS: upload the profile generated on the wg runner (UI)
  AS->>WG: WireGuard handshake through the mesh
  T->>AS: path wg:ci-vpn is up
  T->>FW: DROP container traffic to 192.0.2.2
  AS->>AS: stall, restart session, restart engine, move to the VPN
  AS->>WG: engine traffic in the tunnel
  WG->>SRC: NAT: announce from 192.0.2.1, P2P data
  T->>SRC: /stats shows a new announce from 192.0.2.1
  T->>AS: pause the controller, restart netgw
  T->>AS: netgw alone: FORWARD DROP, no rule for the engine
  T->>AS: unpause: the controller sends the paths again, back on the VPN
  T->>FW: remove the DROP rule
  T->>AS: 45 s later still on the VPN, no recoveries (sticky path)
  T->>AS: delete the WireGuard profile
  AS->>SRC: back on the direct path: new announce from 192.0.2.3
```

### One engine per path

`shared-engines.spec.ts` runs these in order, on two streams. All the while, the second stream (the bystander) has to keep playing, with no recovery.

```mermaid
sequenceDiagram
  autonumber
  participant T as Playwright
  participant AS as AceSwarm (stack runner)
  participant FW as host firewall
  participant SRC as source runner
  T->>AS: two broadcasts play, one engine each
  T->>AS: turn "One engine per path" on in the Streams dialog
  AS->>AS: shared engine for the direct path, both streams move make-before-break
  T->>AS: the engines metric counts 1 shared engine and no own ones
  T->>FW: DROP the first broadcast's P2P port
  AS->>AS: nobody watches it: session restarts only, the shared engine stays
  T->>FW: remove the DROP rule, it plays again
  T->>AS: open the first stream in the player: 1 viewer, a random id, no cookies or storage
  T->>FW: DROP the first broadcast's P2P port again
  AS->>AS: the watched stream failed: start a second shared engine
  T->>FW: remove the DROP rule
  AS->>AS: both streams move to the new engine, the old one goes
  T->>AS: restarts metric says "watched", closing the player leaves 0 viewers
  T->>AS: turn it off: each stream moves to an engine of its own
```

### Hot standby

`standby.spec.ts` runs these in order, on one stream, with hot standby on:

```mermaid
sequenceDiagram
  autonumber
  participant T as Playwright
  participant AS as AceSwarm (stack runner)
  participant WG as wg runner
  T->>AS: the stream plays on the direct path, no standby (one path)
  T->>AS: upload the WireGuard profile
  AS->>WG: a standby engine on the VPN, the transcoder reads it: "hot"
  T->>AS: the engines metric counts 2 own engines, the standby too
  T->>AS: pause the engine the stream plays from (it hangs)
  AS->>AS: no video for 8 s: fail over to the VPN standby (one recovery, no "recovering")
  T->>AS: unpause it
  AS->>AS: no new engine: the old one becomes the standby on the direct path
  AS->>AS: the direct standby gets hot, the stream stays on the VPN
  T->>AS: turn "One engine per path" on
  AS->>AS: stream and standby become sessions on the two paths' shared engines
  T->>AS: pause the VPN's shared engine, then unpause it
  AS->>AS: fail over to the direct path's shared engine
  T->>AS: turn "Hot standby on other paths" off in the Streams dialog: standbys go
  T->>AS: turn it on again, without engine sharing: two engines of its own, one standby "hot"
  T->>AS: stop the broadcast's input: both engines keep its old window and peer with each other
  AS->>AS: "stale-source", the standby goes, no segment listed or "playing" after the threshold
  T->>AS: start the input: it plays from new data, and its standby gets hot again
```

The faults are engines that hang, not paths that lose the broadcast. With a standby running, cutting the direct path off does not stall the stream: its engine keeps getting the broadcast from the standby, over the engines' network.

### WireGuard only

`wireguard-only.spec.ts` runs these in order:

```mermaid
sequenceDiagram
  autonumber
  participant T as Playwright
  participant AS as AceSwarm (stack runner)
  participant FW as host firewall
  participant WG as wg runner
  participant SRC as source runner (tracker)
  T->>AS: the switch is greyed out without a profile, the API answers 409
  T->>AS: stream 1 plays on the direct path
  T->>AS: upload the profile, turn WireGuard only on (remote keys)
  AS->>AS: gateway cuts engines off the direct path, stream 1 moves at once (no recovery)
  WG->>SRC: NAT: announce from 192.0.2.1
  T->>AS: netgw refuses direct assignments, no direct accept or NAT rules
  T->>AS: stream 2 plays on the VPN
  T->>FW: DROP UDP to 192.0.2.1:51820
  AS->>AS: VPN path down, streams stall and recover in place, never direct
  T->>AS: stream 3 waits: "no WireGuard path is up", no engine
  T->>FW: remove the DROP rule
  AS->>WG: tunnel back, all three play on the VPN
  T->>AS: the last profile can't be removed while on
  T->>AS: turn it off: direct is allowed again, streams stay on the VPN
```

## Debugging a failed run

- **Each job's last step prints its logs:** the mesh (`wg show`), the WireGuard server, or the broadcasts (tracker, ffmpeg and engine logs).
- **Each stack job also uploads** `e2e-results-<docker|podman>-<attempt>` on failure: the Playwright report, traces, videos and `e2e-stack.log` (every service and engine).
- **"no connectivity to …" in `mesh.sh join`** means hole punching failed. Check that `endpointIndependent` was `true` in each runner's "public UDP address" line. If GitHub ever changes its NAT, this suite needs a relay instead.
- **Tests time out waiting for playback** while the mesh is fine: check the tracker log in the source job. Each engine should announce and get its source as a peer.

## Files

| File                                     | Role                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `.github/workflows/e2e.yml`              | the jobs                                                             |
| `e2e/mesh.sh`                            | STUN, artifacts, the WireGuard mesh, file sharing                    |
| `e2e/stun.ts`                            | minimal STUN client with keepalive                                   |
| `e2e/vpn.sh`, `e2e/wg-server/`           | the WireGuard server under test                                      |
| `e2e/broadcast.sh`                       | ffmpeg, the broadcast sources and the tracker                        |
| `e2e/tracker.ts`                         | minimal BitTorrent HTTP tracker with `/stats`                        |
| `e2e/stack.sh`, `e2e/compose.e2e.yaml`   | AceSwarm with real engines                                           |
| `e2e/podman.sh`                          | rootless Podman on the `stack-podman` runner                         |
| `e2e/playwright.config.ts`, `e2e/tests/` | the specs, their helpers (`helpers.ts`) and mesh helpers (`mesh.ts`) |
| `e2e/test/`                              | unit tests for the STUN client and the tracker (run by `npm test`)   |

## The Podman stack runner

The `stack-podman` runner (`ubuntu-26.04`) runs AceSwarm like a host that starts it with `docker compose up` on rootless Podman. `e2e/podman.sh setup` installs `podman`, `podman-docker` and `docker-compose-v2` from the distribution, so `docker` runs Podman and `docker compose` runs `podman compose` with Docker Compose as its provider. It starts a systemd user instance (linger) for Podman's cgroups, healthchecks and API socket, and sets `DOCKER_SOCKET` to that socket and `ACESWARM_ENGINES_INTERNAL=true`, as `.env.example` describes for Podman.

- **Faults go into Podman's network namespace.** Rootless containers reach the outside through rootless Podman's own network namespace, not the host's forwarding path, so the host's `DOCKER-USER` chain never sees their traffic. With `E2E_RUNTIME=podman`, the specs add their `DROP` rules to that namespace's `FORWARD` chain instead (`e2e/podman.sh iptables`), which also sees container traffic only.
- **AppArmor on Ubuntu 26.04.** Its AppArmor ships a profile for `/usr/bin/wg` that only lets `wg` read `/etc/wireguard`. That is why the mesh keeps its private key there. The gateway image installs `wg` as `/usr/local/sbin/wg` for the same reason: rootless containers have no AppArmor profile of their own, so the host's profile would apply to the container's `/usr/bin/wg` (see the netgw stage in `Dockerfile`).
