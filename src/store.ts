// In-memory store for the forge: one store behind git, REST, GraphQL and
// MCP. Everything is deterministic: ids from counters, timestamps from the
// logical clock, commit bytes from fixed identity + logical clock.
import { STRANGER, VIEWER, type ScenarioUser } from './scenario.ts';
import { b64urlDecode, b64urlEncode, clock, hashObject } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full refname -> oid
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number; // shared issues + PRs, starts at 1
  createdAt: string;
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '40000' | '120000' | '160000'
  name: string;
  oid: string;
}

export interface FileEntry {
  mode: string;
  oid: string;
}

function compareTreeName(a: string, b: string, aIsDir: boolean, bIsDir: boolean): number {
  // Git tree sort: a directory name compares as if it ended in '/'.
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export class Store {
  readonly viewer: ScenarioUser = VIEWER;
  readonly strangerLogin: string = STRANGER.login;
  readonly org = 'faint-meadow-org';
  readonly clock = clock;

  private reposByKey = new Map<string, Repo>(); // `${owner}/${name}`
  private reposByGlobalId = new Map<string, Repo>();
  private idCounter = 0;

  /** Next deterministic db id (repos, issues, PRs, comments share one counter). */
  nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  // ---- repositories -------------------------------------------------
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${owner}/${name}`;
    if (this.reposByKey.has(key)) return null;
    const repo: Repo = {
      dbId: this.nextId(),
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      createdAt: clock.nowIso(),
    };
    this.reposByKey.set(key, repo);
    this.reposByGlobalId.set(this.globalId('repo', owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(`${owner}/${name}`);
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.reposByKey.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out; // creation order (Map insertion order)
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const repo = this.reposByKey.get(key);
    if (!repo) return false;
    this.reposByKey.delete(key);
    this.reposByGlobalId.delete(this.globalId('repo', owner, name));
    return true;
  }

  getRepoByGlobalId(id: string): Repo | undefined {
    return this.reposByGlobalId.get(id);
  }

  // ---- global (GraphQL Relay-style) ids ------------------------------
  globalId(kind: 'repo' | 'issue' | 'pull', ...parts: (string | number)[]): string {
    const prefix = kind === 'repo' ? 'R' : kind === 'issue' ? 'I' : 'P';
    return `${prefix}_${b64urlEncode([kind, ...parts].join(':'))}`;
  }

  parseGlobalId(id: string): { kind: string; parts: string[] } | null {
    const m = /^([RIP])_([A-Za-z0-9_-]+)$/.exec(id);
    if (!m) return null;
    try {
      const decoded = b64urlDecode(m[2] as string);
      const parts = decoded.split(':');
      const kind = parts[0] as string;
      if (kind !== 'repo' && kind !== 'issue' && kind !== 'pull') return null;
      return { kind, parts: parts.slice(1) };
    } catch {
      return null;
    }
  }

  // ---- git objects ---------------------------------------------------
  hashObject(type: ObjectType, data: Buffer): string {
    return hashObject(type, data);
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose oid is already known (e.g. computed while parsing
   * a pack): skips the re-hash that putObject would do. */
  putObjectKnown(repo: Repo, type: ObjectType, data: Buffer, oid: string): void {
    const key = oid.toLowerCase();
    if (!repo.objects.has(key)) repo.objects.set(key, { type, data });
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  // ---- refs -----------------------------------------------------------
  getRef(repo: Repo, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  setRef(repo: Repo, refname: string, oid: string): void {
    repo.refs.set(refname, oid.toLowerCase());
  }

  deleteRef(repo: Repo, refname: string): boolean {
    return repo.refs.delete(refname);
  }

  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // ---- commits ---------------------------------------------------------
  parseCommit(data: Buffer): {
    tree: string;
    parents: string[];
    author: string;
    committer: string;
    message: string;
  } {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const message = split >= 0 ? text.slice(split + 2) : '';
    let tree = '';
    const parents: string[] = [];
    let author = '';
    let committer = '';
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) author = line.slice(7);
      else if (line.startsWith('committer ')) committer = line.slice(10);
    }
    return { tree, parents, author, committer, message };
  }

  /** Create a commit with the viewer identity and the logical clock. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const ts = clock.nowSec();
    const who = `${this.viewer.name} <${this.viewer.email}> ${ts} +0000`;
    const lines = [`tree ${tree}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${who}`, `committer ${who}`, '', msg);
    return this.putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  // ---- trees ------------------------------------------------------------
  parseTree(data: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      if (sp < 0) break;
      const mode = data.subarray(i, sp).toString('utf8');
      const nul = data.indexOf(0, sp + 1);
      if (nul < 0) break;
      const name = data.subarray(sp + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      i = nul + 21;
    }
    return entries;
  }

  buildTree(repo: Repo, entries: TreeEntry[]): string {
    const sorted = entries.slice().sort((a, b) =>
      compareTreeName(a.name, b.name, a.mode === '40000', b.mode === '40000'),
    );
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return this.putObject(repo, 'tree', Buffer.concat(parts));
  }

  /** All files under a tree, recursively: path -> {mode, oid}. */
  readTreeRecursive(repo: Repo, treeOid: string, prefix = ''): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    const obj = this.getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of this.parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        for (const [p, v] of this.readTreeRecursive(repo, e.oid, path)) out.set(p, v);
      } else if (e.mode !== '160000') {
        out.set(path, { mode: e.mode, oid: e.oid });
      }
    }
    return out;
  }

  /** Build nested trees from a flat file map; returns the root tree oid. */
  treeFromFileMap(repo: Repo, files: Map<string, FileEntry>): string {
    const build = (dir: string): string => {
      const direct: TreeEntry[] = [];
      const subdirs = new Map<string, Map<string, FileEntry>>();
      for (const [path, entry] of files) {
        if (!path.startsWith(dir)) continue;
        const rest = dir ? path.slice(dir.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash < 0) {
          direct.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const sub = rest.slice(0, slash);
          let m = subdirs.get(sub);
          if (!m) {
            m = new Map();
            subdirs.set(sub, m);
          }
          m.set(path, entry);
        }
      }
      for (const [sub, subFiles] of subdirs) {
        const subDir = dir ? `${dir}/${sub}` : sub;
        direct.push({ mode: '40000', name: sub, oid: build(subDir) });
      }
      return this.buildTree(repo, direct);
    };
    return build('');
  }

  /** Flat file map of a ref tip (or a commit oid): path -> {mode, oid}. */
  fileMapAt(repo: Repo, refOrOid: string): Map<string, FileEntry> {
    let oid = repo.refs.get(refOrOid);
    if (!oid) oid = refOrOid;
    const obj = this.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return new Map();
    const commit = this.parseCommit(obj.data);
    return this.readTreeRecursive(repo, commit.tree);
  }

  /** Tip commit oid of a ref, or undefined. */
  tipOf(repo: Repo, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  // ---- reachability -----------------------------------------------------
  collectReachable(repo: Repo, tips: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = (stack.pop() as string).toLowerCase();
      if (seen.has(oid)) continue;
      const obj = this.getObject(repo, oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = this.parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === 'tree') {
        for (const e of this.parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (m) stack.push(m[1] as string);
      }
    }
    return seen;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    const target = anc.toLowerCase();
    const seen = new Set<string>();
    const stack = [desc.toLowerCase()];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === target) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      stack.push(...this.parseCommit(obj.data).parents);
    }
    return false;
  }

  /** Best-effort merge base: first common commit found by BFS from both sides. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancA = new Map<string, number>(); // oid -> depth
    const queueA: Array<[string, number]> = [[a.toLowerCase(), 0]];
    for (let qi = 0; qi < queueA.length; qi++) {
      const [oid, depth] = queueA[qi] as [string, number];
      if (ancA.has(oid)) continue;
      ancA.set(oid, depth);
      const obj = this.getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) queueA.push([p, depth + 1]);
    }
    const queueB: Array<[string, number]> = [[b.toLowerCase(), 0]];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestDepth = Infinity;
    for (let qi = 0; qi < queueB.length; qi++) {
      const [oid, depth] = queueB[qi] as [string, number];
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const da = ancA.get(oid);
      if (da !== undefined && da + depth < bestDepth) {
        best = oid;
        bestDepth = da + depth;
      }
      const obj = this.getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.data).parents) queueB.push([p, depth + 1]);
    }
    return best;
  }

  // ---- diffs and merges ---------------------------------------------------
  private countLines(data: Buffer): number {
    if (data.length === 0) return 0;
    let n = 0;
    for (const byte of data) if (byte === 0x0a) n += 1;
    if (data[data.length - 1] !== 0x0a) n += 1;
    return n;
  }

  diffFileMaps(
    repo: Repo,
    base: Map<string, FileEntry>,
    head: Map<string, FileEntry>,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const data = this.getObject(repo, b.oid)?.data ?? Buffer.alloc(0);
        out.push({ path, status: 'removed', additions: 0, deletions: this.countLines(data) });
      } else if (!b && h) {
        const data = this.getObject(repo, h.oid)?.data ?? Buffer.alloc(0);
        out.push({ path, status: 'added', additions: this.countLines(data), deletions: 0 });
      } else if (b && h && b.oid !== h.oid) {
        const bd = this.getObject(repo, b.oid)?.data ?? Buffer.alloc(0);
        const hd = this.getObject(repo, h.oid)?.data ?? Buffer.alloc(0);
        const bl = this.countLines(bd);
        const hl = this.countLines(hd);
        out.push({ path, status: 'modified', additions: Math.max(0, hl - bl) + 1, deletions: Math.max(0, bl - hl) });
      }
    }
    out.sort((x, y) => (x.path < y.path ? -1 : 1));
    return out;
  }

  /**
   * File-level three-way merge. `base`, `ours`, `theirs` are flat file maps.
   * A path both sides changed differently from base is a conflict.
   */
  threeWayMerge(
    base: Map<string, FileEntry>,
    ours: Map<string, FileEntry>,
    theirs: Map<string, FileEntry>,
  ): { files: Map<string, FileEntry>; conflicts: string[] } {
    const files = new Map<string, FileEntry>();
    const conflicts: string[] = [];
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const bOid = b?.oid;
      const oOid = o?.oid;
      const tOid = t?.oid;
      if (oOid === tOid) {
        if (o) files.set(path, o);
      } else if (oOid === bOid) {
        if (t) files.set(path, t);
      } else if (tOid === bOid) {
        if (o) files.set(path, o);
      } else {
        conflicts.push(path);
        if (o) files.set(path, o);
      }
    }
    return { files, conflicts };
  }
}
