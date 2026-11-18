// REST v3 handler for /api/v3 — see spec/rest.md and DESIGN.md.
// Stdlib only, no wall clock, no randomness, no network, no child_process.
import type { ServerResponse } from 'node:http';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import {
  b64decode,
  b64encode,
  nextRequestId,
  parseJsonBody,
  sendError,
  sendJson,
} from './util.ts';

/** Handler context built by app.ts (see DESIGN.md). */
export interface Ctx {
  store: Store;
  method: string;
  path: string; // pathname, decoded, no trailing-slash normalization except exact matches
  query: URLSearchParams;
  headers: Record<string, string>; // lower-cased names
  body: Buffer; // raw request body (may be empty)
  token: string | null; // Bearer token or null
}

export type Handler = (ctx: Ctx, res: ServerResponse) => Promise<boolean>;

const PREFIX = '/api/v3';
const INSTALLED_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function authorized(ctx: Ctx): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return ctx.token !== null && ctx.token === expected;
  // Local dev only: no configured token — accept any non-empty Bearer token.
  return ctx.token !== null && ctx.token !== '';
}

// ---------------------------------------------------------------------------
// shape helpers (full GitHub-shaped objects; the REST suite asserts a
// subset, GraphQL/MCP read the same store and may assert more)
// ---------------------------------------------------------------------------

function userShape(store: Store, login: string): Record<string, unknown> {
  const u = login === store.viewer.login ? store.viewer : null;
  return {
    login,
    id: u ? u.id : 0,
    node_id: '',
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
    name: u ? u.name : login,
    email: u ? u.email : '',
  };
}

function repoShape(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: store.globalId('repo', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(store, repo.owner),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    git_url: '',
    ssh_url: '',
    clone_url: '',
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelShape(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueShape(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: store.globalId('issue', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((l): l is Label => l !== undefined)
      .map(labelShape),
    user: userShape(store, issue.userLogin),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: '',
    url: '',
  };
}

function pullShape(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.dbId,
    node_id: store.globalId('pull', repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    draft: false,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    user: userShape(store, pr.userLogin),
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
      label: `${repo.owner}:${pr.headRef}`,
      repo: repoShape(store, repo),
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
      label: `${repo.owner}:${pr.baseRef}`,
      repo: repoShape(store, repo),
    },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    mergeable: pr.state === 'open' ? isMergeable(store, repo, pr) : null,
    mergeable_state: pr.state === 'open' ? 'clean' : 'unknown',
    html_url: '',
    url: '',
    diff_url: '',
    patch_url: '',
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function parseBody(ctx: Ctx, res: ServerResponse, emptyOk = false): unknown | null {
  const parsed = parseJsonBody(ctx.body, emptyOk);
  if (!parsed.ok) {
    sendError(res, 400, 'Malformed JSON body');
    return null;
  }
  return parsed.value;
}

function bodyObj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function intParam(query: URLSearchParams, name: string, def: number): number {
  const raw = query.get(name);
  if (raw === null) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Resolve a branch name / full refname / raw oid to a refname or oid usable by fileMapAt. */
function resolveRef(repo: Repo, ref: string): string {
  if (repo.refs.has(ref)) return ref;
  const heads = `refs/heads/${ref}`;
  if (repo.refs.has(heads)) return heads;
  return ref;
}

/** Tip oid of a branch name (or full refname / raw oid), or undefined. */
function tipOfRef(repo: Repo, ref: string): string | undefined {
  const resolved = resolveRef(repo, ref);
  const byRef = repo.refs.get(resolved);
  if (byRef) return byRef;
  return storeHasCommit(repo, resolved) ? resolved : undefined;
}

function storeHasCommit(repo: Repo, oid: string): boolean {
  const obj = repo.objects.get(oid.toLowerCase());
  return obj !== undefined && obj.type === 'commit';
}

/**
 * Paginate a list. Returns the page slice and, when there is a next page,
 * an absolute same-origin Link header value (rel="next" + rel="last").
 */
function paginate<T>(
  items: T[],
  ctx: Ctx,
  basePath: string,
): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, intParam(ctx.query, 'per_page', 30)));
  const pageNum = intParam(ctx.query, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (pageNum < totalPages) {
    const host = ctx.headers['host'] ?? 'localhost';
    const origin = `http://${host}`;
    const next = `${origin}${basePath}?per_page=${perPage}&page=${pageNum + 1}`;
    const last = `${origin}${basePath}?per_page=${perPage}&page=${totalPages}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page, link };
}

function sendPage<T>(ctx: Ctx, res: ServerResponse, items: T[], basePath: string): void {
  const { page, link } = paginate(items, ctx, basePath);
  const extra: Record<string, string> = {};
  if (link) extra['link'] = link;
  sendJson(res, 200, page, extra);
}

/** Repo visible to the viewer, or null (missing or under another owner → 404). */
function findRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return null;
  if (repo.owner !== ctx.store.viewer.login) return null;
  return repo;
}

/** Walk commit history from a tip (newest first), deduped. */
function commitHistory(store: Store, repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip.toLowerCase()];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parsed = store.parseCommit(obj.data);
    for (const p of parsed.parents) stack.push(p.toLowerCase());
  }
  return out;
}

function commitShape(store: Store, repo: Repo, sha: string): Record<string, unknown> {
  const obj = store.getObject(repo, sha);
  const parsed = obj ? store.parseCommit(obj.data) : null;
  const message = parsed ? parsed.message.replace(/\n$/, '') : '';
  const who = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!m) return { name: '', email: '', date: '' };
    return {
      name: m[1] as string,
      email: m[2] as string,
      date: new Date(Number(m[3]) * 1000).toISOString(),
    };
  };
  return {
    sha,
    commit: {
      message,
      author: who(parsed?.author ?? ''),
      committer: who(parsed?.committer ?? ''),
      tree: { sha: parsed?.tree ?? '' },
    },
    author: { login: store.viewer.login },
    committer: { login: store.viewer.login },
    parents: (parsed?.parents ?? []).map((p) => ({ sha: p })),
    tree: { sha: parsed?.tree ?? '' },
    url: '',
    html_url: '',
  };
}

/** True when a squash merge of this PR would apply cleanly. */
function isMergeable(store: Store, repo: Repo, pr: Pull): boolean {
  const baseTip = tipOfRef(repo, pr.baseRef);
  const headTip = tipOfRef(repo, pr.headRef);
  if (!baseTip || !headTip) return false;
  const base = store.mergeBase(repo, baseTip, headTip);
  if (!base) return false;
  const { conflicts } = store.threeWayMerge(
    store.fileMapAt(repo, base),
    store.fileMapAt(repo, baseTip),
    store.fileMapAt(repo, headTip),
  );
  return conflicts.length === 0;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function contentsFileShape(
  store: Store,
  repo: Repo,
  path: string,
  mode: string,
  oid: string,
): Record<string, unknown> {
  const obj = store.getObject(repo, oid);
  const data = obj ? obj.data : Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: b64encode(data),
    sha: oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
    _links: { self: '', git: '', html: '' },
  };
}

function dirListing(
  store: Store,
  repo: Repo,
  dirPath: string,
  files: Map<string, { mode: string; oid: string }>,
): Array<Record<string, unknown>> {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const entries: Array<Record<string, unknown>> = [];
  const subdirs = new Map<string, Map<string, { mode: string; oid: string }>>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.push({ type: 'file', name: rest, path, sha: entry.oid, size: 0, url: '', html_url: '', git_url: '', download_url: '' });
    } else {
      const sub = rest.slice(0, slash);
      let m = subdirs.get(sub);
      if (!m) {
        m = new Map();
        subdirs.set(sub, m);
      }
      m.set(rest.slice(slash + 1), entry);
    }
  }
  for (const [sub, subFiles] of subdirs) {
    const treeOid = store.treeFromFileMap(repo, subFiles);
    entries.push({
      type: 'dir',
      name: sub,
      path: prefix + sub,
      sha: treeOid,
      size: 0,
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
    });
  }
  entries.sort((a, b) => ((a['name'] as string) < (b['name'] as string) ? -1 : 1));
  return entries;
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

export async function handleRest(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  const { store } = ctx;
  if (ctx.path !== PREFIX && !ctx.path.startsWith(`${PREFIX}/`)) return false;

  // Auth on every /api/v3 route.
  if (!authorized(ctx)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  const sub = ctx.path.slice(PREFIX.length); // '' or '/...'
  const segs = sub.split('/').filter((s) => s.length > 0);
  const method = ctx.method;

  // GET /api/v3/ — root
  if (segs.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{username}',
        meta: { installed_version: INSTALLED_VERSION },
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { installed_version: INSTALLED_VERSION });
    return true;
  }

  // GET /api/v3/user
  if (segs.length === 1 && segs[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, userShape(store, store.viewer.login));
    return true;
  }

  // /api/v3/user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      sendPage(ctx, res, store.listRepos(store.viewer.login).map((r) => repoShape(store, r)), `${PREFIX}/user/repos`);
      return true;
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx, res);
      if (parsed === null) return true;
      const b = bodyObj(parsed);
      const name = str(b['name']).trim();
      if (name === '') {
        sendError(res, 422, 'Repository name is required');
        return true;
      }
      const repo = store.createRepo(
        store.viewer.login,
        name,
        str(b['description']),
        b['private'] === true,
      );
      if (!repo) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, 201, repoShape(store, repo));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1] as string;
    const repoName = segs[2] as string;
    const repo = findRepo(ctx, owner, repoName);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const rest = segs.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoShape(store, repo));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseBody(ctx, res);
        if (parsed === null) return true;
        const b = bodyObj(parsed);
        if (typeof b['description'] === 'string') repo.description = b['description'];
        if (typeof b['name'] === 'string' && b['name'] !== '') {
          // Rename is untested; support it by recreating the key.
          const oldKey = repo.name;
          if (b['name'] !== oldKey) {
            const renamed = store.createRepo(repo.owner, b['name'] as string, repo.description, repo.isPrivate);
            if (renamed) {
              // Move state across (objects/refs/issues/pulls/labels/counters).
              renamed.objects = repo.objects;
              renamed.refs = repo.refs;
              renamed.issues = repo.issues;
              renamed.pulls = repo.pulls;
              renamed.labels = repo.labels;
              renamed.nextNumber = repo.nextNumber;
              store.deleteRepo(repo.owner, oldKey);
              sendJson(res, 200, repoShape(store, renamed));
              return true;
            }
            sendError(res, 422, 'Repository name already exists');
            return true;
          }
        }
        sendJson(res, 200, repoShape(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const branches = store
        .listRefs(repo)
        .filter((r) => r.name.startsWith('refs/heads/'))
        .map((r) => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.oid, url: '' } }));
      sendJson(res, 200, branches);
      return true;
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const shaParam = ctx.query.get('sha');
      const tip = shaParam
        ? tipOfRef(repo, shaParam)
        : tipOfRef(repo, repo.defaultBranch);
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
      sendJson(res, 200, commitHistory(store, repo, tip).map((sha) => commitShape(store, repo, sha)));
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const parsed = parseBody(ctx, res);
      if (parsed === null) return true;
      const b = bodyObj(parsed);
      const ref = str(b['ref']);
      const sha = str(b['sha']).toLowerCase();
      if (!ref.startsWith('refs/') || sha === '' || !storeHasCommit(repo, sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return true;
      }
      if (store.getRef(repo, ref) !== undefined) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      store.setRef(repo, ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit', url: '' }, url: '' });
      return true;
    }

    // /repos/{o}/{r}/contents[/{path...}]
    if (rest.length >= 1 && rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') {
        const refParam = ctx.query.get('ref');
        const refOrOid = refParam ? resolveRef(repo, refParam) : `refs/heads/${repo.defaultBranch}`;
        const files = store.fileMapAt(repo, refOrOid);
        if (contentPath === '') {
          sendJson(res, 200, dirListing(store, repo, '', files));
          return true;
        }
        const file = files.get(contentPath);
        if (file) {
          sendJson(res, 200, contentsFileShape(store, repo, contentPath, file.mode, file.oid));
          return true;
        }
        // Directory? Any file under this path, or the path is a dir prefix.
        const isDir = [...files.keys()].some((p) => p.startsWith(`${contentPath}/`));
        if (isDir) {
          sendJson(res, 200, dirListing(store, repo, contentPath, files));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const parsed = parseBody(ctx, res);
        if (parsed === null) return true;
        const b = bodyObj(parsed);
        const message = str(b['message']) === '' ? `Update ${contentPath}` : str(b['message']);
        const contentB64 = str(b['content']);
        if (contentB64 === '') {
          sendError(res, 422, 'content is required');
          return true;
        }
        let bytes: Buffer;
        try {
          bytes = b64decode(contentB64);
        } catch {
          sendError(res, 422, 'content is not valid base64');
          return true;
        }
        const branch = str(b['branch']) === '' ? repo.defaultBranch : str(b['branch']);
        const refname = `refs/heads/${branch}`;
        const tip = store.getRef(repo, refname);
        const files = tip ? store.fileMapAt(repo, tip) : new Map<string, { mode: string; oid: string }>();
        const existing = files.get(contentPath);
        const reqSha = str(b['sha']).toLowerCase();
        if (reqSha !== '' && (!existing || existing.oid.toLowerCase() !== reqSha)) {
          sendError(res, 409, 'sha does not match the current blob');
          return true;
        }
        const isUpdate = existing !== undefined;
        const blobOid = store.putObject(repo, 'blob', bytes);
        files.set(contentPath, { mode: '100644', oid: blobOid });
        const tree = store.treeFromFileMap(repo, files);
        const commitSha = store.makeCommit(repo, tree, tip ? [tip] : [], message);
        store.setRef(repo, refname, commitSha);
        sendJson(res, isUpdate ? 200 : 201, {
          content: {
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
            sha: blobOid,
            size: bytes.length,
            type: 'file',
            encoding: 'base64',
            url: '',
            html_url: '',
            git_url: '',
            download_url: '',
          },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = parseBody(ctx, res, true);
        if (parsed === null) return true;
        const b = bodyObj(parsed);
        const message = str(b['message']) === '' ? `Delete ${contentPath}` : str(b['message']);
        const branch = str(b['branch']) === '' ? repo.defaultBranch : str(b['branch']);
        const refname = `refs/heads/${branch}`;
        const tip = store.getRef(repo, refname);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const files = store.fileMapAt(repo, tip);
        const existing = files.get(contentPath);
        if (!existing) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const reqSha = str(b['sha']).toLowerCase();
        if (reqSha !== '' && existing.oid.toLowerCase() !== reqSha) {
          sendError(res, 409, 'sha does not match the current blob');
          return true;
        }
        files.delete(contentPath);
        const tree = store.treeFromFileMap(repo, files);
        const commitSha = store.makeCommit(repo, tree, [tip], message);
        store.setRef(repo, refname, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map(labelShape));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(ctx, res);
        if (parsed === null) return true;
        const b = bodyObj(parsed);
        const name = str(b['name']).trim();
        if (name === '') {
          sendError(res, 422, 'Label name is required');
          return true;
        }
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(res, 200, labelShape(existing));
          return true;
        }
        const label: Label = {
          name,
          color: str(b['color']) === '' ? 'ededed' : str(b['color']),
          description: str(b['description']),
        };
        repo.labels.set(name, label);
        sendJson(res, 201, labelShape(label));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest.length >= 1 && rest[0] === 'issues') {
      // GET/POST /issues
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let items = repo.issues.slice();
          if (state === 'open') items = items.filter((i) => i.state === 'open');
          else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
          // state=all: everything
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          if (sort === 'created') {
            items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          sendPage(ctx, res, items.map((i) => issueShape(store, repo, i)), `${PREFIX}/repos/${owner}/${repoName}/issues`);
          return true;
        }
        if (method === 'POST') {
          const parsed = parseBody(ctx, res);
          if (parsed === null) return true;
          const b = bodyObj(parsed);
          const labels: string[] = Array.isArray(b['labels'])
            ? (b['labels'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          for (const name of labels) {
            if (!repo.labels.has(name)) {
              sendError(res, 422, `Label does not exist: ${name}`);
              return true;
            }
          }
          const now = store.clock.nowIso();
          const issue: Issue = {
            dbId: store.nextId(),
            number: repo.nextNumber,
            title: str(b['title']),
            body: str(b['body']),
            state: 'open',
            labels,
            userLogin: store.viewer.login,
            createdAt: now,
            updatedAt: now,
            closedAt: null,
            comments: [],
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          sendJson(res, 201, issueShape(store, repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }

      // /issues/{n}...
      const num = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(num)) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueShape(store, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const parsed = parseBody(ctx, res);
          if (parsed === null) return true;
          const b = bodyObj(parsed);
          if (typeof b['title'] === 'string') issue.title = b['title'];
          if (typeof b['body'] === 'string') issue.body = b['body'];
          if (b['state'] === 'open' || b['state'] === 'closed') {
            issue.state = b['state'];
            issue.closedAt = b['state'] === 'closed' ? store.clock.nowIso() : null;
          }
          if (Array.isArray(b['labels'])) {
            const labels = (b['labels'] as unknown[]).filter((x): x is string => typeof x === 'string');
            for (const name of labels) {
              if (!repo.labels.has(name)) {
                sendError(res, 422, `Label does not exist: ${name}`);
                return true;
              }
            }
            issue.labels = labels;
          }
          issue.updatedAt = store.clock.nowIso();
          sendJson(res, 200, issueShape(store, repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendJson(
            res,
            200,
            issue.comments.map((c) => ({
              id: c.id,
              body: c.body,
              user: userShape(store, c.userLogin),
              created_at: c.createdAt,
              updated_at: c.createdAt,
              html_url: '',
              url: '',
            })),
          );
          return true;
        }
        if (method === 'POST') {
          const parsed = parseBody(ctx, res);
          if (parsed === null) return true;
          const b = bodyObj(parsed);
          const comment = {
            id: store.nextId(),
            body: str(b['body']),
            userLogin: store.viewer.login,
            createdAt: store.clock.nowIso(),
          };
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id,
            body: comment.body,
            user: userShape(store, comment.userLogin),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            html_url: '',
            url: '',
          });
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      // GET/POST /pulls
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let items = repo.pulls.slice();
          if (state === 'open') items = items.filter((p) => p.state === 'open');
          else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
          items.sort((a, b) => b.number - a.number);
          sendPage(ctx, res, items.map((p) => pullShape(store, repo, p)), `${PREFIX}/repos/${owner}/${repoName}/pulls`);
          return true;
        }
        if (method === 'POST') {
          const parsed = parseBody(ctx, res);
          if (parsed === null) return true;
          const b = bodyObj(parsed);
          const headRef = str(b['head']);
          const baseRef = str(b['base']);
          if (headRef === '' || baseRef === '') {
            sendError(res, 422, 'head and base are required');
            return true;
          }
          const headSha = tipOfRef(repo, headRef);
          const baseSha = tipOfRef(repo, baseRef);
          if (!headSha || !baseSha) {
            sendError(res, 422, 'head or base branch not found');
            return true;
          }
          const now = store.clock.nowIso();
          const pr: Pull = {
            dbId: store.nextId(),
            number: repo.nextNumber,
            title: str(b['title']),
            body: str(b['body']),
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef,
            baseRef,
            headSha,
            baseSha,
            userLogin: store.viewer.login,
            createdAt: now,
            updatedAt: now,
          };
          repo.nextNumber += 1;
          repo.pulls.push(pr);
          sendJson(res, 201, pullShape(store, repo, pr));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }

      // /pulls/{n}...
      const num = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(num)) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, pullShape(store, repo, pr));
          return true;
        }
        if (method === 'PATCH') {
          const parsed = parseBody(ctx, res);
          if (parsed === null) return true;
          const b = bodyObj(parsed);
          if (typeof b['title'] === 'string') pr.title = b['title'];
          if (typeof b['body'] === 'string') pr.body = b['body'];
          if (b['state'] === 'closed') {
            pr.state = 'closed';
            pr.updatedAt = store.clock.nowIso();
          } else if (b['state'] === 'open') {
            pr.state = 'open';
            pr.updatedAt = store.clock.nowIso();
          }
          sendJson(res, 200, pullShape(store, repo, pr));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const baseTip = tipOfRef(repo, pr.baseRef);
        const headTip = tipOfRef(repo, pr.headRef);
        if (!baseTip || !headTip) {
          sendJson(res, 200, []);
          return true;
        }
        const mergeBase = store.mergeBase(repo, baseTip, headTip);
        const baseMap = mergeBase ? store.fileMapAt(repo, mergeBase) : new Map();
        const headMap = store.fileMapAt(repo, headTip);
        const diff = store.diffFileMaps(repo, baseMap, headMap);
        sendJson(
          res,
          200,
          diff.map((d) => ({
            filename: d.path,
            status: d.status,
            additions: d.additions,
            deletions: d.deletions,
            changes: d.additions + d.deletions,
            sha: headMap.get(d.path)?.oid ?? baseMap.get(d.path)?.oid ?? '',
            blob_url: '',
            raw_url: '',
          })),
        );
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const parsed = parseBody(ctx, res, true);
        if (parsed === null) return true;
        if (pr.merged || pr.state === 'closed') {
          sendError(res, 405, 'Pull request is already merged or closed');
          return true;
        }
        const baseTip = tipOfRef(repo, pr.baseRef);
        const headTip = tipOfRef(repo, pr.headRef);
        if (!baseTip || !headTip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const mergeBase = store.mergeBase(repo, baseTip, headTip);
        if (!mergeBase) {
          sendError(res, 405, 'No merge base found');
          return true;
        }
        const { files, conflicts } = store.threeWayMerge(
          store.fileMapAt(repo, mergeBase),
          store.fileMapAt(repo, baseTip),
          store.fileMapAt(repo, headTip),
        );
        if (conflicts.length > 0) {
          sendError(res, 405, `Merge conflict in: ${conflicts.join(', ')}`);
          return true;
        }
        const tree = store.treeFromFileMap(repo, files);
        const message = `${pr.title} (#${pr.number})`;
        const mergeSha = store.makeCommit(repo, tree, [baseTip], message);
        store.setRef(repo, `refs/heads/${pr.baseRef}`, mergeSha);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = store.clock.nowIso();
        pr.mergeCommitSha = mergeSha;
        pr.updatedAt = store.clock.nowIso();
        sendJson(res, 200, { merged: true, sha: mergeSha, message: 'Pull request successfully merged' });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // No repo sub-route matched.
    sendError(res, 404, 'Not Found');
    return true;
  }

  // Anything else under /api/v3.
  sendError(res, 404, 'Not Found');
  return true;
}
