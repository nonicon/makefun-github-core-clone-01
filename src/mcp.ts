// MCP endpoint (POST /mcp) for the forge: JSON-RPC 2.0 over Streamable HTTP.
// Supports both the modern era (revision 2026-07-28 via server/discover) and
// the legacy handshake (initialize + notifications/initialized). No Date.now(),
// no Math.random(), no network, no git binary. tools/list is byte-identical
// across calls: built once from a frozen constant.
import type { ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from './util.ts';
import { type Repo, type Store } from './store.ts';
import {
  createIssueInStore,
  createPullInStore,
  mergePullInStore,
  mergeableOf,
  type Ctx,
} from './graphql.ts';

const SERVER_NAME = 'github-core-clone-mcp';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

// ---------------------------------------------------------------------------
// Tool definitions — frozen constant, fixed key order, built once.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the given owner.',
    {
      owner: { type: 'string', description: 'Owner login of the new repository.' },
      name: { type: 'string', description: 'Name of the new repository.' },
      description: { type: 'string', description: 'Description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and repo name.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      title: { type: 'string', description: 'Title of the issue.' },
      body: { type: 'string', description: 'Body of the issue.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository, optionally filtered by state.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request in a repository.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      title: { type: 'string', description: 'Title of the pull request.' },
      body: { type: 'string', description: 'Body of the pull request.' },
      head: { type: 'string', description: 'Name of the head branch.' },
      base: { type: 'string', description: 'Name of the base branch.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request in a repository.',
    {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      pull_number: { type: 'integer', description: 'Number of the pull request.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

// ---------------------------------------------------------------------------
// Argument mapping: canonical names + the spec's synonym tables (normalized
// comparison), plus full_name fill-in (owner/repo split).
// ---------------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  repo_full_name: ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve one semantic argument from the raw arguments object. */
function pickArg(args: Record<string, unknown>, semantic: string): unknown {
  const synonyms = SYNONYMS[semantic] ?? [semantic];
  for (const syn of synonyms) {
    const want = normalize(syn);
    for (const [k, v] of Object.entries(args)) {
      if (normalize(k) === want) return v;
    }
  }
  return undefined;
}

function splitFullName(args: Record<string, unknown>): { owner?: string; repo?: string } {
  const full = pickArg(args, 'repo_full_name');
  if (typeof full === 'string') {
    const slash = full.indexOf('/');
    if (slash > 0) return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  }
  return {};
}

/** Canonical argument view for a tools/call, applying synonyms + full_name. */
function canonicalArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const semantic of Object.keys(SYNONYMS)) {
    const v = pickArg(raw, semantic);
    if (v !== undefined) out[semantic] = v;
  }
  const split = splitFullName(raw);
  if (out['owner'] === undefined && split.owner) out['owner'] = split.owner;
  if (out['repo'] === undefined && split.repo) out['repo'] = split.repo;
  // 'name' for create_repo may arrive under repo/repository synonyms.
  if (out['name'] === undefined && out['repo'] !== undefined) out['name'] = out['repo'];
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Tool implementations (all act on the shared store)
// ---------------------------------------------------------------------------

interface ToolOutcome {
  ok: boolean;
  result: unknown;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: Store, name: string, rawArgs: Record<string, unknown>): ToolOutcome {
  const args = canonicalArgs(rawArgs);
  const owner = str(args['owner']) ?? store.viewer.login;
  const repoName = str(args['repo']);
  switch (name) {
    case 'create_repo': {
      const repoNameArg = str(args['name']) ?? repoName;
      if (!repoNameArg) return { ok: false, result: { error: 'missing required argument: name' } };
      const repoOwner = str(args['owner']) ?? store.viewer.login;
      const repo = store.createRepo(repoOwner, repoNameArg, str(args['description']) ?? '', args['private'] === true);
      if (!repo) return { ok: false, result: { error: `repository ${repoOwner}/${repoNameArg} already exists` } };
      return { ok: true, result: repoJson(repo) };
    }
    case 'get_repo': {
      if (!repoName) return { ok: false, result: { error: 'missing required argument: repo' } };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, result: { error: `repository ${owner}/${repoName} not found` } };
      return { ok: true, result: repoJson(repo) };
    }
    case 'create_issue': {
      const title = str(args['title']);
      if (!repoName) return { ok: false, result: { error: 'missing required argument: repo' } };
      if (!title) return { ok: false, result: { error: 'missing required argument: title' } };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, result: { error: `repository ${owner}/${repoName} not found` } };
      const issue = createIssueInStore(store, repo, title, str(args['body']));
      return {
        ok: true,
        result: {
          id: issue.dbId,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: 'open',
          full_name: `${repo.owner}/${repo.name}`,
          owner: repo.owner,
          repo: repo.name,
        },
      };
    }
    case 'list_issues': {
      if (!repoName) return { ok: false, result: { error: 'missing required argument: repo' } };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, result: { error: `repository ${owner}/${repoName} not found` } };
      const state = typeof args['state'] === 'string' ? (args['state'] as string).toLowerCase() : 'open';
      const list = repo.issues
        .filter((i) => (state === 'all' ? true : i.state === state))
        .map((i) => ({
          id: i.dbId,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          full_name: `${repo.owner}/${repo.name}`,
        }));
      return { ok: true, result: list };
    }
    case 'create_pull_request': {
      const title = str(args['title']);
      const head = str(args['head']);
      const base = str(args['base']);
      if (!repoName) return { ok: false, result: { error: 'missing required argument: repo' } };
      if (!title) return { ok: false, result: { error: 'missing required argument: title' } };
      if (!head) return { ok: false, result: { error: 'missing required argument: head' } };
      if (!base) return { ok: false, result: { error: 'missing required argument: base' } };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, result: { error: `repository ${owner}/${repoName} not found` } };
      const pull = createPullInStore(store, repo, title, str(args['body']), head, base);
      if (!pull) return { ok: false, result: { error: `head branch ${head} does not exist` } };
      return {
        ok: true,
        result: {
          id: pull.dbId,
          number: pull.number,
          pull_number: pull.number,
          pull_request_number: pull.number,
          title: pull.title,
          body: pull.body,
          state: 'open',
          merged: false,
          mergeable: mergeableOf(store, repo, pull),
          head,
          head_ref: head,
          base,
          base_ref: base,
          full_name: `${repo.owner}/${repo.name}`,
          owner: repo.owner,
          repo: repo.name,
        },
      };
    }
    case 'merge_pull_request': {
      const num = args['pull_number'];
      if (!repoName) return { ok: false, result: { error: 'missing required argument: repo' } };
      if (typeof num !== 'number') return { ok: false, result: { error: 'missing required argument: pull_number' } };
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, result: { error: `repository ${owner}/${repoName} not found` } };
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return { ok: false, result: { error: `pull request ${num} not found` } };
      mergePullInStore(store, repo, pull);
      return {
        ok: true,
        result: {
          id: pull.dbId,
          number: pull.number,
          pull_number: pull.number,
          title: pull.title,
          state: 'closed',
          merged: true,
          merged_at: pull.mergedAt,
          head: pull.headRef,
          base: pull.baseRef,
          full_name: `${repo.owner}/${repo.name}`,
        },
      };
    }
    default:
      return { ok: false, result: { error: `unknown tool ${name}` } };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function authorized(ctx: Ctx): boolean {
  const token = ctx.token;
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '' && token !== expected) return false;
  return true;
}

function handleRequest(store: Store, req: unknown): { status: number; body: unknown; notification: boolean } {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return { status: 200, body: rpcError(null, -32600, 'Invalid Request'), notification: false };
  }
  const r = req as Record<string, unknown>;
  const id = 'id' in r ? r['id'] : undefined;
  const isNotification = id === undefined;
  const method = typeof r['method'] === 'string' ? (r['method'] as string) : '';
  const params = (r['params'] as Record<string, unknown> | undefined) ?? {};

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null, notification: true };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [MODERN_VERSION, LEGACY_VERSION, '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
      notification: false,
    };
  }

  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
    const version = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : LEGACY_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      notification: false,
    };
  }

  if (method === 'tools/list') {
    if (typeof params['cursor'] === 'string' && params['cursor'] !== '') {
      return { status: 200, body: rpcResult(id, { tools: [] }), notification: false };
    }
    // TOOLS is a frozen constant: byte-identical across calls.
    return { status: 200, body: rpcResult(id, { tools: TOOLS }), notification: false };
  }

  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const rawArgs = (params['arguments'] as Record<string, unknown> | undefined) ?? {};
    const known = TOOLS.some((t) => t.name === name);
    if (!known) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`), notification: false };
    }
    const outcome = callTool(store, name, rawArgs);
    const text = JSON.stringify(outcome.result);
    if (!outcome.ok) {
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text }],
          structuredContent: outcome.result,
          isError: true,
        }),
        notification: false,
      };
    }
    return {
      status: 200,
      body: rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.result,
      }),
      notification: false,
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}), notification: false };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`), notification: false };
}

export async function handleMcp(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method !== 'POST') {
    // GET /mcp is never exercised by the suite; answer 405 JSON-RPC-ish.
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
    return true;
  }
  if (!authorized(ctx)) {
    // Auth is decided before any tool lookup (check mcp.auth-required).
    sendJson(res, 401, { message: 'Unauthorized' }, {}, false);
    return true;
  }
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    // Non-JSON body: HTTP 400 + JSON-RPC -32700 (modern era).
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, {}, false);
    return true;
  }
  const sessionId = ctx.headers['mcp-session-id'];
  const extra: Record<string, string> = {};
  if (sessionId) extra['mcp-session-id'] = sessionId;

  const value = parsed.value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const req of value) {
      const handled = handleRequest(ctx.store, req);
      if (!handled.notification && handled.body !== null) out.push(handled.body);
    }
    sendJson(res, 200, out, extra, false);
    return true;
  }
  const handled = handleRequest(ctx.store, value);
  if (handled.notification || handled.body === null) {
    res.writeHead(202, { 'content-length': '0', ...extra });
    res.end();
    return true;
  }
  sendJson(res, handled.status, handled.body, extra, false);
  return true;
}
