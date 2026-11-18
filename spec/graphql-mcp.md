# GraphQL v4 + MCP — implementation-ready specification

Source of truth (read verbatim; this spec paraphrases nothing the suite does not do):

- `program/env/src/checks-graphql.ts` (20 checks, `GRAPHQL_CHECKS`)
- `program/env/src/graphql-client.ts` (`GraphQLClient`, 331 lines)
- `program/env/src/checks-mcp.ts` (15 checks, `MCP_CHECKS`)
- `program/env/src/mcp-client.ts` (`McpClient`, 795 lines)
- `RULES.txt` §"GraphQL" (line 41) and §"MCP" (line 44)

Scope: only what the suite sends and asserts. Anything GitHub does that the suite never sends is **not** required. No implementation code in this file.

## 0. Shared ground rules

- Base URL: the entry's registered base URL. GraphQL at `<base>/api/graphql`, MCP at `<base>/mcp`, REST at `<base>/api/v3`.
- Auth on both surfaces: `Authorization: Bearer <trial token>` (token = `MAKEFUN_SHOP_TOKEN`). **No token → exactly HTTP 401** on both surfaces (GraphQL check 15; MCP check `auth-required`). No other auth scheme is used.
- The forge starts **fresh and empty**. Every check builds its own fixtures through the entry's own surfaces (REST create + git push; MCP checks also use REST for setup/verification). Fixture names derive from the single seeded `Scenario` (`wire.ts`): the viewer's first repository, three pull-request branch pairs, two blobs, issue templates — plus a fixed suffix so groups do not collide.
- A check that throws fails with its message; it never crashes the suite. A fixture that cannot be built is that check's failure, not a crash.
- **No check times anything**: no pass/fail bit reads a clock. Timeouts below are per-call liveness bounds only (GraphQL client default 10 000 ms; MCP default 3 000 ms per request, stated in RULES.txt: "each request must answer inside 3 seconds").
- User-Agent sent by both clients: `makefun-github-core-clone-env/1` (GraphQL) / `makefun-github-core-clone-env` (MCP REST setup calls).
- GraphQL client sends `Accept: application/json`, `Content-Type: application/json`. MCP client sends `Accept: application/json, text/event-stream`, `Content-Type: application/json`.

---

# PART A — GraphQL v4 (`POST /api/graphql`)

## A.1 Transport (from `graphql-client.ts`)

- Single operation: `POST /api/graphql`, JSON body `{"query": "<document>", "variables": {...}}`. `variables` is always present (possibly `{}`); `operationName` is sent only in the batched form when the caller supplies one (the suite's batch call does not supply one).
- Response: JSON object `{"data": ..., "errors": [...]}`. `data` may be `null`. `errors` entries are `{message: string, path?: (string|number)[], locations?: [{line, column}], extensions?: {...}}`.
- **GraphQL-level failure = HTTP 200 with an `errors` array** — never an HTTP error — except where a check explicitly expects it (only check 14). Every other check treats a non-empty `errors` array as failure, whatever the HTTP status. A 200 response with neither `data` nor `errors` is treated as a parse error by the client.
- **Batching**: a JSON **array** of operation objects `[{"query": ..., "variables": {...}}, ...]` in one body is answered by a JSON **array** of per-operation `{data, errors}` bodies **in the same order** (check 18). The client requires the response to be an array of exactly the sent length; a single object for a batched request is a parse error.
- Unauthenticated: `POST` with no `Authorization` header → **HTTP 401 exactly** (check 15, via `client.withoutToken()`).
- No GET, no query-string form, no persisted queries, no subscriptions are ever sent.

## A.2 The 18 documents (verbatim — copy exactly)

All documents are string constants in `checks-graphql.ts`; nothing builds GraphQL text at run time.

### D1 `ViewerLogin`
```graphql
query ViewerLogin {
  viewer {
    login
  }
}
```

### D2 `RepositoryFields`
```graphql
query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}
```

### D3 `Issue_fields`
```graphql
query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```

### D4 `PullRequestAndRepositoryFields`
```graphql
query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}
```

### D5 `SearchType_enumValues`
```graphql
query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}
```

### D6 `OpenIssues`
```graphql
query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}
```

### D7 `IssueByNumber`
```graphql
query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}
```

### D8 `IssueCreate`
```graphql
mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}
```

### D9 `IssueClose`
```graphql
mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}
```

### D10 `PullRequests`
```graphql
query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}
```

### D11 `PullRequestFiles`
```graphql
query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}
```

### D12 `PullRequestId`
```graphql
query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}
```

### D13 `PullRequestCreate`
```graphql
mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}
```

### D14 `MergePullRequest`
```graphql
mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}
```

### D15 `AddComment`
```graphql
mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}
```

### D16 `ViewerInvalidField`
```graphql
query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}
```

### D17 `NodeRepository`
```graphql
query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}
```

### D18 `IssuesPage`
```graphql
query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

## A.3 The 20 checks, in run order

Fixture naming (all derived from the scenario's first repo, `scenario.repos[0].name`):

| Fixture | Name |
|---|---|
| Main repo | `<repo>-graphql` |
| Pagination repo | `<repo>-graphql-pages` |
| Unknown repo (never created) | `<repo>-graphql-missing` |
| Base branch | scenario repo's `defaultBranch` |
| Head / create / merge branches | scenario `pulls[0].head`, `pulls[1].head`, `pulls[2].head` (three distinct branches) |
| File paths | scenario `blobs[0].path` (head change), `blobs[1].path` (base/first commit) |
| Issue title prefix / body / comment | scenario `issues[0].title`, `issues[0].body`, `issues[1].body` |
| Pagination | pageSize **5**, pageCount **7** (second repo holds exactly 7 issues) |

Fixtures are built lazily and memoized per run (one `Harness` per base URL + scenario seed): a check pays only for what it needs, reuses what an earlier check built. The repo fixture is created via `POST /api/v3/user/repos` (accepts 201/200/422/409 as "already there"), then its ids are read back over GraphQL (`REPOSITORY_FIELDS`). The base branch gets its first commit via a git push (env-installed adapter `configureGraphQLGit()`; **without it the 4 PR checks fail with a clear detail and the other 16 still run**). The three head branches are pushed from the base branch, each adding one file. Issues fixture: 3 open issues (`"<prefix> open 1..3"`) + 1 closed issue (`"<prefix> closed"`, created then `PATCH /issues/{n} {state:"closed"}`), all over REST. PR fixtures: created over REST `POST /pulls {title, body, head, base}`; a 422 on creation is tolerated by re-reading `GET /pulls?state=all` and reusing an open PR from the same head branch.

Per-check timeouts are the `CHECK_TABLE` values (8–15 s); they bound the whole check body, not one request.

### 1. `graphql.viewer-login` (8 s) — D1, no variables
`data.viewer.login` must be a non-empty string **equal to the token owner's login** (scenario viewer login). Anything else fails.

### 2. `graphql.repository-fields` (10 s) — D2 `{owner: viewer, name: "<repo>-graphql"}`
Requires the repo fixture; if a git adapter is installed, also the base-branch fixture first. Asserts, field by field:
- `data.repository` is an object (not null).
- `id` equals the id read when the fixture was built (same value as the fixture's own GraphQL read).
- `databaseId` equals the fixture's numeric id, a positive integer.
- `name` equals `"<repo>-graphql"`.
- `owner.login` equals the viewer login.
- `defaultBranchRef.name` equals the base branch — **only asserted when the git adapter is installed** (otherwise skipped, because no branch exists yet).
- `viewerPermission` is one of `ADMIN, MAINTAIN, WRITE, TRIAGE, READ` (any of the five passes; the owner is expected to be `ADMIN` in practice but the suite does not require it).
- `hasIssuesEnabled` is exactly `true`.

### 3. `graphql.introspection-issue` (8 s) — D3, no variables
`data.Issue.fields` (the `__type(name:"Issue")` result under the alias `Issue`) must be a non-empty list of `{name}` entries containing **all of** `id, number, title, state, body`. Missing any one fails, and the failure message lists the names actually returned. Note `fields(includeDeprecated: true)` — deprecated fields, if any, are included in the list the suite reads.

### 4. `graphql.introspection-types` (10 s) — D4 then D5, no variables
Three gh feature probes collapsed into one check:
- `data.PullRequest.fields` non-empty and containing **all of** `id, number, headRefName, baseRefName, mergeable, state, merged, files`.
- `data.Repository.fields` non-empty and containing **all of** `id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest`.
- `data.SearchType.enumValues` (from D5) non-empty and containing `ISSUE`. No other `SearchType` value is asserted; no other enum's values are probed in this check.
- The two `__type` calls in D4 are sent in **one** document (two aliased root fields).

### 5. `graphql.issues-open-order` (12 s) — D6 `{owner, name, first: 10}`
Requires repo + issues fixtures (3 open, 1 closed). Asserts:
- `data.repository.issues.nodes` is non-empty and has **≤ 10** entries (`first: 10` is a hard cap).
- Every node: `number` a positive integer, `state` exactly `"OPEN"`, `title` a string, `id` a non-empty string.
- Numbers are **non-increasing** down the list (strictly descending in practice since numbers are unique): any `numbers[i] > numbers[i-1]` fails with "CREATED_AT DESC list is out of order". Per RULES.txt, ties break by number DESC — i.e. the order is `(created_at DESC, number DESC)`.
- The closed fixture issue's number **must not** appear.
- All three open fixture numbers **must** appear (no other open issues need appear, but the list must contain at least these three; extra open issues from other checks are tolerated — the check does not assert exact equality with the fixture set, only inclusion + ordering + the closed exclusion + the `first` cap).

### 6. `graphql.issue-by-number` (10 s) — D7 `{owner, name, number: <open[0]>}`
Asserts `data.repository.issue` is an object with `number` equal to the requested number, `state` `"OPEN"`, `title` exactly `"<prefix> open 1"`, `body` exactly equal (string equality) to the seeded body, `id` non-empty.

### 7. `graphql.create-issue` (12 s) — D8 `{input: {repositoryId: <repo global id>, title: "<prefix> created over graphql", body: <seeded body>}}`
Asserts `data.createIssue.issue` is an object, `number` a positive integer, `id` non-empty. Then verifies over REST: `GET /api/v3/repos/{owner}/{repo}/issues/{number}` → 200, `number` matches, `title` matches exactly, `state` is `"open"` (lowercase REST spelling).

### 8. `graphql.close-issue` (12 s) — D9
Setup: create an issue over REST (`"<prefix> closed over graphql"`), read its global id via D7, then send D9 `{input: {issueId: <global id>}}`. Asserts `data.closeIssue.issue.number` equals the created number and `state` exactly `"CLOSED"`. Then REST `GET /issues/{number}` → 200 with `state` `"closed"`.

### 9. `graphql.pull-requests-list` (15 s) — D10 `{owner, name, first: 5}`
Requires the PR fixture (REST-created open PR from `pulls[0].head`). Asserts:
- `nodes` length **≤ 5**.
- Some node has `number` equal to the fixture PR number.
- That node: `headRefName` = head branch, `baseRefName` = base branch, `state` exactly `"OPEN"`, `mergeable` one of `MERGEABLE, CONFLICTING, UNKNOWN` (any of the three passes).
- Note: only the **open** list is consulted — the fixture PR must be open at this point.

### 10. `graphql.pull-request-files` (12 s) — D11 `{owner, name, number: <fixture PR>}`
Asserts `data.repository.pullRequest` is an object with `number` equal to the requested number, and `files.nodes[].path` includes `blobs[0].path` (the file the head branch added). Other paths may also be present. `files(first: 10)` — at most 10 nodes are requested; the required path must be within them.

### 11. `graphql.create-pull-request` (15 s) — D13
Requires repo + all branches pushed. Sends `{input: {repositoryId: <repo global id>, baseRefName: <base branch>, headRefName: <pulls[1].head>, title: "<prefix> created over graphql"}}` (no `body` field in the input). Asserts `data.createPullRequest.pullRequest`: `number` positive integer, `id` non-empty, `state` `"OPEN"`, `headRefName` = create branch, `baseRefName` = base branch. Then REST `GET /pulls/{number}` → 200 with `head.ref` = create branch and `base.ref` = base branch. The head branch must already exist (pushed over git) before this mutation — the mutation does not create the branch.

### 12. `graphql.merge-pull-request` (15 s) — D14
Requires the merge PR fixture (REST-created open PR from `pulls[2].head`). Reads its global id via D12, then sends `{input: {pullRequestId: <global id>, mergeMethod: "SQUASH"}}`. Asserts `data.mergePullRequest.pullRequest.merged` is exactly `true` (no `state` assertion on the GraphQL side). Then REST `GET /pulls/{number}` → 200 with `merged` exactly `true` and `state` exactly `"closed"`.

### 13. `graphql.add-comment` (12 s) — D15
Setup: create an issue over REST (`"<prefix> commented over graphql"`), read its global id via D7, then send `{input: {subjectId: <issue global id>, body: <issues[1].body>}}`. Asserts `data.addComment.commentEdge.node.body` is exactly equal to the sent body and `node.id` is non-empty. Then REST `GET /issues/{number}/comments` → 200 array containing an entry whose `body` equals the sent body.

### 14. `graphql.invalid-field` (8 s) — D16, no variables
The **only** check that expects GraphQL errors. Asserts:
- HTTP status is **exactly 200** (not 400).
- Response parses as JSON.
- `errors` array is **non-empty**.
- **At least one `errors[].message` contains the substring `noSuchFieldOnViewer`** (exact case). The full message format is otherwise unconstrained — any message naming the field passes, e.g. `Cannot query field "noSuchFieldOnViewer" on type "User".`
- `data` may be null or partial; the suite does not assert on it here.

### 15. `graphql.unauthenticated` (8 s) — D1, no token
Same client with `token: null` (no `Authorization` header at all). Asserts HTTP status is **exactly 401**. Body content is not asserted.

### 16. `graphql.node-repository` (10 s) — D17 `{id: <repo global id>}`
Asserts `data.node` is an object, `node.id` equals the sent id, `node.name` equals `"<repo>-graphql"`, and `node.nameWithOwner` equals `"<viewer>/<repo>-graphql"`. This exercises the `Node` interface + the `... on Repository` inline fragment. Only `Repository` is ever resolved through `node(id:)` by the suite.

### 17. `graphql.unknown-repository` (8 s) — D2 `{owner: viewer, name: "<repo>-graphql-missing"}`
Asserts the call succeeds as GraphQL (no transport/parse error, HTTP 200, **no `errors`** — `dataOf` fails the check if `errors` is non-empty), and `data.repository` is exactly `null`. This is a nullable-field success, not an error.

### 18. `graphql.batched-operations` (10 s) — batch of two
One HTTP body, a JSON array of two operation objects: `[{query: D1}, {query: D3}]` (no variables, no `operationName`). Asserts:
- HTTP 200, body parses as a JSON array of **exactly 2** entries.
- Entry 0: no errors, `data.viewer.login` equals the viewer login.
- Entry 1: no errors, `data.Issue.fields` non-empty.
- Order matters: results must correspond to request order.

### 19. `graphql.global-id-stability` (12 s) — D2 twice + D7 twice
- Read the repo twice via D2; the two `repository.id` values must be **identical strings**, non-empty.
- `repository.id` must **not** equal `String(databaseId)` — i.e. the global id must be opaque, not the bare numeric id.
- Read issue `open[0]` twice via D7; the two `issue.id` values must be identical, non-empty, and **not** equal to `String(number)` — not the bare issue number.
- No particular encoding is asserted (see §A.5).

### 20. `graphql.issues-pagination` (12 s) — D18 twice
Uses the separate pagination repo (`<repo>-graphql-pages`, exactly 7 issues, created over REST in creation order):
- Page 1: `{owner, name, first: 5, after: null}` — note **`after: null` is sent explicitly** as a JSON null variable. Asserts exactly **5** nodes, `pageInfo.hasNextPage` exactly `true`, `pageInfo.endCursor` a non-empty string.
- Page 2: `{owner, name, first: 5, after: <page-1 endCursor>}`. Asserts exactly **2** nodes (7 − 5), `pageInfo.hasNextPage` exactly `false`.
- Across both pages: every `number` a positive integer, **no number appears on both pages**, every number is one of the 7 fixture numbers, and the union is exactly **7 distinct** numbers. The suite does **not** assert the order within/between pages here (only set membership + disjointness + counts).

## A.4 Full schema surface the suite needs

Derived from the header comment of `checks-graphql.ts` plus the documents above. Only these shapes are exercised; unlisted fields/types are never sent and need not exist (but must not break introspection of the listed ones).

**Query**
| Field | Signature | Notes |
|---|---|---|
| `viewer` | `User!` (asserted non-null in practice; suite reads `viewer.login`) | Token owner. |
| `repository` | `repository(owner: String!, name: String!): Repository` — **nullable** | Unknown owner/name → `null`, no errors (check 17). |
| `node` | `node(id: ID!): Node` — nullable | Only `... on Repository { name nameWithOwner }` is ever selected (check 16). |

**`Repository`** — fields the suite selects or introspects: `id`, `databaseId`, `name`, `nameWithOwner`, `owner`, `defaultBranchRef`, `viewerPermission`, `hasIssuesEnabled`, `issue`, `issues`, `pullRequests`, `pullRequest`. Field arguments:
- `owner: User` (suite reads `owner.login`).
- `defaultBranchRef: Ref` (suite reads `defaultBranchRef.name`).
- `issue(number: Int!): Issue` — nullable (unknown number is never probed; behaviour unspecified).
- `issues(first: Int, states: [IssueState!], orderBy: IssueOrderBy, after: String): IssueConnection` — `first` caps the count; `states: [OPEN]` filters out non-OPEN; `orderBy: {field: CREATED_AT, direction: DESC}` orders `(created_at DESC, number DESC)`; `after` is a cursor string, `null` means "from the start".
- `pullRequests(first: Int): PullRequestConnection`.
- `pullRequest(number: Int!): PullRequest` — nullable.

**`Issue`** — `id, number, title, state, body`. `state` is `IssueState` (`OPEN`/`CLOSED`).

**`IssueConnection`** — `nodes` (list of `Issue`), `pageInfo { hasNextPage, endCursor }`. `edges` is **never** selected — it need not be implemented, but implementing it is harmless. `pageInfo.endCursor` must be an opaque non-empty string while more pages remain; the suite passes it back verbatim as `after`.

**`PullRequest`** — `id, number, state, merged, headRefName, baseRefName, mergeable, files`. Field arguments: `files(first: Int): PullRequestChangedFileConnection`.
- `state` is `PullRequestState` (`OPEN`/`CLOSED`/`MERGED` — the suite only ever asserts `OPEN` on reads and `merged: true` + REST `state: closed` after a merge; it never asserts GraphQL `state` after a merge).
- `mergeable` is `MergeableState` (`MERGEABLE`/`CONFLICTING`/`UNKNOWN` — any of the three passes on a fresh open PR).
- `merged: Boolean`.

**`PullRequestConnection`** — `nodes` (list of `PullRequest`). `pageInfo` is never selected on it.

**`PullRequestChangedFile`** — `path` only (inside `files.nodes`). The connection wrapper is `PullRequestChangedFileConnection { nodes }`.

**`User`** — `login` only.

**`Node`** — interface with `id: ID!`; `Repository` implements it (the only type ever resolved via `node(id:)`).

**Introspection** — the suite sends **only** `__type(name: "...")` queries (D3, D4, D5, and D3 again inside the batch). It never sends `__schema`. Required behaviour:
- `__type(name: "Issue").fields(includeDeprecated: true)` → list of `{name}` covering §A.3 check 3.
- `__type(name: "PullRequest").fields(includeDeprecated: true)` and `__type(name: "Repository").fields(includeDeprecated: true)` in one document, aliased `PullRequest:` / `Repository:`.
- `__type(name: "SearchType").enumValues(includeDeprecated: true)` → list of `{name}` including `ISSUE`.
- Aliases on the root field must work (`Issue: __type(...)` etc.).
- `includeDeprecated: true` must be accepted as an argument (the suite always passes it). The returned lists must at least contain the required names; extra names are fine.

**Mutations** (all take a single `input:` variable of the named input type; all return a payload object):

| Mutation | Input type / required fields (as sent) | Payload fields asserted |
|---|---|---|
| `createIssue` | `CreateIssueInput { repositoryId: ID!, title: String!, body: String }` | `issue { number, id }` |
| `closeIssue` | `CloseIssueInput { issueId: ID! }` | `issue { number, id, state }` — `state` must be `"CLOSED"` |
| `createPullRequest` | `CreatePullRequestInput { repositoryId: ID!, baseRefName: String!, headRefName: String!, title: String! }` | `pullRequest { number, id, state, headRefName, baseRefName }` — `state` `"OPEN"` |
| `mergePullRequest` | `MergePullRequestInput { pullRequestId: ID!, mergeMethod: PullRequestMergeMethod }` — sent value is `"SQUASH"` | `pullRequest { number, merged, state }` — `merged` `true` |
| `addComment` | `AddCommentInput { subjectId: ID!, body: String! }` | `commentEdge { node { id, body } }` — `body` echoes the input exactly |

No other mutation is ever sent. Input-field nullability beyond "the sent fields must be accepted" is not asserted; extra optional input fields are never sent.

**Enums** (values the suite sends or asserts):
- `IssueState`: `OPEN`, `CLOSED` (sent inline as `states: [OPEN]`; asserted as string values).
- `PullRequestState`: `OPEN`, `CLOSED`, `MERGED` (only `OPEN` asserted on reads).
- `MergeableState`: `MERGEABLE`, `CONFLICTING`, `UNKNOWN`.
- `PullRequestMergeMethod`: `MERGE`, `SQUASH`, `REBASE` — only `SQUASH` is sent.
- `RepositoryPermission`: `ADMIN`, `MAINTAIN`, `WRITE`, `TRIAGE`, `READ` — `viewerPermission` must be one of these.
- `SearchType`: must include `ISSUE` in `enumValues` (other values unasserted).
- `IssueOrderField`: `CREATED_AT`, `UPDATED_AT`, `COMMENTS` (only `CREATED_AT` sent).
- `OrderDirection`: `ASC`, `DESC` (only `DESC` sent).

**Argument forms the parser must accept** (header comment): string/int variables, inline enum lists (`states: [OPEN]`), inline input objects (`orderBy: {field: CREATED_AT, direction: DESC}`), null variables (`after: null`), operation names (`query ViewerLogin`, `mutation IssueCreate`, …), and a JSON array of operation documents in one request (batching).

## A.5 Id encoding

- **No exact encoding is asserted.** The suite never decodes an id and never asserts a prefix, a base64 alphabet, or a `TypeName:id` structure.
- The only assertions (check 19): ids are **non-empty strings**, **stable across repeated reads** (same object → same id string every time), and **opaque** — `repository.id ≠ String(databaseId)` and `issue.id ≠ String(number)`. A Relay-style base64 id (e.g. base64 of `Repository:<databaseId>`) satisfies all of this; so does any other stable opaque string, as long as it is not the bare number.
- Ids must **round-trip**: the id returned by a read must be accepted by `node(id:)`, `closeIssue(issueId:)`, `addComment(subjectId:)`, `createIssue(repositoryId:)`, `createPullRequest(repositoryId:)`, `mergePullRequest(pullRequestId:)` and resolve to the same object. The suite obtains every mutation id from a prior GraphQL read (D7 for issues, D12 for PRs, D2 for repos) — it never constructs an id itself.
- `databaseId` is the plain numeric REST id (positive integer), asserted equal to the REST object's id via the fixture build. Issue `number` is the plain per-repo sequence (1, 2, 3, …) shared with REST.

## A.6 Error semantics

| Situation | Required response |
|---|---|
| Unknown field in document (D16) | **HTTP 200**, JSON body with non-empty `errors` array; ≥1 `errors[].message` contains substring `noSuchFieldOnViewer`. `data` unconstrained. |
| Unknown repository (`repository(owner, name)` misses) | HTTP 200, **no `errors`**, `data.repository === null`. |
| Malformed query / bad argument / missing variables | Not exercised by any check. No assertion exists. (Client treats any 200 + `errors` as failure except check 14; a non-200 is a failure for every check that calls `dataOf`.) |
| Unauthenticated (no `Authorization` header) | **HTTP exactly 401** (check 15). Body unconstrained. |
| Any other GraphQL error on a check that expects success | Check fails: `dataOf` throws if HTTP ≠ 200, if the body has no `data` object, or if `errors` is non-empty. The failure detail is the joined `errors[].message` strings. |
| Transport failure / unparseable body | Check fails with the transport/parse detail. |

## A.7 Consistency with REST / git

- **Shared store**: GraphQL and REST read/write the same objects. Every mutation check verifies the result over REST (§A.3 checks 7, 8, 11, 12, 13). REST routes the GraphQL checks rely on: `POST /user/repos`, `GET /repos/{o}/{r}`, `POST/GET/PATCH /repos/{o}/{r}/issues[/{n}]`, `GET /repos/{o}/{r}/issues/{n}/comments`, `POST/GET /repos/{o}/{r}/pulls[/{n}]`.
- **Issues**: `createIssue` → REST-visible open issue with same number/title; `closeIssue` → REST `state: "closed"`; issues created over REST are readable over GraphQL with identical `number`/`title`/`body`/`state` (checks 5, 6).
- **PRs**: `createPullRequest` requires the head branch to **already exist** (pushed over git smart-HTTP before the mutation). The mutation takes only `repositoryId + baseRefName + headRefName + title`; the diff is derived from the git branches. REST must read the created PR back with identical `head.ref`/`base.ref`. A PR created over REST must list over GraphQL with identical refs/state/mergeable (check 9) and its changed files must include the head branch's added path (check 10).
- **Merge**: `mergePullRequest` with `mergeMethod: "SQUASH"` must make REST read `merged: true` and `state: "closed"` for that PR (check 12). (Whether a squash commit lands on the default branch is asserted by the REST group, not here.)
- **Ordering**: `repository.issues` with `orderBy {field: CREATED_AT, direction: DESC}` returns numbers descending; ties (same creation timestamp) break by **number DESC** (RULES.txt). `states: [OPEN]` excludes closed issues. `first: N` caps the returned node count at N.
- **Pagination**: cursor from `pageInfo.endCursor` must be usable as the next call's `after` and must advance the window (no repeats, no gaps across the full set — check 20). The suite does not assert cursor opacity/format, only that it is a non-empty string and that paging through it enumerates the whole set exactly once.

---

# PART B — MCP (`POST /mcp`)

## B.1 Transport — Streamable HTTP (from `mcp-client.ts`)

- **Endpoint**: `POST <base>/mcp` only. The suite never issues `GET /mcp` (no GET stream is used in either era) and never uses any other path.
- **Request**: JSON-RPC 2.0 object `{jsonrpc: "2.0", id, method, params}`. Notifications (`notifications/initialized`) omit `id`.
- **Response**: either `Content-Type: application/json` with a single JSON-RPC response object, **or** `Content-Type: text/event-stream` (SSE) — a request-scoped stream whose **final data frame is the JSON-RPC response**. Either form is accepted for every request. For SSE the client reads `data:` lines until an event whose parsed JSON is a JSON-RPC response with the expected `id` arrives, then cancels the stream; notifications/comment lines before it are skipped. A JSON **array** body is also tolerated: the client takes the first element that looks like a JSON-RPC response (has `id` + `result`/`error`).
- **Per-request timeout: 3 000 ms** (`MCP_DEFAULT_TIMEOUT_MS`; RULES.txt: "each request must answer inside 3 seconds"). The client's per-check budget is capped at this. A timeout is a client-side failure, not a scored assertion — but a server that routinely exceeds it fails every check that calls it.
- **Headers the client sends on every POST** (`headersFor`):
  - `Accept: application/json, text/event-stream`
  - `Content-Type: application/json`
  - `MCP-Protocol-Version: <negotiated revision>` — except on the legacy `initialize` and `notifications/initialized`, where it is deliberately omitted (`omitProtocolVersionHeader: true`).
  - `Mcp-Method: <method>` — mirrored on every request.
  - `Mcp-Name: <tool name>` — mirrored on `tools/call` only (value-encoded: plain ASCII as-is, otherwise `=?base64?<base64-utf8>?=`).
  - `Mcp-Session-Id: <session>` — only when the server has previously handed one out (see §B.2).
  - `Authorization: Bearer <token>` — unless `omitAuth` (only the `auth-required` check).
  - `Mcp-Param-<Header>: <value>` — only for tool parameters whose schema property carries `x-mcp-header` (see §B.5).
  - No `User-Agent` is set by the MCP client itself (fetch default); the REST setup calls use `makefun-github-core-clone-env`.
- **Session teardown**: `close()` sends `DELETE <base>/mcp` with `Accept: application/json, text/event-stream`, `Mcp-Session-Id: <session>` and the bearer token, best-effort (errors ignored), **only when a session id was handed out** (legacy era). No `DELETE` is sent in the modern era (no session exists).
- The client **never throws for an HTTP status**: every answer is returned whole (status, headers, exact body text, parsed JSON-RPC) and the check judges it. It throws only when the entry does not answer at all, exceeds the timeout, or the check's abort signal fires. `connect()` is the exception: a server speaking neither era throws `McpError`.

## B.2 Protocol negotiation — two eras

The client probes `server/discover` first and falls back to the handshake. A server may implement **either** era; both are accepted.

### Modern era — revision `2026-07-28` (preferred)

- Every request declares the revision **twice**: in `params._meta["io.modelcontextprotocol/protocolVersion"]` **and** in the `MCP-Protocol-Version` header (see §B.3 for the full `_meta`).
- No handshake, no session: `server/discover` is the first request and establishes the connection.
- `server/discover` must answer a **result** (not an error) whose `supportedVersions` is a non-empty list of `YYYY-MM-DD` revision strings. The client picks `2026-07-28` if listed, else `supportedVersions[0]`, and uses that as the negotiated revision for all later requests.
- If `server/discover` answers JSON-RPC `-32022` (`UnsupportedProtocolVersionError`) with `error.data.supported` listing versions, the client retries once with the preferred revision if listed, else `supported[0]`; if the retry still fails, `connect()` throws.
- A modern refusal that is **not** "method not found" — auth refusal (401/403), 5xx, `-32020` HeaderMismatch, `-32021`, `-32600`, `-32602` — is reported as-is and `connect()` throws; the server is **not** given the legacy fallback.
- Server identity for the modern era is read from the discover result: `result._meta["io.modelcontextprotocol/serverInfo"]` first, else a top-level `result.serverInfo`. Either location is accepted.

### Legacy era — revisions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (newest first)

- Triggered when `server/discover` is refused as **method-not-found**: JSON-RPC `-32601`, or HTTP 404/405. (Any other refusal before a working handshake is **not** treated as pre-discover.)
- Handshake: `initialize` with params `{protocolVersion: <offered revision>, capabilities: {}, clientInfo: {name: "makefun-github-core-clone-env", version: "1.0.0"}}`, id `"initialize-1"`, **without** the `MCP-Protocol-Version` header. The client tries revisions newest-first; it accepts whatever revision the server echoes in `result.protocolVersion` as negotiated (the echoed value must match `YYYY-MM-DD` to be used, else the offered revision is kept). If `initialize` answers `-32602`, the client stops trying further revisions and throws.
- On a successful `initialize`, the client sends `notifications/initialized` (a notification: `{jsonrpc: "2.0", method: "notifications/initialized", params: <with _meta>}`, **no `id`**, no protocol-version header). Its answer is ignored — a lost notification is no error.
- `Mcp-Session-Id`: **optional**. If any response carries an `Mcp-Session-Id` header, the client stores it and sends it on every subsequent request. If none is ever issued, requests simply carry none — the suite never requires a session id, and never sends one unsolicited.
- `initialize` result shape asserted: `result.protocolVersion` (revision string), `result.serverInfo` (object with `name`/`version`), `result.capabilities` (object; `capabilities.tools` must be present — see check `initialize`).

### `server/discover` result shape (modern)

The `DiscoverResult` interface: `{resultType?, supportedVersions?: string[], capabilities?: object, instructions?: string, serverInfo?: object, _meta?: object, ...}`. The suite asserts only:
- `supportedVersions`: non-empty array, entries matching `YYYY-MM-DD` (the client filters with `/^\d{4}-\d{2}-\d{2}$/`; non-matching entries are dropped, and the check fails if none remain).
- Identity + capabilities come from the same result (see check `initialize` below).
- `resultType`, `instructions` and any other fields are never asserted.

## B.3 Every request's `_meta` (exact)

`withMeta` builds `params._meta` for **every** request/notification (never overwriting an explicit `_meta` key the caller set):

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "<negotiated revision>",
    "io.modelcontextprotocol/clientInfo": {"name": "makefun-github-core-clone-env", "version": "1.0.0"},
    "io.modelcontextprotocol/clientCapabilities": {},
    "protocolVersion": "<negotiated revision>"
  }
}
```

Note the **duplicate** plain `protocolVersion` key alongside the namespaced one — the client's contract says a `_meta.protocolVersion` field is present on every request and an older server may look for that spelling. A server must not reject requests for carrying `_meta`, and must not require any other `_meta` field. Client capabilities are always `{}` (empty).

## B.4 The 15 checks, in run order

Setup shared by most checks (from `checks-mcp.ts`): names are seeded — repo names `mcp-<seed8>-<part>`, branches `mcp-head-<seed8>-<part>`, file paths `mcp-<seed8>-<part>-<which>.txt`, where `<seed8>` is the first 8 hex chars of the scenario seed. Owner is resolved via `GET /api/v3/user` (fallback: scenario viewer login). Setup repos are created over REST (`POST /user/repos {name, private: true, description: "github-core-clone-01 MCP setup"}`). For PR checks, the base commit is a `PUT /contents/{path}` and the head branch is created via `POST /git/refs {ref: "refs/heads/<head>", sha: <base sha>}` **or**, if that route refuses, via a contents write with `branch: <head>` — whichever creates the ref; then one more file is committed on the head branch. Either route is acceptable. Each check creates a **fresh** `McpClient`, calls `connect()`, does its work, then `close()`.

### 1. `mcp.initialize`
`connect()` (discover-first, legacy fallback). Asserts from the settled connection info:
- `serverInfo.name` is a non-empty string (after trimming).
- `serverInfo.version` is a non-empty string.
- `capabilities.tools` is present and is an object (`isRecord` — any object passes, even `{}`).
- Era may be `modern` (`server/discover`) or `legacy` (`initialize`); the pass detail names which. A server speaking neither era fails here (and therefore everywhere — every check calls `connect()` first).

### 2. `mcp.server-discover`
Calls `connect()` and inspects the recorded discover probe:
- **Modern**: `supportedVersions` (the `YYYY-MM-DD` entries of the discover result) must be non-empty → pass, naming the negotiated revision.
- **Legacy**: passes unconditionally with detail "pre-discover revision" — the probe may have been HTTP 404, JSON-RPC `-32601`, or any other refusal, **provided the `initialize` handshake then worked** (which `connect()` already proved). A legacy server is never failed for lacking `server/discover`.

### 3. `mcp.tools-list`
After `connect()`, one `tools/list` call (see §B.5 for the wire shape). Asserts:
- **≥ 6 tools** returned.
- All six canonical tools present, each found by `findTool` (see §B.5): exact canonical name, an obvious alias, or a name whose normalized form **ends with** the canonical/alias normalized form (server prefix allowed, e.g. `github__create_issue`). Matching is case-insensitive and ignores all non-alphanumeric characters.
- Failure names the missing canonical tools and the tools that were found.

### 4. `mcp.tool-schemas`
After `connect()` + `tools/list`. Asserts for **every** listed tool (not just the six):
- `description` is a non-empty string (after trimming).
- `inputSchema` is an object with `inputSchema.type === "object"` exactly.
- Up to 4 failures are listed in the detail; more are counted as `(+N more)`. An empty tool list fails outright.

### 5. `mcp.create-issue`
Setup: fresh REST repo `mcp-<seed>-issue-create` (private). Calls `tools/call` `create_issue` with the mapped arguments (§B.6): `{owner, repo, title: <scenario issue[0].title>, body: <scenario issue[0].body>}`. Then REST `GET /repos/{o}/{r}/issues?state=all&per_page=100` → 200; the listed issues must include one whose `title` equals the sent title exactly. The tool result itself is **not** parsed for the issue in this check — only that the call did not return a JSON-RPC error or `isError: true`, and that REST lists the issue. (If the tool's `inputSchema` has a required property the suite cannot fill, the check fails naming that property instead of calling.)

### 6. `mcp.list-issues`
Setup: fresh REST repo `mcp-<seed>-issue-list`; one issue created over REST (`scenario issue[1]`, number recorded). Calls `tools/call` `list_issues` with `{owner, repo, state: "open"}` (lowercase `"open"`). Asserts the tool result — `resultText` (all `content[]` blocks with `type: "text"` joined, plus `structuredContent` stringified if present) — contains either the issue's **title** verbatim or `"number": <n>` matching the created number (regex `"number"\s*:\s*<n>` with a non-digit boundary). Either match passes. The call must not error / `isError`.

### 7. `mcp.create-pull-request`
Setup: fresh REST repo `mcp-<seed>-pr-create` + base commit + head branch `mcp-head-<seed>-pr-create` (see §B.4 preamble). Calls `tools/call` `create_pull_request` with `{owner, repo, title: <scenario pull[0].title>, body: <scenario pull[0].body>, head: <head branch>, base: <default branch>}`. Then finds the PR over REST: first by the number parsed from the tool result JSON (`number` / `pull_number` / `pull_request_number` fields, in that order), else by scanning `GET /pulls?state=all&per_page=100` for matching `title` or `head.ref`. Asserts the PR exists and `head.ref` (or `head.label`'s last segment, or bare `head`) equals the head branch and `base.ref` equals the base branch.

### 8. `mcp.merge-pull-request`
Setup: fresh REST repo `mcp-<seed>-pr-merge` + base/head branches; PR created over REST (`scenario pull[1]`, number recorded). Calls `tools/call` `merge_pull_request` with `{owner, repo, pull_number: <number>}`. Then REST `GET /pulls/{number}` → must read `merged === true` (boolean). The tool result is not otherwise parsed; `state` is reported in the pass detail but not asserted.

### 9. `mcp.unknown-tool`
After `connect()`, a raw `tools/call` request: `{name: "mcp_no_such_tool_<seed8>", arguments: {}}`. Asserts:
- HTTP status is **not 500** (an explicit 500 fails even before looking at the body).
- The answer is a JSON-RPC **error** with code `-32602` (invalid params) **or** `-32601` (method not found). Any other code fails; a success `result` fails.
- The tool name is deliberately un-prefixed and unknown; no setup repo is involved.

### 10. `mcp.parse-error`
After `connect()`, a raw POST whose body is the **truncated, invalid JSON** string (sent byte-for-byte, no closing braces):
```
{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"
```
(with `Mcp-Method: tools/list` header and expected id `424242`). Asserts:
- **Modern era**: HTTP **400** **and** JSON-RPC error code `-32700`.
- **Legacy era**: HTTP **200** with `-32700` also passes ("the pre-2026-07-28 transport status").
- Anything else fails (wrong status, no `-32700`). The id in the answer is not asserted.

### 11. `mcp.missing-arguments`
After `connect()` + `tools/list`, calls `create_issue` with **empty arguments `{}`** (`allowMissing: true` — the argument mapper is bypassed so the call is actually made despite unfilled required properties). Asserts **either**:
- a JSON-RPC error with code `-32602`, **or**
- a tool result with `isError: true`.
- Any other outcome fails — including a success result and any other JSON-RPC code. If `tools/list` has no `create_issue` tool, the check fails for that reason.

### 12. `mcp.concurrent-calls`
Setup: two fresh REST repos, `mcp-<seed>-concurrent-left` and `mcp-<seed>-concurrent-right`. Resolves `get_repo` from `tools/list`; maps `{owner, repo}` for each repo. Fires **both** `tools/call get_repo` requests concurrently (`Promise.all`) with explicit string JSON-RPC ids `"concurrent-left-<seed8>"` and `"concurrent-right-<seed8>"`. Asserts:
- Each answer's `matchedId` (the `id` in the JSON-RPC response) equals the id that request sent. A swapped id fails.
- Neither answer carries a JSON-RPC error.
- Each answer's result text contains its **own** repo name (`leftText` includes the left repo, `rightText` includes the right repo) — a swapped payload fails.
- No assertion is made about request ordering on the wire; only that the two in-flight calls keep their own ids and arguments.

### 13. `mcp.tools-list-idempotent`
After `connect()`, calls `tools/list` **twice** and compares `JSON.stringify(toolsArray)` of the two answers. Asserts the two serializations are **byte-identical** (same length and same string). Implication: tool order, field order within each tool object, descriptions, and schemas must be **deterministic** — no timestamps, random ids, map-iteration order, or per-call variation in the `tools` array. (The comparison is on the client's parsed-then-restringified array, so JSON key order inside each tool object as the server serialized it is preserved through `JSON.stringify` of the parsed objects in insertion order — the server must emit keys in a stable order too.)

### 14. `mcp.rest-parity`
- Calls `create_repo` with `{owner: <token login>, name: "mcp-<seed>-parity", description: <scenario repo[0].description>, private: true}` (note: the suite **does** pass `owner` here, although RULES.txt documents `create_repo {name}`).
- Reads the repo name/owner back from the tool result JSON if it carries a `full_name` string `"owner/repo"`; otherwise uses the requested owner/name.
- REST `GET /repos/{o}/{r}` **twice**; both must be 200, both must carry an `id`, and `String(id)` must be identical across the two reads.
- Calls `create_issue` with `{owner, repo, title: <scenario issue[2].title>, body: <scenario issue[2].body>}`.
- Determines the issue number from the tool result JSON (`number` field) or, failing that, by listing REST issues and matching the title.
- REST `GET /repos/{o}/{r}/issues/{number}` **twice**; both 200, both carry an `id`, `String(id)` identical, and `title` equals the sent title.
- Net requirement: MCP-created objects are the **same objects** REST serves (same ids), and ids are **stable across repeated REST reads**.

### 15. `mcp.auth-required`
After `connect()` (authenticated — the connection itself is established with the token), resolves the `create_issue` tool name from `tools/list` if available (a prefixed name is still the same tool), else falls back to the canonical `"create_issue"`. Then calls `tools/call` with `{owner: "no-auth", repo: "no-auth-<seed8>", title: <scenario issue[3].title>, body: <scenario issue[3].body>}` and **`omitAuth: true`** (no `Authorization` header at all). Asserts HTTP status is **exactly 401**. (Authentication is decided before any tool lookup, so the refusal must be 401 even if the tool name were unknown.)

## B.5 `tools/list` — wire shape and tool set

**Request** (client `listTools()`): JSON-RPC `tools/list`, params `{}` on the first page; if the result carries a non-empty string `nextCursor`, the client follows it with params `{cursor: <nextCursor>}`, up to **10 pages**, concatenating all `tools` arrays. A result with no `tools` array throws (client-side failure). Each entry must be an object with a non-empty string `name` to be kept.

**Response shape** (per page): `{result: {tools: [{name, description, inputSchema, ...?}], nextCursor?: string}}`. `nextCursor` is optional; omitting it (single page) is the normal case. Extra fields on a tool (e.g. `title`) are ignored by the suite.

**Required tools** (canonical names from `github-mcp-server`; `MCP_REQUIRED_TOOLS`):

| Canonical | Accepted aliases (normalized match) |
|---|---|
| `create_repo` | `create_repository`, `repo_create`, `repos_create`, `repository_create` |
| `get_repo` | `get_repository`, `repo_get`, `repos_get`, `repository_get` |
| `create_issue` | `issue_create`, `issues_create` |
| `list_issues` | `issues_list`, `issue_list` |
| `create_pull_request` | `pull_request_create`, `pulls_create`, `create_pr`, `pr_create` |
| `merge_pull_request` | `pull_request_merge`, `pulls_merge`, `merge_pr`, `pr_merge` |

**Name matching** (`findTool`, exact algorithm): normalize a name by lowercasing and deleting every non-`[a-z0-9]` character (`github__create_issue` → `githubcreateissue`; `create_issue` → `createissue`). First pass: exact normalized equality against the canonical name or any alias. Second pass: a listed name whose normalized form **ends with** a wanted normalized form (and is strictly longer) — this is the server-prefix allowance. Matching is therefore case-insensitive and separator-insensitive. A tool named e.g. `create_issue_v2` does **not** match (it does not end with `createissue`); `github__create_issue` does.
**At least 6 tools** must be listed in total; extra tools are allowed and are also subject to the description + `inputSchema.type === "object"` rule (check 4).

**`x-mcp-header` mirroring**: if a tool's `inputSchema.properties[<param>]` carries a string `x-mcp-header` value, the client mirrors that argument into a request header `Mcp-Param-<value>` on `tools/call`, with the transport's value encoding (plain visible-ASCII as-is; otherwise `=?base64?<base64 of UTF-8 bytes>?=`). Only string/number/boolean argument values are mirrored; other types are skipped. Servers need not use `x-mcp-header` at all — it only matters if the schema declares it.

## B.6 `tools/call` — argument mapping, result shape, errors

**Request**: JSON-RPC `tools/call`, params `{name: "<listed tool name, exactly as listed>", arguments: {<mapped args>}}`, plus the `Mcp-Name` header carrying the same tool name. The suite calls the tool **by the name the server listed** (including any prefix), not by the canonical name.

**Argument mapping** (`mapArguments` — the exact algorithm the implementer must design schemas around):
1. Read the tool's `inputSchema.properties` keys. If the schema has no `properties` object, the suite's semantic arguments are sent **as-is** (canonical names) and no "missing" check applies.
2. For each semantic argument key, look for a schema property whose **normalized** name (lowercase, non-alphanumerics removed) equals the normalized form of the key or of any of its synonyms (table below), first synonym match wins. The argument is then sent under the **schema's own property name**.
3. `full_name` fill-in: if the schema has a property matching `full_name`/`repo_full_name`/`repository_full_name`/`fullName` **and** no property matched `repo`, the suite additionally sends that property with the value `"<owner>/<repo>"`. (This only triggers when the schema uses `full_name` instead of a separate `repo` property.)
4. After mapping, the suite computes `missing` = `inputSchema.required[]` entries not present in the mapped args. **If any required property cannot be filled, the tool is NOT called** — the check fails naming the unfilled required property (checks 5–8, 14). The suite never invents a value for a required property it has no semantic value for. (Exception: check 11 deliberately calls with `{}` anyway.)
5. Arguments whose semantic value is `undefined` (optional args not provided) are omitted entirely.

**Semantic arguments the suite sends, and their synonym lists** (normalized comparison; first match wins):

| Semantic key | Synonyms (in order) |
|---|---|
| `owner` | `owner`, `owner_login`, `org`, `organization`, `organisation`, `user`, `user_login`, `login`, `account`, `namespace`, `owner_name` |
| `repo` | `repo`, `repository`, `repository_name`, `repo_name`, `repo_slug`, `project`, `project_name` |
| `repo_full_name` | `full_name`, `repo_full_name`, `repository_full_name`, `fullName` |
| `title` | `title`, `issue_title`, `pr_title`, `pull_request_title`, `subject` |
| `body` | `body`, `issue_body`, `description`, `content`, `text`, `comment` |
| `head` | `head`, `head_ref`, `head_branch`, `pull_request_head`, `pr_head`, `source`, `source_ref`, `source_branch`, `from`, `from_branch`, `branch` |
| `base` | `base`, `base_ref`, `base_branch`, `pull_request_base`, `pr_base`, `target`, `target_ref`, `target_branch`, `into`, `into_branch` |
| `pull_number` | `pull_number`, `pull_request_number`, `pr_number`, `number`, `issue_number`, `index` |
| `name` | `name`, `repo`, `repository`, `repository_name`, `repo_name` |
| `description` | `description`, `about`, `summary`, `body` |
| `private` | `private`, `is_private` |
| `state` | `state`, `status` |

Practical consequences:
- The **safest schema** uses exactly the canonical property names (`owner`, `repo`, `name`, `title`, `body`, `head`, `base`, `pull_number`, `description`, `private`, `state`). Any synonym above also works, but a property name outside these lists (e.g. `repositoryOwner`) is **never** filled — the argument is silently dropped and the property counts as missing if required.
- **Required vs optional**: only mark a property `required` if the suite sends a value for it (see the per-tool argument lists below). A required property the suite cannot fill fails the check before any call. Optional properties the suite does not send must be genuinely optional server-side.
- Note the `name` synonyms include `repo`/`repository`: for `create_repo`, a schema property named `repo` would receive the repo name. And `body` synonyms include `description`: a `create_issue` schema with a `description` property (and no `body`) receives the issue body under `description`.

**Per-tool argument shapes actually sent** (semantic keys; after mapping, the keys become the schema's property names):

| Tool | Arguments sent (semantic) | Notes |
|---|---|---|
| `create_repo` | `{owner, name, description, private}` | `owner` = token login; `description` = scenario repo description; `private` = `true`. RULES.txt documents `{name}` only, but the code sends all four. In check 5–8 setups the repo is created over REST instead; `create_repo` is only exercised in check 14. |
| `get_repo` | `{owner, repo}` | Used in check 12 (concurrency) and implicitly by nothing else. Result text must contain the repo name. |
| `create_issue` | `{owner, repo, title, body}` | `body` always sent in checks 5 and 14 (it is optional per RULES.txt `body?`, but the code always provides it). Check 11 sends `{}`. |
| `list_issues` | `{owner, repo, state}` | `state` = `"open"` (lowercase). RULES.txt documents `state?`; the code always sends it. |
| `create_pull_request` | `{owner, repo, title, body, head, base}` | `body` **is** sent here (scenario pull body), although RULES.txt documents `{owner, repo, title, head, base}` without `body`. |
| `merge_pull_request` | `{owner, repo, pull_number}` | `pull_number` is a JSON number. |

**Result shape the suite parses** (`McpToolResult`): `{content?: [{type, text, ...}], structuredContent?: any, isError?: boolean, ...}`. The suite reads results in two ways:
- `resultText`: concatenation of every `content[]` block with `type === "text"` and a string `text`, plus `JSON.stringify(structuredContent)` appended when present. Checks 6 and 12 search this text (title substring / repo-name substring / `"number": N` regex).
- `resultJson`: `structuredContent` if present (preferred), else `JSON.parse` of the whole text, else the outermost `{...}` or `[...]` substring parsed as JSON. Checks 7, 8 (via `numberFrom`), 14 read numbers/fields from it: `number` (also `pull_number`, `pull_request_number` for PRs), `full_name` (for `create_repo` parity).
- **Recommendation (not a suite assertion)**: return both `content: [{type: "text", text: <JSON string of the object>}]` and `structuredContent: <the object>` so every parser path succeeds; include `number` and `full_name`/`name` in the JSON. `isError` must be absent or `false` on success, `true` on a tool execution error.
- A tool result that is not an object (e.g. a bare string) yields `toolResult: null`; checks that need data from it then fail.

**Error cases**:

| Situation | Required response |
|---|---|
| Unknown tool name | JSON-RPC error code `-32602` **or** `-32601`; HTTP status **≠ 500** (check 9 asserts the status is not 500 first). |
| Missing required argument (`create_issue` with `{}`) | **Either** JSON-RPC error `-32602` **or** a tool result with `isError: true` (check 11). |
| Body that is not JSON | **Modern**: HTTP **400** + JSON-RPC `-32700`. **Legacy**: HTTP **200** + `-32700` also passes. |
| No `Authorization` header | HTTP **exactly 401** (check 15). |
| Tool execution failure (e.g. repo does not exist) | Not directly asserted except via `isError`/error handling above; any JSON-RPC error or `isError: true` fails the functional checks that expect success. |

**Concurrency**: two `tools/call` requests in flight must each be answered with the **response `id` equal to the request's `id`** and the payload for **that request's arguments** (check 12). No server-side serialization is required — the client fires both at once — but responses must not be crossed. JSON-RPC ids used by the client are normally incrementing integers starting at 1 (`discover-1` and `initialize-1` are the only string ids the client generates itself; check 12 passes explicit string ids).

## B.7 Other methods the suite calls (complete list)

- `server/discover` (modern probe; params `{}` + `_meta`).
- `initialize` (legacy handshake only).
- `notifications/initialized` (legacy only; notification, no `id`, answer ignored).
- `tools/list` (with optional `cursor` param for pagination).
- `tools/call` (with `name` + `arguments`).
- **Nothing else.** The suite never sends `ping`, `roots/list`, `sampling/createMessage`, `resources/*`, `prompts/*`, `notifications/cancelled`, `notifications/progress`, or any other MCP method. `GET /mcp` is never sent. No elicitation, no logging subscription.

## B.8 Determinism

- Every name, title, branch, path and byte the MCP group sends comes from the seeded scenario; no `Math.random`, no clock in any pass bit. The same entry + same scenario issues the same requests in the same order, so the run's check bits replay identically.
- `tools/list` must be **byte-identical across two calls** (check 13): fixed tool order, fixed key order, fixed descriptions/schemas, no timestamps/random values anywhere in the `tools` array.
- REST ids of MCP-created objects must be **stable across repeated reads** (check 14).
- GraphQL global ids must be **stable across repeated reads** (check 19); MCP has no equivalent id-stability assertion on its own results, but the REST-parity check effectively requires the underlying store ids to be stable.

---

# PART C — Cross-cutting notes for the implementer

1. **One store, three surfaces.** REST, GraphQL and MCP all read/write the same repositories/issues/PRs/comments/branches. Nearly every check verifies a write made on one surface by reading it on another.
2. **Auth is uniform**: missing/invalid bearer → 401 on GraphQL, MCP and (per RULES.txt) REST. The suite only tests the missing-token case on GraphQL (check 15) and MCP (check 15); an invalid/wrong token is never sent.
3. **HTTP status discipline**: GraphQL validation failures are 200 + `errors`; MCP unknown-tool is a JSON-RPC error, never HTTP 500; MCP parse errors are 400 (modern) / 200 (legacy) + `-32700`; unauthenticated is 401 on both.
4. **Timeouts are liveness bounds, not scores** — but the MCP bound is tight (3 s per request) and every MCP check creates a fresh client and re-runs `connect()`, so `server/discover`/`initialize` + `tools/list` run ~15 times per suite run; keep them fast and side-effect-free.
5. **The git dependency**: GraphQL checks 9–12 and MCP checks 7–8 need branches with commits pushed over git smart-HTTP (or, for MCP setup, created via REST contents/git-refs). The GraphQL PR checks fail cleanly if the env's git adapter is absent — the implementation itself is still expected to serve git, since the adapter drives the entry's own git endpoint.

## Ambiguities / things the source does not pin down

1. **Global-id format**: not specified anywhere (see §A.5). Any stable opaque string works; Relay base64 is the natural choice but is not asserted.
2. **Unknown-field error message**: only the substring `noSuchFieldOnViewer` in some `errors[].message` is asserted. Exact wording, `path`, `locations`, `extensions`, and error `code` are unconstrained.
3. **Malformed GraphQL / missing variables / bad arguments**: no check sends them (except the unknown-field document). Behaviour is unconstrained by the suite — any 200 + `errors` or non-200 is only judged through the generic `dataOf` failure path of the check that happened to send it.
4. **Unknown issue/PR numbers over GraphQL** (`issue(number:)` / `pullRequest(number:)` for a number that does not exist): never probed. Nullable-vs-error is unspecified.
5. **`SearchType` values beyond `ISSUE`**: unasserted. Likewise `IssueOrderField` values other than `CREATED_AT`, `OrderDirection ASC`, `PullRequestState MERGED/CLOSED`, and `MergeableState` values other than "one of the three" are never asserted.
6. **`viewerPermission`**: any of the five enum values passes; the suite does not require `ADMIN` for the owner.
7. **`mergeable`**: any of `MERGEABLE`/`CONFLICTING`/`UNKNOWN` passes on a fresh PR; the suite never constructs a conflicting PR to force `CONFLICTING`.
8. **MCP `create_repo` argument list**: RULES.txt says `{name}` but the code sends `{owner, name, description, private}` (check 14). Implement for the code's shape.
9. **MCP `create_pull_request` argument list**: RULES.txt omits `body`, but the code sends `body` too (check 7). Implement for the code's shape.
10. **MCP `initialize` result `capabilities`**: only `capabilities.tools` being a present object is asserted; its contents (e.g. `listChanged`) are not. Similarly `serverInfo` needs only non-empty `name`/`version`.
11. **MCP SSE vs JSON**: either response form is accepted for every request; the suite never requires SSE and never requires plain JSON. `GET /mcp` behaviour is never exercised.
12. **`Mcp-Session-Id`**: optional in the legacy era, absent in the modern era. The suite never requires the server to issue one and never sends one unless issued. `DELETE /mcp` on close is best-effort and its result is ignored.
13. **MCP tool-result content**: the suite tolerates `structuredContent`-only, `content`-text-only, or both — but at least one path must yield the data the checks parse (`number`, `full_name`, title, repo name). A prose-only result with no parseable JSON fails checks 7 and 14.
14. **GraphQL `edges`**: never selected; whether `IssueConnection`/`PullRequestConnection` implement `edges`/`totalCount` is unconstrained.
15. **`defaultBranchRef` when no branch exists**: check 2 only asserts it when the git adapter is installed (i.e. when a branch was pushed). Its value on a branchless repo is unconstrained.
16. **Check ordering / dependencies**: checks run in the listed order within each group, but each group has its own harness/fixtures and groups are independent. Within GraphQL, later checks reuse fixtures built by earlier ones (repo → issues → PRs), so a failure to build the repo fixture fails many checks at once; the PR checks additionally depend on the env-installed git adapter. Within MCP, each check builds its own fresh repos, so checks are independent of each other except for sharing the negotiated connection era per client instance (each check creates a new client, so even that is per-check).
