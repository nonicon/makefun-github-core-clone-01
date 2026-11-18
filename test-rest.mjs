// REST module tests: plain node, no deps. Boots test-server.ts on a
// scratch port and exercises the /api/v3 surface with fetch.
// Run: node test-rest.mjs
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const TOKEN = 'test-token-123';
const OWNER = 'adaiversen'; // viewer login from the scenario seed

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', 'test-server.ts', '0'],
  {
    cwd: new URL('.', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, MAKEFUN_SHOP_TOKEN: TOKEN },
  },
);

let failures = 0;
let passes = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) {
    passes += 1;
    results.push(`PASS ${name}`);
  } else {
    failures += 1;
    results.push(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function main() {
  const [line] = await once(server.stdout, 'data');
  const port = Number(String(line).trim().split(/\s+/).pop());
  const base = `http://127.0.0.1:${port}`;

  async function req(path, { method = 'GET', body = undefined, token = TOKEN, rawBody = undefined, headers = {} } = {}) {
    const h = { Accept: 'application/vnd.github+json', ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const init = { method, headers: h, redirect: 'follow' };
    if (rawBody !== undefined) {
      init.body = rawBody;
      h['Content-Type'] = 'application/json';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: res.status, headers: res.headers, text, json };
  }

  const reqId = (r) => r.headers.get('x-github-request-id');

  // ---- root + meta -------------------------------------------------------
  let r = await req('/api/v3/');
  check('root 200 + json + request-id + scopes', r.status === 200 && r.json && typeof r.json === 'object'
    && reqId(r) && r.headers.get('x-oauth-scopes') === 'repo, read:org', `status=${r.status} body=${r.text.slice(0, 120)}`);
  r = await req('/api/v3/meta');
  check('meta 200 installed_version non-empty', r.status === 200 && r.json && typeof r.json.installed_version === 'string' && r.json.installed_version.length > 0, `status=${r.status} body=${r.text.slice(0, 120)}`);
  r = await req('/api/v3/user');
  check('user 200 login=viewer', r.status === 200 && r.json && r.json.login === OWNER, `status=${r.status} body=${r.text.slice(0, 120)}`);

  // ---- repo create / duplicate / get / patch / delete --------------------
  r = await req('/api/v3/user/repos', { method: 'POST', body: { name: 't-basic', private: true, description: 'desc-one' } });
  check('repo create 201 private=true', r.status === 201 && r.json && r.json.private === true && r.json.name === 't-basic' && r.json.default_branch === 'main', `status=${r.status} body=${r.text.slice(0, 200)}`);
  r = await req('/api/v3/user/repos', { method: 'POST', body: { name: 't-basic', private: true, description: 'dup' } });
  check('repo duplicate 422', r.status === 422 && r.json && typeof r.json.message === 'string' && r.json.message.length > 0, `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/t-basic`);
  check('repo get 200 description', r.status === 200 && r.json && r.json.description === 'desc-one' && r.json.full_name === `${OWNER}/t-basic`, `status=${r.status} body=${r.text.slice(0, 200)}`);
  r = await req(`/api/v3/repos/${OWNER}/t-basic`, { method: 'PATCH', body: { description: 'desc-two' } });
  check('repo patch 200 descriptionAlt', r.status === 200 && r.json && r.json.description === 'desc-two', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/t-basic`);
  check('repo patch persists on GET', r.status === 200 && r.json && r.json.description === 'desc-two', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/t-basic`, { method: 'DELETE' });
  check('repo delete 204 empty body', r.status === 204 && r.text === '', `status=${r.status} body=${JSON.stringify(r.text)}`);
  r = await req(`/api/v3/repos/${OWNER}/t-basic`);
  check('repo get after delete 404', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/never-created-repo`);
  check('repo not-found 404', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status}`);

  // ---- auth / foreign owner / unknown route / malformed JSON -------------
  r = await req(`/api/v3/repos/${OWNER}/t-basic`, { token: null });
  check('unauthorized 401 no token', r.status === 401 && r.json && typeof r.json.message === 'string' && reqId(r), `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/t-basic`, { token: 'wrong-token' });
  check('wrong token 401', r.status === 401 && r.json && typeof r.json.message === 'string', `status=${r.status}`);
  r = await req(`/api/v3/repos/olgabauer/t-basic`);
  check('foreign owner 404 never 403', r.status === 404, `status=${r.status}`);
  r = await req('/api/v3/no-such-route/whatever');
  check('unknown route 404 json', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status}`);
  r = await req('/api/v3/user/repos', { method: 'POST', rawBody: '{"name":' });
  check('malformed JSON 400', r.status === 400 && r.json && typeof r.json.message === 'string', `status=${r.status} body=${r.text.slice(0, 120)}`);
  r = await req('/api/v3/repos/x/y', { token: null });
  check('protocol: 401 reply is json + request-id', r.status === 401 && r.headers.get('content-type')?.includes('application/json') && reqId(r), `status=${r.status}`);

  // ---- pagination: 30 repos, per_page=10 -> 3 pages ----------------------
  const pageNames = [];
  for (let i = 0; i < 30; i += 1) {
    const name = `t-page-${String(i).padStart(2, '0')}`;
    const cr = await req('/api/v3/user/repos', { method: 'POST', body: { name, private: true, description: '' } });
    if (cr.status !== 201 && cr.status !== 422) check(`pagination setup create ${name}`, false, `status=${cr.status}`);
  }
  const seen = new Set();
  let pages = 0;
  let nextUrl = `${base}/api/v3/user/repos?per_page=10`;
  let overLimit = false;
  let guard = 0;
  while (nextUrl && guard < 25) {
    guard += 1;
    const res = await fetch(nextUrl, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' } });
    const items = await res.json();
    pages += 1;
    if (!Array.isArray(items) || items.length > 10) overLimit = true;
    for (const it of items) {
      if (seen.has(it.name)) overLimit = true;
      seen.add(it.name);
    }
    const link = res.headers.get('link') ?? '';
    const m = /<([^>]+)>;\s*rel="next"/i.exec(link);
    nextUrl = m ? m[1] : null;
    if (nextUrl && !nextUrl.startsWith(base)) { check('pagination next stays same-origin', false, nextUrl); nextUrl = null; }
  }
  const missing = [];
  for (let i = 0; i < 30; i += 1) {
    const name = `t-page-${String(i).padStart(2, '0')}`;
    if (!seen.has(name)) missing.push(name);
  }
  check('pagination 3+ pages, <=10/page, no dupes, all 30 found', pages >= 3 && !overLimit && missing.length === 0, `pages=${pages} overLimit=${overLimit} missing=${missing.join(',')}`);

  // ---- contents: create / update / stale 409 / delete / dir / ?ref= ------
  const repo = 't-contents';
  r = await req('/api/v3/user/repos', { method: 'POST', body: { name: repo, private: true, description: '' } });
  check('contents fixture repo 201', r.status === 201, `status=${r.status}`);
  const filePath = 'docs/readme.md';
  r = await req(`/api/v3/repos/${OWNER}/${repo}/contents/${filePath}`, {
    method: 'PUT', body: { message: 'add readme', content: b64('hello world\n') },
  });
  check('contents create 201 content.sha + commit.sha SHA40', r.status === 201 && r.json
    && /^[0-9a-f]{40}$/.test(r.json.content?.sha ?? '') && /^[0-9a-f]{40}$/.test(r.json.commit?.sha ?? '')
    && r.json.content?.encoding === 'base64', `status=${r.status} body=${r.text.slice(0, 200)}`);
  const firstBlobSha = r.json.content.sha;
  r = await req(`/api/v3/repos/${OWNER}/${repo}/contents/${filePath}`);
  check('contents get 200 base64 round-trip + size', r.status === 200 && r.json
    && Buffer.from(r.json.content.replace(/\s/g, ''), 'base64').toString('utf8') === 'hello world\n'
    && r.json.size === 12 && r.json.sha === firstBlobSha && r.json.type === 'file', `status=${r.status} body=${r.text.slice(0, 200)}`);
  r = await req(`/api/v3/repos/${OWNER}/${repo}/contents/${filePath}`, {
    method: 'PUT', body: { message: 'update readme', content: b64('hello world v2\n'), sha: firstBlobSha },
  });
  check('contents update 200 sha changes', r.status === 200 && r.json && r.json.content?.sha !== firstBlobSha, `status=${r.status} body=${r.text.slice(0, 200)}`);
  const secondBlobSha = r.json.content.sha;
  r = await req(`/api/v3/repos/${OWNER}/${repo}/contents/${filePath}`, {
    method: 'PUT', body: { message: 'stale update', content: b64('stale\n'), sha: firstBlobSha },
  });
  check('contents stale sha 409', r.status === 409 && r.json && typeof r.json.message === 'string', `status=${r.status}`);
  // directory listing: 3 files in one dir
  for (const f of ['seed.txt', 'one.txt', 'two.txt']) {
    const cr = await req(`/api/v3/repos/${OWNER}/${repo}/contents/dir/${f}`, {
      method: 'PUT', body: { message: `add ${f}`, content: b64(`content of ${f}\n`) },
    });
    if (cr.status !== 201) check(`contents dir setup ${f}`, false, `status=${cr.status}`);
  }
  r = await req(`/api/v3/repos/${OWNER}/${repo}/contents/dir`);
  const dirNames = Array.isArray(r.json) ? r.json.map((e) => e.name) : [];
  check('contents directory listing has 3 files', r.status === 200 && Array.isArray(r.json)
    && dirNames.includes('seed.txt') && dirNames.includes('one.txt') && dirNames.includes('two.txt')
    && r.json.every((e) => (e.type === 'file' || e.type === 'dir') && e.name && e.path && /^[0-9a-f]{40}$/.test(e.sha ?? '')), `status=${r.status} body=${r.text.slice(0, 300)}`);
  // delete
  r = await req(`/api/v3/repos/${OWNER}/${repo}/contents/${filePath}`, {
    method: 'DELETE', body: { message: 'remove readme', sha: secondBlobSha },
  });
  check('contents delete 200 commit.sha', r.status === 200 && r.json && /^[0-9a-f]{40}$/.test(r.json.commit?.sha ?? ''), `status=${r.status} body=${r.text.slice(0, 200)}`);
  r = await req(`/api/v3/repos/${OWNER}/${repo}/contents/${filePath}`);
  check('contents get after delete 404', r.status === 404, `status=${r.status}`);

  // ---- labels + issues ----------------------------------------------------
  const irepo = 't-issues';
  await req('/api/v3/user/repos', { method: 'POST', body: { name: irepo, private: true, description: '' } });
  await req(`/api/v3/repos/${OWNER}/${irepo}/contents/seed.txt`, { method: 'PUT', body: { message: 'seed', content: b64('seed\n') } });
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/labels`, { method: 'POST', body: { name: 'bug', color: 'ededed' } });
  check('label create 201 name', r.status === 201 && r.json && r.json.name === 'bug', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/labels`);
  check('labels list contains bug', r.status === 200 && Array.isArray(r.json) && r.json.some((l) => l.name === 'bug'), `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues`, { method: 'POST', body: { title: 'first issue', body: 'body one', labels: ['bug'] } });
  check('issue create 201 open + labels', r.status === 201 && r.json && r.json.state === 'open' && r.json.title === 'first issue' && r.json.body === 'body one'
    && Array.isArray(r.json.labels) && r.json.labels.some((l) => l.name === 'bug') && Number.isInteger(r.json.number) && r.json.number >= 1, `status=${r.status} body=${r.text.slice(0, 250)}`);
  const issue1 = r.json.number;
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues`, { method: 'POST', body: { title: 'second issue', body: 'body two' } });
  check('issue numbers increment by 1', r.status === 201 && r.json && r.json.number === issue1 + 1, `status=${r.status} first=${issue1} second=${r.json?.number}`);
  const issue2 = r.json.number;
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues`, { method: 'POST', body: { title: 'bad label issue', body: 'x', labels: ['bug-not-a-label'] } });
  check('issue bad label 422', r.status === 422 && r.json && typeof r.json.message === 'string', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues/${issue1}`);
  check('issue get-one number/title/body', r.status === 200 && r.json && r.json.number === issue1 && r.json.title === 'first issue' && r.json.body === 'body one', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues/${issue1}/comments`, { method: 'POST', body: { body: 'a comment' } });
  check('comment create 201 id>=1 body echo', r.status === 201 && r.json && Number.isInteger(r.json.id) && r.json.id >= 1 && r.json.body === 'a comment', `status=${r.status} body=${r.text.slice(0, 200)}`);
  const commentId = r.json.id;
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues/${issue1}/comments`);
  check('comments list contains id+body', r.status === 200 && Array.isArray(r.json) && r.json.some((c) => c.id === commentId && c.body === 'a comment'), `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues/${issue2}`, { method: 'PATCH', body: { state: 'closed' } });
  check('issue patch-close 200 closed', r.status === 200 && r.json && r.json.state === 'closed', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues/${issue2}`);
  check('issue patch-close persists', r.status === 200 && r.json && r.json.state === 'closed', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${irepo}/issues?state=open&per_page=100`);
  check('issues list-open only open', r.status === 200 && Array.isArray(r.json) && r.json.length >= 1 && r.json.every((i) => i.state === 'open') && r.json.some((i) => i.number === issue1) && !r.json.some((i) => i.number === issue2), `status=${r.status} body=${r.text.slice(0, 200)}`);
  // sort asc/desc with 3 fresh issues in a new repo
  const srepo = 't-issues-sort';
  await req('/api/v3/user/repos', { method: 'POST', body: { name: srepo, private: true, description: '' } });
  const nums = [];
  for (let i = 0; i < 3; i += 1) {
    const cr = await req(`/api/v3/repos/${OWNER}/${srepo}/issues`, { method: 'POST', body: { title: `s${i}`, body: '' } });
    nums.push(cr.json.number);
  }
  r = await req(`/api/v3/repos/${OWNER}/${srepo}/issues?state=open&sort=created&direction=asc&per_page=100`);
  const ascNums = Array.isArray(r.json) ? r.json.map((i) => i.number) : [];
  check('issues sort asc creation order', r.status === 200 && JSON.stringify(ascNums) === JSON.stringify(nums), `asc=${ascNums} expected=${nums}`);
  r = await req(`/api/v3/repos/${OWNER}/${srepo}/issues?state=open&sort=created&direction=desc&per_page=100`);
  const descNums = Array.isArray(r.json) ? r.json.map((i) => i.number) : [];
  check('issues sort desc newest first', r.status === 200 && JSON.stringify(descNums) === JSON.stringify([...nums].reverse()), `desc=${descNums} expected=${[...nums].reverse()}`);

  // ---- branches / commits isolation ---------------------------------------
  const brepo = 't-branches';
  await req('/api/v3/user/repos', { method: 'POST', body: { name: brepo, private: true, description: '' } });
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/contents/seed.txt`, { method: 'PUT', body: { message: 'initial commit', content: b64('seed\n') } });
  const initSha = r.json.commit.sha;
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/feature-x', sha: initSha } });
  check('git/refs create 201 ref echo', r.status === 201 && r.json && r.json.ref === 'refs/heads/feature-x' && /^[0-9a-f]{40}$/.test(r.json.object?.sha ?? ''), `status=${r.status} body=${r.text.slice(0, 200)}`);
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/branches`);
  check('branches list has feature-x at init sha + main', r.status === 200 && Array.isArray(r.json)
    && r.json.some((b) => b.name === 'feature-x' && b.commit.sha.toLowerCase() === initSha.toLowerCase())
    && r.json.some((b) => b.name === 'main'), `status=${r.status} body=${r.text.slice(0, 300)}`);
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/contents/branch-file.txt?branch=feature-x`, {
    method: 'PUT', body: { message: 'branch commit (commits)', content: b64('branch only\n'), branch: 'feature-x' },
  });
  check('contents commit on branch 201', r.status === 201, `status=${r.status} body=${r.text.slice(0, 200)}`);
  const branchCommitSha = r.json.commit.sha;
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/commits?sha=feature-x`);
  check('commits?sha=branch lists branch commit with exact message', r.status === 200 && Array.isArray(r.json)
    && r.json.some((c) => c.sha.toLowerCase() === branchCommitSha.toLowerCase() && c.commit.message === 'branch commit (commits)'), `status=${r.status} body=${r.text.slice(0, 300)}`);
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/commits`);
  check('commits (default) excludes branch-only commit', r.status === 200 && Array.isArray(r.json)
    && !r.json.some((c) => c.sha.toLowerCase() === branchCommitSha.toLowerCase())
    && r.json.some((c) => c.sha.toLowerCase() === initSha.toLowerCase()), `status=${r.status} body=${r.text.slice(0, 300)}`);
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/contents/branch-file.txt?ref=feature-x`);
  check('contents ?ref=branch reads branch file', r.status === 200 && r.json
    && Buffer.from(r.json.content.replace(/\s/g, ''), 'base64').toString('utf8') === 'branch only\n', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${brepo}/contents/branch-file.txt`);
  check('contents default branch lacks branch file 404', r.status === 404, `status=${r.status}`);

  // ---- pulls: create, files, squash merge, conflict ----------------------
  const prepo = 't-pulls';
  await req('/api/v3/user/repos', { method: 'POST', body: { name: prepo, private: true, description: '' } });
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/contents/seed.txt`, { method: 'PUT', body: { message: 'initial commit', content: b64('seed\n') } });
  const pInitSha = r.json.commit.sha;
  // head branch + one file commit
  await req(`/api/v3/repos/${OWNER}/${prepo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/feature-a', sha: pInitSha } });
  await req(`/api/v3/repos/${OWNER}/${prepo}/contents/docs/readme-a.md?branch=feature-a`, {
    method: 'PUT', body: { message: 'add readme a', content: b64('readme a\n'), branch: 'feature-a' },
  });
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls`, { method: 'POST', body: { title: 'PR A', body: 'pr a body', head: 'feature-a', base: 'main' } });
  check('pull create 201 open head/base refs+shas', r.status === 201 && r.json && r.json.state === 'open'
    && r.json.head.ref === 'feature-a' && r.json.base.ref === 'main'
    && /^[0-9a-f]{40}$/.test(r.json.head.sha ?? '') && r.json.base.sha.toLowerCase() === pInitSha.toLowerCase()
    && r.json.title === 'PR A' && r.json.body === 'pr a body', `status=${r.status} body=${r.text.slice(0, 300)}`);
  const prA = r.json.number;
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls/${prA}`);
  check('pull get-one number/title', r.status === 200 && r.json && r.json.number === prA && r.json.title === 'PR A', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls/${prA}/files`);
  check('pull files list added file additions>=1', r.status === 200 && Array.isArray(r.json) && r.json.length >= 1
    && r.json.some((f) => f.filename === 'docs/readme-a.md' && ['added', 'modified', 'changed'].includes(f.status) && f.additions >= 1 && Number.isInteger(f.deletions) && Number.isInteger(f.changes)), `status=${r.status} body=${r.text.slice(0, 300)}`);
  // second PR on a second file, to test list filters after merge
  await req(`/api/v3/repos/${OWNER}/${prepo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/feature-b', sha: pInitSha } });
  await req(`/api/v3/repos/${OWNER}/${prepo}/contents/docs/readme-b.md?branch=feature-b`, {
    method: 'PUT', body: { message: 'add readme b', content: b64('readme b\n'), branch: 'feature-b' },
  });
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls`, { method: 'POST', body: { title: 'PR B', body: 'pr b body', head: 'feature-b', base: 'main' } });
  const prB = r.json.number;
  check('pull B create 201 (number increments after A)', r.status === 201 && r.json && r.json.number === prA + 1, `status=${r.status} prA=${prA} prB=${r.json?.number}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls/${prB}/files`);
  check('pull B files list has readme-b', r.status === 200 && Array.isArray(r.json) && r.json.some((f) => f.filename === 'docs/readme-b.md'), `status=${r.status}`);
  // merge A (squash)
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls/${prA}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('pull merge squash 200 merged=true sha SHA40', r.status === 200 && r.json && r.json.merged === true && /^[0-9a-f]{40}$/.test(r.json.sha ?? '') && typeof r.json.message === 'string', `status=${r.status} body=${r.text.slice(0, 200)}`);
  const mergeSha = r.json.sha;
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls/${prA}`);
  check('merged PR closed + merged + merged_at + merge_commit_sha', r.status === 200 && r.json && r.json.state === 'closed' && r.json.merged === true
    && typeof r.json.merged_at === 'string' && r.json.merged_at.length > 0 && r.json.merge_commit_sha?.toLowerCase() === mergeSha.toLowerCase(), `status=${r.status} body=${r.text.slice(0, 300)}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/commits?sha=main`);
  check('merge commit on default branch list', r.status === 200 && Array.isArray(r.json) && r.json.some((c) => c.sha.toLowerCase() === mergeSha.toLowerCase()), `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/contents/docs/readme-a.md?ref=main`);
  check('merge content on default decodes to merged bytes', r.status === 200 && r.json
    && Buffer.from(r.json.content.replace(/\s/g, ''), 'base64').toString('utf8') === 'readme a\n', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls?state=all&per_page=100`);
  check('pulls list state=all has both A and B', r.status === 200 && Array.isArray(r.json)
    && r.json.some((p) => p.number === prA) && r.json.some((p) => p.number === prB), `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls?per_page=100`);
  check('pulls list default open: merged A absent, open B present', r.status === 200 && Array.isArray(r.json)
    && !r.json.some((p) => p.number === prA) && r.json.some((p) => p.number === prB), `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls/999999999`);
  check('pull get unknown 404', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${prepo}/pulls/999999999/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('pull merge unknown 404', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status}`);

  // ---- conflict: two PRs, same file, divergent ---------------------------
  const crepo = 't-conflict';
  await req('/api/v3/user/repos', { method: 'POST', body: { name: crepo, private: true, description: '' } });
  r = await req(`/api/v3/repos/${OWNER}/${crepo}/contents/shared.txt`, { method: 'PUT', body: { message: 'initial commit', content: b64('base\n') } });
  const cInit = r.json.commit.sha;
  await req(`/api/v3/repos/${OWNER}/${crepo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/conflict-a', sha: cInit } });
  await req(`/api/v3/repos/${OWNER}/${crepo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/conflict-b', sha: cInit } });
  await req(`/api/v3/repos/${OWNER}/${crepo}/contents/shared.txt?branch=conflict-a`, {
    method: 'PUT', body: { message: 'edit a', content: b64('version a\n'), branch: 'conflict-a', sha: (await req(`/api/v3/repos/${OWNER}/${crepo}/contents/shared.txt?ref=conflict-a`)).json.sha },
  });
  await req(`/api/v3/repos/${OWNER}/${crepo}/contents/shared.txt?branch=conflict-b`, {
    method: 'PUT', body: { message: 'edit b', content: b64('version b\n'), branch: 'conflict-b', sha: (await req(`/api/v3/repos/${OWNER}/${crepo}/contents/shared.txt?ref=conflict-b`)).json.sha },
  });
  r = await req(`/api/v3/repos/${OWNER}/${crepo}/pulls`, { method: 'POST', body: { title: 'conflict A', body: '', head: 'conflict-a', base: 'main' } });
  const prCA = r.json.number;
  r = await req(`/api/v3/repos/${OWNER}/${crepo}/pulls`, { method: 'POST', body: { title: 'conflict B', body: '', head: 'conflict-b', base: 'main' } });
  const prCB = r.json.number;
  r = await req(`/api/v3/repos/${OWNER}/${crepo}/pulls/${prCA}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('conflict fixture: first merge 200', r.status === 200 && r.json && r.json.merged === true, `status=${r.status}`);
  r = await req(`/api/v3/repos/${OWNER}/${crepo}/pulls/${prCB}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  check('conflict: second merge 405', r.status === 405 && r.json && typeof r.json.message === 'string', `status=${r.status} body=${r.text.slice(0, 200)}`);

  // ---- shared numbering: issue + PR share one counter --------------------
  const nrepo = 't-numbering';
  await req('/api/v3/user/repos', { method: 'POST', body: { name: nrepo, private: true, description: '' } });
  await req(`/api/v3/repos/${OWNER}/${nrepo}/contents/seed.txt`, { method: 'PUT', body: { message: 'seed', content: b64('seed\n') } });
  r = await req(`/api/v3/repos/${OWNER}/${nrepo}/issues`, { method: 'POST', body: { title: 'n1', body: '' } });
  const nIssue = r.json.number;
  await req(`/api/v3/repos/${OWNER}/${nrepo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/feat', sha: (await req(`/api/v3/repos/${OWNER}/${nrepo}/commits`)).json[0].sha } });
  r = await req(`/api/v3/repos/${OWNER}/${nrepo}/pulls`, { method: 'POST', body: { title: 'npr', body: '', head: 'feat', base: 'main' } });
  check('shared numbering: PR number = issue number + 1', r.status === 201 && r.json && r.json.number === nIssue + 1, `issue=${nIssue} pr=${r.json?.number}`);

  // ---- outside /api/v3 returns false (test server 404s) ------------------
  r = await req('/not-api-v3');
  check('outside /api/v3 not handled by rest (404 from test server)', r.status === 404, `status=${r.status}`);

  server.kill();
  console.log(results.join('\n'));
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try { server.kill(); } catch { /* ignore */ }
  process.exit(1);
});
