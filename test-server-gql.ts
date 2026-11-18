// Tiny test server for the GraphQL+MCP modules: dispatches ONLY to
// handleGraphql / handleMcp, seeds the store directly.
// Run: node --experimental-strip-types test-server-gql.ts
// Prints `PORT <n>` on stdout, then serves until killed.
process.env.MAKEFUN_SHOP_TOKEN = 'test-token';

import { createServer } from 'node:http';
import { Store } from './src/store.ts';
import { bearerToken, lowerHeaders, readBody, sendError } from './src/util.ts';
import { handleGraphql, createIssueInStore, createPullInStore, closeIssueInStore } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const store = new Store();
const viewer = store.viewer.login;

function commitFiles(repo: any, files: Record<string, string>, parent: string | null, message: string): string {
  const map = new Map<string, { mode: string; oid: string }>();
  for (const [path, content] of Object.entries(files)) {
    const oid = store.putObject(repo, 'blob', Buffer.from(content, 'utf8'));
    map.set(path, { mode: '100644', oid });
  }
  const tree = store.treeFromFileMap(repo, map);
  return store.makeCommit(repo, tree, parent ? [parent] : [], message);
}

// Main GraphQL repo: base commit + three head branches + issues + one PR.
const repo = store.createRepo(viewer, 'test-gql', 'graphql test repo', false) as any;
const base = commitFiles(repo, { 'README.md': 'hello\n', 'base.txt': 'base\n' }, null, 'initial commit');
store.setRef(repo, 'refs/heads/main', base);
for (const head of ['feature-a', 'feature-b', 'feature-c']) {
  const c = commitFiles(
    repo,
    { 'README.md': 'hello\n', 'base.txt': 'base\n', [`${head}.txt`]: `${head}\n` },
    base,
    `add ${head}`,
  );
  store.setRef(repo, `refs/heads/${head}`, c);
}
const openIssues: any[] = [];
for (let i = 1; i <= 3; i += 1) {
  openIssues.push(createIssueInStore(store, repo, `issue open ${i}`, 'seeded body'));
}
const closedIssue = createIssueInStore(store, repo, 'issue closed', 'seeded body');
closeIssueInStore(store, closedIssue);
const prOne = createPullInStore(store, repo, 'PR one', 'pr body', 'feature-a', 'main') as any;

// Pagination repo: exactly 7 issues.
const pagesRepo = store.createRepo(viewer, 'test-gql-pages', 'pagination repo', false) as any;
const pageIssues: any[] = [];
for (let i = 1; i <= 7; i += 1) {
  pageIssues.push(createIssueInStore(store, pagesRepo, `page issue ${i}`, 'page body'));
}

// MCP repo: base commit + one head branch for PR tools.
const mcpRepo = store.createRepo(viewer, 'mcp-test', 'mcp test repo', true) as any;
const mcpBase = commitFiles(mcpRepo, { 'README.md': 'mcp\n' }, null, 'mcp initial');
store.setRef(mcpRepo, 'refs/heads/main', mcpBase);
const mcpHead = commitFiles(mcpRepo, { 'README.md': 'mcp\n', 'mcp-head.txt': 'head\n' }, mcpBase, 'mcp head');
store.setRef(mcpRepo, 'refs/heads/mcp-head', mcpHead);

const server = createServer(async (req, res) => {
  try {
    const body = await readBody(req as any);
    const url = new URL(req.url ?? '/', 'http://x');
    const headers = lowerHeaders(req as any);
    const ctx: any = {
      store,
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
      token: bearerToken(headers),
    };
    if (url.pathname === '/__seed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        viewer,
        repoDbId: repo.dbId,
        openNumbers: openIssues.map((i: any) => i.number),
        closedNumber: closedIssue.number,
        prNumber: prOne.number,
        pageNumbers: pageIssues.map((i: any) => i.number),
      }));
      return;
    }
    if (await handleGraphql(ctx, res)) return;
    if (await handleMcp(ctx, res)) return;
    sendError(res, 404, 'Not Found');
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: String(err) }));
    }
  }
});

server.listen(0, () => {
  const addr = server.address() as { port: number };
  process.stdout.write(`PORT ${addr.port}\n`);
});
