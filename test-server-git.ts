// Tiny scratch server for test-git.mjs: dispatches ONLY to handleGit.
// Builds one fixture repo (owner = scenario viewer) with a 3-commit chain
// on main plus an annotated tag v1 on the second commit, then prints READY
// and the fixture oids for the test to use.
import { createServer } from 'node:http';
import { Store } from './src/store.ts';
import { handleGit } from './src/git.ts';
import type { Ctx } from './src/git.ts';
import { bearerToken, lowerHeaders, readBody } from './src/util.ts';

const store = new Store();
const owner = store.viewer.login;
const repo = store.createRepo(owner, 'gitconf-test', 'git conformance test', true);
if (!repo) throw new Error('fixture repo already exists');

const blobA = store.putObject(repo, 'blob', Buffer.from('alpha\n', 'utf8'));
const blobA2 = store.putObject(repo, 'blob', Buffer.from('alpha revision 2\n', 'utf8'));
const blobA3 = store.putObject(repo, 'blob', Buffer.from('alpha revision 3\n', 'utf8'));
const blobB = store.putObject(repo, 'blob', Buffer.from('beta\n', 'utf8'));
const blobC = store.putObject(repo, 'blob', Buffer.from('gamma\n', 'utf8'));
const blobOld = store.putObject(repo, 'blob', Buffer.from('old file\n', 'utf8'));

const tree1 = store.treeFromFileMap(
  repo,
  new Map([['a.txt', { mode: '100644', oid: blobA }]]),
);
const tree2 = store.treeFromFileMap(
  repo,
  new Map([
    ['a.txt', { mode: '100644', oid: blobA2 }],
    ['b.txt', { mode: '100644', oid: blobB }],
  ]),
);
const tree3 = store.treeFromFileMap(
  repo,
  new Map([
    ['a.txt', { mode: '100644', oid: blobA3 }],
    ['b.txt', { mode: '100644', oid: blobB }],
    ['old.txt', { mode: '100644', oid: blobOld }],
    ['src/c.txt', { mode: '100644', oid: blobC }],
  ]),
);

const c1 = store.makeCommit(repo, tree1, [], 'first commit');
const c2 = store.makeCommit(repo, tree2, [c1], 'second commit');
const c3 = store.makeCommit(repo, tree3, [c2], 'third commit');
store.setRef(repo, 'refs/heads/main', c3);

const who = `${store.viewer.name} <${store.viewer.email}> 1735689600 +0000`;
const tag = store.putObject(
  repo,
  'tag',
  Buffer.from(`object ${c2}\ntype commit\ntag v1\ntagger ${who}\n\nv1\n`, 'utf8'),
);
store.setRef(repo, 'refs/tags/v1', tag);

// A second, empty repo (no refs) for the clone-empty behaviour.
const emptyRepo = store.createRepo(owner, 'gitconf-empty', 'empty repo', true);
if (!emptyRepo) throw new Error('empty fixture repo already exists');

const fixture = {
  owner,
  repo: 'gitconf-test',
  emptyRepo: 'gitconf-empty',
  c1,
  c2,
  c3,
  tag,
  tree1,
  tree2,
  tree3,
  blobContents: {
    [blobA]: 'alpha\n',
    [blobA2]: 'alpha revision 2\n',
    [blobA3]: 'alpha revision 3\n',
    [blobB]: 'beta\n',
    [blobC]: 'gamma\n',
    [blobOld]: 'old file\n',
  },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const headers = lowerHeaders(req);
    const body = await readBody(req);
    const ctx: Ctx = {
      store,
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
      token: bearerToken(headers),
    };
    const handled = await handleGit(ctx, res);
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(`${JSON.stringify({ message: 'Not Found' })}\n`);
    }
  } catch {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(`${JSON.stringify({ message: 'Internal Server Error' })}\n`);
      } else res.end();
    } catch {
      // ignore
    }
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`READY ${port}`);
  console.log(`FIXTURE ${JSON.stringify(fixture)}`);
});
