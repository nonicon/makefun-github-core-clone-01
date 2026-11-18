// GraphQL v4 endpoint (POST /api/graphql) for the forge.
// Hand-written executor: tokenizer + parser + validator + resolvers over
// the shared store. No Date.now(), no Math.random(), no network, no git binary.
import type { ServerResponse } from 'node:http';
import { b64urlEncode, parseJsonBody, sendError, sendJson } from './util.ts';
import { type Comment, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface Ctx {
  store: Store;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  token: string | null;
}

// ---------------------------------------------------------------------------
// Shared store helpers (also used by mcp.ts so both surfaces write the same
// objects with the same ids/numbers).
// ---------------------------------------------------------------------------

export function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  const parsed = store.parseGlobalId(id);
  if (!parsed || parsed.kind !== 'repo') return undefined;
  const [owner, name] = parsed.parts as [string, string];
  if (!owner || !name) return undefined;
  return store.getRepo(owner, name);
}

export function findIssueByGlobalId(
  store: Store,
  id: string,
): { repo: Repo; issue: Issue } | null {
  const parsed = store.parseGlobalId(id);
  if (!parsed || parsed.kind !== 'issue') return null;
  const [owner, name, num] = parsed.parts as [string, string, string];
  const repo = owner && name ? store.getRepo(owner, name) : undefined;
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === Number(num));
  return issue ? { repo, issue } : null;
}

export function findPullByGlobalId(
  store: Store,
  id: string,
): { repo: Repo; pull: Pull } | null {
  const parsed = store.parseGlobalId(id);
  if (!parsed || parsed.kind !== 'pull') return null;
  const [owner, name, num] = parsed.parts as [string, string, string];
  const repo = owner && name ? store.getRepo(owner, name) : undefined;
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === Number(num));
  return pull ? { repo, pull } : null;
}

export function issueGlobalId(store: Store, repo: Repo, issue: Issue): string {
  return store.globalId('issue', repo.owner, repo.name, issue.number);
}

export function pullGlobalId(store: Store, repo: Repo, pull: Pull): string {
  return store.globalId('pull', repo.owner, repo.name, pull.number);
}

export function createIssueInStore(
  store: Store,
  repo: Repo,
  title: string,
  body: string | null | undefined,
): Issue {
  const now = store.clock.nowIso();
  const issue: Issue = {
    dbId: store.nextId(),
    number: repo.nextNumber,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    userLogin: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

export function closeIssueInStore(store: Store, issue: Issue): Issue {
  const now = store.clock.nowIso();
  issue.state = 'closed';
  issue.closedAt = now;
  issue.updatedAt = now;
  return issue;
}

export function createPullInStore(
  store: Store,
  repo: Repo,
  title: string,
  body: string | null | undefined,
  headRefName: string,
  baseRefName: string,
): Pull | null {
  const headSha = store.getRef(repo, `refs/heads/${headRefName}`);
  const baseSha = store.getRef(repo, `refs/heads/${baseRefName}`);
  if (!headSha || !baseSha) return null;
  const now = store.clock.nowIso();
  const pull: Pull = {
    dbId: store.nextId(),
    number: repo.nextNumber,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: headRefName,
    baseRef: baseRefName,
    headSha,
    baseSha,
    userLogin: store.viewer.login,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

export function mergePullInStore(store: Store, repo: Repo, pull: Pull): Pull {
  const baseMap = store.fileMapAt(repo, pull.baseSha);
  const headMap = store.fileMapAt(repo, pull.headSha);
  const mb = store.mergeBase(repo, pull.baseSha, pull.headSha);
  const base0 = mb ? store.fileMapAt(repo, mb) : new Map();
  const merged = store.threeWayMerge(base0, baseMap, headMap);
  const tree = store.treeFromFileMap(repo, merged.files);
  const commit = store.makeCommit(
    repo,
    tree,
    [pull.baseSha],
    `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
  );
  store.setRef(repo, `refs/heads/${pull.baseRef}`, commit);
  const now = store.clock.nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = commit;
  pull.updatedAt = now;
  return pull;
}

export function addCommentInStore(
  store: Store,
  issue: Issue,
  body: string,
): Comment {
  const comment: Comment = {
    id: store.nextId(),
    body,
    userLogin: store.viewer.login,
    createdAt: store.clock.nowIso(),
  };
  issue.comments.push(comment);
  return comment;
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return `C_${b64urlEncode(`comment:${repo.owner}:${repo.name}:${issue.number}:${comment.id}`)}`;
}

/** Mergeable state of an open PR, derived from the git branches. */
export function mergeableOf(store: Store, repo: Repo, pull: Pull): string {
  const headSha = store.getRef(repo, `refs/heads/${pull.headRef}`);
  const baseSha = store.getRef(repo, `refs/heads/${pull.baseRef}`);
  if (!headSha || !baseSha) return 'UNKNOWN';
  const mb = store.mergeBase(repo, baseSha, headSha);
  const base0 = mb ? store.fileMapAt(repo, mb) : new Map();
  const merged = store.threeWayMerge(base0, store.fileMapAt(repo, baseSha), store.fileMapAt(repo, headSha));
  return merged.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Block string """...""" or normal "..." with escapes.
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end < 0 ? src.slice(i + 3) : src.slice(i + 3, end);
        toks.push({ kind: 'string', value: raw.replace(/^\n/, '').replace(/\n$/, '') });
        i = end < 0 ? src.length : end + 3;
      } else {
        let j = i + 1;
        let out = '';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\' && j + 1 < src.length) {
            const e = src[j + 1] as string;
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'u' ? '' : e;
            if (e === 'u') {
              const hex = src.slice(j + 2, j + 6);
              out += String.fromCharCode(parseInt(hex, 16));
              j += 4;
            }
            j += 2;
          } else {
            out += src[j] as string;
            j += 1;
          }
        }
        toks.push({ kind: 'string', value: out });
        i = j + 1;
      }
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
}

type SelectionNode =
  | {
      kind: 'Field';
      alias: string | null;
      name: string;
      args: Array<{ name: string; value: ValueNode }>;
      directives: DirectiveNode[];
      selections: SelectionNode[] | null;
    }
  | { kind: 'FragmentSpread'; name: string; directives: DirectiveNode[] }
  | {
      kind: 'InlineFragment';
      typeCondition: string | null;
      directives: DirectiveNode[];
      selections: SelectionNode[];
    };

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(offset = 0): Tok | undefined {
    return this.toks[this.pos + offset];
  }
  next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected "${v}" but got "${t.value}"`);
  }
  expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected name but got "${t.value}"`);
    if (v !== undefined && t.value !== v) throw new Error(`Expected "${v}" but got "${t.value}"`);
    return t.value;
  }
  skipPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek()) defs.push(this.parseDefinition());
    return defs;
  }

  parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of document');
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'Operation', operation: 'query', name: null, variables: [], directives: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const op = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      const n = this.peek();
      if (n && n.kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      const directives = this.parseDirectives();
      return { kind: 'Operation', operation: op, name, variables, directives, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'Fragment', name, typeCondition, directives, selections: this.parseSelectionSet() };
    }
    throw new Error(`Unexpected token "${t.value}" at document level`);
  }

  parseVariableDefinitions(): Array<{ name: string; type: string; defaultValue: ValueNode | null }> {
    const out: Array<{ name: string; type: string; defaultValue: ValueNode | null }> = [];
    if (!this.skipPunct('(')) return out;
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.skipPunct('=')) defaultValue = this.parseValue(true);
      out.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  parseType(): string {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of type');
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let s = `[${inner}]`;
      if (this.skipPunct('!')) s += '!';
      return s;
    }
    const name = this.expectName();
    let s = name;
    if (this.skipPunct('!')) s += '!';
    return s;
  }

  parseDirectives(): DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      const name = this.expectName();
      const args = this.parseArguments();
      out.push({ name, args });
    }
    return out;
  }

  parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    if (!this.skipPunct('(')) return out;
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return out;
  }

  parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('Variable in constant value');
      return { kind: 'Variable', name: this.expectName() };
    }
    if (t.kind === 'int') return { kind: 'Int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'Float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'String', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'Boolean', value: true };
      if (t.value === 'false') return { kind: 'Boolean', value: false };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    throw new Error(`Unexpected value token "${t.value}"`);
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  parseSelection(): SelectionNode {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of selection set');
    if (t.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'InlineFragment', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (n && n.kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'FragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'InlineFragment', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, directives, selections };
  }
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
      return node.value;
    case 'Enum':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => valueFromAst(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromAst(f.value, variables);
      return out;
    }
  }
}

function argsFromAst(
  args: Array<{ name: string; value: ValueNode }>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = valueFromAst(a.value, variables);
  return out;
}

function directivesSkip(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const d of directives) {
    const args = argsFromAst(d.args, variables);
    if (d.name === 'skip' && args['if'] === true) return true;
    if (d.name === 'include' && args['if'] === false) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Schema (field surface the suite needs; also drives introspection)
// ---------------------------------------------------------------------------

interface FieldDef {
  type: string; // named return type
}

const OBJECT_FIELDS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User' },
    repository: { type: 'Repository' },
    node: { type: 'Node' },
    __type: { type: '__Type' },
    __schema: { type: '__Schema' },
  },
  Mutation: {
    createIssue: { type: 'CreateIssuePayload' },
    closeIssue: { type: 'CloseIssuePayload' },
    createPullRequest: { type: 'CreatePullRequestPayload' },
    mergePullRequest: { type: 'MergePullRequestPayload' },
    addComment: { type: 'AddCommentPayload' },
  },
  Repository: {
    id: { type: 'ID' },
    databaseId: { type: 'Int' },
    name: { type: 'String' },
    nameWithOwner: { type: 'String' },
    owner: { type: 'User' },
    defaultBranchRef: { type: 'Ref' },
    viewerPermission: { type: 'RepositoryPermission' },
    hasIssuesEnabled: { type: 'Boolean' },
    description: { type: 'String' },
    isPrivate: { type: 'Boolean' },
    createdAt: { type: 'DateTime' },
    issue: { type: 'Issue' },
    issues: { type: 'IssueConnection' },
    pullRequests: { type: 'PullRequestConnection' },
    pullRequest: { type: 'PullRequest' },
  },
  Issue: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    title: { type: 'String' },
    body: { type: 'String' },
    state: { type: 'IssueState' },
    createdAt: { type: 'DateTime' },
    updatedAt: { type: 'DateTime' },
    author: { type: 'User' },
    url: { type: 'String' },
  },
  PullRequest: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    title: { type: 'String' },
    body: { type: 'String' },
    state: { type: 'PullRequestState' },
    merged: { type: 'Boolean' },
    mergeable: { type: 'MergeableState' },
    headRefName: { type: 'String' },
    baseRefName: { type: 'String' },
    files: { type: 'PullRequestChangedFileConnection' },
    createdAt: { type: 'DateTime' },
    updatedAt: { type: 'DateTime' },
    author: { type: 'User' },
  },
  User: {
    id: { type: 'ID' },
    login: { type: 'String' },
    name: { type: 'String' },
    email: { type: 'String' },
  },
  Node: {
    id: { type: 'ID' },
  },
  Ref: {
    id: { type: 'ID' },
    name: { type: 'String' },
    prefix: { type: 'String' },
  },
  IssueConnection: {
    nodes: { type: 'Issue' },
    edges: { type: 'IssueEdge' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  IssueEdge: {
    node: { type: 'Issue' },
    cursor: { type: 'String' },
  },
  PullRequestConnection: {
    nodes: { type: 'PullRequest' },
    edges: { type: 'PullRequestEdge' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  PullRequestEdge: {
    node: { type: 'PullRequest' },
    cursor: { type: 'String' },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: 'PullRequestChangedFile' },
    edges: { type: 'PullRequestChangedFileEdge' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  PullRequestChangedFileEdge: {
    node: { type: 'PullRequestChangedFile' },
    cursor: { type: 'String' },
  },
  PullRequestChangedFile: {
    path: { type: 'String' },
    status: { type: 'String' },
    additions: { type: 'Int' },
    deletions: { type: 'Int' },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean' },
    hasPreviousPage: { type: 'Boolean' },
    startCursor: { type: 'String' },
    endCursor: { type: 'String' },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue' },
    clientMutationId: { type: 'String' },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue' },
    clientMutationId: { type: 'String' },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest' },
    clientMutationId: { type: 'String' },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest' },
    clientMutationId: { type: 'String' },
  },
  AddCommentPayload: {
    commentEdge: { type: 'IssueCommentEdge' },
    subject: { type: 'Issue' },
    clientMutationId: { type: 'String' },
  },
  IssueCommentEdge: {
    node: { type: 'IssueComment' },
    cursor: { type: 'String' },
  },
  IssueComment: {
    id: { type: 'ID' },
    body: { type: 'String' },
    author: { type: 'User' },
    createdAt: { type: 'DateTime' },
  },
  __Type: {
    name: { type: 'String' },
    kind: { type: 'String' },
    description: { type: 'String' },
    fields: { type: '__Field' },
    enumValues: { type: '__EnumValue' },
    inputFields: { type: '__InputValue' },
    interfaces: { type: '__Type' },
    possibleTypes: { type: '__Type' },
    specifiedByURL: { type: 'String' },
  },
  __Field: {
    name: { type: 'String' },
    description: { type: 'String' },
    args: { type: '__InputValue' },
    type: { type: '__Type' },
    isDeprecated: { type: 'Boolean' },
    deprecationReason: { type: 'String' },
  },
  __EnumValue: {
    name: { type: 'String' },
    description: { type: 'String' },
    isDeprecated: { type: 'Boolean' },
    deprecationReason: { type: 'String' },
  },
  __InputValue: {
    name: { type: 'String' },
    description: { type: 'String' },
    type: { type: '__Type' },
    defaultValue: { type: 'String' },
  },
  __Schema: {
    description: { type: 'String' },
    types: { type: '__Type' },
    queryType: { type: '__Type' },
    mutationType: { type: '__Type' },
    subscriptionType: { type: '__Type' },
    directives: { type: '__Directive' },
  },
  __Directive: {
    name: { type: 'String' },
    description: { type: 'String' },
    locations: { type: 'String' },
    args: { type: '__InputValue' },
    isRepeatable: { type: 'Boolean' },
  },
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime']);
const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PACKAGE', 'TOPIC', 'WIKI'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeKind(name: string): string {
  if (SCALARS.has(name)) return 'SCALAR';
  if (ENUM_VALUES[name]) return 'ENUM';
  if (name === 'Node') return 'INTERFACE';
  if (OBJECT_FIELDS[name]) return 'OBJECT';
  return 'OBJECT';
}

function typeFields(name: string): Array<{ name: string }> {
  const fields = OBJECT_FIELDS[name];
  if (!fields) return [];
  return Object.keys(fields).map((n) => ({ name: n }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSelections(
  selections: SelectionNode[],
  typeName: string,
  fragments: Map<string, FragmentNode>,
  errors: Array<{ message: string }>,
  depth: number,
): void {
  if (depth > 50) return;
  for (const sel of selections) {
    if (sel.kind === 'FragmentSpread') {
      const frag = fragments.get(sel.name);
      if (!frag) {
        errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      validateSelections(frag.selections, frag.typeCondition, fragments, errors, depth + 1);
      continue;
    }
    if (sel.kind === 'InlineFragment') {
      validateSelections(sel.selections, sel.typeCondition ?? typeName, fragments, errors, depth + 1);
      continue;
    }
    const fieldName = sel.name;
    if (fieldName === '__typename') continue;
    const fields = OBJECT_FIELDS[typeName];
    if (!fields || !fields[fieldName]) {
      errors.push({
        message: `Cannot query field "${fieldName}" on type "${typeName}".`,
      });
      continue;
    }
    if (sel.selections) {
      const retType = (fields[fieldName] as FieldDef).type;
      if (SCALARS.has(retType) || ENUM_VALUES[retType]) {
        errors.push({ message: `Field "${fieldName}" must not have a selection since type "${retType}" has no subfields.` });
      } else {
        validateSelections(sel.selections, retType, fragments, errors, depth + 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Resolved = { __type: string; [key: string]: unknown };

function userResolved(store: Store, login: string): Resolved {
  const u = login === store.viewer.login ? store.viewer : null;
  return {
    __type: 'User',
    id: u ? String(u.id) : login,
    login,
    name: u ? u.name : login,
    email: u ? u.email : `${login}@example.invalid`,
  };
}

function repoResolved(repo: Repo): Resolved {
  return { __type: 'Repository', repo };
}

function issueResolved(repo: Repo, issue: Issue): Resolved {
  return { __type: 'Issue', repo, issue };
}

function pullResolved(repo: Repo, pull: Pull): Resolved {
  return { __type: 'PullRequest', repo, pull };
}

function encodeCursor(n: number): string {
  return b64urlEncode(`cursor:${n}`);
}

function decodeCursor(c: string | null | undefined): number | null {
  if (typeof c !== 'string' || c === '') return null;
  try {
    const decoded = Buffer.from(c, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function sortIssues(issues: Issue[], direction: string): Issue[] {
  const sorted = issues.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.number - b.number;
  });
  if (direction === 'DESC') sorted.reverse();
  return sorted;
}

function pageInfoResolved(items: Array<{ cursorNum: number }>, hasNext: boolean, hasPrev: boolean): Resolved {
  const last = items.length > 0 ? (items[items.length - 1] as { cursorNum: number }) : null;
  const first = items.length > 0 ? (items[0] as { cursorNum: number }) : null;
  return {
    __type: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: hasPrev,
    startCursor: first ? encodeCursor(first.cursorNum) : null,
    endCursor: last ? encodeCursor(last.cursorNum) : null,
  };
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Resolved {
  let items = repo.issues.slice();
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase() === 'OPEN' ? 'open' : 'closed'));
    items = items.filter((i) => wanted.has(i.state));
  }
  const orderBy = args['orderBy'] as { field?: string; direction?: string } | undefined;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction.toUpperCase() : 'DESC';
  items = sortIssues(items, direction);
  const afterNum = decodeCursor(args['after'] as string | null | undefined);
  if (afterNum !== null) {
    items = items.filter((i) => (direction === 'DESC' ? i.number < afterNum : i.number > afterNum));
  }
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : null;
  const page = first !== null ? items.slice(0, first) : items;
  const hasNext = first !== null ? items.length > first : false;
  const nodes = page.map((i) => issueResolved(repo, i));
  const withCursor = page.map((i) => ({ cursorNum: i.number }));
  return {
    __type: 'IssueConnection',
    nodes,
    edges: page.map((i) => ({ __type: 'IssueEdge', node: issueResolved(repo, i), cursor: encodeCursor(i.number) })),
    pageInfo: pageInfoResolved(withCursor, hasNext, afterNum !== null),
    totalCount: items.length,
  };
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): Resolved {
  let items = repo.pulls.filter((p) => p.state === 'open');
  items = items.slice().sort((a, b) => b.number - a.number);
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : null;
  const page = first !== null ? items.slice(0, first) : items;
  const hasNext = first !== null ? items.length > first : false;
  const withCursor = page.map((p) => ({ cursorNum: p.number }));
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((p) => pullResolved(repo, p)),
    edges: page.map((p) => ({ __type: 'PullRequestEdge', node: pullResolved(repo, p), cursor: encodeCursor(p.number) })),
    pageInfo: pageInfoResolved(withCursor, hasNext, false),
    totalCount: items.length,
  };
}

function prFilesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): Resolved {
  const baseMap = store.fileMapAt(repo, pull.baseSha);
  const headMap = store.fileMapAt(repo, pull.headSha);
  const diff = store.diffFileMaps(repo, baseMap, headMap);
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : null;
  const page = first !== null ? diff.slice(0, first) : diff;
  const hasNext = first !== null ? diff.length > first : false;
  const nodes = page.map((d, idx) => ({
    __type: 'PullRequestChangedFile',
    path: d.path,
    status: d.status,
    additions: d.additions,
    deletions: d.deletions,
    cursorNum: idx,
  }));
  return {
    __type: 'PullRequestChangedFileConnection',
    nodes,
    edges: nodes.map((n) => ({ __type: 'PullRequestChangedFileEdge', node: n, cursor: encodeCursor(n.cursorNum as number) })),
    pageInfo: pageInfoResolved(
      nodes.map((n) => ({ cursorNum: n.cursorNum as number })),
      hasNext,
      false,
    ),
    totalCount: diff.length,
  };
}

function resolveField(store: Store, parent: Resolved, field: string, args: Record<string, unknown>): unknown {
  switch (parent.__type) {
    case 'Query': {
      if (field === 'viewer') return userResolved(store, store.viewer.login);
      if (field === 'repository') {
        const repo = store.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
        return repo ? repoResolved(repo) : null;
      }
      if (field === 'node') {
        const id = String(args['id'] ?? '');
        const parsed = store.parseGlobalId(id);
        if (!parsed) return null;
        if (parsed.kind === 'repo') {
          const repo = findRepoByGlobalId(store, id);
          return repo ? repoResolved(repo) : null;
        }
        if (parsed.kind === 'issue') {
          const found = findIssueByGlobalId(store, id);
          return found ? issueResolved(found.repo, found.issue) : null;
        }
        if (parsed.kind === 'pull') {
          const found = findPullByGlobalId(store, id);
          return found ? pullResolved(found.repo, found.pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args['name'] ?? '');
        if (!OBJECT_FIELDS[name] && !ENUM_VALUES[name] && name !== 'Node' && !SCALARS.has(name)) return null;
        return { __type: '__Type', typeName: name };
      }
      if (field === '__schema') return { __type: '__Schema' };
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, String(input['repositoryId'] ?? ''));
        if (!repo) throw new Error('Repository not found');
        const issue = createIssueInStore(store, repo, String(input['title'] ?? ''), (input['body'] as string | null) ?? null);
        return { __type: 'CreateIssuePayload', issue: issueResolved(repo, issue) };
      }
      if (field === 'closeIssue') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, String(input['issueId'] ?? ''));
        if (!found) throw new Error('Issue not found');
        closeIssueInStore(store, found.issue);
        return { __type: 'CloseIssuePayload', issue: issueResolved(found.repo, found.issue) };
      }
      if (field === 'createPullRequest') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, String(input['repositoryId'] ?? ''));
        if (!repo) throw new Error('Repository not found');
        const pull = createPullInStore(
          store,
          repo,
          String(input['title'] ?? ''),
          (input['body'] as string | null) ?? null,
          String(input['headRefName'] ?? ''),
          String(input['baseRefName'] ?? ''),
        );
        if (!pull) throw new Error('Head branch does not exist');
        return { __type: 'CreatePullRequestPayload', pullRequest: pullResolved(repo, pull) };
      }
      if (field === 'mergePullRequest') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(store, String(input['pullRequestId'] ?? ''));
        if (!found) throw new Error('Pull request not found');
        mergePullInStore(store, found.repo, found.pull);
        return { __type: 'MergePullRequestPayload', pullRequest: pullResolved(found.repo, found.pull) };
      }
      if (field === 'addComment') {
        const input = (args['input'] ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, String(input['subjectId'] ?? ''));
        if (!found) throw new Error('Subject not found');
        const comment = addCommentInStore(store, found.issue, String(input['body'] ?? ''));
        return {
          __type: 'AddCommentPayload',
          commentEdge: {
            __type: 'IssueCommentEdge',
            node: {
              __type: 'IssueComment',
              id: commentGlobalId(found.repo, found.issue, comment),
              body: comment.body,
              author: userResolved(store, comment.userLogin),
              createdAt: comment.createdAt,
              repo: found.repo,
              issue: found.issue,
              comment,
            },
            cursor: encodeCursor(comment.id),
          },
          subject: issueResolved(found.repo, found.issue),
        };
      }
      return null;
    }
    case 'Repository': {
      const repo = parent['repo'] as Repo;
      switch (field) {
        case 'id':
          return store.globalId('repo', repo.owner, repo.name);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userResolved(store, repo.owner);
        case 'defaultBranchRef': {
          const oid = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
          return oid ? { __type: 'Ref', name: repo.defaultBranch } : null;
        }
        case 'viewerPermission':
          return repo.owner === store.viewer.login ? 'ADMIN' : 'READ';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'createdAt':
          return repo.createdAt;
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === Number(args['number']));
          return issue ? issueResolved(repo, issue) : null;
        }
        case 'issues':
          return issuesConnection(store, repo, args);
        case 'pullRequests':
          return pullsConnection(store, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === Number(args['number']));
          return pull ? pullResolved(repo, pull) : null;
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const repo = parent['repo'] as Repo;
      const issue = parent['issue'] as Issue;
      switch (field) {
        case 'id':
          return issueGlobalId(store, repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'author':
          return userResolved(store, issue.userLogin);
        case 'url':
          return `${repo.owner}/${repo.name}/issues/${issue.number}`;
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = parent['repo'] as Repo;
      const pull = parent['pull'] as Pull;
      switch (field) {
        case 'id':
          return pullGlobalId(store, repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return mergeableOf(store, repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files':
          return prFilesConnection(store, repo, pull, args);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'author':
          return userResolved(store, pull.userLogin);
        default:
          return null;
      }
    }
    case 'User': {
      switch (field) {
        case 'id':
          return String(parent['id'] ?? '');
        case 'login':
          return String(parent['login'] ?? '');
        case 'name':
          return String(parent['name'] ?? '');
        case 'email':
          return String(parent['email'] ?? '');
        default:
          return null;
      }
    }
    case 'Ref': {
      switch (field) {
        case 'id':
          return `Ref_${b64urlEncode(`ref:${String(parent['name'] ?? '')}`)}`;
        case 'name':
          return String(parent['name'] ?? '');
        case 'prefix':
          return 'refs/heads/';
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      switch (field) {
        case 'nodes':
          return (parent['nodes'] as unknown[]) ?? [];
        case 'edges':
          return (parent['edges'] as unknown[]) ?? [];
        case 'pageInfo':
          return parent['pageInfo'] as Resolved;
        case 'totalCount':
          return (parent['totalCount'] as number) ?? 0;
        default:
          return null;
      }
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge': {
      if (field === 'node') return parent['node'] as Resolved;
      if (field === 'cursor') return String(parent['cursor'] ?? '');
      return null;
    }
    case 'PullRequestChangedFile': {
      switch (field) {
        case 'path':
          return String(parent['path'] ?? '');
        case 'status':
          return String(parent['status'] ?? '');
        case 'additions':
          return (parent['additions'] as number) ?? 0;
        case 'deletions':
          return (parent['deletions'] as number) ?? 0;
        default:
          return null;
      }
    }
    case 'PageInfo': {
      switch (field) {
        case 'hasNextPage':
          return Boolean(parent['hasNextPage']);
        case 'hasPreviousPage':
          return Boolean(parent['hasPreviousPage']);
        case 'startCursor':
          return (parent['startCursor'] as string | null) ?? null;
        case 'endCursor':
          return (parent['endCursor'] as string | null) ?? null;
        default:
          return null;
      }
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return parent['issue'] as Resolved;
      if (field === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return parent['pullRequest'] as Resolved;
      if (field === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return parent['commentEdge'] as Resolved;
      if (field === 'subject') return parent['subject'] as Resolved;
      if (field === 'clientMutationId') return null;
      return null;
    }
    case 'IssueComment': {
      switch (field) {
        case 'id':
          return String(parent['id'] ?? '');
        case 'body':
          return String(parent['body'] ?? '');
        case 'author':
          return parent['author'] as Resolved;
        case 'createdAt':
          return String(parent['createdAt'] ?? '');
        default:
          return null;
      }
    }
    case '__Type': {
      const typeName = String(parent['typeName'] ?? '');
      switch (field) {
        case 'name':
          return typeName;
        case 'kind':
          return typeKind(typeName);
        case 'description':
          return null;
        case 'fields':
          return typeFields(typeName).map((f) => ({ __type: '__Field', name: f.name }));
        case 'enumValues': {
          const vals = ENUM_VALUES[typeName] ?? [];
          return vals.map((v) => ({ __type: '__EnumValue', name: v }));
        }
        case 'inputFields':
          return [];
        case 'interfaces':
          return [];
        case 'possibleTypes':
          return typeName === 'Node' ? [{ __type: '__Type', typeName: 'Repository' }] : [];
        case 'specifiedByURL':
          return null;
        default:
          return null;
      }
    }
    case '__Field': {
      switch (field) {
        case 'name':
          return String(parent['name'] ?? '');
        case 'description':
          return null;
        case 'args':
          return [];
        case 'type':
          return { __type: '__Type', typeName: 'String' };
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          return null;
      }
    }
    case '__EnumValue': {
      switch (field) {
        case 'name':
          return String(parent['name'] ?? '');
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          return null;
      }
    }
    case '__InputValue': {
      switch (field) {
        case 'name':
          return String(parent['name'] ?? '');
        case 'description':
          return null;
        case 'type':
          return { __type: '__Type', typeName: 'String' };
        case 'defaultValue':
          return null;
        default:
          return null;
      }
    }
    case '__Schema': {
      switch (field) {
        case 'description':
          return null;
        case 'types': {
          const names = new Set<string>([...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES), 'Node']);
          for (const s of SCALARS) names.add(s);
          return [...names].map((n) => ({ __type: '__Type', typeName: n }));
        }
        case 'queryType':
          return { __type: '__Type', typeName: 'Query' };
        case 'mutationType':
          return { __type: '__Type', typeName: 'Mutation' };
        case 'subscriptionType':
          return null;
        case 'directives':
          return [];
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

function shapeValue(
  store: Store,
  value: unknown,
  retType: string,
  selections: SelectionNode[] | null,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  ctx: Ctx,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => shapeValue(store, v, retType, selections, variables, fragments, ctx, errors));
  }
  if (selections && typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>)) {
    return executeSelections(store, selections, value as Resolved, variables, fragments, ctx, errors);
  }
  return value;
}

function executeSelections(
  store: Store,
  selections: SelectionNode[],
  parent: Resolved,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  ctx: Ctx,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'FragmentSpread') {
      if (directivesSkip(sel.directives, variables)) continue;
      const frag = fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition !== parent.__type && frag.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(store, frag.selections, parent, variables, fragments, ctx, errors));
      continue;
    }
    if (sel.kind === 'InlineFragment') {
      if (directivesSkip(sel.directives, variables)) continue;
      if (sel.typeCondition && sel.typeCondition !== parent.__type && sel.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(store, sel.selections, parent, variables, fragments, ctx, errors));
      continue;
    }
    if (directivesSkip(sel.directives, variables)) continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = parent.__type;
      continue;
    }
    const args = argsFromAst(sel.args, variables);
    let value: unknown;
    try {
      value = resolveField(store, parent, sel.name, args);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    const fields = OBJECT_FIELDS[parent.__type] ?? OBJECT_FIELDS['Node'] ?? {};
    const def = fields[sel.name] as FieldDef | undefined;
    const retType = def ? def.type : 'String';
    // Node interface: resolve against the runtime type's field table.
    const runtimeDef = (OBJECT_FIELDS[parent.__type] ?? {})[sel.name] as FieldDef | undefined;
    out[key] = shapeValue(store, value, runtimeDef ? runtimeDef.type : retType, sel.selections, variables, fragments, ctx, errors);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document execution + HTTP handler
// ---------------------------------------------------------------------------

function executeDocument(store: Store, opValue: unknown): Record<string, unknown> {
  if (typeof opValue !== 'object' || opValue === null || Array.isArray(opValue)) {
    return { data: null, errors: [{ message: 'GraphQL operation must be an object' }] };
  }
  const op = opValue as Record<string, unknown>;
  if (typeof op['query'] !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL query must be a string' }] };
  }
  const variables = (op['variables'] as Record<string, unknown> | undefined) ?? {};
  let defs: DefinitionNode[];
  try {
    defs = new Parser(tokenize(op['query'] as string)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'Fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  let operation: OperationNode | undefined;
  const operationName = typeof op['operationName'] === 'string' ? (op['operationName'] as string) : null;
  if (operationName) operation = operations.find((o) => o.name === operationName);
  else operation = operations[0];
  if (!operation) {
    return { data: null, errors: [{ message: 'No operation found in GraphQL document' }] };
  }
  if (operation.operation === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported' }] };
  }
  // Apply variable defaults.
  const vars: Record<string, unknown> = {};
  for (const v of operation.variables) {
    if (Object.prototype.hasOwnProperty.call(variables, v.name)) vars[v.name] = variables[v.name];
    else if (v.defaultValue) vars[v.name] = valueFromAst(v.defaultValue, {});
    else vars[v.name] = undefined;
  }
  for (const [k, v] of Object.entries(variables)) {
    if (!(k in vars)) vars[k] = v;
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: Array<{ message: string }> = [];
  validateSelections(operation.selections, rootType, fragments, errors, 0);
  if (errors.length > 0) {
    return { data: null, errors };
  }
  const execErrors: Array<{ message: string }> = [];
  const ctx = { store } as unknown as Ctx;
  const data = executeSelections(store, operation.selections, { __type: rootType }, vars, fragments, ctx, execErrors);
  if (execErrors.length > 0) {
    return { data, errors: execErrors };
  }
  return { data };
}

function authorized(ctx: Ctx): boolean {
  const token = ctx.token;
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '' && token !== expected) return false;
  return true;
}

export async function handleGraphql(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  if (ctx.method !== 'POST' || ctx.path !== '/api/graphql') return false;
  if (!authorized(ctx)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendError(res, 400, 'Malformed JSON body');
    return true;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    const results = value.map((op) => executeDocument(ctx.store, op));
    sendJson(res, 200, results);
    return true;
  }
  sendJson(res, 200, executeDocument(ctx.store, value));
  return true;
}
