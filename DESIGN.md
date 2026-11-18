# github-core-clone-01 — implementation design

Stack: **Node 22 TypeScript, stdlib only** (starter layout, `node /bot/main.ts`
type-strips). Work dir: `~/workspace/makefun/github-core-clone-01/`.
Specs: `spec/git.md`, `spec/rest.md`, `spec/graphql-mcp.md`,
`spec/lifecycle-bench.md` — read the one for your module in full before coding.

## Files

| File | Owner | Contents |
|---|---|---|
| `main.ts` | starter, keep as-is | lifecycle: listen(0) → POST /register → poll /done → exit 0 |
| `app.ts` | integrator | HTTP server + routing + auth gate + body parsing; calls module handlers |
| `src/scenario.ts` | DONE (vendored) | deterministic viewer identity from the fixed scenario seed |
| `src/util.ts` | DONE | `sendJson`, `sendError`, `readBody`, `sha1`, base64, logical clock |
| `src/store.ts` | DONE | in-memory store: repos, git objects, refs, issues, PRs, labels, comments |
| `src/git.ts` | AGENT-GIT | smart HTTP: pkt-line, pack read/write, upload-pack v2+v0, receive-pack v0 |
| `src/rest.ts` | AGENT-REST | REST v3 under `/api/v3` |
| `src/graphql.ts` | AGENT-GQL | GraphQL v4 at `/api/graphql` (18 documents verbatim in spec) |
| `src/mcp.ts` | AGENT-GQL | MCP at `/mcp` (JSON-RPC 2.0 streamable HTTP) |
| `package.json`, `tsconfig.json`, `LICENSE`, `README.md` | starter | copy from kit `starter/`, adapt README |

## Ground truths (verified against the kit)

- Viewer (token owner): login `adaiversen`, name `ada iversen`,
  email `adaiversen@example.invalid`, id `1000`. Stranger login `olgabauer`.
  Org `faint-meadow-org`. These come from the fixed scenario seed
  (`SCENARIO_SEED = 0x6a09e667f3bcc909n`); `src/scenario.ts` re-derives them
  from the seed with the kit's own RNG (never hardcode a different value).
  Forge-created commits use author/committer
  `ada iversen <adaiversen@example.invalid>`.
- Default branch is `main`. Repo ids / issue ids / numbers are assigned by
  deterministic counters in the store (creation order) — never wall clock,
  never `Math.random`, never UUIDs. All timestamps come from the logical
  clock in `util.ts` (base `MAKEFUN_TRIAL_NOW` if set, else competition
  opening `2026-11-14T06:30:00Z`; +1s per issuance).
- Auth: `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; missing or wrong token
  → 401 JSON `{"message": ...}` (except `/healthz`, which takes none).
  A repo under another owner → 404, never 403. If `MAKEFUN_SHOP_TOKEN` is
  unset (local dev only), accept any non-empty Bearer token, still 401 when
  absent.
- Every REST reply: `application/json`, non-empty `X-GitHub-Request-Id`
  header (deterministic `req-<n>` counter), never HTML. Unknown route →
  404 `{"message":"Not Found"}`. Malformed JSON body → 400.
- X-GitHub-Request-Id: issued by `app.ts` for every REST reply (counter in
  `util.ts`).

## Module handler contract

`app.ts` parses the request (method, pathname, query, headers, raw body
Buffer) and builds a `Ctx`, then dispatches in this order:
1. `GET /healthz` → 200 `{"ok":true}` (no auth).
2. Path matches `/<owner>/<repo>.git/...` → `git.handleGit(ctx)`.
3. Path starts `/api/v3` → `rest.handleRest(ctx)`.
4. Path is `/api/graphql` (POST) → `graphql.handleGraphql(ctx)`.
5. Path is `/mcp` (POST) → `mcp.handleMcp(ctx)`.
6. Else → 404 JSON.

```ts
export interface Ctx {
  store: Store;
  method: string;
  path: string;            // pathname, decoded, no trailing-slash normalization except exact matches
  query: URLSearchParams;
  headers: Record<string, string>; // lower-cased names
  body: Buffer;            // raw request body (may be empty)
  token: string | null;    // Bearer token or null
}
export type Handler = (ctx: Ctx, res: ServerResponse) => Promise<boolean>; // true = handled
```

Each module handler returns `true` when it answered the request (including
error answers), `false` when the route is not its own (app.ts then 404s).
Handlers use `sendJson`/`sendError` from `util.ts` and never write headers
twice. JSON bodies are parsed inside the handler (`parseJsonBody` from
`util.ts` → 400 on malformed JSON, only for endpoints that expect JSON).

## Store API (src/store.ts) — the shared contract

```ts
store.viewer: User; store.strangerLogin: string; store.org: string;
store.createRepo(owner, name, description, isPrivate): Repo | null; // null = duplicate name
store.getRepo(owner, name): Repo | undefined;
store.listRepos(owner): Repo[];           // creation order
store.deleteRepo(owner, name): boolean;
store.getRepoByGlobalId(id): Repo | undefined;
store.hashObject(type, data: Buffer): string;      // git sha1
store.putObject(type, data: Buffer): string;       // store + return oid
store.putObjectKnown(type, data: Buffer, oid: string): void; // store with a precomputed oid (pack ingest: skips the re-hash)
store.getObject(oid): GitObject | undefined;       // {type, data}
store.getRef(repo, refname): string | undefined;   // full refname e.g. refs/heads/main
store.setRef(repo, refname, oid): void;
store.deleteRef(repo, refname): boolean;
store.listRefs(repo): Array<{name, oid}>;
store.parseCommit(data: Buffer): {tree, parents, author, committer, message, raw};
store.makeCommit(repo, tree, parents, message): string; // author/committer = viewer, ts = logical clock
store.parseTree(data: Buffer): Array<{mode, name, oid}>;
store.buildTree(entries): string;                    // entries sorted git-order, stored, returns oid
store.readTreeRecursive(treeOid, prefix=''): Map<string, {mode, oid}>; // path -> entry
store.treeFromFileMap(files: Map<string, {mode, oid}>): string;        // builds nested trees
store.fileMapAt(refOrOid, repo): Map<string, {mode, oid}>;             // tree of a ref tip / commit
store.collectReachable(oids: string[]): Set<string>;
store.isAncestor(anc, desc): boolean;
store.mergeBase(a, b): string | null;
store.diffFileMaps(base, head): Array<{path, status: 'added'|'modified'|'removed', additions, deletions}>;
store.threeWayMerge(base, ours, theirs): {files: Map<string,{mode,oid}>, conflicts: string[]};
store.globalId(kind: 'repo'|'issue'|'pull', ...parts): string;  // opaque, stable, decodable
store.parseGlobalId(id): {kind, owner?, repo?, number?} | null;
store.nextId(): number;    // global deterministic db-id counter (repos/issues/PRs/comments)
store.clock: { nowSec(): number; nowIso(): string }; // logical clock, +1s per call
```

Repo shape (see `store.ts` for the exact interfaces): `dbId, name, owner,
description, isPrivate, defaultBranch='main', objects: Map, refs: Map,
issues: Issue[], pulls: Pull[], labels: Map<string,Label>,
nextNumber (shared issues+PRs, starts 1), createdAt`.

Issue: `dbId, number, title, body, state, labels: string[], userLogin,
createdAt, updatedAt, closedAt|null, comments: Comment[]`.
Comment: `id, body, userLogin, createdAt`.
Pull: `dbId, number, title, body, state, merged, mergedAt|null,
mergeCommitSha|null, headRef, baseRef, headSha, baseSha, userLogin,
createdAt, updatedAt`.
Label: `name, color, description`.

## Rules for implementation agents

- Read your spec file in full first. Do not guess wire formats — the specs
  quote the exact bytes the suite asserts.
- Never print/copy any API key or private key. Never commit a key.
  Never use the xingchiapi API or its helper (default model only).
- No `Date.now()`, no `Math.random()`, no wall-clock timestamps anywhere in
  responses. No `node:child_process`, no `git` binary, no network calls.
- Keep every handler synchronous-fast: the perf workloads are 200 pushes,
  50 concurrent shallow clones, 2000 sequential issue reads, 200 issue
  writes. Avoid O(n²) scans over all objects per request where a Map will do.
- Write your module to `src/<module>.ts` plus a test script
  `test-<module>.mjs` (or `.ts`) that boots `app.ts` on a scratch port and
  exercises your surface with plain `fetch` (no git binary: simulate the
  client with raw HTTP per your spec). Report the test results.
- If the store API lacks something you need, add it to `store.ts` in a
  clearly-marked section and say so in your report — do not silently fork
  the store.
- Do NOT create GitHub repos, do NOT submit anything. Report: files written,
  checks you self-tested (pass/fail), and open issues.
