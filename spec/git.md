# GIT surface — implementation-ready specification

Source of truth: `program/env/src/checks-git.ts` (30 checks, `GIT_GROUP_SIZE = 30`),
`program/env/src/git-client.ts` (the only client; no git binary in the pod),
`program/env/src/wire.ts` (git-relevant parts only), `RULES.txt` § "Git over smart HTTP".
All identifiers, strings and regexes below are copied verbatim from those files.
Scope: git smart HTTP only. REST/GraphQL/MCP are out of scope here except where the
git checks touch them (repo creation, §1.3).

Status model of the whole task: the forge is **one process**, binds an ephemeral port
(`listen(0)`; never 8080), `POST`s `{"port": N}` to `$MAKEFUN_ENV_URL/register`,
long-polls `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, then exits 0.
The suite dials the forge at the base URL derived from the register request
(`http://<remote-address>:<port>`, no trailing slash) and drives only that origin.

## 0. Ground rules (read first)

- **No git binary at grading time.** Hand-roll everything (Node 22 stdlib `zlib`/`crypto`
  or Python 3.13 stdlib). Object ids are SHA-1 only (`object-format` other than `sha1`
  makes the client throw `object-format`).
- **upload-pack must speak protocol v2.** The suite requests it with header
  `Git-Protocol: version=2`. A v0 answer loses exactly 3 checks (`advertise-v2`,
  `ls-refs`, `ls-refs-prefix`); everything else falls back to v0. Implement v2 **and**
  a correct v0 fallback for upload-pack anyway (the client picks v0 when the
  advertisement is v0, and several checks tolerate either protocol).
- **receive-pack is v0 only.** If it answers v2 the client throws `push-protocol`.
  It must advertise `report-status`, `side-band-64k`, `delete-refs`.
- **v0 upload-pack must advertise `side-band-64k`** — without it the client throws
  `sideband` before sending a v0 fetch ("A v0 upload-pack that does not advertise
  side-band-64k cannot be framed", RULES.txt).
- **A repo is created through REST first** (`POST /api/v3/user/repos`); a push cannot
  invent one (§1.3). Missing repo = **404** on `GET /info/refs` for both services,
  server stays up.
- **Every update must fast-forward.** Non-FF push: refused per ref with
  `ng <ref> non-fast-forward`, ref does not move. The suite never force-pushes.
  A push with one FF + one refused ref applies the FF ref and answers one report
  line each (`ok` / `ng`).
- **Store object bytes verbatim, never re-serialise.** Checks compare pushed bytes
  with cloned bytes (`Buffer.equals`) and recompute every SHA-1.
- **A check that throws is a failure carrying the message, never a crash**
  (the `define()` wrapper catches). The runner owns timeouts/deadline; nothing in
  the client turns a duration into a pass bit.

## 1. Harness, repos, and shared setup

### 1.1 Per-check harness (`harness()`, `repoWithInitialCommit()`)

- Each check creates its **own** repo, deterministically named `gitconf-<slug>`,
  under the scenario viewer's login (`context.scenario.viewer.login`), via
  `client.createRepo()` (§1.3). Checks are independent and can run in any order,
  one at a time. Check ids are `git.<slug>` (e.g. `git.advertise-v2`).
- `GitClient` per check: `baseUrl = context.baseUrl`, `token = context.token`,
  `timeoutMs = max(1, min(context.timeoutMs || 8000, 8000))` — i.e. **per-request
  timeout is 8000 ms max** (`DEFAULT_GIT_TIMEOUT_MS = 8000`). The v0-only client
  used in `advertise-headers` is built with `gitProtocol: 0`.
- `repoWithInitialCommit(context, slug, files?)`: pushes **one commit on
  `refs/heads/main`** (old `000…0` → tip) and throws `setup push … failed: …` if
  the report is not `ok` — a setup failure fails the whole check. Most checks
  start here. `push-100-files` and `clone-empty` / `push-first-commit` use
  `harness()` directly (no initial commit).
- `pushRefs()` (the harness push helper): before pushing it `GET`s the
  receive-pack advertisement, computes the set of objects reachable from the
  advertised tips **using the local repo as lookup**, and sends **only objects
  the server does not already reach**. If any advertised tip is missing locally,
  it sends everything reachable from the new tips. Consequence: the server must
  advertise accurate tips (else the client sends redundant objects — harmless),
  and must accept packs that contain already-held objects (idempotent store).
  After a push, it updates its local ref mirror **only for report lines with
  `ok: true`**.
- Scenario data: every path, blob content, commit message, author and timestamp
  comes from `context.scenario` (`wire.ts` `buildScenario()`, seed
  `SCENARIO_SEED = 0x6a09e667f3bcc909n`, `SCENARIO_EPOCH_SEC = 1735689600` =
  2025-01-01). Live, replay and practice runs see byte-identical repos, so object
  ids are reproducible. Commit identity is `<viewer.name> <viewer.email>`,
  timestamps are `template.epochSec + revision` (revision 0–3), timezone `+0000`.
  Blob sizes used: ~4 KiB (`scenarioSizedFile(…, 4096)`), 2048, 20000 bytes;
  `scenarioManyFiles` builds 100 distinct paths.

### 1.2 Local repo model the checks compare against (`LocalRepo`)

- Files → blob (`100644`), dirs → tree (`40000`), nested via path segments.
  Tree entries are built with `buildTree()` (git sort: a directory name compared
  as if it ended in `/`).
- Commit bytes (`buildCommit`): `tree <oid>\n`, `parent <oid>\n` (0+),
  `author <who> <ts> +0000\n`, `committer <who> <ts> +0000\n`, blank line,
  message (forced to end `\n`). Default identity `Conformance <conformance@make.fun>`
  is only the fallback; checks pass the scenario identity.
- Annotated tag bytes (`buildTag`): `object <oid>\ntype commit\ntag <name>\n
  tagger <who> <ts> +0000\n\n<message>` (message forced to end `\n`).
- Reachability (`collectReachable`): commit → tree + parents; tree → entries
  (mode `160000` gitlinks skipped); tag → target; blob → nothing. Throws
  `missing-object` on a gap.

### 1.3 Repo creation through REST (`GitClient.createRepo`)

- `POST <baseUrl>/api/v3/user/repos`, headers `User-Agent: makefun-git-client/1.0`,
  `Accept: application/vnd.github+json`, `Content-Type: application/json`,
  `Authorization: Bearer <token>` (when a token is set), body:
  `{"name": "<repo>", "description": "git conformance for <owner>/<name>",
  "private": true, "auto_init": false}`.
- Success: HTTP **201 or 200**. **422 with a body matching `/already exists/i`**
  is accepted (idempotent re-run). Anything else throws `GitHttpError`.
- The git checks never test repo creation itself; a creation failure throws out
  of the check (fail). `auto_init: false` — the repo is born **empty, no refs**,
  HEAD unborn pointing at `main` (`DEFAULT_BRANCH = 'main'` in `wire.ts`).

## 2. Smart-HTTP endpoints and framing

### 2.1 URLs

- Repo path: `/<owner>/<repo>.git` (`repoPath()`). Owner and repo must match
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/` and repo must not end in `.git` — this is
  **client-side validation**; the server need not enforce it, but must serve
  exactly this path shape.
- `GET /<owner>/<repo>.git/info/refs?service=<git-upload-pack|git-receive-pack>`
- `POST /<owner>/<repo>.git/git-upload-pack`
- `POST /<owner>/<repo>.git/git-receive-pack`
- The client refuses any URL not under its base URL and uses `redirect: 'error'`
  — **never redirect**; a redirect is a fetch failure.

### 2.2 HTTP headers the client sends (every request)

| Header | Value / rule |
|---|---|
| `User-Agent` | `makefun-git-client/1.0` (`GIT_CLIENT_AGENT`) |
| `Accept` | `*/*` on `GET /info/refs`; `application/x-<service>-result` on POSTs; `application/vnd.github+json` on repo creation |
| `Content-Type` | `application/x-<service>-request` on POSTs (never on GET) |
| `Content-Length` | exact body byte length, always set on POSTs (client sends a `Buffer` body; chunked request bodies are never used) |
| `Git-Protocol` | `version=2` **only** when requesting v2 (see §2.3); otherwise absent |
| `Authorization` | `Bearer <token>` on **all** requests including git ones, when a token is set |

Response requirements (enforced by `expectOk` / `advertisement` / `infoRefs`):

| Call | Required status | Required `Content-Type` (case-insensitive `includes`) |
|---|---|---|
| `GET /info/refs` (upload) | 200 (404 for missing repo, §5.1) | `application/x-git-upload-pack-advertisement` |
| `GET /info/refs` (receive) | 200 (404 for missing repo) | `application/x-git-receive-pack-advertisement` |
| `POST /git-upload-pack` | 200 | `application/x-git-upload-pack-result` |
| `POST /git-receive-pack` | 200 | `application/x-git-receive-pack-result` |

Notes: `infoRefs()` itself does **not** throw on non-200 — it returns
`{status, contentType, packets: [], bodySnippet}` so checks can assert 404.
`advertisement()` and `post()` **do** throw: non-200 → `GitHttpError`
(`"<url> returned HTTP <status>: <400-char snippet>"`); wrong content-type →
`GitProtocolError` code `content-type`. A `null` content-type is **not** checked
in `advertisement()` (`raw.contentType !== null && !includes…`) but `expectOk`
on POSTs checks it unconditionally (`contentType !== null` guard is only in
`advertisement`; in `post()` the check is `contentType !== null && !includes`,
same shape — actually `expectOk(response, url, response.headers.get('content-type'), …)`
with `if (contentType !== null && !includes…)`; so a missing content-type
passes both paths, but serve the correct type anyway). A charset suffix is fine
(`includes`, not equality).

### 2.3 Protocol selection

- `infoRefs()`: `Git-Protocol: version=2` is sent **only** for `git-upload-pack`
  when the client's `gitProtocol` preference is not `0`. For `git-receive-pack`
  the header is **never** sent. The v0-only client (`gitProtocol: 0`) never sends it.
- `advertisement()` then: if the server answers v2 while preference is `0` →
  throw `protocol-mismatch`; if it answers v0 while preference is `2` → throw
  `protocol-v2-required` ("server does not support protocol v2"). Default
  preference is `auto`: v2 when advertised, else v0.
- `lsRefs()` / `fetch()`: first `GET /info/refs` (v2 requested); if the
  advertisement is v0 they run the v0 path, else the v2 path.
- `push()`: first `GET /info/refs?service=git-receive-pack`; if the advertisement
  is not v0 → throw `push-protocol` ("receive-pack must advertise protocol v0").
- **Server rule:** answer v2 to an upload-pack `info/refs` **iff** the request
  carries `Git-Protocol: version=2`; answer v0 otherwise. Answer v0 to
  receive-pack `info/refs` always.

### 2.4 pkt-line codec (exact)

- Data packet: 4 ASCII lowercase-hex bytes = payload length + 4, then payload.
  Max packet 65520 bytes total (`PKT_LINE_MAX`), payload ≤ 65516.
  `0000` = flush, `0001` = delim, `0002` = response-end. `0003` is invalid.
- The client decoder (`PktLineDecoder`) is **strict**: a non-hex 4-byte header →
  throw `pktline-header` (`invalid pkt-line length "<4 bytes>"`); a length
  > 65520 → `pktline-too-long`; a truncated packet at end of stream →
  `pktline-truncated`; bytes after `finish()` → `pktline-after-end`; trailing
  bytes after a complete decode are an error (except the v0 raw-pack fallback,
  which the client only uses when the next 4 bytes are not a hex length).
- Server responses must be **exactly framed, no trailing bytes**. A single
  malformed packet fails the whole call (the check fails, it does not retry).
- Text lines inside pkt-lines end with `\n` (e.g. `version 2\n`, `want <oid>\n`).
  The client's parsers strip one trailing `\n` (`replace(/\n$/, '')`).

### 2.5 v0 advertisement format

Body = pkt-lines, first data packet is the preamble:

```
# service=git-upload-pack\n        (or # service=git-receive-pack\n)
0000                                (flush after the preamble)
<oid> <ref>\0<capabilities space-separated>\n     <- first ref line carries caps after NUL
<oid> <ref>\n
<oid> <ref>^{}\n                    <- peeled tag: commit oid + "^{}" suffix
0000
```

- Capabilities live **only** on the first ref line, after a literal NUL byte.
  Tokens are space-separated, `key` or `key=value` (`parseCapabilityList`).
- Empty repo: the first (only) line is
  `0000000000000000000000000000000000000000 capabilities^{}\0<caps>\n`
  (zero oid, pseudo-ref `capabilities^{}` — the client skips it). A zero-oid ref
  is recorded as `unborn: true`.
- HEAD: a line `<oid> HEAD\n` plus capability `symref=HEAD:refs/heads/main`
  on the first line. The client sets `symrefTarget` only from that capability
  (`symref.slice(5)` when it starts with `HEAD:`), and `headSymref` from it.
  Without the capability, HEAD has no symref target (checks that read HEAD
  through v0 would fail — but all HEAD assertions go through v2 `ls-refs`).
- **Upload-pack v0 caps (required):** `side-band-64k`. Recommended also:
  `ofs-delta`, `shallow`, `symref=HEAD:refs/heads/main`,
  `agent=<something>` (client sends `agent=…` lines only if `agent` is
  advertised). `multi_ack` / `multi_ack_detailed` are optional (client requests
  `multi_ack_detailed` if advertised, else `multi_ack`).
- **Receive-pack v0 caps (required):** `report-status`, `side-band-64k`,
  `delete-refs`. Recommended also: `ofs-delta`, `agent=…`. Do **not** advertise
  `report-status-v2` unless you implement its `option` lines (client prefers it
  when present; plain `report-status` is simpler and sufficient).

### 2.6 v2 advertisement format

Body = pkt-lines. No `# service=` preamble is required; the first data packet
must be `version 2\n` (the `advertise-headers` check accepts `# service=…` as
the first line of a v2-requested response too, but treats it as "the server
answered v0 to the v2 request" — only `advertise-v2` owns that failure; serve
`version 2`).

```
version 2\n
<capability>[=<value>]\n
...
0000
```

- Required capabilities: **`fetch`** and **`ls-refs`** (missing either fails
  `advertise-v2` with `the v2 advertisement is missing fetch, ls-refs (saw …)`).
  If `object-format` is present it must be `sha1` (else `advertise-v2` fails with
  `object-format <x>: the rules require sha1`).
- The client reads feature tokens from the **value** of the capability:
  `fetch` value is split on spaces; `shallow` is required in it whenever a
  fetch/clone carries `depth` (client throws `fetch-shallow` before sending
  otherwise), `filter` is required only if a `filter` is requested (never by
  these checks). `ls-refs` value is split on spaces; `unborn` is required in it
  for the client to send the `unborn` argument. **Advertise
  `fetch=shallow` and `ls-refs=unborn`.** Also advertise `agent` and
  `object-format=sha1` if you want the client to echo `agent=` /
  `object-format=sha1` lines (optional; harmless either way).
- v2 capability lines are parsed as `key` or `key=value` on the **first** `=`;
  a line `version 2` (or starting `version 2 `) is the version line, skipped.
  Empty lines are skipped.

## 3. The 30 checks (in run/registration order)

`MAX_DETAIL = 600`: every detail string is truncated to 600 chars. A check's
`timeoutMs` is its per-check budget (5–15 s); the per-request timeout inside is
≤ 8000 ms (§1.1). "Setup" = pushes via `pushRefs()`/`repoWithInitialCommit()`
that must succeed or the check fails with `setup push failed: …`.

### 3.1 Advertisement & discovery (checks 1–6)

**1. `git.advertise-v2` (5000 ms)** — "protocol v2 capability advertisement is served
and well formed". Setup: repo + 1 commit on `main`. Sends: `GET /info/refs?
service=git-upload-pack` with `Git-Protocol: version=2`. Asserts:
`advertisement.protocol === 2`, else fail
`the server answered protocol v0; the rules require Git-Protocol: version=2 to be honoured`;
capabilities contain `fetch` and `ls-refs`, else
`the v2 advertisement is missing <names> (saw <sorted caps>)`; if
`object-format` present and ≠ `sha1`, fail. Pass detail:
`protocol v2; capabilities: <sorted, comma-separated>`.

**2. `git.advertise-receive-pack` (5000 ms)** — "receive-pack serves a v0 ref
advertisement with push capabilities". Setup: repo + 1 commit (`tip`). Sends:
`GET /info/refs?service=git-receive-pack`. Asserts: protocol is 0, else
`receive-pack answered protocol v<2>; it is v0-only`; a ref
`refs/heads/main` with oid exactly `tip`, else
`the advertisement does not list refs/heads/main at <tip[:8]> (refs: <names>)`;
caps contain `report-status`, `side-band-64k`, `delete-refs`, else
`receive-pack is missing <names> (saw <sorted caps>)`.

**3. `git.advertise-headers` (5000 ms)** — "info/refs answers the smart-HTTP
content type and preamble". Setup: repo + 1 commit. Sends three `infoRefs`
calls: v0 client (`gitProtocol: 0`) upload-pack; default client upload-pack
(v2 requested); default client receive-pack. Asserts, for each of
`v0 upload-pack` / `v2 upload-pack` / `receive-pack`: status 200 and
content-type includes `application/x-git-upload-pack-advertisement` (both
upload calls) / `application/x-git-receive-pack-advertisement`. First data
packet: v0 upload must be `# service=git-upload-pack` **or** `version 2`
(the check accepts either — a v2 answer to a v0 request is not failed here);
receive-pack must be exactly `# service=git-receive-pack`; v2 upload must be
`# service=git-upload-pack` **or** `version 2`. Failure strings are e.g.
`the v0 request's body starts with "<line>", neither the service preamble nor "version 2"`.
Pass detail notes `(the server answered v0 to the v2 request; git.advertise-v2 owns that)`
when the v2 call returned the v0 preamble — i.e. this check **passes** even if
v2 is missing; only `advertise-v2` fails for that.

**4. `git.unknown-repo-404` (5000 ms)** — "a missing repository advertises 404
and the server stays up". Setup: repo `gitconf-unknown-repo` + 1 commit.
Sends: `infoRefs` upload-pack and receive-pack for `<repo>-missing` (a name
that was never created). Asserts: **both return HTTP 404**, else
`upload-pack advertisement of a missing repo returned HTTP <n>, not 404`
(same for receive). Then `infoRefs` on the known repo must still be 200, else
`the server stopped serving a known repo afterwards (HTTP <n>)`.

**5. `git.ls-refs` (8000 ms)** — "v2 ls-refs reports refs, HEAD symref and peeled
tags". Setup: 1 commit (`tip`); second commit on `main`; annotated tag `v1`
(object `tag`) pointing at `second`; one push of both refs. Sends: v2 `ls-refs`
with `peel: true, symrefs: true` (and `unborn`, since the default is
`unborn !== false`). Asserts: `listed.protocol === 2`, else
`ls-refs needs protocol v2; the server answered v<0>`; `refs/heads/main` oid
is `second`; a `HEAD` ref with `symrefTarget === 'refs/heads/main'`, else
`HEAD does not report symref-target refs/heads/main (saw <json|null>)`;
`refs/tags/v1` oid is the tag object; `tagRef.peeled === second`, else
`refs/tags/v1 peels to <short|none>, not <short>`.

**6. `git.ls-refs-prefix` (8000 ms)** — "v2 ls-refs honours ref-prefix filtering".
Setup: 1 commit + annotated tag `v1` on it. Sends three v2 `ls-refs` calls with
prefixes `['refs/heads/']`, `['refs/tags/']`, `['refs/does-not-exist/']`.
Asserts (on `rawRefs` — the refs **before** the client's own prefix filter, so
the server must filter server-side): every ref in the heads answer starts with
`refs/heads/`; `refs/heads/main` at `tip` present; every ref in the tags answer
starts with `refs/tags/`; `refs/tags/v1` at the tag oid present; the unmatched
prefix returns **0** refs. Note: `HEAD` does **not** start with `refs/heads/`,
so it must **not** appear in the `refs/heads/` answer.

### 3.2 Clone (checks 7–13)

**7. `git.clone-empty` (8000 ms)** — "a repository with no refs clones as an empty
repository". Setup: fresh repo, **no push**. Sends: upload-pack advertisement;
if v2, `ls-refs`, else the advertisement's ref list. Asserts: no ref whose name
starts with `refs/` (else `a fresh repo already advertises <names>`); then
`clone()`: `clone.objects.size === 0`, else `an empty clone fetched <n> object(s)`;
`clone.pack === null || clone.packBytes === 0`, else
`an empty clone fetched a <n>-byte pack`. Pass detail records
`unborn HEAD → <target>` when a HEAD symref is known. (The client short-circuits:
with zero wants it returns an empty clone **without any fetch POST**, so the
server only has to answer advertisement + `ls-refs` correctly. For v2 `ls-refs`
on an empty repo, return the HEAD line as unborn — see §4.3.)

**8. `git.push-first-commit` (8000 ms)** — "a first commit pushes to an unborn
branch and becomes the tip". Setup: fresh repo. Sends: push
`{old: 000…0, new: tip, ref: refs/heads/main}`. Asserts: `report.unpackOk`,
else `unpack failed: <detail|no report>`; report line for `refs/heads/main`
is `ok`, else `report-status did not accept the first push: <pushFailure>`;
then `ls-refs`: `refs/heads/main` at `tip`; `HEAD` symref-target is
`refs/heads/main`, else `HEAD does not resolve to refs/heads/main after the first push`.

**9. `git.clone-object-hashes` (12000 ms)** — "a full clone verifies object-for-object".
Setup: 2 files, 3-commit chain (`tip → second → third`) on `main`. Sends:
full `clone()`. Asserts: every cloned object's SHA-1 recomputes
(`hashMismatches`, else `<n> cloned object(s) do not recompute to their id: <short>`),
`clone.objects` contains `third`; the reachable closure from `third` is complete
inside the clone (`missingClosure`, else `the clone's reachable graph is incomplete: …`);
every object reachable locally from `third` is present (else
`<n> reachable object(s) are missing from the clone: <short>`). Pass detail:
`cloned <n> objects (<deltas> deltas, <packBytes> bytes); every SHA-1 recomputed;
the closure of <tip[:8]> is complete`.

**10. `git.clone-blob-bytes` (12000 ms)** — "every cloned blob equals the pushed bytes".
Setup: 4 KiB blob (rev 0) + a second file, then a second commit (4 KiB blob rev 1,
extra file). Sends: full clone. Asserts: reachable comparison — no missing, no
byte-different objects (`<n> object(s) differ byte-for-byte: …`). Pass detail:
`<n> blob(s) byte-identical across <n> objects`.

**11. `git.clone-tree-entries` (12000 ms)** — "cloned trees round-trip paths, modes
and nested directories". Setup: 4 files, the first forced into a nested path
(`src/<blob-0-path>` if the blob path has no `/`). Sends: full clone. Asserts:
the tip commit and root tree exist; root entry **names** (sorted) equal the
sorted set of first path segments; the first directory entry has mode exactly
`40000` (else `<dir> has mode <m>, not 40000`); that subtree exists and its entry
names equal the expected set; no byte-different reachable objects.

**12. `git.clone-commit-bytes` (12000 ms)** — "commit objects round-trip byte-exactly
with their metadata". Setup: 1 commit, then a second commit (rev 1, meta index 1,
revision 3). Sends: full clone. Asserts: tip commit bytes `Buffer.equals` the
pushed bytes; parsed parents are exactly `[tip]`; parsed message equals the
expected message (with trailing `\n`); author **and** committer contain the
string `<timestamp> +0000`; author contains the viewer email. Any deviation fails
with the actual value quoted (e.g. `the message is "<actual>"`).

**13. `git.clone-annotated-tag` (10000 ms)** — "an annotated tag object round-trips
and peels to its commit". Setup: 1 commit + annotated tag `v1` on it. Sends:
push tag, full clone, then `ls-refs` with `peel: true`. Asserts: tag object
present in the clone and byte-identical; parsed tag headers
`object === tip`, `type === 'commit'`, `tag === 'v1'` (else
`the tag headers are {"object":…,"type":…,"tag":…}`); tagger contains the viewer
email; `ls-refs` shows `refs/tags/v1` at the tag oid and `peeled === tip`.

### 3.3 Fetch & shallow (checks 14–18)

**14. `git.fetch-incremental` (12000 ms)** — "an incremental fetch sends only the new
objects and advances the tip". Setup: 2 files, 1 commit; full clone; second commit
(3 files) pushed. Sends: `fetch({wants: [second], haves: [tip], haveObjects: <clone objects>})`.
Asserts: `second` present; `tip` **absent** (`the incremental fetch re-sent the old tip`);
all fetched hashes recompute; every object in `reachable(second) − reachable(tip)`
present; **no** object from `reachable(tip)` re-sent
(`<n> already-held object(s) were re-sent: …`). Pass detail:
`<n> new object(s) (<packBytes> bytes, <deltas> deltas); the old tip was not re-sent`.

**15. `git.fetch-nothing-new` (10000 ms)** — "a fetch with the tip already held
transfers no objects". Setup: 1 commit; full clone. Sends:
`fetch({wants: [tip], haves: [tip], haveObjects: <clone objects>})`. Asserts:
`fetched.objects.size === 0`, else `the fetch delivered <n> object(s) that were already held`.
(Pass detail anticipates `a <packBytes>-byte pack with no entries` — either an
empty pack or no packfile section satisfies this; see §6.4.)

**16. `git.fetch-shallow-depth1` (12000 ms)** — "a depth-1 shallow clone lands the tip
only". Setup: 3-commit chain on `main`. Sends: `clone({depth: 1})`. Asserts:
`third` present and byte-identical; `second` **and** `tip` absent
(`the shallow clone carried history beyond depth 1 (parent…/grandparent…)`); the
tip's tree present and all its blobs present; `shallow.shallow` includes `third`
(`shallow-info did not name the tip (shallow: <list|none>)`).

**17. `git.fetch-shallow-deepen` (12000 ms)** — "deepen 2 extends a shallow clone by
exactly one generation". Setup: 3-commit chain; depth-1 clone (asserted to be
exactly at depth 1). Sends: `fetch({wants: [third], haves: [third],
shallow: <depth-1 shallow list>, depth: 2, haveObjects: <shallow objects>})`.
Asserts: `second` delivered and byte-identical; `tip` absent
(`deepen 2 delivered the grandparent …`); the boundary moved:
`deepened.shallow` includes `second` **or** `deepened.unshallow` includes `third`
(`shallow-info did not move the boundary (shallow=… unshallow=…)`); the delivered
parent's tree present.

**18. `git.fetch-shallow-new-tip` (12000 ms)** — "a shallow fetch of a new tip does
not pull the old history". Setup: 2-commit chain; depth-1 clone (shallow boundary
`[second]`); third commit pushed. Sends: `fetch({wants: [third], haves: [second],
shallow: [second], depth: 1, haveObjects: <shallow objects>})`. Asserts: `third`
delivered; `tip` absent (`the shallow fetch pulled the old history (…)`); `second`
absent (`the shallow fetch re-sent the already-held parent`).

### 3.4 Push (checks 19–25)

**19. `git.push-update-ref` (10000 ms)** — "a fast-forward update moves a branch and
clones see it". Setup: 1 commit; second commit pushed `{old: tip, new: second,
ref: refs/heads/main}`. Asserts: `unpackOk`; report `ok` for `main`, else
`the fast-forward update was refused: <pushFailure>`; `ls-refs` shows `main` at
`second`; a full clone contains `second`.

**20. `git.push-create-branch` (10000 ms)** — "creating a branch from an existing
commit is reported and advertised". Setup: 1 commit. Sends: push
`{old: 000…0, new: tip, ref: refs/heads/feature}` (no new objects needed — the
client sends only objects the server lacks, i.e. none). Asserts: `unpackOk`;
report `ok`; `ls-refs` shows `refs/heads/feature` at `tip`; a full clone's refs
include `refs/heads/feature` at `tip`.

**21. `git.push-delete-branch` (10000 ms)** — "deleting a branch is reported and
removes the ref". Setup: 1 commit; `feature` created at `tip`. Sends: push
`{old: tip, new: 000…0, ref: refs/heads/feature}` (delete-only: **no pack** is
sent, §4.5). Asserts: `unpackOk`; report `ok`; `ls-refs` no longer lists
`refs/heads/feature`; `refs/heads/main` still at `tip`; repo still clonable
(clone contains `tip`).

**22. `git.push-non-fast-forward` (10000 ms)** — "a non-fast-forward update is refused
per-ref and changes nothing". Setup: 1 commit; `second` (child of `tip`) pushed
to `main`. Then a **sibling** commit (child of `tip`, different content) is pushed
directly via `client.push` with `{old: second, new: sibling, ref: refs/heads/main}`
and **all** objects reachable from `sibling` (bypassing `pushRefs`). Asserts:
`refused.report.unpackOk === true` (a refused update must still unpack — else
`a refused update must still unpack: <detail|no report>`); report line exists
and `ok === false`, else `the non-fast-forward update was accepted: <refs json>`;
`report.reason === 'non-fast-forward'` exactly, else
`the refusal reason is "<reason>", not non-fast-forward`; `ls-refs` still shows
`main` at `second` (`the refused push moved refs/heads/main`); `infoRefs`
upload-pack still 200 (`the server stopped serving advertisements (HTTP <n>)`);
a full clone still contains `second`.

**23. `git.push-mixed-report` (12000 ms)** — "one command list reports ok and ng per
ref, and applies only the ok one". Setup: 1 commit; `main` → `second`,
`side` created at `second` (one push, two commands, both `ok`). Then one push
with two commands: `{old: second, new: forward, ref: refs/heads/main}` (FF,
child of `second`) and `{old: second, new: sibling, ref: refs/heads/side}`
(non-FF, child of `tip`), with the union of reachable objects. Asserts:
`unpackOk`; `main` report `ok` (else `the fast-forward half was refused: <reason|missing>`);
`side` report exists and `ok === false` (else `the non-fast-forward half was accepted`);
`side` reason is exactly `non-fast-forward`; **`mixed.report.refs.length === 2`**
(one line per command, no more, no fewer); `ls-refs`: `main` at `forward`,
`side` still at `second` (`the refused ref moved`).

**24. `git.push-delete-tag` (10000 ms)** — "deleting a tag ref is reported and removes
the ref". Setup: 1 commit; annotated tag `v1` created. Sends: delete push
`{old: <tag oid>, new: 000…0, ref: refs/tags/v1}`. Asserts: `unpackOk`; report
`ok`; `ls-refs` no longer lists `refs/tags/v1`. (Pass detail: `refs/tags/v1 deleted;
refs/heads/main untouched` — main is not re-checked by an assertion here, but
do not touch it.)

**25. `git.push-100-files` (15000 ms)** — "a 100-file single-commit push round-trips
byte-exactly". Setup: fresh repo; one commit with 100 files (paths derived from
the 60 scenario paths, disambiguated with `.1`, `.2`, … suffixes before the
extension; contents `<blob content>\nfile <i> revision 1\n`). Sends: first push
to `main`, then full clone. Asserts: `unpackOk`; report `ok`; reachable
comparison — no missing, no byte-different objects; then a path-by-path walk of
the cloned trees: every one of the 100 paths resolves to a blob whose bytes equal
the pushed bytes (`the cloned bytes for <path> differ` / `the cloned tree is missing
the path <path>`). Pass detail: `100 files byte-identical; <n> objects; every SHA-1 recomputed`.

### 3.5 Pack & robustness (checks 26–30)

**26. `git.pack-integrity` (12000 ms)** — "a fetched pack is structurally valid and
checksummed". Setup: 2 KiB blob, 2-commit chain. Sends: `fetch({wants: [second],
parse: false})` — the raw pack is kept, not parsed by the client fetch path.
Asserts: `fetched.pack` non-null (`the fetch delivered no pack`);
`verifyPackChecksum` ok (else `the pack trailer <actual> does not match the bytes <expected>`);
`readPack`: `declaredCount === entries.length`; `objects.size === declaredCount`
(**no duplicate entries for one oid** — see §6.1); version is 2 or 3; every
object's SHA-1 recomputes. Pass detail:
`<packBytes> bytes, version <v>, <count> objects (<deltas> deltas), trailer <first 12 hex> verified`.

**27. `git.pack-deltas` (15000 ms)** — "delta-compressed objects resolve correctly
(when the server sends them)". Setup: 20 KiB blob, 4-commit chain (rev 0–3, each
pushing a new revision of the same large blob). Sends: full clone. Asserts: tip
present; all hashes recompute; reachable comparison byte-identical. **No
assertion requires `deltaCount > 0`** — the parenthetical in the title is literal:
sending plain (undeltified) objects passes. Deltas are optional for the server;
accepting them on push is unnecessary because the client never sends deltas (§6.2).

**28. `git.sideband-framing` (12000 ms)** — "the fetch packfile section is valid
sideband framing". Setup: 4 KiB blob, 2-commit chain. Sends:
`fetch({wants: [second], parse: false, observe: <record every packet>})`.
Asserts, over the observed packets: no pkt-line longer than 65520 bytes
(`a pkt-line is <n> bytes, over 65520`); section tracking — after a flush/delim
the section resets; a `packfile\n` line opens the packfile section,
`acknowledgments\n` / `shallow-info\n` / `wanted-refs\n` open control sections
(a v0 response has no section names: after NAK/ACK the sideband packets follow
directly); inside the packfile section every packet is non-empty and its first
byte is a band 1, 2 or 3 — band 1 bytes are pack data, band 2 bytes are progress
(counted, not asserted), band 3 fails with
`the server sent a sideband error: <text>`; any other band fails with
`invalid sideband band <n>`; at least one sideband packet, else
`the fetch response had no packfile sideband packets`; the reassembled band-1
bytes are non-empty and parse as a pack whose trailer checksum verifies.

**29. `git.push-sideband-report` (12000 ms)** — "the push report arrives in valid
sideband frames". Setup: 1 commit; second commit pushed via `pushRefs`. Asserts:
`pushed.sideband === true` — i.e. the client included `side-band-64k` in its
command capabilities, which it does **only if the server advertised it**
(`the server did not advertise side-band-64k for receive-pack`); `unpackOk`;
report `ok` for `main`. (The report bytes themselves are demuxed from band 1
by the client; a non-sideband report would still parse, but `sideband === false`
fails the check. The server must therefore both advertise `side-band-64k` **and**
actually frame the report in band-1 sideband packets — §4.5.)

**30. `git.repo-survives-errors` (15000 ms)** — "the server stays healthy through
404s, refusals and a malformed request". Setup: repo + 1 commit. Sequence:
(a) `infoRefs` for `<repo>-missing` → must be 404; (b) second commit pushed
to `main` (setup must succeed); (c) a non-FF sibling push is attempted — **either
verdict is survivable** (the check records `an accepted non-fast-forward update`
or `ng <reason|unreported>` in the pass detail; refusal correctness is
`push-non-fast-forward`'s job, not this check's); (d) a malformed POST:
`postRaw(owner, repo, 'git-upload-pack', Buffer.from('zzzznot-a-pkt-line'))` —
19 bytes, not a valid pkt-line; the result is only recorded
(`HTTP <status>` or the thrown error's description) — **any** status or a
thrown error is acceptable, but the server process must survive it; (e) after
all that: `infoRefs` upload-pack is 200; `ls-refs` still lists `refs/heads/main`;
a full clone contains that tip, all hashes recompute, and the reachable closure
is complete.

## 4. Protocol v2 — exact request/response shapes

### 4.1 `ls-refs` (v2)

Request body (pkt-lines), built by `lsRefs()`:

```
command=ls-refs\n
agent=makefun-git-client/1.0\n      <- only if 'agent' capability advertised
object-format=sha1\n                <- only if 'object-format' capability advertised
0001                                 (delim)
peel\n                               <- sent unless peel === false (checks: peel true)
symrefs\n                            <- sent unless symrefs === false (checks: symrefs true)
unborn\n                             <- sent only if the 'ls-refs' capability VALUE contains 'unborn'
ref-prefix <prefix>\n                <- one per requested prefix, in order
0000                                 (flush)
```

Response: pkt-lines, one per ref, then flush (the client streams until the
response ends; it does not require a specific terminator, but end with a flush):

```
<oid> <ref>[ symref-target:<target>][ peeled:<oid>]\n
unborn <ref>[ symref-target:<target>]\n     <- for unborn refs (zero oid)
```

Parsing is strict: a line with no space throws `ls-refs`; a first token that is
not `unborn` and not a lowercase 40-hex oid throws `ls-refs`. Attributes after
the ref name are space-separated `symref-target:…` / `peeled:…` tokens; unknown
tokens are ignored. The client keeps `rawRefs` (everything sent) and `refs`
(client-side prefix filter) separately — §3.1 check 6 asserts on `rawRefs`, so
**filter server-side by `ref-prefix`** (a ref is returned iff its name starts
with at least one requested prefix; with no prefix, return all). `HEAD` must be
returned on an unprefixed call (with `symref-target:refs/heads/main`), and must
**not** be returned for prefix `refs/heads/` (it does not start with it).
`peel` handling: when `peel` was requested, an annotated-tag ref carries
`peeled:<target commit oid>`; when `peel` was not requested, omit it (the client
stores whatever is sent; checks always request peel when they assert it).
`unborn` handling: HEAD on an empty repo is `unborn HEAD symref-target:refs/heads/main`;
a born HEAD is `<tip-oid> HEAD symref-target:refs/heads/main`.

### 4.2 `fetch` (v2)

Request body (pkt-lines), built by `fetchV2()` — **one request, no multi-round
negotiation** (`done` is sent immediately):

```
command=fetch\n
agent=makefun-git-client/1.0\n      <- only if 'agent' advertised
object-format=sha1\n                <- only if 'object-format' advertised
0001                                 (delim)
thin-pack\n                          <- always (thinPack !== false; checks never set false)
no-progress\n                        <- always (noProgress !== false)
ofs-delta\n                          <- ALWAYS, unconditionally
filter <spec>\n                      <- only if filter requested (never by these checks)
want <oid>\n                         <- one per want, deduplicated, in order
have <oid>\n                         <- one per have
shallow <oid>\n                      <- one per current shallow boundary (deepen only)
deepen <n>\n                         <- only when depth is set
deepen-since <ts>\n / deepen-not <ref>\n   <- never sent by these checks
done\n
0000
```

Response sections (pkt-lines). Section headers are data packets containing
exactly e.g. `acknowledgments\n`; a flush (`0000`) or delim (`0001`) resets the
section to "none". The client's `parseV2Fetch` throws `fetch-section` on any
unexpected section header or any packet in an unknown section, and throws
`sideband` if the packfile section carried zero packets. Section order in the
client's parser is free (it dispatches on the header line), but use the
conventional order: `acknowledgments`, `shallow-info`, `wanted-refs`, `packfile`.

```
acknowledgments\n
NAK\n                                <- no haves, or no common objects
ACK <oid>\n                          <- per acknowledged have (optional; see §7.5)
ready\n                              <- with ACKs when done (optional; see §7.5)
0000
shallow-info\n                       <- include only when shallow boundaries exist
shallow <oid>\n                      <- one per new boundary commit
unshallow <oid>\n                    <- one per previously-shallow commit now fully present
0000
wanted-refs\n                        <- optional; never asserted by these checks
<oid> <ref>\n                        <- one per want that resolved to a ref (?)
0000
packfile\n
<sideband pkt-lines: 1-byte band + data>...
0000
```

- `acknowledgments` lines: exactly `NAK`, `ACK <oid>` (the client stores
  `line.slice(4).trim()`), or `ready`. Anything else throws `fetch-ack`.
- `shallow-info` lines: exactly `shallow <oid>` / `unshallow <oid>`; anything
  else throws `fetch-shallow`.
- `packfile` section: every packet's first byte is the sideband band (§6.3).
  An empty packet throws `sideband`. Band 3 throws `sideband-error` with the
  server's text. After the packfile section, the pack bytes (band-1
  concatenation) must have a valid trailer checksum or the client throws
  `pack-checksum` — **before** parsing objects. With `parse: false`
  (`pack-integrity`, `sideband-framing`) the checksum is still verified but the
  pack is not parsed.
- If there is no pack to send (fetch-nothing-new): either **omit the packfile
  section entirely** (pack = null, 0 bytes — passes) or send a valid **empty
  pack** (32 bytes: header + trailer, 0 objects). Do **not** send an empty
  packfile section (0 sideband packets → client throws `sideband`).
- The client verifies the checksum even when `parse: false`; it parses the pack
  (resolving REF_DELTA bases against `haveObjects`) only when `parse !== false`.

### 4.3 `clone` (client-side composition — what the server sees)

`clone()` = advertisement → (`ls-refs` with `peel: true, symrefs: true` if v2,
else the v0 ref list) → one `fetch()`:

- Full clone (`depth` unset, `singleBranch` unset): wants = every
  `refs/heads/*` and `refs/tags/*` oid (zero oids skipped), deduplicated.
  So the pack must contain the closure of **all** branch tips **and** all tag
  objects (annotated tag objects themselves, plus their targets).
- Shallow clone (`depth: 1`): wants = the HEAD tip only (the ref whose name is
  the HEAD symref target, else the first `refs/heads/*`). `fetch` carries
  `deepen 1`. For a depth-1 clone of an **empty** repo, wants is empty and the
  client returns early with no fetch at all.
- `clone.head` = the HEAD symref target from `ls-refs` (v2) or the v0
  `symref` capability. `clone.refs` = the full ref list from `ls-refs`/advertisement.

### 4.4 `fetch` (v0 fallback — implement, it is cheap)

The client uses this only if the upload-pack advertisement is v0. Request:
**two sections**, wants first, then negotiation — a single section is a v2 shape
and the comment warns upload-pack would answer "expected to get object ID, not 'done'":

```
want <oid> side-band-64k [multi_ack_detailed|multi_ack] [thin-pack] [no-progress] [ofs-delta]\n
   <- capabilities ONLY on the FIRST want line, space-joined after the oid
want <oid>\n                         <- further wants, bare
shallow <oid>\n                      <- current boundaries
deepen <n>\n                         <- only if 'shallow' advertised, else client throws first
deepen-since <ts>\n / deepen-not <ref>\n
0000                                 (flush — end of section 1)
have <oid>\n                         <- negotiation
done\n
0000                                 (flush — end of section 2)
```

Capability negotiation on the first want line: `side-band-64k` always (the
client throws before sending if not advertised); `multi_ack_detailed` if
advertised else `multi_ack` if advertised; `thin-pack` if advertised (and
`thinPack !== false`); `no-progress` always (when `noProgress !== false`);
`ofs-delta` if advertised. Response: bare pkt-lines — `NAK\n`, `ACK <oid>\n`,
`shallow <oid>\n`, `unshallow <oid>\n` — followed directly by sideband packets
(band byte + data). No section names. The client's v0 consumer throws
`fetch-v0` on any other bare line. The v0 path also requires the pack checksum
and parses deltas the same way.

### 4.5 `push` / receive-pack (v0)

Request body: command list (pkt-lines) + raw pack bytes (not pkt-framed):

```
<old> <new> <ref>\0<capabilities space-joined>\n    <- FIRST command only; caps after NUL
<old> <new> <ref>\n                                   <- further commands, bare
0000                                                   (flush)
<pack bytes, raw>                                      <- present iff any command creates/updates,
                                                           or objects were supplied; ABSENT for delete-only
```

- `old`/`new` are lowercase 40-hex; `000…0` (`ZERO_OID`) means create (old) /
  delete (new). Ref names start with `refs/`, ≤ 200 chars, no whitespace or
  control chars (client-side validation; the server may trust it).
- Capabilities the client sends (each only if the server advertised it, except
  report-status which needs the advertisement to contain it at all):
  `report-status-v2` if advertised, else `report-status` if advertised;
  `side-band-64k` if advertised; `ofs-delta` if advertised;
  `agent=makefun-git-client/1.0` if `agent` advertised. If the server advertises
  **neither** `report-status` nor `report-status-v2`, the client sends neither
  and `parsePushReport` receives no `unpack` line → throws `push-report`
  ("report-status has no unpack line") — every push check then fails.
- The pack is written by `writePack()`: **plain objects only, no deltas**,
  in the caller's order. Even a create/update with zero new objects carries an
  **empty pack** (32 bytes: `PACK` v2, count 0, trailer). A delete-only command
  list carries **no pack bytes at all** after the flush — the server must not
  wait for / require pack bytes in that case (and must not misread a missing
  pack as a truncated one).
- Response: `Content-Type: application/x-git-receive-pack-result`, HTTP 200
  **even when refs are refused** ("A rejection is returned in `report` (an `ng`
  line), never thrown: HTTP 200 with a refused ref is a successful exchange of
  a refused update"). Body with `side-band-64k` negotiated: the report-status
  stream is itself pkt-lined **inside band-1 sideband packets**:

```
<pkt-line: 0x01 + pkt-line("unpack ok\n")>...
<pkt-line: 0x01 + pkt-line("ok refs/heads/main\n")>...
<pkt-line: 0x01 + pkt-line("ng refs/heads/side non-fast-forward\n")>...
0000
```

  i.e. each sideband packet payload = `0x01` + one pkt-line of report text
  (the client concatenates all band-1 payloads, then decodes them as pkt-lines
  if they start with 4 hex chars, else treats them as raw text). Band 2 =
  progress text (free-form; `push-sideband-report` records its length but does
  not assert content — may be empty). Band 3 = fatal error (client throws
  `sideband-error`). Without side-band-64k the body is the report pkt-line
  stream directly — but the server must advertise side-band-64k anyway, so
  always use the sideband framing.
- Report lines (exact grammar, from `parsePushReport`):
  `unpack ok\n` — `unpackOk = true` iff the detail is exactly `ok`; any other
  detail (`unpack <error>`) means unpack failed. **The `unpack` line is
  mandatory** — a missing one throws `push-report`.
  `ok <ref>\n` — accepted. `ng <ref> <reason>\n` — refused; the reason is
  everything after the first space (`rest.slice(space + 1)`), so it must be a
  single token for these checks: exactly `non-fast-forward`. (A reason with a
  space would still parse, but the checks compare `=== 'non-fast-forward'`.)
  `option <key>[ <value>]\n` — only for `report-status-v2`, attached to the
  preceding ref line; a report-status-v2 server that never emits `option` lines
  is fine. Any other line throws `push-report` (`bad report-status line "…"`).
  An `ng` line with no space after the ref throws `bad ng line`.
- **Per-ref application (not atomic):** apply each command independently —
  FF commands move their ref, refused ones do not (§3.4 check 23 asserts
  exactly 2 report lines for 2 commands, in command order, and that only the
  FF ref advanced). A refused ref's objects may still be stored (unreachable);
  nothing asserts otherwise.
- **Fast-forward rule (per ref):** let `cur` be the ref's current oid
  (`ZERO_OID` if absent). Accept iff: create (`old == ZERO_OID`, `cur == ZERO_OID`,
  `new != ZERO_OID`); delete (`new == ZERO_OID`, `old == cur`); update
  (`old == cur` and `new` is a descendant of `cur` — `new` reachable from `cur`
  by following commit parents — or `new == cur`). Otherwise refuse with
  `ng <ref> non-fast-forward`. The suite's non-FF cases are always
  `old == cur` with `new` a sibling (not a descendant), so the descendant test
  is the operative one. **Unpack must still succeed** (`unpack ok`) for a
  refused update — the pack itself is valid; only the ref update is refused.
  (§7 lists the untested old-mismatch corner.)

## 5. Refs

### 5.1 Which refs exist

- Only `refs/heads/*` and `refs/tags/*` are created/updated/deleted by the
  suite: `refs/heads/main` (default branch), `refs/heads/feature`,
  `refs/heads/side`, `refs/tags/v1`. No other namespaces, no `refs/remotes/*`,
  no notes, no `HEAD` as a writable ref.
- **Default branch is always `main`** (`DEFAULT_BRANCH = 'main'`, scenario
  `defaultBranch: 'main'`). HEAD is a symref to `refs/heads/main` from birth
  (before any push: unborn). There is no check that creates a repo with a
  different default branch and no check that changes HEAD.
- Repos are created empty (`auto_init: false`); the first push creates `main`
  from `ZERO_OID`.

### 5.2 Advertisement & listing rules (summary)

- v0 upload-pack: `<oid> <ref>` lines; peeled tags as `<commit-oid> <ref>^{}`;
  `HEAD` line + `symref=HEAD:refs/heads/main` capability; empty repo =
  zero-oid `capabilities^{}` line carrying the caps.
- v0 receive-pack: same ref lines; caps must include `report-status`,
  `side-band-64k`, `delete-refs`.
- v2 `ls-refs`: `<oid> <ref> [symref-target:…] [peeled:…]`; unborn refs as
  `unborn <ref> …`; HEAD always present (born: `<tip> HEAD symref-target:refs/heads/main`;
  unborn: `unborn HEAD symref-target:refs/heads/main`); server-side `ref-prefix`
  filtering; peeled tags when `peel` requested.
- Tag peeling: an annotated tag object peels to its target commit (recursive
  through tag→tag if ever needed; checks only use tag→commit). A lightweight tag
  (ref pointing directly at a commit) has no `^{}` line / no `peeled:` attribute
  — the suite never creates one, but that is the correct behaviour.

### 5.3 Ref update semantics

- Create: `old == ZERO_OID`, ref must not exist (if it exists, the update is
  not a fast-forward from nothing — refuse `non-fast-forward`; untested, §7).
- Update: `old` must equal the current oid and `new` must be a descendant
  (§4.5). Equal old/new (no-op update) is a fast-forward of length zero —
  accept (untested; harmless).
- Delete: `new == ZERO_OID`, `old` must equal the current oid. Deletes require
  the `delete-refs` capability to be advertised. Deleting a ref must not disturb
  other refs or stored objects (check 21 asserts `main` intact and the repo
  still clonable; check 24 asserts the same for a tag delete). Objects that
  become unreachable stay stored (nothing asserts garbage collection; do not
  prune — a later check never re-reads them, but pruning risks nothing either;
  simplest is to never prune).
- Ref names in `ls-refs`/advertisement: exact strings as pushed. No ref is
  ever renamed. Sorting of advertised refs is not asserted (checks use
  `find`); advertise in a stable order anyway (e.g. `HEAD` first, then
  `refs/heads/*`, then `refs/tags/*`, each sorted) for deterministic output.

## 6. Packs and objects

### 6.1 Packfile format (what the server must generate)

- Header: `PACK`, u32 BE version (**2** recommended; 3 also accepted by
  `readPack`), u32 BE object count, then entries, then a 20-byte trailer =
  SHA-1 of **all preceding pack bytes**. `verifyPackChecksum` recomputes it;
  a mismatch fails `pack-integrity` and throws `pack-checksum` in every fetch.
- `readPack` requires: total length ≥ 32; magic `PACK`; version 2 or 3;
  **declared count == number of entries parsed == number of unique resolved
  objects** — so **never emit two entries resolving to the same oid**
  (dedupe by oid; two refs pointing at one commit contribute one entry).
  No stray bytes between the last entry and the trailer (`pack-trailing`).
  Each entry's inflated size must equal its declared size (`pack-size`).
- Entry header (varint): first byte `(typeCode << 4) | (size & 0x0f)` with
  continuation bit `0x80` while more size bytes follow; subsequent bytes are
  7 bits each, little-endian-ish git varint (`size += (byte & 0x7f) << shift`,
  shift starts at 4 then += 7). Type codes: 1 commit, 2 tree, 3 blob, 4 tag,
  6 OFS_DELTA, 7 REF_DELTA. Unknown code → `pack-type`.
- Each entry's data is one **zlib** (deflate) stream; `inflateAt` uses
  `inflateSync` with `info` and requires it to consume ≥ 1 byte and produce
  exactly the declared size.
- **Simplest compliant choice: send plain objects only (types 1–4), no deltas.**
  `pack-deltas` does not require any delta (`deltaCount` is reported, never
  asserted > 0). If you do emit deltas: OFS_DELTA base must be an earlier entry
  in the same pack (offset varint: `value = ((v+1)*128) + …` per
  `readOfsDeltaBase`; a base offset ≤ 0 or > current offset → `pack-delta`);
  REF_DELTA carries the 20-byte base oid and the base must be in the pack or
  held by the client (thin pack); delta application is the standard copy/insert
  stream (`applyDelta`: varint source size, varint target size, copy ops
  `0x80|…`, insert ops `1–127`, opcode `0` invalid, copy size 0 means `0x10000`);
  delta cycles throw `pack-delta-cycle`. The client resolves REF_DELTA bases
  against `haveObjects` only — a thin pack whose base the client does **not**
  hold throws `pack-delta-base` and fails the fetch. Plain objects avoid all of this.
- Deterministic generation (recommended): fixed entry order (e.g. breadth-first
  from the wants, or sorted by oid), fixed zlib level. The export records only
  pass/fail bits, but `packBytes`/`deltaCount` appear in check detail strings,
  so identical behaviour should produce identical details across live/replay.

### 6.2 Packs the client sends (what the server must accept)

- `writePack()`: **plain objects only, no deltas**, version 2, entries in the
  caller's order (reachability order from `pushRefs`/`objectsToSend`), trailer
  SHA-1. The server will **never** receive OFS_DELTA/REF_DELTA from this client.
  It must still parse the pack strictly: verify the trailer, verify each
  object's SHA-1 recomputes to the id implied by its content (the checks only
  verify this via later clones, but a corrupt pack must yield `unpack <error>`,
  not a silent accept — see §6.5).
- The client sends **only objects the server does not already reach** (§1.1),
  but may send already-held objects if its local reachability computation was
  incomplete. Store idempotently (same oid + same bytes = no-op; same oid +
  different bytes is impossible for a correct SHA-1 — treat as unpack failure).

### 6.3 Sideband framing (fetch & push)

- Sideband packet payload = **1 band byte + data**. Band 1 = pack/report data,
  band 2 = progress (UTF-8 text, free-form), band 3 = fatal error (text; the
  client throws with that text). Any other first byte in a packfile section →
  `invalid sideband band <n>` / `sideband` failure. Empty sideband packet
  (payload length < 1) → failure.
- Pack data must be split across pkt-lines of ≤ 65520 bytes total (payload
  ≤ 65516 including the band byte). The client's `PktLineDecoder` enforces the
  limit on every packet, including sideband ones (`sideband-framing` re-checks
  `packet.raw.length > PKT_LINE_MAX`).
- Progress (band 2) is optional and unasserted in content; it may be omitted
  entirely (the client sends `no-progress`, so the server should send none or
  very little). Never send band 3 unless the whole operation has failed.
- Push report: same banding, report text pkt-lined inside band 1 (§4.5).

### 6.4 What a fetch must return for a given want/have set

Let `W` = wants, `H` = haves, `S` = client's shallow boundaries (if any),
`D` = depth (if any). Let `R(X)` = objects reachable from X in the server store.

- **No depth, no shallow:** send exactly `R(W) − R(H)` as plain objects.
  `fetch-incremental` asserts: every object of the difference present, no
  object of `R(H)` present, `second ∈` result, `tip ∉` result.
  `fetch-nothing-new` (`W = H = {tip}`): difference is empty → empty pack or
  no packfile section (§4.2).
- **Depth `D` (no prior shallow):** send commits within `D` generations of
  each want (want itself = generation 1), plus their trees/blobs, and **exclude**
  parents beyond the boundary. `shallow-info` must list the boundary commits —
  the commits at generation `D` whose parents were cut (`shallow <oid>`).
  Depth 1: boundary = the want itself. The tip commit's tree and blobs are
  always included (the tip's tree is not "history").
- **Deepen (prior shallow `S`, new depth `D`):** send commits within `D`
  generations of the want that the client does not already hold, with trees/blobs;
  `shallow-info` lists the new boundary (`shallow <oid>`) **and** any commit in
  `S` that is now within the delivered range (`unshallow <oid>`). Check 17
  accepts either `shallow` containing the parent **or** `unshallow` containing
  the old tip — send **both** (`shallow <parent>`, `unshallow <old-tip>`) to be safe.
- **Shallow fetch of a new tip (`S = [old-tip]`, `D = 1`, `H = [old-tip]`):**
  send only the new tip's new objects; do not traverse past the shallow
  boundary and do not re-send held objects (check 18).
- Tag wants: a want that is a tag oid must deliver the tag object **and** its
  target's closure (subject to the same have/depth subtraction). Full clone
  wants include tag oids (§4.3).
- Unknown want oid (never sent by these checks): no specified behaviour — see §7.7.

### 6.5 What a push must do with a received pack

1. Read the command list (pkt-lines up to the flush). Parse caps after NUL on
   the first line (report-status / side-band-64k / ofs-delta / agent — the
   server only needs report-status + side-band-64k).
2. If any command creates/updates, read the pack: it follows the flush **raw**
   (not pkt-framed). Its length is the request's remaining body
   (`Content-Length` minus the command bytes). Parse it as §6.1: verify the
   trailer SHA-1; inflate each entry; verify each object's SHA-1 recomputes
   and its size matches; resolve deltas if any (none expected). On any failure:
   answer `unpack <detail>` (detail ≠ `ok`), apply **no** ref, HTTP 200 with a
   sideband report. (No check sends a corrupt pack, so the exact detail string
   is free — but `unpackOk` must be false.)
3. Verify closure: every new tip's reachable set must be present in
   (pack ∪ existing store). A missing object is an unpack failure (same handling).
   (Again untested directly; a missing object that later breaks a clone would
   fail the check that clones, so fail fast here.)
4. Apply §4.5 per-ref FF rules; build the report (§4.5); store the pack's objects
   (even for refused refs — harmless and matches git, which stores the pack
   before ref checks). Ref moves must be visible to immediately following
   `ls-refs`/clone calls (checks do this in sequence with no delay).
5. Delete-only pushes have no pack: skip steps 2–3, apply deletes, report
   `unpack ok` + one `ok` line per command.

## 7. Error cases (complete list from the checks)

| Case | Required behaviour |
|---|---|
| Missing repo, `GET /info/refs` both services | HTTP **404**; server stays up; a known repo still answers 200 afterwards (checks 4, 30) |
| Missing repo, POST upload/receive-pack | Untested. Recommended: 404, same as info/refs. |
| Empty repo clone | 0 refs (`refs/*`), 0 objects, no pack; unborn HEAD → `refs/heads/main` (check 7) |
| Clone/fetch of a repo with commits | Full closure, byte-exact (checks 9–13) |
| Push to an unborn branch | Accepted, `ok`, ref created (check 8) |
| Push creating a branch from an existing commit | Accepted, `ok` (check 20) |
| Push deleting a branch/tag | Accepted, `ok`, ref gone, other refs intact (checks 21, 24) |
| Non-FF push | `unpack ok` + `ng <ref> non-fast-forward`; ref unmoved; server healthy; clone intact (check 22) |
| Mixed FF + non-FF push | `unpack ok`, one `ok` + one `ng non-fast-forward` line (exactly 2 lines), only the FF ref moves (check 23) |
| Unknown ref in `ls-refs` prefix | 0 refs returned (check 6) |
| Malformed pkt-line POST (`zzzznot-a-pkt-line`) | Must not crash the process; any HTTP status (400 recommended) or a transport error is acceptable — but the next `infoRefs` must be 200 and the repo clonable (check 30) |
| Unknown want oid in fetch | **Untested** — see §8.7 |
| Stale `oldOid` in a push command | **Untested** — see §8.1 |
| Deleting the current/default branch | **Untested** — see §8.2 |

## 8. Determinism, timeouts, and ambiguities

### 8.1 Determinism / replay

- `wire.ts`: `export/state.json` holds **only** pass/fail bits, counts and coarse
  perf tiers — "No times, no ports, no random ids" — written as canonical JSON
  (keys sorted at every depth) plus a trailing newline. Timings go in the
  separate `export/perf.json`. A contender's trial runs twice (live, then replay)
  and the two `state.json` files must be **byte-identical**, or the entry is
  listed and unranked.
- What the checks record: pass/fail bits plus ≤600-char detail strings built from
  server answers (oids, counts, sorted capability lists, `packBytes`, `deltaCount`,
  ref names). Nothing in the git checks records a time, port or random id.
  Consequence for the server: **never put a timestamp, random value or port in any
  git response** (advertisements, `ls-refs`, fetch sections, sideband progress,
  report lines). Object ids are already deterministic (scenario-seeded data).
  Capability/ref ordering is not asserted (checks sort or `find`), but keep it
  stable anyway; keep pack generation deterministic (§6.1) so `packBytes` and
  `deltaCount` in detail strings are stable across live and replay.
- The server's own store must be deterministic in content: object bytes are
  stored verbatim from the client, so two runs on the same scenario produce the
  same objects. (Whether the store persists across the live run and its replay is
  the harness's business — each trial is a fresh pod with a fresh store.)

### 8.2 Timeouts, retries, parsing strictness

- Per-request timeout: 8000 ms (`DEFAULT_GIT_TIMEOUT_MS`); the harness clamps
  each check's timeout to ≤ 8000 ms per call. Check budgets: 5000 ms
  (advertise ×3, unknown-repo-404), 8000 ms (ls-refs ×2, clone-empty,
  push-first-commit), 10000 ms (annotated-tag, fetch-nothing-new, push-update-ref,
  push-create/delete-branch, push-non-FF, push-delete-tag), 12000 ms
  (clone-object-hashes, clone-blob-bytes, clone-tree-entries, fetch-incremental,
  fetch-shallow ×3, push-mixed-report, pack-integrity, sideband-framing,
  push-sideband-report), 15000 ms (push-100-files, pack-deltas,
  repo-survives-errors). Overall conformance budget: 240 s (`CONFORMANCE_BUDGET_MS`).
- **No retries anywhere in the client.** One attempt per HTTP call; a timeout
  throws `GitProtocolError` (`request timed out after <ms> ms`, code `timeout`)
  and the check fails. The suite runs checks one at a time, so there is no
  concurrent git load from the checks (the benchmark phase later does 50
  concurrent shallow clones — out of scope for this spec, but the server must
  handle concurrent fetches).
- Parsing is **strict** on the client side: bad pkt-line headers, truncated
  packets, bad oids in `ls-refs`/advertisements, unknown fetch-section lines,
  bad report lines, bad pack checksums, delta errors — all throw and fail the
  check. The server should be equally strict on input only where the checks
  require it (malformed POST must not crash it, §3.5 check 30) and otherwise
  liberal in what it accepts (e.g. extra objects in a push pack).
- HTTP: the client streams response bodies incrementally (`responseChunks` via
  async iteration); either `Content-Length` or chunked transfer encoding works
  for responses. Requests always carry `Content-Length`. `redirect: 'error'` —
  never redirect.

### 8.3 Ambiguities the source does not resolve

1. **Stale `oldOid`.** No check sends a push whose `oldOid` differs from the
   ref's current value (except create/delete where it is `ZERO_OID`/the tip).
   Recommended: treat `old != cur` as a refusal with reason
   `non-fast-forward` (git's behaviour for a stale base); do not invent a new
   reason string, since checks compare reasons exactly.
2. **Deleting the default/current branch (`main`).** Never attempted. Git
   refuses this by default; the suite never tests it. Recommended: refuse with
   `ng refs/heads/main non-fast-forward` is wrong semantically; a plain
   `ng refs/heads/main delete-current-branch`… — any reason is untested, so
   either allow the delete (HEAD becomes unborn, clone-empty behaviour) or
   refuse with a clear reason. Pick one and be consistent.
3. **v0 upload-pack advertisement on an empty repo.** The client tolerates a
   zero-oid `capabilities^{}` first line or a HEAD line; either parses. Serve
   the `capabilities^{}` form (standard git) with the caps after NUL.
4. **`wanted-refs` section in v2 fetch.** Optional, never asserted; the client
   parses `<oid> <ref>` lines if present. Omit it (simplest) or include one line
   per want that names a ref. There is no specified mapping from a bare want oid
   to a ref name when several refs point at it — another reason to omit it.
5. **ACK vs NAK in v2 `acknowledgments`.** Never asserted (`acks`/`nak`/`ready`
   are recorded, not checked). Recommended: `NAK` when no `have` was sent;
   when haves were sent, `ACK <first-have>` + `ready` (closest to git). Sending
   `NAK` unconditionally also passes these checks, but misstates the protocol.
6. **Empty pack vs omitted packfile section for fetch-nothing-new.** Both pass
   (§4.2). Recommended: send a valid empty pack (32 bytes) — it exercises the
   same code path as a normal fetch.
7. **Unknown want oid / unknown ref in fetch.** No check sends one. Recommended:
   a band-3 sideband error (`<text>`) in the packfile section, or an HTTP 200
   with an empty pack — either is untested; do not crash, do not hang. (Real git
   errors; band 3 is the protocol-correct signal and the client surfaces it as
   `sideband-error`.)
8. **Which refs a v0 `ls-refs` fallback returns.** `lsRefs()` on a v0 server
   returns the advertisement's ref list, client-side prefix-filtered — so the
   prefix check's `rawRefs` assertions would see **unfiltered** refs and fail
   (`ls-refs-prefix` requires protocol 2 first, so it fails at the protocol
   assertion anyway). No separate work needed: v2 is mandatory for that check.
9. **`agent` / `object-format` capabilities.** Optional. If advertised, the
   client echoes `agent=` / `object-format=sha1` lines in `ls-refs` and `fetch`
   requests — the server must accept and ignore them (they arrive after
   `command=…` and before the delim). If not advertised, they are never sent.
10. **Report `option` lines.** Only relevant if `report-status-v2` is advertised.
    Do not advertise `report-status-v2`; plain `report-status` suffices.

## 9. Checklists

### 9.1 Minimum viable surface (passes the most checks)

- [ ] `GET /info/refs?service=git-upload-pack`: v2 advertisement when
      `Git-Protocol: version=2`, else v0; correct content-type; 404 for missing repo.
- [ ] `GET /info/refs?service=git-receive-pack`: v0 advertisement, caps
      `report-status side-band-64k delete-refs`; correct content-type; 404 for missing repo.
- [ ] `POST /git-upload-pack`: v2 `ls-refs` (prefix filter, peel, symrefs, unborn)
      and v2 `fetch` (want/have, depth, shallow-info, sideband packfile).
- [ ] `POST /git-receive-pack`: command list + pack, per-ref FF, `unpack ok` +
      `ok`/`ng <ref> non-fast-forward` report in band-1 sideband packets.
- [ ] Pack generation: plain objects, deduped, version 2, valid SHA-1 trailer.
- [ ] Object store: verbatim bytes, SHA-1 ids, reachability walk, tag peeling.
- [ ] REST repo creation (`POST /api/v3/user/repos` → 201, 422-already-exists tolerated).

### 9.2 The three checks that need v2 (lose them with a v0-only server)

`advertise-v2`, `ls-refs`, `ls-refs-prefix` — all fail at the protocol assertion
(`the server answered protocol v0…` / `ls-refs needs protocol v2…` /
`ref-prefix needs protocol v2…`). Every other check falls back to v0, **provided**
the v0 upload-pack advertises `side-band-64k` (else v0 fetch throws client-side
before any bytes are sent).

### 9.3 Failure strings to grep for in your own testing

- `the server answered protocol v0; the rules require Git-Protocol: version=2 to be honoured`
- `receive-pack is missing report-status, side-band-64k, delete-refs`
- `the server did not advertise side-band-64k for receive-pack`
- `report-status has no unpack line` / `bad report-status line`
- `the refusal reason is "…", not non-fast-forward`
- `the incremental fetch re-sent the old tip` / `already-held object(s) were re-sent`
- `the pack trailer … does not match the bytes …`
- `invalid sideband band` / `the server sent a sideband error:`

## Appendix A. Verbatim client constants

- `ZERO_OID = '0'.repeat(40)`; `PKT_LINE_MAX = 65520`; `PKT_LINE_MAX_PAYLOAD = 65516`;
  `DEFAULT_GIT_TIMEOUT_MS = 8000`; `GIT_CLIENT_AGENT = 'makefun-git-client/1.0'`;
  `GIT_OBJECT_FORMAT = 'sha1'`.
- Object type codes: commit 1, tree 2, blob 3, tag 4, OFS_DELTA 6, REF_DELTA 7.
- OID validity: `/^[0-9a-f]{40}$/` (lowercase hex only).
- Loose-object hash: SHA-1 over `<type> <decimal size>\0` + raw bytes.
- Tree entry: `<mode ascii> <name>\0<20 raw oid bytes>`; commit/tag formats per §1.2.
- `parseAdvertisement` v2 object-format guard: any `object-format` ≠ `sha1` throws.
- `parsePushReport`: `unpack ` → detail; `ok ` → ref; `ng ` → ref + reason
  (split on first space after `ng `); `option ` → attached to previous ref.
  Missing `unpack` line → throw `push-report`.
- `readPack`: versions 2/3 only; trailer = SHA-1 of all preceding bytes; every
  resolved object's SHA-1 recomputed; delta cycles, bad bases, size mismatches
  and stray bytes all throw.
- `PktLineDecoder`: 4-hex header, `0000` flush, `0001` delim, `0002`
  response-end, `0003` invalid, > 65520 invalid; truncated stream throws.

## Appendix B. Files consulted

- `program/env/src/checks-git.ts` — 30 checks, lines 1–1150 (all `define()` calls,
  `harness`, `pushRefs`, `repoWithInitialCommit`, `LocalRepo`, helpers).
- `program/env/src/git-client.ts` — 2144 lines (pkt-line codec, object model,
  pack read/write, `GitClient`: `infoRefs`, `advertisement`, `lsRefs`,
  `fetch`/`fetchV2`/`fetchV0`, `clone`, `push`, `parsePushReport`, `createRepo`,
  `postRaw`).
- `program/env/src/wire.ts` — git-relevant parts: register/done/healthz wire,
  `DEFAULT_BRANCH = 'main'`, `SCENARIO_SEED`, `SCENARIO_EPOCH_SEC`, scenario
  generators, `StateFile`/`PerfFile` export shapes (state.json: bits only, no
  times/ports/ids; canonical JSON).
- `RULES.txt` § "Git over smart HTTP" (line 38) and § "The suite and the wire"
  / "What is scored" (replay byte-identical `state.json`).
