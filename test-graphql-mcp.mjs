// Tests for src/graphql.ts + src/mcp.ts (plain node, no deps).
// Spawns test-server-gql.ts, runs the 18 GraphQL documents verbatim from
// spec/graphql-mcp.md plus the MCP checks, prints PASS/FAIL per case.
// Usage: node test-graphql-mcp.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const REPO = 'test-gql';
const PAGES_REPO = 'test-gql-pages';

let base = '';
let failures = 0;
let passes = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) {
    passes += 1;
    results.push(`PASS ${name}`);
  } else {
    failures += 1;
    results.push(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- GraphQL documents (verbatim from spec/graphql-mcp.md §A.2) ---
const D1 = `query ViewerLogin {
  viewer {
    login
  }
}`;
const D2 = `query RepositoryFields($owner: String!, $name: String!) {
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
}`;
const D3 = `query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;
const D4 = `query PullRequestAndRepositoryFields {
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
}`;
const D5 = `query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}`;
const D6 = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
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
}`;
const D7 = `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}`;
const D8 = `mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}`;
const D9 = `mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}`;
const D10 = `query PullRequests($owner: String!, $name: String!, $first: Int!) {
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
}`;
const D11 = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
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
}`;
const D12 = `query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}`;
const D13 = `mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}`;
const D14 = `mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}`;
const D15 = `mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}`;
const D16 = `query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}`;
const D17 = `query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}`;
const D18 = `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
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
}`;

async function gql(query, variables = {}, withToken = true) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (withToken) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* leave null */ }
  return { status: res.status, json, text };
}

async function gqlRaw(body, withToken = true) {
  const headers = { 'content-type': 'application/json' };
  if (withToken) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${base}/api/graphql`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

let rpcId = 0;
async function mcp(method, params = {}, opts = {}) {
  const id = opts.id !== undefined ? opts.id : ++rpcId;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (!opts.omitAuth) headers.authorization = `Bearer ${TOKEN}`;
  if (opts.protocolVersion) headers['mcp-protocol-version'] = opts.protocolVersion;
  const body = { jsonrpc: '2.0', method, params };
  if (id !== null) body.id = id;
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* leave null */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function mcpRaw(body, opts = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (!opts.omitAuth) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

function toolText(result) {
  if (!result) return '';
  let out = '';
  for (const b of result.content ?? []) {
    if (b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  if (result.structuredContent !== undefined) out += JSON.stringify(result.structuredContent);
  return out;
}

async function main() {
  // Seed facts from the test server.
  const seedRes = await fetch(`${base}/__seed`);
  const seed = await seedRes.json();
  const viewer = seed.viewer;
  const openNums = seed.openNumbers;
  const closedNum = seed.closedNumber;
  const prNum = seed.prNumber;
  const pageNums = seed.pageNumbers;

  // --- GraphQL ---
  let r = await gql(D1);
  check('gql.viewer-login', r.status === 200 && r.json?.data?.viewer?.login === viewer, JSON.stringify(r.json));

  r = await gql(D2, { owner: viewer, name: REPO });
  const repoFields = r.json?.data?.repository;
  check(
    'gql.repository-fields',
    r.status === 200 && repoFields && repoFields.id && repoFields.databaseId === seed.repoDbId
      && repoFields.name === REPO && repoFields.owner?.login === viewer
      && repoFields.defaultBranchRef?.name === 'main'
      && ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(repoFields.viewerPermission)
      && repoFields.hasIssuesEnabled === true,
    JSON.stringify(r.json),
  );
  const repoId = repoFields?.id;

  r = await gql(D3);
  const issueFieldNames = (r.json?.data?.Issue?.fields ?? []).map((f) => f.name);
  check('gql.introspection-issue', ['id', 'number', 'title', 'state', 'body'].every((n) => issueFieldNames.includes(n)), issueFieldNames.join(','));

  r = await gql(D4);
  const prFieldNames = (r.json?.data?.PullRequest?.fields ?? []).map((f) => f.name);
  const repoFieldNames = (r.json?.data?.Repository?.fields ?? []).map((f) => f.name);
  check(
    'gql.introspection-types',
    ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((n) => prFieldNames.includes(n))
      && ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((n) => repoFieldNames.includes(n)),
    `PR:[${prFieldNames}] Repo:[${repoFieldNames}]`,
  );

  r = await gql(D5);
  const searchVals = (r.json?.data?.SearchType?.enumValues ?? []).map((f) => f.name);
  check('gql.introspection-searchtype', searchVals.includes('ISSUE'), searchVals.join(','));

  r = await gql(D6, { owner: viewer, name: REPO, first: 10 });
  const nodes6 = r.json?.data?.repository?.issues?.nodes ?? [];
  const nums6 = nodes6.map((n) => n.number);
  const ordered = nums6.every((n, i) => i === 0 || n <= nums6[i - 1]);
  check(
    'gql.issues-open-order',
    nodes6.length > 0 && nodes6.length <= 10 && nodes6.every((n) => n.state === 'OPEN' && n.number > 0 && n.id)
      && ordered && !nums6.includes(closedNum) && openNums.every((n) => nums6.includes(n)),
    JSON.stringify(nums6),
  );

  r = await gql(D7, { owner: viewer, name: REPO, number: openNums[0] });
  const issue7 = r.json?.data?.repository?.issue;
  check(
    'gql.issue-by-number',
    issue7 && issue7.number === openNums[0] && issue7.state === 'OPEN' && issue7.title === 'issue open 1'
      && issue7.body === 'seeded body' && issue7.id,
    JSON.stringify(r.json),
  );
  const issueId7 = issue7?.id;

  r = await gql(D8, { input: { repositoryId: repoId, title: 'created over graphql', body: 'seeded body' } });
  const created = r.json?.data?.createIssue?.issue;
  check('gql.create-issue', created && created.number > 0 && created.id, JSON.stringify(r.json));
  const createdNum = created?.number;
  r = await gql(D7, { owner: viewer, name: REPO, number: createdNum });
  check('gql.create-issue-readback', r.json?.data?.repository?.issue?.title === 'created over graphql', JSON.stringify(r.json));

  r = await gql(D8, { input: { repositoryId: repoId, title: 'closed over graphql', body: 'seeded body' } });
  const toCloseNum = r.json?.data?.createIssue?.issue?.number;
  r = await gql(D7, { owner: viewer, name: REPO, number: toCloseNum });
  const toCloseId = r.json?.data?.repository?.issue?.id;
  r = await gql(D9, { input: { issueId: toCloseId } });
  check(
    'gql.close-issue',
    r.json?.data?.closeIssue?.issue?.number === toCloseNum && r.json?.data?.closeIssue?.issue?.state === 'CLOSED',
    JSON.stringify(r.json),
  );
  r = await gql(D7, { owner: viewer, name: REPO, number: toCloseNum });
  check('gql.close-issue-readback', r.json?.data?.repository?.issue?.state === 'CLOSED', JSON.stringify(r.json));

  r = await gql(D10, { owner: viewer, name: REPO, first: 5 });
  const nodes10 = r.json?.data?.repository?.pullRequests?.nodes ?? [];
  const pr10 = nodes10.find((n) => n.number === prNum);
  check(
    'gql.pull-requests-list',
    nodes10.length <= 5 && pr10 && pr10.headRefName === 'feature-a' && pr10.baseRefName === 'main'
      && pr10.state === 'OPEN' && ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr10.mergeable),
    JSON.stringify(nodes10),
  );

  r = await gql(D11, { owner: viewer, name: REPO, number: prNum });
  const paths11 = (r.json?.data?.repository?.pullRequest?.files?.nodes ?? []).map((n) => n.path);
  check('gql.pull-request-files', r.json?.data?.repository?.pullRequest?.number === prNum && paths11.includes('feature-a.txt'), paths11.join(','));

  r = await gql(D12, { owner: viewer, name: REPO, number: prNum });
  const prId = r.json?.data?.repository?.pullRequest?.id;
  check('gql.pull-request-id', prId && r.json?.data?.repository?.pullRequest?.number === prNum, JSON.stringify(r.json));

  r = await gql(D13, { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feature-b', title: 'PR created over graphql' } });
  const createdPr = r.json?.data?.createPullRequest?.pullRequest;
  check(
    'gql.create-pull-request',
    createdPr && createdPr.number > 0 && createdPr.id && createdPr.state === 'OPEN'
      && createdPr.headRefName === 'feature-b' && createdPr.baseRefName === 'main',
    JSON.stringify(r.json),
  );
  const createdPrNum = createdPr?.number;
  r = await gql(D12, { owner: viewer, name: REPO, number: createdPrNum });
  check('gql.create-pull-request-readback', r.json?.data?.repository?.pullRequest?.id === createdPr?.id, JSON.stringify(r.json));

  // Merge PR: create a fresh PR from feature-c, then merge it.
  r = await gql(D13, { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feature-c', title: 'PR to merge' } });
  const mergePrNum = r.json?.data?.createPullRequest?.pullRequest?.number;
  r = await gql(D12, { owner: viewer, name: REPO, number: mergePrNum });
  const mergePrId = r.json?.data?.repository?.pullRequest?.id;
  r = await gql(D14, { input: { pullRequestId: mergePrId, mergeMethod: 'SQUASH' } });
  check(
    'gql.merge-pull-request',
    r.json?.data?.mergePullRequest?.pullRequest?.number === mergePrNum
      && r.json?.data?.mergePullRequest?.pullRequest?.merged === true,
    JSON.stringify(r.json),
  );
  r = await gql(D12, { owner: viewer, name: REPO, number: mergePrNum });
  check('gql.merge-pull-request-readback', r.json?.data?.repository?.pullRequest?.number === mergePrNum, JSON.stringify(r.json));

  r = await gql(D15, { input: { subjectId: issueId7, body: 'comment body here' } });
  const commentNode = r.json?.data?.addComment?.commentEdge?.node;
  check('gql.add-comment', commentNode && commentNode.body === 'comment body here' && commentNode.id, JSON.stringify(r.json));

  r = await gql(D16);
  check(
    'gql.invalid-field',
    r.status === 200 && Array.isArray(r.json?.errors) && r.json.errors.length > 0
      && r.json.errors.some((e) => String(e.message).includes('noSuchFieldOnViewer')),
    JSON.stringify(r.json),
  );

  r = await gql(D17, { id: repoId });
  check(
    'gql.node-repository',
    r.json?.data?.node?.id === repoId && r.json?.data?.node?.name === REPO
      && r.json?.data?.node?.nameWithOwner === `${viewer}/${REPO}`,
    JSON.stringify(r.json),
  );

  r = await gql(D2, { owner: viewer, name: `${REPO}-missing` });
  check('gql.unknown-repository', r.status === 200 && !r.json?.errors && r.json?.data?.repository === null, JSON.stringify(r.json));

  r = await gql(D1, {}, false);
  check('gql.unauthenticated', r.status === 401, `status=${r.status}`);

  const batch = await gqlRaw(JSON.stringify([{ query: D1, variables: {} }, { query: D3, variables: {} }]));
  let batchJson = null;
  try {
    batchJson = JSON.parse(batch.text);
  } catch { /* ignore */ }
  check(
    'gql.batched-operations',
    batch.status === 200 && Array.isArray(batchJson) && batchJson.length === 2
      && batchJson[0]?.data?.viewer?.login === viewer && !batchJson[0]?.errors
      && Array.isArray(batchJson[1]?.data?.Issue?.fields) && batchJson[1].data.Issue.fields.length > 0,
    batch.text.slice(0, 300),
  );

  const r2a = await gql(D2, { owner: viewer, name: REPO });
  const r2b = await gql(D2, { owner: viewer, name: REPO });
  const r7a = await gql(D7, { owner: viewer, name: REPO, number: openNums[0] });
  const r7b = await gql(D7, { owner: viewer, name: REPO, number: openNums[0] });
  check(
    'gql.global-id-stability',
    r2a.json?.data?.repository?.id === r2b.json?.data?.repository?.id
      && r2a.json.data.repository.id !== String(r2a.json.data.repository.databaseId)
      && r7a.json?.data?.repository?.issue?.id === r7b.json?.data?.repository?.issue?.id
      && r7a.json.data.repository.issue.id !== String(openNums[0]),
    JSON.stringify({ a: r2a.json?.data?.repository?.id, b: r7a.json?.data?.repository?.issue?.id }),
  );

  const p1 = await gql(D18, { owner: viewer, name: PAGES_REPO, first: 5, after: null });
  const page1Nodes = p1.json?.data?.repository?.issues?.nodes ?? [];
  const page1Info = p1.json?.data?.repository?.issues?.pageInfo;
  const p2 = await gql(D18, { owner: viewer, name: PAGES_REPO, first: 5, after: page1Info?.endCursor });
  const page2Nodes = p2.json?.data?.repository?.issues?.nodes ?? [];
  const page2Info = p2.json?.data?.repository?.issues?.pageInfo;
  const allNums = [...page1Nodes, ...page2Nodes].map((n) => n.number);
  const unionOk = new Set(allNums).size === 7 && pageNums.every((n) => allNums.includes(n));
  check(
    'gql.issues-pagination',
    page1Nodes.length === 5 && page1Info?.hasNextPage === true && typeof page1Info?.endCursor === 'string' && page1Info.endCursor !== ''
      && page2Nodes.length === 2 && page2Info?.hasNextPage === false && unionOk,
    JSON.stringify({ p1: page1Nodes.map((n) => n.number), p2: page2Nodes.map((n) => n.number), page1Info, page2Info }),
  );

  // --- MCP ---
  let m = await mcp('server/discover', {}, { id: 'discover-1' });
  const supported = m.json?.result?.supportedVersions ?? [];
  check('mcp.server-discover', m.status === 200 && Array.isArray(supported) && supported.length > 0 && supported.includes('2026-07-28'), JSON.stringify(m.json));

  m = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'makefun-github-core-clone-env', version: '1.0.0' } }, { id: 'initialize-1' });
  check(
    'mcp.initialize',
    m.json?.result?.protocolVersion === '2025-11-25'
      && typeof m.json?.result?.serverInfo?.name === 'string' && m.json.result.serverInfo.name !== ''
      && typeof m.json?.result?.serverInfo?.version === 'string' && m.json.result.serverInfo.version !== ''
      && typeof m.json?.result?.capabilities?.tools === 'object',
    JSON.stringify(m.json),
  );

  m = await mcp('notifications/initialized', {}, { id: null });
  check('mcp.notifications-initialized', m.status === 202 && m.text === '', `status=${m.status} body=${JSON.stringify(m.text)}`);

  const list1 = await mcp('tools/list', {});
  const list2 = await mcp('tools/list', {});
  const tools1 = list1.json?.result?.tools ?? [];
  const tools2 = list2.json?.result?.tools ?? [];
  // Suite compares JSON.stringify of the parsed tools arrays (raw bodies
  // differ only by the JSON-RPC id, which is per-request).
  check('mcp.tools-list-idempotent', JSON.stringify(tools1) === JSON.stringify(tools2), `len ${JSON.stringify(tools1).length} vs ${JSON.stringify(tools2).length}`);
  const names = tools1.map((t) => t.name);
  check('mcp.tools-list', tools1.length >= 6 && ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => names.includes(n)), names.join(','));
  check(
    'mcp.tool-schemas',
    tools1.length > 0 && tools1.every((t) => typeof t.description === 'string' && t.description.trim() !== '' && t.inputSchema?.type === 'object'),
    JSON.stringify(tools1.map((t) => t.name)),
  );

  // create_repo + read back via get_repo and via GraphQL (same store/ids).
  m = await mcp('tools/call', { name: 'create_repo', arguments: { owner: viewer, name: 'mcp-parity', description: 'mcp parity repo', private: true } });
  const createdRepo = m.json?.result?.structuredContent ?? null;
  check('mcp.create-repo', !m.json?.error && !m.json?.result?.isError && createdRepo?.full_name === `${viewer}/mcp-parity` && typeof createdRepo?.id === 'number', JSON.stringify(m.json));
  m = await mcp('tools/call', { name: 'get_repo', arguments: { owner: viewer, repo: 'mcp-parity' } });
  check('mcp.get-repo', toolText(m.json?.result).includes('mcp-parity') && !m.json?.result?.isError, toolText(m.json?.result).slice(0, 200));
  r = await gql(D2, { owner: viewer, name: 'mcp-parity' });
  check('mcp.rest-parity-repo', r.json?.data?.repository?.databaseId === createdRepo?.id, JSON.stringify(r.json));

  // create_issue via MCP, read back via GraphQL.
  m = await mcp('tools/call', { name: 'create_issue', arguments: { owner: viewer, repo: 'mcp-parity', title: 'mcp issue one', body: 'mcp body' } });
  const mcpIssue = m.json?.result?.structuredContent ?? null;
  check('mcp.create-issue', !m.json?.result?.isError && typeof mcpIssue?.number === 'number', JSON.stringify(m.json));
  r = await gql(D7, { owner: viewer, name: 'mcp-parity', number: mcpIssue?.number });
  check('mcp.create-issue-readback', r.json?.data?.repository?.issue?.title === 'mcp issue one', JSON.stringify(r.json));

  // Argument synonyms + full_name fill-in.
  m = await mcp('tools/call', { name: 'create_issue', arguments: { owner: viewer, repository: 'mcp-parity', issue_title: 'synonym issue', issue_body: 'syn body' } });
  check('mcp.arg-synonyms', !m.json?.result?.isError && typeof m.json?.result?.structuredContent?.number === 'number', JSON.stringify(m.json));
  m = await mcp('tools/call', { name: 'get_repo', arguments: { full_name: `${viewer}/mcp-parity` } });
  check('mcp.full-name-fill-in', !m.json?.result?.isError && toolText(m.json?.result).includes('mcp-parity'), toolText(m.json?.result).slice(0, 200));

  // list_issues: result text must contain the title or "number": N.
  m = await mcp('tools/call', { name: 'list_issues', arguments: { owner: viewer, repo: 'mcp-parity', state: 'open' } });
  const listText = toolText(m.json?.result);
  check('mcp.list-issues', !m.json?.result?.isError && (listText.includes('mcp issue one') || new RegExp(`"number"\\s*:\\s*${mcpIssue?.number}\\b`).test(listText)), listText.slice(0, 200));

  // create_pull_request + merge_pull_request on the seeded mcp-test repo.
  m = await mcp('tools/call', { name: 'create_pull_request', arguments: { owner: viewer, repo: 'mcp-test', title: 'mcp pr one', body: 'mcp pr body', head: 'mcp-head', base: 'main' } });
  const mcpPr = m.json?.result?.structuredContent ?? null;
  check('mcp.create-pull-request', !m.json?.result?.isError && typeof mcpPr?.number === 'number', JSON.stringify(m.json));
  m = await mcp('tools/call', { name: 'merge_pull_request', arguments: { owner: viewer, repo: 'mcp-test', pull_number: mcpPr?.number } });
  check('mcp.merge-pull-request', !m.json?.result?.isError && m.json?.result?.structuredContent?.merged === true, JSON.stringify(m.json));
  r = await gql(D12, { owner: viewer, name: 'mcp-test', number: mcpPr?.number });
  check('mcp.merge-readback', r.json?.data?.repository?.pullRequest?.number === mcpPr?.number, JSON.stringify(r.json));

  // Unknown tool.
  m = await mcp('tools/call', { name: 'mcp_no_such_tool_abcdef12', arguments: {} });
  check('mcp.unknown-tool', m.status !== 500 && (m.json?.error?.code === -32602 || m.json?.error?.code === -32601), `status=${m.status} ${JSON.stringify(m.json)}`);

  // Missing arguments.
  m = await mcp('tools/call', { name: 'create_issue', arguments: {} });
  check('mcp.missing-arguments', m.json?.error?.code === -32602 || m.json?.result?.isError === true, JSON.stringify(m.json));

  // Parse error: truncated invalid JSON.
  const perr = await mcpRaw('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"');
  let perrJson = null;
  try {
    perrJson = JSON.parse(perr.text);
  } catch { /* ignore */ }
  check('mcp.parse-error', perr.status === 400 && perrJson?.error?.code === -32700, `status=${perr.status} ${perr.text}`);

  // No auth.
  m = await mcp('tools/call', { name: 'create_issue', arguments: { owner: 'no-auth', repo: 'no-auth-x', title: 't', body: 'b' } }, { omitAuth: true });
  check('mcp.auth-required', m.status === 401, `status=${m.status}`);

  // Concurrent calls keep their own ids and payloads.
  const [left, right] = await Promise.all([
    mcp('tools/call', { name: 'get_repo', arguments: { owner: viewer, repo: 'test-gql' } }, { id: 'concurrent-left-abcdef12' }),
    mcp('tools/call', { name: 'get_repo', arguments: { owner: viewer, repo: 'mcp-test' } }, { id: 'concurrent-right-abcdef12' }),
  ]);
  check(
    'mcp.concurrent-calls',
    left.json?.id === 'concurrent-left-abcdef12' && right.json?.id === 'concurrent-right-abcdef12'
      && !left.json?.error && !right.json?.error
      && toolText(left.json?.result).includes('test-gql') && toolText(right.json?.result).includes('mcp-test'),
    JSON.stringify({ left: left.json?.id, right: right.json?.id }),
  );

  // GET /mcp is not part of the suite; server answers 405 (not a crash).
  const getRes = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
  check('mcp.get-method', getRes.status === 405 || getRes.status === 404, `status=${getRes.status}`);

  for (const line of results) console.log(line);
  console.log(`\n${passes} passed, ${failures} failed`);
  return failures;
}

async function run() {
  const server = spawn('node', ['--experimental-strip-types', join(DIR, 'test-server-gql.ts')], {
    cwd: DIR,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let port = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not print PORT')), 15000);
    server.stdout.on('data', (chunk) => {
      const m = /PORT (\d+)/.exec(chunk.toString());
      if (m) {
        port = Number(m[1]);
        clearTimeout(timer);
        resolve();
      }
    });
    server.on('error', reject);
  });
  base = `http://127.0.0.1:${port}`;
  let failures = 0;
  try {
    failures = await main();
  } catch (err) {
    console.log(`FAIL harness-error — ${err instanceof Error ? err.stack : String(err)}`);
    failures += 1;
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

run();
