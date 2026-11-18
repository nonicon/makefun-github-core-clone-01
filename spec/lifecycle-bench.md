# Lifecycle & Bench Specification — github-core-clone-01

Implementation-ready specification of how a trial runs, how to run the suite
locally on this VM, and what determinism / performance rules apply.

Sources (all under `github-core-clone-01-kit/github-core-clone-01-kit/`):
`program/env/src/main.ts`, `wire.ts`, `manifest.ts`, `bench.ts`, `export.ts`,
`calibration.json`; `program/scorer/score.mjs` (+ `score.ts`, `columns.ts`,
`main.ts`); `starter/main.ts`, `starter/app.ts`, `starter/package.json`;
`cli/makefun.mjs` (`--help` output and `grade-local` section); `sdk/run.ts`;
`competition.yaml`, `RULES.txt`. The sealed bundle `program/env/server.mjs`
is the esbuild-inlined form of `env/src/*` — same behaviour, do not edit it.

Verified on this VM (2026-11-15): Node v24.22.1, Python 3.12.3, **no Docker**.
`node program/env/server.mjs` boots directly (ready file written, SIGTERM
writes the boot-failure export, scorer reads it and prints `score 0/1000`).
See §2 for the exact commands used.

Trial limits (from `competition.yaml` / `RULES.txt`): entry 2 CPUs, 1024 MB,
256 processes, **900 s wall budget**. Repo mounted read-only at `/bot`; write
only under `/tmp`. No internet, no git binary. Entry runs as
`node /bot/main.ts` (Node 22) or `python3 /bot/main.py` (Python 3.13), stdlib
only, no install step. The env runs beside the entry in the same pod and
shares those totals — leave the suite room.

---

## 1. Lifecycle exactness

### 1.1 Actors and addresses

- **Env** (`program/env/server.mjs`, the sealed suite): listens on
  `MAKEFUN_ENV_HOST` / `MAKEFUN_ENV_PORT`, serves only `POST /register` and
  `GET /done` (anything else: JSON 404), runs the checks + benchmark, writes
  the export.
- **Entry** (the forge): binds its **own ephemeral port** (`listen(0)`),
  registers that port, then polls `/done` until told to exit.
- The env never knows the entry's port in advance. It derives the entry base
  URL from the **register request's peer address + the port the entry named**:
  `http://<remoteAddress>:<port>` (wire.ts `entryBase`). Peer-address
  normalisation: `::ffff:a.b.c.d` → `a.b.c.d`; `[...]` brackets and `%zone`
  suffixes are stripped; an empty peer address is a `WireError`. IPv6 literals
  are re-bracketed in the URL. No trailing slash on the base URL.
- In a trial container `MAKEFUN_ENV_URL` is `http://store:8080` (the env's
  service alias); under the process driver it is
  `http://127.0.0.1:<envPort>`. The entry reads it from its own environment.

### 1.2 Env boot sequence (env `main.ts` `startEnv` / `runSuite`)

1. Bind the listener (`reusePort: false` — a second listener is refused).
   Port must be digits `0..65535`; `0` picks a free port.
2. `mkdir -p <stateDir>`; write `<stateDir>/calls.ndjson` **empty** (the
   harness stores it as the pass's env log and faults `env` on a pass without
   one; the env makes no model calls, so it stays empty).
3. Write `<stateDir>/ready` atomically (temp file + rename), body
   `{"schema":"github-core-clone-01/ready/v1","host":…,"port":…}` + newline.
   The harness waits for this file before starting the entry.
4. Confirm `<stateDir>/ready` reads back, waiting up to `READY_WAIT_MS`
   **30 000 ms**. If it never reads back: boot failure, export written, done.
5. **Boot phase** (`runBoot`):
   - Wait for the first register, up to `BOOT_BUDGET_MS` **20 000 ms**
     (capped by what is left of the internal deadline). Polling uses
     exponential backoff: first gap 100 ms, factor 2, ceiling 2 000 ms.
   - No register inside the budget → **boot failure**: every check 0,
     `working` 0, fixed note `"no entry registered before the boot deadline"`,
     `/done` answers `{"done":true}` at once. Score 0.
   - Then `GET /healthz` **twice**, sequentially, inside
     `HEALTHZ_BUDGET_MS` **10 000 ms**. Each attempt's fetch timeout is the
     remaining health budget. A 200 counts as answered; any other status or
     transport error is logged and does not count. There is no delay between
     the two attempts.
   - `bootOk` is true only if **both** answers are 200.
   - **Important:** a healthz failure does NOT stop the trial. If the entry
     registered, the conformance phase still runs in full and can earn
     feature/agent/perf points; only `working` becomes 0
     (`working = bootOk && passed > 0`).
6. Install the GraphQL git fixture (`configureGraphQLGit` over a `GitClient`
   bound to the entry; it creates fixture repos through REST and pushes
   branches the pull-request checks open from). If installation throws, the
   fixture is `null` and the affected checks fail with a detail.
7. **Conformance phase**: every check of
   `[...GIT_CHECKS, ...restChecks(), ...restProtocolChecks(), ...GRAPHQL_CHECKS, ...MCP_CHECKS]`
   in registration order, **one at a time, never overlapping**, each with its
   own timeout and its own `AbortSignal`. A check that times out is recorded
   0 with detail `"deadline"`; the rest still run. After a timed-out check the
   runner waits up to `CHECK_DRAIN_GRACE_MS` **1 000 ms** for the abandoned
   promise to settle before starting the next check (0 ms once the deadline
   has fallen).
8. **Benchmark phase**: the four workloads (§3).
9. **Export phase**: write `<stateDir>/export/state.json` then `perf.json`
   (state first, so a run cut between the two never pairs a new perf with an
   older state). `/done` answers `{"done":true}` as soon as the export is
   written. The env keeps serving until SIGTERM.
10. On SIGTERM/SIGINT: `stop()` aborts the trial, (re)writes the export under
    the never-worse rule (§4.3), sets done, closes the listener (including
    `closeIdleConnections` / `closeAllConnections`), exits **0**. `stop()` is
    idempotent. A signal **before** the listener is ready writes the
    boot-failure export and exits 0. An uncaught exception / unhandled
    rejection / fatal throw writes the boot-failure export (keeping a better
    file already on disk) and exits **1**.

### 1.3 Budgets and the internal deadline

All clocks are monotonic (`performance.now()` in the env); the deadline is
`startedAt + wallBudgetSec*1000 − DEADLINE_MARGIN_MS`.

| Constant | Value |
|---|---|
| `TRIAL_WALL_BUDGET_SEC` (wall budget) | 900 s |
| `DEADLINE_MARGIN_MS` | 90 000 ms |
| **Internal deadline** | start + **810 000 ms** (810 s) |
| `BOOT_BUDGET_MS` | 20 000 ms |
| `HEALTHZ_BUDGET_MS` / `HEALTHZ_ATTEMPTS` | 10 000 ms / 2 |
| `READY_WAIT_MS` | 30 000 ms |
| `CONFORMANCE_BUDGET_MS` | 240 000 ms |
| `BENCHMARK_BUDGET_MS` | 240 000 ms |
| `EXPORT_BUDGET_MS` | 30 000 ms |
| `DEADLINE_EXIT_GRACE_MS` | 5 000 ms |
| `CHECK_TIMEOUT_MS` (default; clamped 5 000–15 000 ms, see §5) | 15 000 ms |
| `CHECK_DRAIN_GRACE_MS` | 1 000 ms |
| `FIXTURE_REQUEST_TIMEOUT_MS` / `FIXTURE_PUSH_BUDGET_MS` | 4 000 ms / 12 000 ms |

- `MAKEFUN_TRIAL_WALL_BUDGET_SEC` overrides the wall budget for a local run
  (positive number only; otherwise 900). The internal deadline follows it.
- At the internal deadline: checks still pending are recorded 0 with
  `"deadline"`, benchmark workloads not yet started are never started, the
  export is written, `/done` is answered, and the process exits after the
  5 s grace if the harness has not SIGTERMed it yet.
- Each phase is also capped by its own budget *and* the deadline, whichever
  ends first (`phaseEnd = min(deadline, now + phaseBudget)`). A check's
  timeout is clamped to the phase's remainder.

### 1.4 `/register` — exact contract

- `POST $MAKEFUN_ENV_URL/register`, JSON body `{"port": N}`.
  `N` must be an integer `1..65535` (`0` is never a valid announced port).
  Extra keys are ignored. Body cap `MAX_REGISTER_BODY_BYTES` = **65 536**.
- Responses (all `application/json; charset=utf-8`, `cache-control: no-store`):
  - `200 {"ok":true}` — first register wins; this entry is now dialled.
  - `409 {"ok":false,"error":"already_registered"}` — a first register already
    won; the base URL does **not** move. The starter treats 409 as "registered"
    and waits for `/done` like any other entry.
  - `400 {"ok":false,"error":"bad_json"}` — body is not JSON.
  - `400 {"ok":false,"error":"body_too_large"}` — body past 65 536 bytes.
  - `400 {"ok":false,"error":"bad_request","message":…}` — not an object, or
    `port` not an integer 1..65535.
  - `405 {"ok":false,"error":"method_not_allowed","message":"/register takes POST"}`
    — any non-POST method.
- The entry must register **after** binding (it announces the port it actually
  bound). Registering before `listen(0)` completes is a race the suite will
  lose.

### 1.5 `/done` polling semantics

- `GET $MAKEFUN_ENV_URL/done`. Answered **at once, never held open**
  (`DONE_ANSWER_DEADLINE_MS` = 1 000 ms): `{"done":false}` while the suite
  runs, `{"done":true}` once the export is written.
- Non-GET method → `405 {"ok":false,"error":"method_not_allowed"}`.
- The entry **polls**; it must never hold a `/done` request open (long-polling
  is not the protocol). Starter timing: per-request timeout 30 000 ms,
  retry delay exponential from 250 ms, capped at 2 000 ms
  (`min(2000, 250 * 2^min(attempt,8))`). A failed/slow poll is retried; the
  process never exits before `{"done":true}`.
- **If the forge exits early** (crash or `process.exit` before done): the env
  does not notice specially — it keeps running the suite against a dead base
  URL, checks fail on connection errors, the benchmark fails, the export is
  still written, `/done` still flips true, and the harness SIGTERMs the env.
  The trial scores whatever the checks earned before the crash (usually 0
  for everything after it). There is no restart and no second register
  opportunity that helps: a second register gets 409, and the first base URL
  stays.
- After `{"done":true}` the entry closes its server and exits **0**
  (`ENTRY_EXIT_OK`). The harness then stops the env.

### 1.6 What the entry must never do

- Never bind port 8080 (the env owns it in a container); always `listen(0)`.
- Never exit before `/done` is true — even on register 409, even on poll
  errors. The starter loops forever on both.
- Never assume `MAKEFUN_ENV_URL` exists: without it the starter exits 1 at
  once (`[entry] MAKEFUN_ENV_URL is not set`).
- Never depend on wall-clock time, `Math.random()`, or unseeded UUIDs for
  anything a check can observe (§4.4).

---

## 2. Running the suite locally on this VM (no Docker)

### 2.1 What works and what does not

| Route | Status on this VM |
|---|---|
| `node program/env/server.mjs` directly | **Works — verified.** It is a self-contained ES module; no build step, no deps. |
| `node cli/makefun.mjs grade-local --driver process` | Exists; process driver runs env + forwarder + entry on this machine, unisolated, on loopback ports. **Not end-to-end verified here** (needs a bot repo; would run a full live+replay trial). |
| `node cli/makefun.mjs grade-local --driver docker` (default) | **Does not work here — no Docker** (`docker: command not found`). Do not use. |
| `node --experimental-strip-types sdk/run.ts` (practice runner) | Works; runs the same checks against a server you started yourself. No register/done lifecycle, no export files, no replay. |
| `node program/scorer/score.mjs` | **Works — verified** against a real export dir. |

Notes on the CLI: `node cli/makefun.mjs grade-local --help` does **not**
print grade-local help — it prints the whole CLI help (the command has no
per-subcommand help). The grade-local usage is inside that output:
`grade-local --kit <dir> --bot <path> [--driver docker|process] [--commit <sha>] [--worktree] [--bundle …] [--house] [--baseline] [--expect <result_sha256>] [--save <dir>] [--instances <n>] [--gateway <url>] [--replay <cassette>] [--json] [--trials <n>] [--check] [--stress [<m>]] [--stress-jobs <n>] [--window <key>] [--env-file <path|->]`.
`--driver docker` is the default; `--driver process` is the only usable one
here. Under `--driver process` the env, forwarder and entry run on this
machine **unisolated, on loopback ports, with no trial network and no
CPU/memory limits enforced** (the help calls it "advisory"). It runs the
trial live, then the replay check a final trial meets, and keeps each trial
(`cassette.json`, `bodies/`, `state/`) under `--save`, else
`~/.makefun/trials/<competition>/<run id>/`. `--replay <cassette>` runs a kept
trial's replay check alone, at no cost. No provider key is needed for this
competition (`model_calls: optional`; the entry makes no model calls), and
`--expect` is refused for agent/v1 kits (a model answers anew each time, so
no `result_sha256` is stable — the replay check is the determinism proof).

The env needs **no Docker networking aliases** locally: under the process
driver it binds loopback, and the entry reaches it through
`MAKEFUN_ENV_URL=http://127.0.0.1:<port>` read from the env's `ready` file.
There is no `store` hostname outside a container.

### 2.2 Env vars of `program/env/server.mjs`

| Variable | Default | Meaning |
|---|---|---|
| `MAKEFUN_STATE_DIR` | `/state` (container) | State directory. **Must be set locally** — `/state` does not exist on this VM. The env `mkdir -p`s it. |
| `MAKEFUN_ENV_HOST` | `127.0.0.1` if `MAKEFUN_STATE_DIR` is set (process driver), else `0.0.0.0` | Host the env binds. |
| `MAKEFUN_ENV_PORT` | `8080` | Port the env binds; `0` picks a free port. **Use `0` locally** (avoids clashes; the ready file reports the real port). |
| `MAKEFUN_SHOP_TOKEN` | `''` (empty) | Bearer token every API call to the entry must carry. Empty means clients send no `Authorization` header. **Set a non-empty value locally and give the same value to the entry.** In a trial the harness derives a per-trial token. |
| `MAKEFUN_TRIAL_WALL_BUDGET_SEC` | `900` | Overrides the trial wall budget (seconds) for a local run; internal deadline = budget − 90 s. Useful for smoke runs (e.g. `300` → 210 s internal deadline). Phase budgets (240 s each) still cap phases. |

### 2.3 State-dir layout the env writes

```
<stateDir>/
  ready          {"schema":"github-core-clone-01/ready/v1","host":"127.0.0.1","port":<N>}
  calls.ndjson   empty (0 bytes)
  export/
    state.json   run-invariant bits (see §4.1)
    perf.json    timings (see §4.2)
```

### 2.4 Recipe A — full-fidelity local grade (recommended)

Runs the real sealed env end-to-end: register, boot probe, 120 checks,
benchmark, export, scorer. This is the closest thing to the trial available
without Docker.

```sh
KIT=~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit
ENTRY_DIR=~/workspace/makefun/github-core-clone-01   # your entry repo (has main.ts)
STATE=/tmp/gc1-state                                  # FRESH dir per run (§4.3)
TOKEN=local-test-token-please-change                  # any non-empty string
rm -rf "$STATE" && mkdir -p "$STATE"

# 1. Start the env (background). It logs "[env] listening on 127.0.0.1:<port>".
MAKEFUN_STATE_DIR="$STATE" MAKEFUN_ENV_PORT=0 MAKEFUN_SHOP_TOKEN="$TOKEN" \
  node "$KIT/program/env/server.mjs" > /tmp/gc1-env.log 2>&1 &
ENV_PID=$!

# 2. Read the port the env actually bound.
ENV_PORT=$(node -e "console.log(require('$STATE/ready').port)")
#    (or: grep -o 'listening on 127.0.0.1:[0-9]*' /tmp/gc1-env.log)

# 3. Start the entry (foreground or background). Same token.
cd "$ENTRY_DIR"
MAKEFUN_ENV_URL="http://127.0.0.1:$ENV_PORT" MAKEFUN_SHOP_TOKEN="$TOKEN" \
  node --experimental-strip-types main.ts > /tmp/gc1-entry.log 2>&1 &
ENTRY_PID=$!

# 4. Wait for the entry to exit 0 (it exits when /done is true).
#    Full run: conformance ≤240 s + benchmark ≤240 s (+ boot). Budget ~10 min.
wait $ENTRY_PID; echo "entry exit: $?"

# 5. Stop the env (writes/keeps the export, exits 0), then score.
kill -TERM $ENV_PID; wait $ENV_PID; echo "env exit: $?"
MAKEFUN_EXPORT_DIR="$STATE/export" MAKEFUN_SCORES_DIR=/tmp/gc1-scores \
  node "$KIT/program/scorer/score.mjs"
cat /tmp/gc1-scores/scores.json
```

What to watch in `/tmp/gc1-env.log`: `[env] listening…`, `internal deadline
in 810000 ms`, `boot: the entry registered at …`, `boot: /healthz answered
2/2 times…`, one line per check (`<id> pass|fail — <detail>`), `[bench]
<workload> round N/3: … ms`, `export: state.json (P/120 passed, working W)
and perf.json (X points) written`. If the entry never registers you will see
`boot: no register inside 20000 ms` and a 0-score export.

**Verified on this VM:** steps 1–2 + SIGTERM with no entry produced the
ready file, the empty `calls.ndjson`, and on SIGTERM a boot-failure export
(all 120 checks 0, `working` 0, perf sentinel `1e9`); the scorer then printed
`[scorer] score 0/1000: feature 0 + agent 0 + perf 0; perf_p50_us 1000000000,
working 0`. A full run with a real entry was not executed here.

Caveats for local numbers: this VM is **not** the production sandbox
(1.5 shared CPUs here vs 2 dedicated there; different load). Local perf
points are indicative only — the reference `T_ref`s were measured on the
production cluster (§3.4). Conformance bits, however, are directly meaningful.

### 2.5 Recipe B — fast practice loop with `sdk/run.ts`

Same checks and benchmark, no lifecycle: you start the entry yourself on a
fixed port and point the runner at it. Good for iterating on check failures;
it does **not** test register/done/boot, writes **no** `state.json`/`perf.json`,
enforces no wall budget, and does not do a replay.

```sh
KIT=~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit
TOKEN=local-test-token-please-change
# Start the entry on a port you choose (e.g. 18080) WITHOUT MAKEFUN_ENV_URL
# (or with it unset — sdk/run.ts does not use register/done; the starter
# exits 1 without MAKEFUN_ENV_URL, so for this recipe run app.ts directly
# or set a dummy MAKEFUN_ENV_URL and ignore the register loop).
cd ~/workspace/makefun/github-core-clone-01
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 \
  --token "$TOKEN" [--perf] [--json] [--timeout-ms 15000]
```

Details: `--url` and `--token` are required; `--perf` also runs the four
benchmark workloads (default 3 rounds / 5 warm-ups, 240 s phase budget);
`--json` prints one JSON object instead of the table; `--timeout-ms N` is the
per-check cap, clamped to 5 000–15 000 ms (default 15 000). It probes
`GET /healthz` **once** (5 s timeout) instead of the env's twice; exit **0**
when healthz answered (whatever the checks said), **1** when it did not or on
a usage error. A failing check is reported in the table, never by exit status.
The runner's `working` is `passed > 0 ? 1 : 0` (it does not apply the env's
boot rule). Note the starter's `main.ts` exits 1 without `MAKEFUN_ENV_URL`,
so for recipe B either start the server via a tiny driver that calls
`createApp()` + `listen(port)` directly, or point `MAKEFUN_ENV_URL` at a
dummy origin and let the register loop retry in the background (it never
succeeds, but the server still serves checks — ugly; prefer the direct driver).

### 2.6 Recipe C — `grade-local --driver process` (whole-trial check)

```sh
KIT=~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit
node "$KIT/cli/makefun.mjs" grade-local --kit "$KIT" --bot <entry-repo-path> \
  --driver process [--instances 1] [--save /tmp/gc1-grade]
```

`--instances <n>` runs practice trials 0..n−1 (default 1, i.e. `practice/trial-0/`).
Runs live, then the replay check; prints score, columns, spend and replay
verdict. No provider key needed (no model calls). Expect it to be slower and
less transparent than Recipe A (trial scaffolding, cassette, forwarder), and
its "advisory" process-driver run enforces no resource limits — a pass here
does not prove the entry fits 2 CPU / 1024 MB. Prefer Recipe A for grading
fidelity and Recipe B for iteration.

---

## 3. Benchmark workloads (full detail)

Common rules (`bench.ts`, `manifest.ts`):

- Four workloads, run **in this order**: `push`, `clone`, `read`, `write`.
- Each workload: **5 untimed warm-up operations** (`BENCH_WARMUP_OPS`), then
  **3 timed rounds** (`BENCH_ROUNDS`); the workload's time is the **median
  round** (nearest-rank percentile: with 3 rounds, the middle value).
  `p99_ms` is the largest round (nearest-rank 99th percentile of 3).
- Timing: wall time of one round on the monotonic clock
  (`performance.now()`), rounded to 0.001 ms. Payloads are built **before**
  the first timing starts; no object hashing or deflating is ever timed.
- All data derives from the seeded scenario (`wire.ts buildScenario()` +
  `scenarioRng('bench.*')`); no `Math.random`, no `Date.now`. Bench commit
  timestamps use fixed epoch `BENCH_EPOCH_SEC` = **1 700 000 000** + index.
- Owner for every bench repo is the scenario viewer's login
  (`scenario.viewer.login`). Repos are named `bench-push`, `bench-clone`,
  `bench-read`, `bench-write`.
- **Setup happens inside the workload's budget but outside every timed
  round.** Each workload first deletes its repo if it exists (a 404 on DELETE
  is the normal fresh case and is not scored), then creates it via
  `GitClient.createRepo` (which accepts the 422 "already exists"), so a
  re-run in the same entry process starts clean. **A workload whose setup
  fails earns 0 points.**
- **Budget per workload: 60 000 ms** (`budgetMs`), capped by the remaining
  benchmark phase budget (240 000 ms total from the first workload) and the
  env's internal deadline. A timer aborts in-flight requests at the deadline;
  every operation is checked against the clock before it starts.
  A workload that throws, or does not complete **all** its rounds inside its
  budget, earns **0 points and stops early**. Rounds that completed before
  the failure are **still recorded** in `rounds`, but `p50_ms`/`p99_ms`
  become the sentinel `FAILED_P50_MS` = **1 000 000 000** and `points` 0.
  A workload the phase never reached is recorded the same way.
- A workload that never got time / a trial with no benchmark at all writes
  `failedPerfFile`: all four workloads as sentinels with `error`, 0 points,
  `perf_p50_us` = **1 000 000 000** (never `emptyPerfFile`'s 0 — a 0 would
  sort first on the tie-break).

### 3.1 push — 200 sequential pushes of a 1 KiB change

- `ops` = **200** per round. Repo `bench-push`, branch `refs/heads/main`,
  file `bench-data.txt`.
- Payloads pre-built for all `5 + 3×200 = 605` operations before timing.
  Each step creates one commit whose tree holds `bench-data.txt` with a fresh
  **1 024-byte** seeded blob (`PUSH_CHANGE_BYTES`); the first creates the
  branch (`oldOid` = `ZERO_OID`), every later one updates it from the
  previous commit. The pack carries only the three objects the server does
  not have (blob, tree, commit).
- One operation = one receive-pack exchange (advertisement + command list +
  pack) creating a new commit on `refs/heads/main`. Sequential.
- Success requires a `report-status`: non-null report, `unpackOk` true, and
  the ref's line `ok`. A refused update (or missing report) **fails the
  workload** — the entry did not do the work, so its wall time means nothing.

### 3.2 clone — 50 concurrent shallow clones of a 200-commit repo

- `ops` = **50** per round. Repo `bench-clone`, branch `refs/heads/main`,
  file `history.txt`.
- Setup (once, untimed): build a **200-commit** history
  (`CLONE_HISTORY_COMMITS` = 200), each commit replacing `history.txt` with
  a fresh **512-byte** blob, and push it in one pack (600 objects).
- One operation = one depth-1 clone (`depth: 1`, `singleBranch: true`,
  `parse: false` — the pack's checksum is verified but objects are **not**
  parsed; object parsing is the conformance checks' work, not the benchmark's).
- A round launches all 50 clones **concurrently** (`Promise.all` over 50
  `cloneOnce()` calls) and times until the last finishes. Each clone must
  return `checksumOk === true`, `packBytes > 0`, and at least one ref, or the
  workload fails.
- 5 sequential warm-up clones precede the rounds.

### 3.3 read — 2 000 sequential GETs on one keep-alive connection

- `ops` = **2 000** per round. Repo `bench-read`.
- Setup: create one issue through REST (`POST /api/v3/repos/{owner}/{repo}/issues`,
  must answer **201**) from `scenario.issues[0]` (title suffixed
  `" (bench setup)"`), read its numeric `number` from the response body.
- One operation = `GET /api/v3/repos/{owner}/{repo}/issues/{n}` for that
  single issue, sequential, on **one warm keep-alive connection** (the same
  `RestClient`, whose undici pool reuses the socket). Must answer **200**
  with a JSON object body, or the workload fails.
- 5 warm-up reads precede the rounds.

### 3.4 write — 200 sequential issue creations

- `ops` = **200** per round. Repo `bench-write`.
- Payloads pre-built for all 605 operations: titles cycle through
  `scenario.issues` as `"<template title> [bench <N>]"`, bodies from the
  template. `POST /api/v3/repos/{owner}/{repo}/issues`, sequential.
- One operation must answer **201** (GitHub's create-issue status), or the
  workload fails.

### 3.5 Scoring formula and T_ref

Per workload, with `t` = median round (ms) and `T_ref` the reference median:

```
points = round(clamp(25 - 12.5 * log2(t / T_ref), 0, 50))
```

| Workload | T_ref (ms) | Notes |
|---|---|---|
| push | **1640.82** | median of 3 runs' p50s: 1914.548 / 1640.82 / 1415.785 |
| clone | **266.941** | 266.941 / 313.634 / 259.436 |
| read | **2759.715** | 2874.092 / 2759.715 / 2428.118 |
| write | **348.965** | 448.01 / 348.965 / 289.433 |

Source: `program/env/src/calibration.json` (`workloads.<name>.p50_ms`,
measured 2026-11-14 on the production cluster dsh-makefun, 3 dev grades of
the reference forge; `manifest.ts` reads them into `T_REF_MS` at build time
and the build inlines them into `env/server.mjs` — verified present in the
bundled file). At `t = T_ref` a workload earns exactly 25 points, so the
reference earns 100/200. Doubling `t` costs 12.5 points; `t ≥ 4×T_ref` → 0;
`t ≤ T_ref/4` → 50. A missing/zero/non-finite `t`, or an uncalibrated
`T_ref` (0), earns 0 (the workload still runs and its times are kept, but
`calibrated: false` and the error line reads `"uncalibrated: T_ref is 0, so
the workload earns 0 points until calibration fills it"`).

`perf` column = sum of the four workloads' points (0–200), each rounded
individually before summing. Tiers: `tier = floor(points / 12.5)`, clamped
0–4 (in `perf.json`'s `tiers`; `state.json`'s `perfTiers` is statically all 0,
§4.3).

**Tie-break `perf_p50_us`**: `round(1000 × geometric mean of the p50_ms of
the workloads that DID measure)` — failed/sentinel workloads are excluded
from the mean, never entered as 1e9 ms. If no workload measured:
`perf_p50_us` = 1 000 000 000. Each time is floored at 0.001 ms in the
geometric-mean computation so a 0 ms round cannot make the mean 0. Lower
`perf_p50_us` ranks first among equal scores, then earlier receipt.
Calibration spread note: the three reference runs' `perf_p50_us` were
712 790 / 839 040 / 900 674 µs (26.36% spread) — perf is noisy run to run;
do not over-tune to a single local measurement.

### 3.6 What "cannot finish in its budget scores 0" means numerically

- Per-workload budget is 60 s **including setup, warm-ups and all 3 rounds**.
  If the timer fires mid-round, the workload stops: completed rounds stay in
  `rounds`, `p50_ms`/`p99_ms` = 1e9, `points` = 0, `error` =
  `"deadline: the workload did not finish inside its 60000 ms budget"`.
- The benchmark phase budget is 240 s from the first workload's start; a
  workload that starts with no phase time left is recorded as failed with
  `"the benchmark phase deadline fell before the workload ran"`.
- Conformance overrunning into the deadline likewise zeroes the remaining
  benchmark: `runBenchmarkPhase` returns `failedPerfFile` if the trial abort
  fired or the deadline fell before the benchmark ran.

---

## 4. Export / determinism

### 4.1 `export/state.json` — exact contents

Canonical JSON (keys sorted at every depth, one trailing newline), version 1:

```json
{
  "version": 1,
  "working": 0,
  "checks": { "<group>.<slug>": 0, "...": 1 },
  "counts": {
    "total": 120, "passed": 0,
    "byGroup": {
      "git":      { "total": 30, "passed": 0 },
      "repos":    { "total": 15, "passed": 0 },
      "issues":   { "total": 15, "passed": 0 },
      "pulls":    { "total": 20, "passed": 0 },
      "graphql":  { "total": 20, "passed": 0 },
      "mcp":      { "total": 15, "passed": 0 },
      "protocol": { "total": 5,  "passed": 0 }
    }
  },
  "perfTiers": { "push": 0, "clone": 0, "read": 0, "write": 0 },
  "notes": ["no entry registered before the boot deadline"]
}
```

- `checks`: one 0|1 bit per check id; a check that did not run (deadline,
  crash, suite short of the manifest) is 0. Missing ids are padded as
  `<group>.missing-<n>` with bit 0 (export.ts `exportCheckIds`), so
  `counts.total` is **always 120** and the denominator can never shrink.
- `counts` is derived from the bits; `passed` is the count of 1-bits.
- `working`: 1 only when boot succeeded (`bootOk`: registered + healthz
  answered twice) **and** at least one check passed.
- `perfTiers`: **statically all 0** (`STATIC_PERF_TIERS`). This is the settled
  ruling: no timing-derived value may enter `state.json`, so the measured
  bands live in `perf.json` alone and two runs of one entry on one seed write
  byte-identical `state.json`. (`manifest.ts perfTiersOf()` still exists but
  is called by `bench.ts` for `perf.json`, never by the export.)
- `notes`: fixed cause strings only, never a timing. Present only when
  non-empty (boot failure: `["no entry registered before the boot deadline"]`).
- No times, no ports, no random ids anywhere in `state.json`.

### 4.2 `export/perf.json` — exact contents

```json
{
  "version": 1,
  "calibrated": true,
  "workloads": [
    { "name": "push", "rounds": [1234.5, 1300.1, 1250.0],
      "p50_ms": 1250.0, "p99_ms": 1300.1, "ops": 200, "points": 28 },
    { "...": "...", "error": "<why it earned 0, when it did>" }
  ],
  "tiers":  { "push": 2, "clone": 2, "read": 2, "write": 2 },
  "points": { "push": 28, "clone": 28, "read": 28, "write": 28 },
  "perf_p50_us": 839040,
  "points_total": 112,
  "notes": ["<fixed lines: uncalibrated T_ref names, per-workload failures>"]
}
```

- `rounds`: each completed round's wall ms, in order (rounds completed
  before a failure are kept).
- `p50_ms`/`p99_ms`: median / largest round, or **1 000 000 000** when the
  workload failed or was cut short. `points` is always recomputed from
  `p50_ms` and `T_ref` when the file is assembled.
- `perf_p50_us` / `points_total` as §3.5. `calibrated` is true only when every
  `T_ref > 0`.
- A boot failure writes all four workloads as sentinels with
  `error: "no entry registered before the boot deadline"`, `points_total` 0,
  `perf_p50_us` 1 000 000 000, plus the note
  `"no workload measured: perf_p50_us is the sentinel 1000000000"`.

### 4.3 Write discipline (never-worse rule)

- Writes are synchronous and atomic: temp file beside the target, written
  and `fsync`ed, then renamed over it.
- `writeExportPair` writes `state.json` first, then `perf.json`.
- **A worse export never replaces a better one in the same state directory.**
  State: a new file is written only if `working` is higher, or `working`
  equal and `passed` is ≥ the file on disk. Perf: only if
  `points_total` is ≥ the file on disk. An equal export is rewritten (bytes
  are identical). Consequence: **always use a fresh state directory per run**
  — reusing one can silently keep an older, better export and make a
  regression invisible (and a later boot failure cannot overwrite a completed
  run's export).
- A SIGTERM at any point still writes an export, so a trial that dies
  mid-suite leaves a scorable one rather than none.

### 4.4 Determinism and replay

- **The replay rule:** final trials run live, then again as a replay, and the
  two `state.json` files must compare **byte for byte**. A trial whose replay
  does not match is nondeterministic: listed, never ranked. (Dev trials run
  live once; `grade-local` runs the replay check for you.)
- Why `state.json` can be byte-identical: it holds only pass/fail bits, and
  every input to the checks is seeded. The scenario is built once from the
  single constant `SCENARIO_SEED` = `0x6a09e667f3bcc909`
  (hex `6a09e667f3bcc909`) via FNV-1a + splitmix64 + xorshift64* streams
  (`scenarioRng(label)`); live, replay and local practice runs all see
  byte-identical data. Generated timestamps are `SCENARIO_EPOCH_SEC` =
  **1 735 689 600** (2025-01-01T00:00:00Z) plus seeded offsets; the GraphQL
  fixture commit uses the same epoch; bench commits use `BENCH_EPOCH_SEC` =
  1 700 000 000. Nothing in the env reads `Math.random` or the wall clock
  for data.
- **What the forge must never vary** (anything a check asserts on must be a
  deterministic function of the request sequence and the seeded data):
  - IDs and numbers: issue/PR numbers must be assigned deterministically
    (sequential per repository in creation order, starting at 1 — the bench
    read workload depends on the setup issue's number being readable back,
    and checks create then fetch by number).
  - Git SHAs are content-addressed: deterministic given identical object
    bytes — so any commit the forge itself builds (e.g. via the contents API
    or a merge) must use deterministic author/committer timestamps and
    messages, never the wall clock, or its SHA will differ between passes
    and any check comparing it will flip.
  - Orderings: list endpoints (repos, issues, pulls, refs, commits) must
    return a stable order for identical state (creation order or a fixed
    sort) — never hash-map / filesystem / arrival order that can change.
  - No timestamps, random tokens, or request counters in any response field
    a check reads back and compares (e.g. `created_at`/`updated_at` must be
    reproducible for the same logical event; `X-GitHub-Request-Id` must be
    present and non-empty but is not compared for equality — still, do not
    derive it from anything a check could observe changing).
  - Error bodies must be deterministic for the same request (same status,
    same JSON `message`).
  - The clone/push bench repos (`bench-*`) are recreated per workload, but
    conformance repos persist for the whole trial: the forge must not leak
    state between the live pass and the replay pass in any way other than
    through the seeded requests — in practice each pass is a fresh entry
    process, so in-memory state is fine; anything persisted to disk outside
    the trial would break replay.
- **What breaks a replay:** any check bit flipping between the two passes —
  typically wall-clock timestamps in created resources, random IDs, unstable
  list ordering, time-dependent rate limiting, or a forge that keeps state
  across passes. Perf timings do **not** break a replay: `perf.json` is not
  compared, only `state.json`.
- `perf.json` is intentionally *not* deterministic (it holds measured times)
  and is never part of the replay comparison.

---

## 5. Manifest / protocol constants

### 5.1 Check groups (120 checks)

| Group | Count | Proves |
|---|---|---|
| `git` | 30 | Git smart HTTP: clone, fetch, push, pack protocol |
| `repos` | 15 | REST v3 repository, branch, commit, contents APIs |
| `issues` | 15 | REST v3 issue, comment, label APIs |
| `pulls` | 20 | REST v3 pull request, files, merge APIs |
| `graphql` | 20 | GraphQL v4 documents `gh` and github-mcp-server send |
| `mcp` | 15 | MCP streamable-HTTP endpoint, tools, effect on REST view (also the agent column) |
| `protocol` | 5 | Status codes, JSON/error bodies, auth, pagination headers, method handling |

Check ids are `<group>.<slug>` (lowercase letters, digits, hyphens).
`validateCheckSpecs` requires exactly these counts, no duplicate ids, every
id's group matching its registration, non-empty titles. Note a discrepancy:
`main.ts`'s header comment says a count mismatch means "no check runs", but
the code actually logs the issues and **runs anyway**, padding missing ids to
0 in the export — the denominator stays 120 either way.

### 5.2 Per-check timeouts

Default `CHECK_TIMEOUT_MS` = 15 000 ms; a check may declare its own, clamped
to `CHECK_TIMEOUT_MIN_MS` 5 000 ms … `CHECK_TIMEOUT_MAX_MS` 15 000 ms, then
clamped again to the conformance phase's remainder. A timeout aborts the
check's signal and records 0 with detail `"deadline"`.

### 5.3 Wire / protocol constants (entry must respect)

| Constant | Value |
|---|---|
| REST v3 prefix | `/api/v3` |
| GraphQL endpoint | `/api/graphql` |
| MCP endpoint | `/mcp` |
| Health probe | `GET /healthz` → `200 {"ok":true}` |
| Auth scheme | `Bearer` (`Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`) |
| Env register / done | `POST /register`, `GET /done` |
| `MAX_REGISTER_BODY_BYTES` | 65 536 |
| Register port range | integer 1..65535 |
| Ready schema | `github-core-clone-01/ready/v1` |
| Export versions | `state.json` v1, `perf.json` v1 |
| `DONE_ANSWER_DEADLINE_MS` | 1 000 ms (env answers at once) |
| Entry poll interval / max | 250 ms → 2 000 ms exponential backoff |
| Entry request timeout | 30 000 ms per register/done request |
| `BOOT_FAILED_NOTE` | `"no entry registered before the boot deadline"` |

### 5.4 Seeded-scenario constants (what the checks' data is made of)

`SCENARIO_USERS` 12, `SCENARIO_VIEWER_REPOS` 30, `SCENARIO_ORG_REPOS` 6,
`SCENARIO_STRANGER_REPOS` 3, `SCENARIO_FILE_PATHS` 60, `SCENARIO_BLOBS` 24,
`SCENARIO_COMMITS` 60, `SCENARIO_ISSUES` 60, `SCENARIO_PULLS` 30,
`DEFAULT_BRANCH` `"main"`. User ids start at 1000, repo ids at 5000 (viewer),
6000 (org), 7000 (stranger). Issue labels:
`bug, enhancement, documentation, question, good first issue, help wanted`.

---

## 6. Scorer (brief)

`program/scorer/score.mjs` (built from `score.ts` / `columns.ts` /
`main.ts`; run on Node 22+). It reads `<exportDir>/state.json` and
`perf.json` and writes `<scoresDir>/scores.json`.

- Export dir: `MAKEFUN_EXPORT_DIR` or `MAKEFUN_OUTPUT_DIR`, else `/output`
  if it exists as a directory, else `/state/export`. Scores dir:
  `MAKEFUN_SCORES_DIR`, else `/scores`.
- `feature = round(600 * counts.passed / counts.total)` (0–600).
- `agent = round(200 * counts.byGroup.mcp.passed / counts.byGroup.mcp.total)`
  (0–200). Missing `byGroup`/`mcp` → agent 0 with a note (not a fault).
- `perf = perf.json`'s `points_total` (0–200), taken as-is (the env already
  computed it from the tier formula).
- `score = feature + agent + perf` (integer, 0–1000). `perf_p50_us` is copied
  through as the tie-break; `working` in the output is recomputed as
  `state.working && counts.passed > 0 ? 1 : 0`.
- Validation is strict and any fault zeroes **all** columns: `version` must
  be 1 in both files; every `checks` value must be 0|1; `counts.passed ≤
  counts.total ≤ number of check ids`; `counts.byGroup.mcp.passed ≤ total`;
  `points_total` integer 0–200; `perf_p50_us` integer 0–1 000 000 000.
  A missing file, bad JSON, or any of the above → all scores 0 with a note
  `scored 0 on every column: <reason>` on stderr. The process still exits 0
  and writes `scores.json` (exit 1 only on an unexpected scorer crash).
- Output line (stdout): `[scorer] score S/1000: feature F + agent A + perf P;
  perf_p50_us U, working W`. `scores.json` is one line:
  `{"score":…,"feature":…,"agent":…,"perf":…,"perf_p50_us":…,"working":…}`.
- Note the scorer's `share()` clamps `passed` into `0..total` and returns 0
  for `total ≤ 0`; `manifest.ts`'s `scoreOf` is the same arithmetic (used by
  `sdk/run.ts` for its printed columns).

---

## 7. Starter lifecycle (what to preserve)

### 7.1 `starter/main.ts` — keep verbatim in spirit

The lifecycle is the harness's, not the contest's. Do not redesign it:

1. `MAKEFUN_ENV_URL` (trailing slashes stripped) is required; unset/empty →
   stderr `[entry] MAKEFUN_ENV_URL is not set…` and exit **1** at once.
2. `createApp()` from `app.ts`, `server.listen(0)` — kernel picks the port.
   **Never bind 8080.** If the address is not a TCP port, throw → exit 1.
3. `register(port)`: `POST $MAKEFUN_ENV_URL/register {"port":N}`,
   `content-type: application/json`, 30 s request timeout, retry forever with
   exponential backoff 250 ms → 2 000 ms cap. **200 or 409 both return
   success** (409 = another entry registered first; keep waiting). **400 or
   405 are fatal** (throw → exit 1). Network errors and any other status are
   retried indefinitely.
4. `waitForDone()`: `GET $MAKEFUN_ENV_URL/done`, 30 s timeout, same
   backoff; return only when the body parses as JSON with `done === true`.
   Non-OK status, bad JSON, timeouts and transport errors are all retried.
   **Never return early.**
5. On done: `server.close()`, print `[entry] done`, exit **0**.
   Any throw in `main()` → stderr `[entry] <message>`, exit **1**.
6. `main.ts` imports only `./app.ts` — no package, no Node built-in, no model
   call. The entry point is `node --experimental-strip-types main.ts`
   (`starter/package.json`: `"type": "module"`, `engines.node >= 22.18`,
   script `"start": "node --experimental-strip-types main.ts"`).

### 7.2 `starter/app.ts` — the skeleton to grow

`createApp()` returns an `http.Server` that binds nothing until the caller
listens. Current surface (the contest surface is what the implementer adds):

- `GET /healthz` → `200 {"ok":true}` (`application/json; charset=utf-8`).
  The env calls this twice at boot; both must be 200.
- `GET /api/v3` or `/api/v3/` → `200 {"current_user_url":"/api/v3/user",
  "rate_limit_url":"/api/v3/rate_limit"}` with header
  `x-oauth-scopes: repo, read:org`.
- Everything else, every method → `404 {"message":"Not Found"}` (GitHub's
  404 body, JSON, never HTML).

Implementation notes carried over from the starter: one JSON helper
(`sendJson`) that always sets `content-type` and `content-length` and appends
a trailing newline; path parsing via `new URL(req.url, 'http://entry')`
falling back to `'/'` on parse failure, never throwing from a request.

---

## Appendix A — check ids (from a boot-failure export)

Group counts verified against a real export: git 30, graphql 20, issues 15,
mcp 15, protocol 5, pulls 20, repos 15 (120 total). The full id list is in
`<stateDir>/export/state.json` after any run; the per-group modules are
`env/src/checks-git.ts`, `checks-rest.ts` (`restChecks` + `restProtocolChecks`),
`checks-graphql.ts`, `checks-mcp.ts`.

## Appendix B — open points / ambiguities

1. **`grade-local --driver process` was not run end-to-end here.** The flags
   and behaviour above come from the CLI's help text and the `process`-driver
   code paths in `cli/makefun.mjs`; a full local grade-local run (live +
   replay, cassette, trial scaffolding) still needs one execution against a
   real entry to confirm it works on this VM and what its output looks like.
2. **`main.ts` header vs code on manifest mismatch** (§5.1): header says a
   count-mismatched suite "refuses" to run; the code logs and runs anyway
   with padded 0 ids. The code governs; flagged so the implementer does not
   rely on the comment.
3. **Which response fields the conformance checks compare exactly** (e.g.
   whether any check asserts on a timestamp string) was not established —
   the check modules (`checks-*.ts`) were out of scope for this spec. §4.4
   therefore states the safe rule (deterministic function of the request
   sequence) rather than a per-field list; the conformance spec should pin
   down any field the checks compare.
4. **Local perf numbers are not production numbers** (§2.4): the `T_ref`s
   were measured on the production cluster; this VM's timings will differ,
   so local perf points rank entries only roughly.
