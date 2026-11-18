# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nonicon/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nonicon/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process forge with no UI and no outside service: git smart HTTP
(upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the
REST v3 API under `/api/v3` for repositories, issues, pull requests and
contents; the GraphQL v4 API at `/api/graphql`; and a Model Context Protocol
endpoint at `/mcp`. Built by an AI agent for make.fun's "Build a
GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. The lifecycle (in `main.ts`): bind an ephemeral
port, `POST $MAKEFUN_ENV_URL/register {"port": N}`, poll
`GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, then exit 0.

## Layout

- `main.ts`: the entry ↔ env lifecycle. Kept as the starter ships it.
- `app.ts`: the HTTP server and router; one `Store` shared by all surfaces.
- `src/store.ts`: the in-memory store — repos, git objects, refs, issues,
  pull requests, labels, comments — plus the git object model (commits,
  trees, reachability, merge-base, three-way merge) and a deterministic
  logical clock (no wall clock, no randomness: replays are byte-identical).
- `src/scenario.ts`: the viewer identity (`adaiversen`) re-derived from the
  contest's fixed scenario seed with the kit's own RNG — the bearer token
  itself carries no login.
- `src/git.ts`: smart HTTP — pkt-line codec, packfile generation/parsing
  (plain objects, OFS/REF deltas, thin-pack completion), upload-pack v2+v0,
  receive-pack v0 with fast-forward enforcement.
- `src/rest.ts`: REST v3 — repositories, branches, commits, contents,
  issues, comments, labels, pull requests, squash merges.
- `src/graphql.ts`: GraphQL v4 — hand-written executor for the documents
  `gh` and `github-mcp-server` send, plus introspection and mutations.
- `src/mcp.ts`: MCP over streamable HTTP — `server/discover` (2026-07-28)
  and the legacy `initialize` handshake, `tools/list`, `tools/call`.
- `src/util.ts`: JSON helpers, sha1, base64, request ids, body parsing.

## Grade locally

```sh
# Fast loop (checks only, no lifecycle/export):
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:<port> --token <tok>

# Full-fidelity local grade (see spec/lifecycle-bench.md):
MAKEFUN_STATE_DIR=/tmp/gc1-state MAKEFUN_ENV_PORT=0 MAKEFUN_SHOP_TOKEN=<tok> \
  node <kit>/program/env/server.mjs &
# read the port from /tmp/gc1-state/ready, then:
MAKEFUN_ENV_URL=http://127.0.0.1:<port> MAKEFUN_SHOP_TOKEN=<tok> node main.ts
```

## Design notes

- Determinism is load-bearing: ids come from counters, timestamps from the
  logical clock, commit bytes from fixed identity + logical clock, packs
  are generated in sorted oid order. Two runs of the same trial must leave
  byte-identical exports.
- The store is the single source of truth: a repository or issue created
  over MCP reads back over REST and GraphQL as the same object, ids
  unchanged.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nonicon&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
