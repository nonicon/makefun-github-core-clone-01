# REST v3 Specification — github-core-clone-01

Source of truth: `program/env/src/checks-rest.ts` (1250 lines) and
`program/env/src/rest-client.ts` (493 lines) in the kit, plus the "wire contract"
section of `RULES.txt`. Every statement below traces to an assertion in those
files. Where the suite does **not** assert something, §10 says so explicitly —
do not invent a requirement there; the GitHub-compatible behaviour is the safe
default, not a graded one.

Scope: **55 REST checks** — `repos` 15, `issues` 15, `pulls` 20,
`protocol` 5. Each check is worth 1 point. The suite is the only client.
All routes live under `/api/v3` (`API_PREFIX = '/api/v3'` in `rest-client.ts`).

---

## 0. Global rules (apply to every call)

### 0.1 Transport / client behaviour (`rest-client.ts`)

- Base URL is the entry's own origin (scheme + host + port, no trailing slash).
  The client refuses off-origin URLs (a `Link` `rel="next"` that leaves the
  origin fails the pagination check outright).
- Every request the suite sends carries:
  - `Accept: application/vnd.github+json` (server may ignore it).
  - `Authorization: Bearer <token>` when a token is configured (see §4).
  - `Content-Type: application/json` on every request with a body; bodies are
    `JSON.stringify` of a JSON value.
- Path building (`apiPath`): each segment is `encodeURIComponent`-encoded
  **per `/`-separated piece**, so a repository-relative file path such as
  `docs/readme.md` keeps its `/`s:
  `apiPath('repos', owner, repo, 'contents', 'docs/readme.md')`
  → `/api/v3/repos/<owner>/<repo>/contents/docs/readme.md`.
- Query parameters are percent-encoded via `URLSearchParams`; `undefined` /
  `null` values are dropped.
- Redirects are followed (`redirect: 'follow'`).
- Per-call timeout is clamped by the runner to **1000–5000 ms**
  (`Math.max(1_000, Math.min(context.timeoutMs, 5_000))`, default 5000).
  A transport failure or timeout surfaces as status `0` and fails the check
  with a detail string — it never passes silently.
- The client never throws on an HTTP outcome; statuses are asserted exactly,
  never as ranges.

### 0.2 What `expectJsonResponse` asserts on every graded reply

For every check that uses it (i.e. all except `repos.delete`'s 204 and
`pulls.merge-status`'s bare status check), a reply must satisfy **all** of:

1. **Exact status** — the single status named, or one of an explicitly named
   set (e.g. `[200, 201]`). No 2xx-range coercion.
2. **Not HTML** — `Content-Type` is not `text/html`, and the body does not
   start with `<` (after optional whitespace).
3. **JSON content type** — `isJsonContentType`: `application/json`,
   `application/vnd.github+json`, or `application/*+json`, with an optional
   `; charset=...` parameter. Anything else fails.
4. **Parseable JSON body.**
5. **Shape** — see §1. The shape checker (`checkShape`):
   - `object`: every listed property must be **present** and match its
     sub-shape. **Extra properties are allowed** (no check sets
     `allowExtra: false`), so returning more fields than asserted is safe
     and returning fewer fails.
   - `string`: `nonEmpty`, `oneOf: [...]` (exact match), or `pattern`.
   - `number`: `integer`, `min`, `max`.
   - `array`: every item must match the item shape.
   - A mismatch produces a path-qualified detail such as
     `"body.labels[0].name: expected string, got number"`.

### 0.3 SHA format

`SHA40 = /^[0-9a-f]{40}$/i` — every asserted sha (content sha, commit sha,
branch tip, merge sha) must be 40 hex characters. Comparisons in the checks
are **case-insensitive** (`lower(...)` on both sides), so lowercase is safe.

### 0.4 Error-body shape (universal)

Every error the suite checks is `{"message": <non-empty string>}` — see §8.
The exact message **text is never asserted**; only that `message` exists,
is a string, and is non-empty.

### 0.5 Headers on every reply

- `X-GitHub-Request-Id`: **non-empty on every reply** (asserted on 4 calls in
  `protocol.request-id`, stated for all replies in `RULES.txt`). Value
  content is unasserted; uniqueness across calls is unasserted.
- `X-OAuth-Scopes`: **present** on `GET /api/v3/` (presence only — value and
  non-emptiness are *not* asserted there). No other endpoint is checked for it.
- **No `X-RateLimit-*` header is required** (explicitly: "deliberately not
  required").

---

## 1. Check inventory (55 checks, in manifest order)

Check ids are `<group>.<slug>`. `repos.pagination` runs **first**.

### 1.1 `repos` (15)

| # | Check id | Method + path | Expected status | Key assertions |
|---|----------|---------------|-----------------|----------------|
| 1 | `repos.pagination` | `GET /user/repos?per_page=10`, follow `Link` | 200 each page | §3: all 30 seeded repos reachable, ≤10/page, ≥3 pages, no dupes |
| 2 | `repos.root` | `GET /api/v3/` | 200 | JSON object (any shape); `X-OAuth-Scopes` present |
| 3 | `repos.meta` | `GET /api/v3/meta` | 200 | `installed_version`: non-empty string |
| 4 | `repos.create` | `POST /user/repos` then `GET /repos/{o}/{r}` ×2 | 201, 200 | §2.1; `private === true` exactly; `default_branch` identical on both GETs |
| 5 | `repos.not-found` | `GET /repos/{o}/{r-never-created}` | 404 | `{"message": string(non-empty)}` |
| 6 | `repos.patch` | `PATCH /repos/{o}/{r}` then `GET` | 200, 200 | `description` becomes `descriptionAlt`, persists on GET |
| 7 | `repos.delete` | `DELETE /repos/{o}/{r}` then `GET` | **204**, 404 | 204: status only (no body/shape check); GET after: 404 + message |
| 8 | `repos.branches` | `POST /repos/{o}/{r}/git/refs`, `GET /repos/{o}/{r}/branches` | 201, 200 | Branch listed with tip = initial commit sha; default branch also listed |
| 9 | `repos.commits` | `POST /git/refs`, `PUT /contents?branch=…`, `GET /commits?sha=…`, `GET /commits` | 201, 201, 200, 200 | Branch commit listed with exact message on branch query; **absent** from default-branch query |
| 10 | `repos.unauthorized` | `GET /repos/{o}/{r}` **without token** | 401 | `{"message": string(non-empty)}` |
| 11 | `repos.foreign-token` | `GET /repos/{owner}/{r}` vs `GET /repos/{stranger}/{r}` | 200 vs **404** | Same name under another owner is 404, never 403 |
| 12 | `repos.contents-create` | `PUT /contents/{path}` then `GET /contents/{path}` | 201, 200 | §5: base64 round-trip, sha equality, byte size |
| 13 | `repos.contents-directory` | `PUT ×3` in one dir, `GET /contents/{dir}` | 201, 200 | Array listing contains all 3 filenames |
| 14 | `repos.contents-stale-sha` | `GET` sha, `PUT` update, `PUT` again with old sha | 200, 200-or-201, **409** | Update changes content sha; stale sha → 409 + message |
| 15 | `repos.contents-delete` | `DELETE /contents/{path}` then `GET` | 200, 404 | `200 {commit:{sha}}`; GET after: 404 + message |

### 1.2 `issues` (15)

| # | Check id | Method + path | Expected status | Key assertions |
|---|----------|---------------|-----------------|----------------|
| 1 | `issues.create` | `POST /repos/{o}/{r}/issues` | 201 | `state === "open"` exactly |
| 2 | `issues.create-title-body` | `POST …/issues` | 201 | `title`, `body` echo the submitted strings exactly |
| 3 | `issues.create-labels` | `POST …/issues {labels:[label]}` | 201 | Returned `labels[]` includes the label by `name` |
| 4 | `issues.numbers-increment` | `POST …/issues` ×2 | 201, 201 | Second `number === first number + 1` |
| 5 | `issues.list-open` | `POST ×2`, `PATCH` one closed, `GET …/issues?state=open&per_page=100` | 201, 201, 200, 200 | Open issue listed; **every** listed item has `state === "open"` |
| 6 | `issues.list-open-excludes-closed` | `POST`, `PATCH` closed, `GET ?state=open&per_page=100` | 201, 200, 200 | Closed issue absent from open list |
| 7 | `issues.list-sort-asc` | `POST ×3`, `GET ?state=open&sort=created&direction=asc&per_page=100` | 201×3, 200 | Positions strictly increasing in creation order |
| 8 | `issues.list-sort-desc` | `POST ×3`, `GET ?state=open&sort=created&direction=desc&per_page=100` | 201×3, 200 | Positions strictly decreasing (newest first) |
| 9 | `issues.list-shape` | `POST`, `GET ?state=open&per_page=10` | 201, 200 | ≥1 item; every item matches the issue shape (§2.2) |
| 10 | `issues.get-one` | `POST`, `GET …/issues/{n}` | 201, 200 | `number === n`, `title`/`body` exact |
| 11 | `issues.patch-close` | `POST`, `PATCH …/issues/{n} {state:"closed"}` | 201, 200 | Reply `state === "closed"` |
| 12 | `issues.patch-close-persists` | `POST`, `PATCH` closed, `GET …/issues/{n}` | 201, 200, 200 | GET after close still `state === "closed"` |
| 13 | `issues.comment-create` | `POST …/issues/{n}/comments` | 201 | `{id: integer ≥ 1, body: <exact submitted body>}` |
| 14 | `issues.comments-list` | `POST` comment, `GET …/issues/{n}/comments` | 201, 200 | List contains the comment with the same `id` **and** body |
| 15 | `issues.bad-label` | `POST …/issues {labels:[badLabel]}` | **422** | `{"message": string(non-empty)}`; issue must not be created (not re-checked, but 422 is the whole assertion) |

### 1.3 `pulls` (20)

| # | Check id | Method + path | Expected status | Key assertions |
|---|----------|---------------|-----------------|----------------|
| 1 | `pulls.create` | fixture PR, `GET …/pulls/{n}` | 200 | `state === "open"`, `head.ref`/`base.ref` exact |
| 2 | `pulls.create-body` | `GET …/pulls/{n}` | 200 | `title`/`body` echo exactly |
| 3 | `pulls.create-head-sha` | `GET …/pulls/{n}` | 200 | `head.sha ===` head-branch tip (case-insensitive) |
| 4 | `pulls.create-base-sha` | `GET …/pulls/{n}` | 200 | `base.sha ===` base-branch tip (= initial commit sha) |
| 5 | `pulls.get-one` | `GET …/pulls/{n}` | 200 | `number === n`, `title` exact |
| 6 | `pulls.files-list` | `GET …/pulls/{n}/files` | 200 | Changed path listed; `status ∈ {added, modified, changed}`; `additions ≥ 1` |
| 7 | `pulls.files-shape` | `GET …/pulls/{n}/files` | 200 | ≥1 file; every file matches the file shape (§2.3) |
| 8 | `pulls.files-multiple` | PR with 2 changed files, `GET …/files` | 200 | Both filenames listed |
| 9 | `pulls.merge-status` | `PUT …/pulls/{n}/merge {merge_method:"squash"}` | 200 | Status only |
| 10 | `pulls.merge-body` | `PUT …/merge` | 200 | `{merged: true, sha: SHA40, message: string}`; `merged === true`; sha matches `SHA40` |
| 11 | `pulls.merge-closes` | `PUT …/merge`, `GET …/pulls/{n}` | 200, 200 | After merge: `state === "closed"`, `merged === true`, `merged_at`: non-empty string |
| 12 | `pulls.merge-commit-on-default` | `PUT …/merge`, `GET …/commits?sha=<base>` | 200, 200 | Merge commit sha present in base-branch commit list |
| 13 | `pulls.merge-content-on-default` | `PUT …/merge`, `GET …/contents/{path}?ref=<base>` | 200, 200 | File on base decodes (base64) to the merged bytes |
| 14 | `pulls.merge-commit-sha` | `PUT …/merge`, `GET …/pulls/{n}` | 200, 200 | `merge_commit_sha ===` merge reply's `sha` (case-insensitive) |
| 15 | `pulls.merge-unknown` | `PUT …/pulls/999999999/merge` | **404** | `{"message": string(non-empty)}` |
| 16 | `pulls.merge-conflict` | Two PRs editing same file divergently; merge 1st (200), merge 2nd | 200, **405** | Second merge: 405 + message |
| 17 | `pulls.list-state-all` | Merge one PR, open a 2nd, `GET …/pulls?state=all&per_page=100` | 200 | Both numbers listed |
| 18 | `pulls.list-default-open` | Merge one PR, open a 2nd, `GET …/pulls?per_page=100` (no `state`) | 200 | Merged PR **absent**; open PR present |
| 19 | `pulls.list-shape` | `GET …/pulls?state=all&per_page=10` | 200 | ≥1 item; every item matches the pull shape (§2.3) |
| 20 | `pulls.get-unknown` | `GET …/pulls/999999999` | **404** | `{"message": string(non-empty)}` |

### 1.4 `protocol` (5)

| # | Check id | What it does | Key assertions |
|---|----------|--------------|----------------|
| 1 | `protocol.content-type-json` | 6 calls: `GET /`, `GET /meta`, `GET` repo, `GET` repo issues, `GET` unknown route, `GET` repo **without token** | Every reply: JSON content type, body not HTML-looking |
| 2 | `protocol.unknown-route-json-404` | `GET /api/v3/no-such-route/<repoPrefix>` | 404 + `{"message": string(non-empty)}`, not HTML |
| 3 | `protocol.malformed-body-400` | `POST /user/repos` with raw body `{"name":` and `Content-Type: application/json` | **400** + `{"message": string(non-empty)}` |
| 4 | `protocol.request-id` | 4 calls: `GET /`, `GET` repo, `GET` unknown route, `GET` repo **without token** | Every reply carries a **non-empty** `X-GitHub-Request-Id` |
| 5 | `protocol.error-message` | `GET` missing repo (404), `GET` private repo without token (401), `POST` issue with unknown label (422) | Each body is `{"message": string(non-empty)}` |

---

## 2. Exact JSON shapes asserted

**Reading rule:** `shapes.object({...})` makes every listed property
**required**; unlisted properties are permitted and never checked. So a field
below marked "asserted" must be present with the stated type/value; a field
marked "NOT asserted" may be present or absent — the REST suite will not
fail either way. (GraphQL/MCP checks may assert more; that is out of scope
for this spec.)

### 2.1 Repository object

Asserted across `prepareRepo` / `repos.create` / `repos.patch` /
`repos.pagination`:

| Field | Assertion |
|---|---|
| `name` | `string`, exactly the requested name (`oneOf: [name]`) on create and on the pagination list items |
| `private` | `boolean` on create; **exactly `true`** in `repos.create` (request sends `private: true`; the reply is compared with `=== true`) and in `prepareRepo`'s create assertion (`private: boolean` shape + the `repos.create` exact check) |
| `default_branch` | `string`, **non-empty**; stable across two consecutive GETs (`repos.create`); value is the seeded default branch — see §2.1.1 |
| `description` | `string`, exactly the submitted description on create (via `prepareRepo` input, not shape-checked there); after `PATCH`, exactly `descriptionAlt` (`oneOf: [descriptionAlt]`), and the same on the follow-up GET |

NOT asserted by any REST check: `id`, `full_name`, `owner`, `html_url`,
`clone_url`, `created_at`, `updated_at`, `pushed_at`, `git_url`, `ssh_url`,
`homepage`, `language`, `forks_count`, `stargazers_count`, `watchers_count`,
`open_issues_count`, `license`, `topics`, `visibility`, `permissions`,
`has_issues`, `has_wiki`, `archived`, `disabled`, `size`. Any of these may
be returned (recommended for GitHub compatibility) but none is graded here.

#### 2.1.1 Default branch

- The scenario's seeded default branch is `main` (`DEFAULT_BRANCH = 'main'`
  in `wire.ts`; `generateRepos` sets `defaultBranch: DEFAULT_BRANCH`).
- The checks never hard-code `"main"`: they read `default_branch` back from
  `GET /repos/{o}/{r}` after the first contents commit and use that value
  as `base` for branches/PRs. **Implement `main`** — anything else would
  still pass these REST checks (they are value-agnostic) but would break
  the git/GraphQL surfaces that do assume it.
- A repository accepts its first commit via `PUT /contents` while
  **unborn** (no commits / no default branch yet); the checks rely on this
  (`prepareRepo` doc: "an unborn repository accepts it").

#### 2.1.2 Repository creation request

`POST /api/v3/user/repos`, body `{name, private: true, description}`.
Response **201**. Duplicate-name behaviour: the pagination check tolerates
**422** for a name that already exists (it then verifies the repo is
listable); no other check tests duplicate creation. Recommended: 422 with a
message on duplicate name, matching GitHub.

Repository names used by the checks: `<repoPrefix>-<slug(check-id)>`,
truncated to **100 characters** max (`repoName()`). `repoPrefix` is the
seeded first repo name (`scenario.repos[0].name`).

### 2.2 Issue object (`issueShape`)

Required fields, all asserted on create, list, and get-one:

```json
{
  "number": 1,
  "title": "…",
  "body": "…",
  "state": "open",
  "labels": [{ "name": "bug" }]
}
```

| Field | Assertion |
|---|---|
| `number` | `integer ≥ 1` |
| `title` | `string` (any; echo asserted exactly in `create-title-body` / `get-one`) |
| `body` | `string` (any; echo asserted exactly) |
| `state` | `string`, `oneOf: ["open", "closed"]`; exactly `"open"` on create; exactly `"closed"` after `PATCH {state:"closed"}` |
| `labels` | `array` of label objects (see §2.5); may be empty |

NOT asserted: `id`, `user`, `assignee`, `assignees`, `milestone`,
`created_at`, `updated_at`, `closed_at`, `comments`, `html_url`, `url`,
`locked`, `author_association`, `reactions`, `pull_request` marker.
**No assignee/milestone behaviour is tested at all** — the suite never sends
`assignees` or `milestone` in a request.

### 2.3 Pull-request object (`pullShape`) and pull files

Required fields on create / list / get-one:

```json
{
  "number": 1,
  "state": "open",
  "title": "…",
  "body": "…",
  "head": { "ref": "feature-x", "sha": "<40-hex>" },
  "base": { "ref": "main", "sha": "<40-hex>" }
}
```

| Field | Assertion |
|---|---|
| `number` | `integer ≥ 1` |
| `state` | `string`, `oneOf: ["open", "closed"]`; `"open"` on create |
| `title` / `body` | `string` (echo asserted exactly) |
| `head.ref` / `base.ref` | non-empty `string`; exact branch names asserted |
| `head.sha` / `base.sha` | `SHA40`; equal to the respective branch tips (case-insensitive) |

Additional fields asserted **only after a merge** (`pulls.merge-closes`,
`pulls.merge-commit-sha` — note: these use a *separate* shape, not
`pullShape`, so they are not required on an open PR):

| Field | Assertion |
|---|---|
| `merged` | `boolean`; must be `true` after merge |
| `merged_at` | non-empty `string` after merge (format unasserted — any non-empty string passes) |
| `merge_commit_sha` | `SHA40`; must equal the sha returned by the merge call |

NOT asserted on a PR at any point: `id`, `user`, `created_at`,
`updated_at`, `closed_at`, `mergeable`, `mergeable_state`, `draft`,
`commits`, `additions`, `deletions`, `changed_files`, `html_url`,
`diff_url`, `head.repo`, `base.repo`, `head.label`, `requested_reviewers`.
(`mergeable` **is** asserted by the GraphQL introspection checks — see the
GraphQL spec, not this one.)

**Pull files** (`GET …/pulls/{n}/files`) — every item must match:

```json
{ "filename": "docs/readme-x.md", "status": "added",
  "additions": 12, "deletions": 0, "changes": 12 }
```

| Field | Assertion |
|---|---|
| `filename` | non-empty `string`; must equal the changed path exactly |
| `status` | non-empty `string` (shape); in `pulls.files-list` additionally must be one of `"added"`, `"modified"`, `"changed"` |
| `additions` / `deletions` / `changes` | `integer ≥ 0`; `additions ≥ 1` for the changed file in `pulls.files-list` |

NOT asserted: `sha`, `blob_url`, `raw_url`, `patch`, `previous_filename`.
Ordering of the files array is unasserted.

### 2.4 Content object (file) and directory listing

**File** — `GET /repos/{o}/{r}/contents/{path}` (200), shape:

```json
{
  "type": "file", "encoding": "base64",
  "content": "aGVsbG8…\n", "sha": "<40-hex>", "size": 123
}
```

| Field | Assertion |
|---|---|
| `type` | exactly `"file"` |
| `encoding` | exactly `"base64"` |
| `content` | `string` (base64; see §5) |
| `sha` | `SHA40` |
| `size` | `integer ≥ 0`; must equal `Buffer.byteLength(content, 'utf8')` of the decoded bytes |

NOT asserted: `name`, `path`, `url`, `html_url`, `download_url`, `git_url`,
`_links`, `license`. (The directory-listing shape *does* assert `name` and
`path` — see below.)

**Directory** — `GET /repos/{o}/{r}/contents/{dirPath}` (200) returns a
**JSON array** (not an object) of entries, each:

| Field | Assertion |
|---|---|
| `type` | `oneOf: ["file", "dir"]` |
| `name` | non-empty `string` |
| `path` | non-empty `string` |
| `sha` | `SHA40` |

The check requires the listing to contain `seed.txt`, `one.txt`,
`two.txt` (by `name`). Subdirectory entries, ordering, and entries for
other files are unasserted.

**Contents write reply** (`PUT`, `contentCommitShape`):

```json
{ "content": { "sha": "<40-hex>", "encoding": "base64" },
  "commit":  { "sha": "<40-hex>" } }
```

Both shas are `SHA40`; `content.encoding` must be exactly `"base64"`.
**Contents delete reply** (`DELETE`, 200): `{ "commit": { "sha": SHA40 } }`.

### 2.5 Label object (`labelShape`)

```json
{ "name": "bug" }
```

- `POST /repos/{o}/{r}/labels` with body `{name, color: "ededed"}` → **201**,
  shape requires only `name`: non-empty string. `color` is **sent but never
  asserted** in the response (return it anyway for compatibility).
- Issue `labels[]` items must each have `name`: non-empty string.
- NOT asserted: `id`, `color`, `description`, `default`, `url`.
- Duplicate-label creation, label update/delete, and listing labels are
  **not tested** by the REST checks.

### 2.6 Comment object

- Create: `POST …/issues/{n}/comments {body}` → **201**,
  `{id: integer ≥ 1, body: <exact submitted body>}`.
- List: `GET …/issues/{n}/comments` → **200**, array of
  `{id: integer ≥ 1, body: string}`; must contain the posted comment by
  both `id` and `body`.
- NOT asserted: `user`, `created_at`, `updated_at`, `html_url`, `url`.
  Comment update/delete endpoints are not tested.

### 2.7 Branch object

`GET /repos/{o}/{r}/branches` → **200**, array of:

```json
{ "name": "feature-x", "commit": { "sha": "<40-hex>" } }
```

- `name`: non-empty string; `commit.sha`: `SHA40`.
- Must include **both** the created branch (with tip exactly the initial
  commit sha, case-insensitive) **and** the default branch.
- NOT asserted: `protected`, `protection`, `commit.url`. No pagination
  parameters are tested on this endpoint. `GET /branches/{name}` (single
  branch) is **not tested**.

### 2.8 Commit object

`GET /repos/{o}/{r}/commits[?sha=<ref>]` → **200**, array of:

```json
{ "sha": "<40-hex>", "commit": { "message": "…" } }
```

- `sha`: `SHA40`; `commit.message`: `string` (exact message asserted in
  `repos.commits`: `"<commitMessage> (commits)"`).
- NOT asserted: `author`, `committer`, `parents`, `tree`, `url`, `html_url`,
  `files`, `stats`. Ordering of the commits array is unasserted.
  `GET /commits/{sha}` (single commit) is **not tested**.
- `GET /commits` with **no** `sha` means the default branch: it must
  **not** list a commit that exists only on another branch (§6.3).

### 2.9 Root and meta

- `GET /api/v3/` → 200, any JSON **object** (`looseObject`: no required
  fields, extras allowed). Body content is otherwise unasserted.
- `GET /api/v3/meta` → 200, `{"installed_version": <non-empty string>}`.
  The version value itself is unasserted (any non-empty string passes).

---

## 3. Pagination

- **The graded pagination case is exactly one:** `GET /user/repos?per_page=10`
  over **30** seeded repositories (`scenario.repos`, `SCENARIO_VIEWER_REPOS = 30`).
- Walk procedure used by `repos.pagination`:
  1. It first creates all 30 repos by name (`POST /user/repos`, 201
     expected; **422 tolerated** if the name already exists — e.g. created
     by an earlier check — provided a follow-up `GET /repos/{owner}/{name}`
     returns 200 with that name).
  2. It starts at `GET /user/repos?per_page=10` (absolute URL built by the
     client) and follows `Link` `rel="next"` until there is no `next`.
  3. Guardrails, each a failure: more than **20 pages**; a `next` URL that
     leaves the entry's origin; any page returning **> 10 items** with
     `per_page=10`; a repeated repository name across pages; any of the 30
     names missing at the end; **fewer than 3 pages** total for the 30 repos.
- `Link` header format (parsed by `parseLinkHeader`):
  `Link: <url>; rel="next", <url>; rel="last"` — comma-separated,
  `<absolute-URL>; rel="next"`; `rel` matching is case-insensitive and the
  quotes around the rel value are optional. The `next` URL must be absolute
  and same-origin. `prev`/`first`/`last` relations are parsed but **not
  required** by the check.
- **Ordering** of `GET /user/repos` items is unasserted (only completeness,
  uniqueness, and page size). Creation order is the safe choice.
- Other lists and their page sizes actually exercised:
  - `GET …/issues`: `per_page=100` (list/open/sort checks) and `per_page=10`
    (list-shape). No test walks more than one page of issues.
  - `GET …/pulls`: `per_page=100` and `per_page=10`. No multi-page walk.
  - `GET …/branches`, `GET …/commits`, `GET …/issues/{n}/comments`,
    `GET …/pulls/{n}/files`, `GET …/contents/{dir}`: called **without**
    pagination parameters; sizes are tiny (1–3 items).
- **Default `per_page` when omitted is never tested** (every multi-page
  assertion passes it explicitly). GitHub's default (30) is the safe choice.
  The `page` parameter is never sent by the suite at all.

---

## 4. Auth behaviour

- **Token source:** one bearer token, `MAKEFUN_SHOP_TOKEN`
  (`wire.ts TOKEN_ENV`). The client sends `Authorization: Bearer <token>`
  on every authenticated call; the anonymous client sends **no**
  `Authorization` header at all.
- **Owner derivation:** the owner login is the login the token names —
  `scenario.viewer.login` in the suite. How the forge maps the token string
  to that login is **not specified by the checks** (the forge owns the
  token↔login mapping; in the trial the token is issued by the environment
  for the viewer). The implementation must resolve the token to the viewer
  login; the suite never tells the forge the login except through the token.
- **Missing token → 401.** Asserted exactly once, by `repos.unauthorized`:
  anonymous `GET` of a **private** repository returns 401 with
  `{"message": string(non-empty)}`. The same 401 is re-asserted in
  `protocol.error-message`.
- **Wrong token:** **never tested** by the REST checks (there is no second
  valid token in the suite). Any non-empty unrecognised token should be
  treated as unauthenticated (401); do not invent a distinct status.
- **Other-owner repository → 404, never 403.** Asserted by
  `repos.foreign-token`: the same repo name under `scenario.stranger.login`
  returns 404 + message, while the owner's own read returns 200. The
  stranger owns 3 seeded repos of their own (`SCENARIO_STRANGER_REPOS = 3`)
  but the suite never creates them through the API — it only probes the
  name collision.
- **Which endpoints require auth:** the suite sends the token on **every**
  call, including `GET /api/v3/` and `GET /api/v3/meta`. Anonymous access
  is tested **only** for `GET /repos/{o}/{r}` (401). Whether `/` and `/meta`
  must reject anonymous callers is **untested** — safest is to require auth
  everywhere except that nothing in the suite proves it for `/` and `/meta`;
  requiring it there cannot fail a REST check (no anonymous call to those
  endpoints asserts a 200). Note the protocol checks *do* make anonymous
  calls to `GET /repos/{o}/{r}` and only assert content-type / request-id
  on them, not status — consistent with 401.
- **Public vs private:** every repo the checks create is created with
  `private: true` (the `prepareRepo` default; `repos.create` also sends
  `true`). Anonymous access to a *public* repository is **never tested**.
  The `private` flag is asserted as a boolean on create and as exactly
  `true` on read-back in `repos.create`; no check creates a public repo.
- **401 body:** JSON `{"message": string(non-empty)}`, JSON content type,
  non-empty `X-GitHub-Request-Id` (both asserted via the protocol checks'
  anonymous calls).

---

## 5. Contents semantics

### 5.1 Encoding

- Request: `PUT …/contents/{path}` body `{message, content, branch?, sha?}`
  where `content` is **standard base64 of the UTF-8 bytes**
  (`b64encode`: `Buffer.from(text, 'utf8').toString('base64')`).
- Response / read-back: `content` is base64; the check decodes with
  `b64decode`, which **strips `[\r\n\t ]` before decoding** — so the server
  **may** wrap base64 at 60 columns GitHub-style (or not); both pass.
  The decoded bytes must equal the submitted bytes exactly.
- `size` is the **byte** length (`Buffer.byteLength(content, 'utf8')`), not
  the character count — matters for non-ASCII content.

### 5.2 Create vs update, and the `sha`

- **Create** (no `sha` in the request, path does not exist): **201** with
  `contentCommitShape` (§2.4).
- **Update** (path exists, request carries the current blob `sha`): the
  suite accepts **200 or 201** in the two helper paths that perform updates
  (`repos.contents-stale-sha` first update, `commitOnBranch` with
  `update: true`). `RULES.txt` states **200 on update** — implement 201 for
  create and 200 for update.
- **Stale sha** (request `sha` ≠ current blob sha): **409** with
  `{"message": string(non-empty)}`. The check proves this by: reading the
  current sha, updating successfully (which must **change** the content
  sha — asserted: new content sha `!==` old content sha), then re-PUTting
  with the old sha and expecting 409.
- The `sha` in requests and replies is the **blob sha** (the checks compare
  the GET file `sha` with the PUT reply's `content.sha`, and pass that sha
  back as the update/delete `sha`). The checks **never compute a git blob
  sha themselves** — they only test equality between server-returned
  values and the `SHA40` pattern. The blob-sha algorithm is therefore not
  pinned by the REST checks alone; but the contents must also be visible
  through git (see §5.4), so implement the real git blob id
  (`sha1("blob <len>\0" + bytes)`).
- `branch` parameter: `PUT …/contents/{path}` accepts an optional `branch`
  naming the branch to commit on (used by `commitOnBranch`). When omitted,
  the commit lands on the default branch. The commit message is the
  request's `message` (asserted verbatim via `GET /commits?sha=<branch>`).

### 5.3 Delete

- `DELETE …/contents/{path}` with body `{message, sha}` (the current blob
  sha) → **200** `{commit: {sha: SHA40}}`.
- A later `GET …/contents/{path}` → **404** + message.
- Behaviour when `sha` is omitted or mismatched on delete is **untested**.
  (Safe choice: require the current sha, 409 on mismatch, mirroring update.)

### 5.4 Directory listing and file vs dir

- `GET …/contents/{path}` where `{path}` is a **directory** returns a JSON
  **array** of entries (§2.4); where it is a file, a JSON **object** (§2.4).
  The check's fixture: repo created with file at `<dir>/seed.txt`, then
  `<dir>/one.txt` and `<dir>/two.txt` added; listing `<dir>` must contain
  all three by `name`.
- `dirPath` is derived from a seeded blob path containing `/` (the directory
  part of the first such blob, else `"src"`).
- `GET` of a missing path → 404 + message (asserted after delete; the
  never-created case is asserted for repos, and the same message shape is
  expected for contents by symmetry — the delete check is the direct
  evidence).

### 5.5 Contents commits and git visibility

- Every contents PUT/DELETE creates a **real commit** (`commit.sha` is
  `SHA40` and is the value the branch/commit endpoints must then report).
- `repos.commits` proves the coupling: a contents commit made with
  `branch: <branch>` must appear in `GET /commits?sha=<branch>` with the
  exact message, and must **not** appear in `GET /commits` (default branch)
  before any merge.
- `pulls.merge-content-on-default` proves the merge coupling the other way:
  after a squash merge, `GET /contents/{path}?ref=<default-branch>` must
  decode to the merged bytes. The `?ref=` query parameter on contents GET
  is therefore required (it is also used by `getContent(..., ref)` for
  branch reads).
- The suite does **not** clone the repository back in the REST checks to
  verify contents commits (git clone-back is covered by the git checks,
  `checks-git.ts`, not this spec). Within REST, visibility is proven only
  through `GET /commits`, `GET /contents?ref=`, and the merge checks above.

---

## 6. Issues / PRs semantics

### 6.1 Numbering

- Issue numbers are a **per-repository sequence incrementing by exactly 1**
  (`issues.numbers-increment`: second number `===` first `+ 1`). The
  absolute starting value is **not asserted** by any REST check (a fresh
  repo's first issue could be 1 — GitHub behaviour — and nothing here would
  distinguish it; the check only asserts the delta).
- PR numbers are used only as opaque identifiers returned by `POST /pulls`
  and then read back (`GET /pulls/{n}`, merge, files). No increment
  assertion exists for PRs alone.
- **Whether issues and PRs share one numbering sequence is NOT tested by
  the REST checks**: every fixture creates issues and PRs in *separate*
  fresh repositories. GitHub shares the sequence; implement a single
  per-repo counter for issues+PRs (safe under every REST check and required
  for GitHub compatibility), but note the REST suite alone cannot prove it.

### 6.2 State transitions

- Issues: created `"open"`; `PATCH …/issues/{n} {state: "closed"}` → 200
  with `state === "closed"`, and a later GET still shows `"closed"`.
  Re-opening (`PATCH {state:"open"}`) is **never tested** (implement it
  symmetrically anyway).
- PRs: created `"open"`; after a successful merge, `state === "closed"`
  **and** `merged === true` **and** `merged_at` non-empty (§2.3). Closing a
  PR without merging (`PATCH` on a PR, or a close endpoint) is **not
  tested** — there is no REST check for it.
- List filters: `GET …/issues?state=open` returns only open issues;
  `?state=all` for pulls returns open **and** merged/closed ones;
  `GET …/pulls` with **no** `state` parameter defaults to **open only**
  (`pulls.list-default-open`: merged PR absent, open PR present).
  `state=closed` as a list filter is never exercised for either resource.

### 6.3 Labels validation

- A label must be created first via `POST …/labels` (201) before an issue
  may carry it (`RULES.txt`, `prepareIssueRepo`).
- `POST …/issues` naming a label that does not exist
  (`badLabel = <label> + "-not-a-label"`) → **422** + message
  (`issues.bad-label`, re-asserted in `protocol.error-message`).
- Labels are sent as an **array of strings** in the create request and
  returned as an **array of objects** `{name}`. The check only asserts the
  names are present in the reply; label `color`/`description` are never
  asserted.
- No other validation of issue creation is tested (missing title, empty
  body, etc. — all untested).

### 6.4 Assignees / milestones

**None.** No request in `checks-rest.ts` sends `assignees`, `assignee`,
`milestone`, or `labels` beyond the cases above, and no shape asserts them.
Do not treat their absence as a failure mode.

### 6.5 Comments

- `POST …/issues/{n}/comments {body}` → 201, `{id, body}` (§2.6).
- `GET …/issues/{n}/comments` → 200, array containing the posted comment.
- Commenting on a missing issue, and comment update/delete, are untested.

### 6.6 PR merge semantics (squash)

- Request: `PUT …/pulls/{n}/merge` with body
  `{merge_method: "squash"}` — the suite **always** sends
  `merge_method: "squash"` (`mergePull()`). No other merge method is tested.
- Success reply: **200** `{merged: true, sha: <SHA40>, message: <string>}`
  (`message` content unasserted — any string passes; GitHub's is
  `"Pull request successfully merged"`-style text).
- Effects asserted after a successful merge:
  1. The PR reads back `state: "closed"`, `merged: true`,
     `merged_at`: non-empty string, `merge_commit_sha` equal to the merge
     reply's `sha`.
  2. The merge commit appears in `GET /commits?sha=<base-branch>`.
  3. The squash content is on the default branch:
     `GET /contents/{changedPath}?ref=<base>` decodes to the head branch's
     file bytes.
- **Exact squash-commit form is NOT pinned by the REST checks:**
  commit message text, author/committer, parent list (one parent — the old
  base tip — vs two), and tree contents beyond the changed file are all
  unasserted. What *is* pinned: exactly one new commit on the base whose
  sha is the merge sha, whose tree contains the merged file bytes, and
  which is reachable from the base branch. Implement a true squash: one
  commit, single parent = previous base tip, tree = merge result.
- **Conflict determination:** a PR is conflicted when, after the base has
  moved, its head can no longer be merged cleanly. The suite's only
  construction (`pulls.merge-conflict`): two branches forked from the same
  base commit, **both** modifying the **same file** (`scenario.filePath`)
  with **different contents**; the first PR merges (200); the second PR's
  merge must then be **405** + message. A three-way merge that would
  produce a conflict on that file is exactly what the check constructs.
  Note the ordering matters: the conflict is only observable *after* the
  first merge lands — the check never asks for `mergeable` over REST.
- **Unknown PR** merge → **404** + message (`pulls.merge-unknown`, number
  `999999999`).
- Merging an already-merged (or already-closed) PR is **untested**.
- **Files list of a PR** (§2.3): the diff is computed head-vs-base
  (merge-base). In the fixtures the head branch is exactly one commit ahead
  of base adding a new file (`variantPath(filePath, slug)`), or two new
  files (`pulls.files-multiple`). `status` must be `added`/`modified`/
  `changed` for those; `additions ≥ 1`.

---

## 7. Branches / commits endpoints

### 7.1 Branch creation

`POST /repos/{o}/{r}/git/refs`, body
`{ref: "refs/heads/<branch>", sha: <commit-sha>}` → **201**,
`{ref: "refs/heads/<branch>", object: {sha: SHA40}}` with `ref` echoed
exactly. The `sha` in the reply is asserted only as `SHA40` (in
`repos.branches` the *list* is where the tip equality is checked).
Branch names used: `<branchName>-<slug>` (e.g. `…-branches`,
`…-commits`, `…-conflict-a/b`); `branchName` is a seeded non-default branch
name from the scenario. Creating a branch at a sha is the only git-refs
write the REST checks use (no tag creation, no ref update/delete, no
`GET /git/refs` — all untested over REST).

### 7.2 Branch list

See §2.7. Must list the default branch as well as created ones, with each
branch's tip sha.

### 7.3 Commit lists

See §2.8. Two query forms:

- `GET /commits?sha=<branch>` — history reachable from that branch; must
  include the branch-only commit with its exact message.
- `GET /commits` (no `sha`) — history of the **default branch**; must
  **exclude** branch-only commits. This is the suite's only test of
  branch isolation over REST.
- Ordering within either list is unasserted. `?sha=` may name a branch
  (all fixtures do); naming a raw commit sha is untested.

### 7.4 Git-store ↔ REST consistency

The REST checks assume one store behind both surfaces:

| REST observation | Git fact it requires |
|---|---|
| `PUT /contents` commit sha | A real commit exists at that sha; the branch tip moves to it |
| `GET /commits?sha=<branch>` | Lists exactly the commits reachable from that branch |
| `GET /contents/{path}?ref=<branch>` | Reads the tree of that branch's tip |
| Merge commit on default branch | Base branch tip moves to the squash commit; its tree holds merged bytes |
| `POST /git/refs` branch tip | The branch points at the named commit sha |

The git checks (`checks-git.ts`) verify the same store over smart HTTP;
the REST checks verify it only through the endpoints above.

---

## 8. Error shapes

| Status | Trigger (as tested) | Body asserted | Notes |
|---|---|---|---|
| **400** | Malformed JSON body: `POST /user/repos` with raw body `{"name":` | `{"message": string(non-empty)}` | Only this one malformed shape is tested. Any body that fails `JSON.parse` on an endpoint expecting JSON should be 400. Whether a malformed body on *other* endpoints is 400 is untested but implied by `RULES.txt` ("any malformed JSON body answers 400"). |
| **401** | No token: `GET` private repo | `{"message": string(non-empty)}` | See §4. Wrong-token behaviour untested. |
| **404** | Missing repo; repo under another owner; missing contents file (after delete); unknown PR (`GET` or merge, number `999999999`); unknown route | `{"message": string(non-empty)}` | Never 403 for foreign owner. Never HTML. |
| **405** | Merging a conflicted PR | `{"message": string(non-empty)}` | Only merge-conflict trigger tested. |
| **409** | `PUT /contents` with a stale `sha` | `{"message": string(non-empty)}` | Only contents-stale-sha trigger tested. |
| **422** | `POST /issues` naming a non-existent label; duplicate repo name (tolerated, not asserted, in pagination) | `{"message": string(non-empty)}` (issues case) | Label case is the asserted one. |
| **204** | `DELETE /repos/{o}/{r}` success | *(no body/shape asserted)* | Status only. Do not send a JSON body with a 204. |

- **Message strings:** no exact text is ever asserted — only presence,
  string type, and non-emptiness. Any human-readable message passes.
- **Unknown route:** any path under `/api/v3` that matches no route
  (tested: `/api/v3/no-such-route/...`) → 404 JSON, never HTML.
  Routes *outside* `/api/v3` are out of scope for this spec (git, GraphQL,
  MCP have their own specs).
- **204 vs JSON:** `RULES.txt` says every REST reply is `application/json`,
  but the delete check asserts status only and a 204 must have an empty
  body per HTTP. Do not attach a JSON content-type/body to the 204.

---

## 9. Check order and dependencies

- **Manifest order** (`restChecks()` array order): `repos.pagination` runs
  **first**, then `repos.root`, `repos.meta`, `repos.create`,
  `repos.not-found`, `repos.patch`, `repos.delete`, `repos.branches`,
  `repos.commits`, `repos.unauthorized`, `repos.foreign-token`,
  `repos.contents-create`, `repos.contents-directory`,
  `repos.contents-stale-sha`, `repos.contents-delete`; then the 15 `issues`
  checks in the order of §1.2; then the 20 `pulls` checks in the order of
  §1.3. The 5 `protocol` checks are a separate list (order §1.4).
  The runner may or may not run groups in this order — **do not depend on
  cross-check ordering**: every check is self-contained.
- **Within-check fixture dependencies** (each check builds its own world):
  - `prepareRepo` (used by ~every check): `POST /user/repos` → `PUT
    /contents` (first commit on the unborn repo) → `GET /repos/{o}/{r}`
    (read `default_branch`). Fails if any step fails.
  - `prepareIssueRepo`: `prepareRepo` → `POST /labels {name, color:
    "ededed"}` (201). Issues checks depend on the label existing.
  - `preparePull`: `prepareRepo` → `POST /git/refs` (head branch at the
    initial commit) → `PUT /contents?branch=<head>` (one commit on the
    head) → `POST /pulls {head, base, title, body}` (201).
  - `commitOnBranch`: optionally `GET /contents/{path}?ref=<branch>` (to
    fetch the blob sha for an update) → `PUT /contents` with `branch` (+
    `sha` when updating).
  - `mergedPull`: `preparePull` → `PUT …/merge {merge_method: "squash"}`.
  - `secondBranchPull`: same repo, second head branch + commit + PR
    (used by the two pull-list checks to have one open and one merged PR
    in one repo).
- **Isolation:** every check creates its own repository named
  `<repoPrefix>-<slug(check-id)>`, so checks do not share repos, issues,
  or PRs — except `repos.pagination`, whose 30 names are the fixed seeded
  list and which tolerates 422 if a name already exists (see §3).
- **No check depends on another check's side effects.** A fresh server per
  trial holds no state of its own; the suite creates everything it needs
  through the API.

---

## 10. Determinism

- The suite's inputs are fully seeded (`wire.ts buildScenario`): two runs
  on the same entry and seed send **byte-identical requests in the same
  order** and must reach the same pass/fail bits. No check reads the clock
  or `Math.random`; no timing reaches a pass/fail bit.
- **What the checks assert must be identical across two runs:**
  - `default_branch` identical across two consecutive GETs (§2.1).
  - Issue numbers incrementing by exactly 1 (§6.1).
  - Shas equal across endpoints: content sha (PUT reply ≡ GET file),
    branch tip (refs reply ≡ branches list ≡ commit lists), merge sha
    (merge reply ≡ `merge_commit_sha` ≡ base commit list) (§5–§7).
  - List ordering under explicit sort: issues `sort=created`
    `direction=asc/desc` must reflect creation order (§6.2 / §1.2).
  - Pagination completeness: the same 30 repos, no duplicates, same page
    boundaries for the same `per_page` (§3).
- **What is NOT asserted for determinism:**
  - Timestamps: `created_at` / `updated_at` / `closed_at` are never
    asserted. Only `merged_at` is asserted, and only as a non-empty
    string — its format and value are free. (For replay-safety the entry
    must still derive any timestamp it emits from `MAKEFUN_TRIAL_NOW`,
    never the wall clock — see `RULES.txt` "The determinism rule".)
  - IDs: repository `id`, issue `id`, user ids, comment `id` values (only
    `integer ≥ 1` and, for comments, equality with the just-created one)
    are not pinned to specific values. Any stable id scheme passes.
  - `X-GitHub-Request-Id` values: non-empty only; uniqueness/format free.
  - `installed_version`: any non-empty string.
  - Error `message` texts: any non-empty string.
- **Replay consequence:** a contender's final trials run live and then
  replayed; the replay must leave the same state export byte-for-byte.
  Deterministic ids, numbers, shas, and orderings (above) are therefore
  load-bearing even where the REST checks only assert them loosely: never
  derive an id, number, timestamp, or ordering from wall-clock time,
  `Math.random`, or an unseeded UUID.

---

## 11. Ambiguities the suite does not resolve (do not guess — use the safe default)

1. **Token→login mapping.** The checks prove the token names the viewer
   login, but no check shows *how* the forge learns the mapping. Safe
   default: resolve `MAKEFUN_SHOP_TOKEN` to the viewer login from the
   trial environment (the token is issued for that login); treat any other
   token as unauthenticated (401).
2. **Default `per_page`.** Never tested when omitted. Safe default: 30
   (GitHub). The `page` parameter is never sent.
3. **Issue/PR shared numbering.** Not tested over REST (separate repos per
   fixture). Safe default: one shared per-repo counter starting at 1.
4. **Blob/commit sha algorithm.** REST checks only assert equality +
   `SHA40`. Safe default: real git object ids (required for git interop
   anyway — see the git spec).
5. **Squash-commit message / parents / author.** Unasserted over REST.
   Safe default: one commit, single parent = old base tip, tree = merge
   result, message mentioning the PR (e.g. `Merge pull request #N …`
   / squash-style `<title> (#N)`).
6. **Auth on `GET /` and `GET /meta`.** Anonymous access untested. Safe
   default: require auth everywhere (no REST check can fail for it).
7. **Anonymous access to public repos.** No public repo is ever created
   by the checks. Safe default: GitHub behaviour (public readable
   anonymously) — but it is ungraded here either way.
8. **Delete-contents `sha` validation.** The check always sends the
   current sha. Safe default: require it, 409 on mismatch (mirrors update).
9. **Duplicate repo / duplicate label creation.** Only the pagination
   check's 422-tolerance for duplicate repo names is evidenced. Safe
   default: 422 + message on duplicate repo name; 422 (or 200 with the
   existing label) on duplicate label — ungraded either way.
10. **Error message texts.** Any non-empty string passes; keep them
    stable and human-readable (they appear in failure details).
11. **Fields beyond the asserted shapes** (`id`, `full_name`, `owner`,
    `user`, `created_at`, …). Not asserted by REST, but GraphQL and MCP
    checks read the same store and *do* assert some of them (notably
    `Repository.id`/`databaseId`, `Issue.id`, `PullRequest.mergeable`).
    Return full GitHub-shaped objects; the REST suite ignores the extras.
12. **Single-branch / single-commit GETs** (`GET /branches/{name}`,
    `GET /commits/{sha}`), label list/update/delete, issue/PR close
    without merge, `state=closed` list filters, re-opening an issue —
    none are exercised by the REST checks. Implement them GitHub-style;
    they are ungraded here.
