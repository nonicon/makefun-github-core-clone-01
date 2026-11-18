// Smart HTTP git transport: protocol v2 + v0 upload-pack, v0 receive-pack.
// Node 22 stdlib only (node:zlib / node:crypto via util). No wall clock, no
// randomness, no subprocess, no network, no git binary.
//
// Wire formats follow spec/git.md exactly: pkt-line codec (strict), plain
// (undeltified) pack generation, pack parsing with OFS_DELTA / REF_DELTA
// resolution and thin-pack completion against the repo store, sideband
// framing, v2 ls-refs / fetch, v0 fetch fallback, receive-pack with
// per-ref fast-forward enforcement and report-status in band-1 sideband.
import { deflateSync, inflateSync } from 'node:zlib';
import type { ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { GitObject, ObjectType, Repo } from './store.ts';
import { bearerToken, hashObject, sendError, sha1 } from './util.ts';

/** Handler context, as defined by DESIGN.md (app.ts builds it). */
export interface Ctx {
  store: Store;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  token: string | null;
}

export type Handler = (ctx: Ctx, res: ServerResponse) => Promise<boolean>;

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-git-forge/1.0';
const UPLOAD_V0_CAPS =
  'side-band-64k ofs-delta shallow thin-pack multi_ack_detailed symref=HEAD:refs/heads/main agent=' +
  AGENT;
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
const OID_RE = /^[0-9a-f]{40}$/;
const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const MAIN_REF = 'refs/heads/main';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Pkt =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Strict pkt-line decode. Throws on a non-hex header, `0003`, a length over
 * 65520, or a truncated packet. When `stopAfterFlush` is set, decoding stops
 * just past the first flush packet and `end` is the offset after it (the
 * bytes after that offset are raw, e.g. a packfile in a receive-pack body).
 */
function decodePktLines(
  buf: Buffer,
  stopAfterFlush = false,
): { packets: Pkt[]; end: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      throw new Error(`pktline-header: invalid pkt-line length "${head}"`);
    }
    const len = parseInt(head, 16);
    if (len === 3) throw new Error('pktline-header: 0003 is invalid');
    if (len > 65520) throw new Error('pktline-too-long');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      if (stopAfterFlush) return { packets, end: off };
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (off + len > buf.length) throw new Error('pktline-truncated');
    packets.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (stopAfterFlush) throw new Error('pktline-truncated: no flush');
  return { packets, end: off };
}

function dataLines(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') out.push(p.data.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function encodeEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [(typeCode << 4) | (size & 0x0f)];
  size >>= 4;
  while (size > 0) {
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) | 0x80;
    bytes.push(size & 0x7f);
    size >>= 7;
  }
  return Buffer.from(bytes);
}

/** Deterministic pack: plain objects only, entries sorted by oid. */
const packCache = new WeakMap<Repo, Map<string, Buffer>>();
const PACK_CACHE_MAX = 32;

export function buildPack(repo: Repo, oids: string[]): Buffer {
  const sorted = [...new Set(oids.map((o) => o.toLowerCase()))].sort();
  const key = sorted.join(',');
  let perRepo = packCache.get(repo);
  if (!perRepo) {
    perRepo = new Map<string, Buffer>();
    packCache.set(repo, perRepo);
  }
  const cached = perRepo.get(key);
  if (cached) return cached;
  const entries: Buffer[] = [];
  let found = 0;
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    found += 1;
    entries.push(
      Buffer.concat([
        encodeEntryHeader(TYPE_CODES[obj.type], obj.data.length),
        deflateSync(obj.data),
      ]),
    );
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  const pack = Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
  // Cache only complete packs: an oid missing now may be pushed later, and
  // a cached pack omitting it would be stale. Objects are immutable once
  // stored, so a complete pack stays valid.
  if (found === sorted.length) {
    if (perRepo.size >= PACK_CACHE_MAX) {
      const oldest = perRepo.keys().next().value as string | undefined;
      if (oldest !== undefined) perRepo.delete(oldest);
    }
    perRepo.set(key, pack);
  }
  return pack;
}

/** Inflate one zlib stream starting at `offset`; returns data + bytes used. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const slice = buf.subarray(offset);
  try {
    const res = inflateSync(slice, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = res.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed >= 1 && consumed <= slice.length) {
      return { data: res.buffer, consumed };
    }
  } catch {
    // Fall through to the binary-search fallback below.
  }
  // Smallest prefix that inflates cleanly is the exact stream end: a
  // truncated stream throws, extra trailing bytes are ignored.
  let lo = 1;
  let hi = slice.length;
  let ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(slice.subarray(0, mid));
      ans = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (ans < 0) throw new Error('pack-inflate: corrupt zlib stream');
  return { data: inflateSync(slice.subarray(0, ans)), consumed: ans };
}

function readEntrySizeVarint(buf: Buffer, off: number): { type: number; size: number; next: number } {
  let b = buf[off] as number;
  let next = off + 1;
  const type = (b >> 4) & 7;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    b = buf[next] as number;
    next += 1;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next };
}

function readDeltaVarint(d: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = off;
  for (;;) {
    const b = d[next] as number;
    next += 1;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const src = readDeltaVarint(delta, p);
  p = src.next;
  if (src.value !== base.length) throw new Error('pack-delta: source size mismatch');
  const tgt = readDeltaVarint(delta, p);
  p = tgt.next;
  const parts: Buffer[] = [];
  let outLen = 0;
  while (p < delta.length) {
    const op = delta[p] as number;
    p += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) {
        cpOff = delta[p] as number;
        p += 1;
      }
      if (op & 0x02) {
        cpOff |= (delta[p] as number) << 8;
        p += 1;
      }
      if (op & 0x04) {
        cpOff |= (delta[p] as number) << 16;
        p += 1;
      }
      if (op & 0x08) {
        cpOff |= (delta[p] as number) << 24;
        p += 1;
      }
      if (op & 0x10) {
        cpSize = delta[p] as number;
        p += 1;
      }
      if (op & 0x20) {
        cpSize |= (delta[p] as number) << 8;
        p += 1;
      }
      if (op & 0x40) {
        cpSize |= (delta[p] as number) << 16;
        p += 1;
      }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('pack-delta: copy out of range');
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      if (p + op > delta.length) throw new Error('pack-delta: insert out of range');
      parts.push(delta.subarray(p, p + op));
      outLen += op;
      p += op;
    } else {
      throw new Error('pack-delta: opcode 0');
    }
  }
  if (outLen !== tgt.value) throw new Error('pack-delta: target size mismatch');
  return Buffer.concat(parts);
}

interface PackEntry {
  start: number;
  kind: 'obj' | 'ofs' | 'ref';
  type?: ObjectType;
  data?: Buffer;
  oid?: string;
  delta?: Buffer;
  size: number;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile strictly: magic, version 2/3, trailer SHA-1, declared
 * sizes, no trailing bytes. Resolves OFS_DELTA (base must be an earlier entry
 * in the same pack) and REF_DELTA (base in the pack or already in the repo
 * store — thin-pack completion). Returns oid -> object for every entry.
 */
export function parsePack(buf: Buffer, repo: Repo): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1(buf.subarray(0, buf.length - 20)) !== trailer) {
    throw new Error('pack checksum mismatch');
  }
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, number>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off >= buf.length - 20) throw new Error('pack truncated');
    const start = off;
    const h = readEntrySizeVarint(buf, off);
    off = h.next;
    if (h.type >= 1 && h.type <= 4) {
      const type = CODE_TYPES[h.type] as ObjectType;
      const inf = inflateAt(buf, off);
      off += inf.consumed;
      if (inf.data.length !== h.size) throw new Error('pack-size mismatch');
      entries.push({
        start,
        kind: 'obj',
        type,
        data: inf.data,
        oid: hashObject(type, inf.data),
        size: h.size,
      });
    } else if (h.type === 6) {
      let b = buf[off] as number;
      off += 1;
      let v = b & 0x7f;
      while (b & 0x80) {
        b = buf[off] as number;
        off += 1;
        v = ((v + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = start - v;
      if (baseOffset <= 0 || baseOffset >= start) throw new Error('pack-delta: bad ofs base');
      const inf = inflateAt(buf, off);
      off += inf.consumed;
      entries.push({ start, kind: 'ofs', delta: inf.data, size: h.size, baseOffset });
    } else if (h.type === 7) {
      if (off + 20 > buf.length - 20) throw new Error('pack truncated');
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inf = inflateAt(buf, off);
      off += inf.consumed;
      entries.push({ start, kind: 'ref', delta: inf.data, size: h.size, baseOid });
    } else {
      throw new Error('pack-type: unknown object type');
    }
    byOffset.set(start, entries.length - 1);
  }
  if (off !== buf.length - 20) throw new Error('pack-trailing bytes');

  const resolved = new Map<string, GitObject>();
  const byIndex = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolve = (idx: number): GitObject => {
    if (byIndex.has(idx)) return byIndex.get(idx) as GitObject;
    const e = entries[idx] as PackEntry;
    if (e.kind === 'obj') {
      const obj: GitObject = { type: e.type as ObjectType, data: e.data as Buffer };
      byIndex.set(idx, obj);
      if (!resolved.has(e.oid as string)) resolved.set(e.oid as string, obj);
      return obj;
    }
    if (resolving.has(idx)) throw new Error('pack-delta-cycle');
    resolving.add(idx);
    try {
      let base: GitObject | undefined;
      if (e.kind === 'ofs') {
        const bi = byOffset.get(e.baseOffset as number);
        if (bi === undefined) throw new Error('pack-delta: ofs base not in pack');
        base = resolve(bi);
      } else {
        const bo = e.baseOid as string;
        base = resolved.get(bo) ?? repo.objects.get(bo);
        if (!base) {
          for (let j = 0; j < entries.length; j++) {
            if (j === idx) continue;
            const ej = entries[j] as PackEntry;
            if (ej.oid === bo && byIndex.has(j)) {
              base = byIndex.get(j);
              break;
            }
            if (ej.kind !== 'obj' && !byIndex.has(j)) {
              try {
                const cand = resolve(j);
                const candOid = hashObject(cand.type, cand.data);
                if (candOid === bo) {
                  base = cand;
                  break;
                }
              } catch {
                // That entry may resolve later; keep looking.
              }
            }
          }
        }
        if (!base) throw new Error('pack-delta-base: base object not found');
      }
      const data = applyDelta(base.data, e.delta as Buffer);
      if (data.length !== e.size) throw new Error('pack-delta: target size mismatch');
      const obj: GitObject = { type: base.type, data };
      const oid = hashObject(base.type, data);
      e.oid = oid;
      byIndex.set(idx, obj);
      if (!resolved.has(oid)) resolved.set(oid, obj);
      return obj;
    } finally {
      resolving.delete(idx);
    }
  };
  for (let i = 0; i < entries.length; i++) resolve(i);
  return resolved;
}

// ---------------------------------------------------------------------------
// refs / reachability helpers
// ---------------------------------------------------------------------------

/** Peel an annotated tag (recursively) to its final non-tag target. */
function peelTarget(repo: Repo, oid: string): string | null {
  let cur = oid.toLowerCase();
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type !== 'tag') return cur;
    if (seen.has(cur)) return null;
    seen.add(cur);
    const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (!m) return null;
    cur = m[1] as string;
  }
}

/**
 * Objects the client already holds, given its haves and its shallow
 * boundaries: walk from each have, but do not follow parents past a shallow
 * boundary commit (its tree is held, its history is not).
 */
function heldSet(store: Store, repo: Repo, haves: string[], shallow: string[]): Set<string> {
  const shallowSet = new Set(shallow.map((s) => s.toLowerCase()));
  const out = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = (stack.pop() as string).toLowerCase();
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = store.parseCommit(obj.data);
      for (const t of store.collectReachable(repo, [c.tree])) out.add(t);
      if (!shallowSet.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const t of store.collectReachable(repo, [oid])) out.add(t);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1] as string);
    }
  }
  return out;
}

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
  unknownWant: string | null;
}

/** Compute exactly which objects a fetch must return (spec §6.4). */
function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | undefined,
): FetchPlan {
  for (const w of wants) {
    if (!repo.objects.has(w.toLowerCase())) {
      return { send: [], shallow: [], unshallow: [], unknownWant: w };
    }
  }
  const held = heldSet(store, repo, haves, shallow);
  const send = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== undefined) {
    const gen = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    const enqueue = (oid: string, g: number): void => {
      const cur = gen.get(oid);
      if (cur === undefined || g < cur) {
        gen.set(oid, g);
        queue.push([oid, g]);
      }
    };
    for (const w of wants) {
      const oid = w.toLowerCase();
      const obj = repo.objects.get(oid) as GitObject;
      if (obj.type === 'tag') {
        let cur = oid;
        for (;;) {
          send.add(cur);
          const o = repo.objects.get(cur);
          if (!o || o.type !== 'tag') break;
          const m = /^object ([0-9a-f]{40})/m.exec(o.data.toString('utf8'));
          if (!m) break;
          cur = m[1] as string;
        }
        const target = peelTarget(repo, oid);
        if (target) enqueue(target, 1);
      } else if (obj.type === 'commit') {
        enqueue(oid, 1);
      } else {
        for (const t of store.collectReachable(repo, [oid])) send.add(t);
      }
    }
    let qi = 0;
    while (qi < queue.length) {
      const [oid, g] = queue[qi] as [string, number];
      qi += 1;
      if (gen.get(oid) !== g) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      send.add(oid);
      const c = store.parseCommit(obj.data);
      for (const t of store.collectReachable(repo, [c.tree])) send.add(t);
      if (g < depth) {
        for (const p of c.parents) enqueue(p.toLowerCase(), g + 1);
      } else if (c.parents.length > 0) {
        shallowOut.push(oid);
      }
    }
    const shallowSet = new Set(shallowOut);
    for (const s of shallow) {
      const sl = s.toLowerCase();
      if (gen.has(sl) && !shallowSet.has(sl)) unshallowOut.push(sl);
    }
  } else {
    for (const t of store.collectReachable(repo, wants)) send.add(t);
  }
  for (const h of held) send.delete(h);
  return {
    send: [...send].sort(),
    shallow: shallowOut.sort(),
    unshallow: unshallowOut.sort(),
    unknownWant: null,
  };
}

/** Verify every new tip's reachable closure is present in pack ∪ store. */
function verifyClosure(
  store: Store,
  repo: Repo,
  packObjects: Map<string, GitObject>,
  tips: string[],
): string | null {
  /**
   * Verify that every new tip's reachable closure is present in pack ∪ store.
   * Only pack objects are descended into: an object already in the store was
   * itself verified when it entered (or was built from verified objects), so
   * its whole closure is present by induction. Descending into store objects
   * too would re-walk the entire history on every push (O(n^2) over a
   * 200-push round).
   */
  const lookup = (oid: string): GitObject | undefined =>
    packObjects.get(oid.toLowerCase()) ?? repo.objects.get(oid.toLowerCase());
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = (stack.pop() as string).toLowerCase();
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) return oid;
    seen.add(oid);
    if (!packObjects.has(oid)) continue; // in the store: closure already known-present
    if (obj.type === 'commit') {
      const c = store.parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of store.parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1] as string);
    }
  }
  return null;
}

/** Fast-forward decision for one ref update (spec §4.5). */
function ffAccept(store: Store, repo: Repo, oldOid: string, newOid: string, ref: string): boolean {
  const cur = store.getRef(repo, ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // Delete: old must match the current value and the ref must exist.
    return oldOid === cur && cur !== ZERO_OID;
  }
  if (oldOid === ZERO_OID) {
    // Create: the ref must not exist yet.
    return cur === ZERO_OID;
  }
  if (oldOid !== cur) return false;
  if (newOid === cur) return true;
  const newObj = repo.objects.get(newOid);
  if (!newObj) return false;
  if (newObj.type === 'tag') return true; // tag ref update with matching old
  if (newObj.type !== 'commit') return false;
  const curObj = repo.objects.get(cur);
  if (!curObj) return false;
  if (curObj.type === 'tag') return true;
  if (curObj.type !== 'commit') return false;
  return store.isAncestor(repo, cur, newOid);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v0Advertisement(store: Store, repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), PKT_FLUSH];
  const refs = store.listRefs(repo);
  const headOid = store.getRef(repo, MAIN_REF);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      const obj = repo.objects.get(r.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelTarget(repo, r.oid);
        if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('fetch=shallow\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// sideband + raw responses
// ---------------------------------------------------------------------------

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
  });
  res.end(body);
}

/** Split pack bytes into sideband pkt-lines (band 1, payload ≤ 65516). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/** Report-status stream: each line pkt-lined inside a band-1 packet, then flush. */
function reportPackets(lines: string[]): Buffer[] {
  const out: Buffer[] = [];
  for (const line of lines) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
  }
  out.push(PKT_FLUSH);
  return out;
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.split(/\s+/)[1] as string;
      if (OID_RE.test(oid) && !wants.includes(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.split(/\s+/)[1] as string;
      if (OID_RE.test(oid) && !haves.includes(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.split(/\s+/)[1] as string;
      if (OID_RE.test(oid) && !shallow.includes(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

function fetchV2Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const acked = args.haves.filter((h) => repo.objects.has(h.toLowerCase()));
  if (acked.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const h of acked) parts.push(pktLine(`ACK ${h.toLowerCase()}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  if (plan.unknownWant) {
    parts.push(
      pktLine(
        Buffer.concat([
          Buffer.from([3]),
          Buffer.from(`unknown object ${plan.unknownWant}\n`, 'utf8'),
        ]),
      ),
    );
  } else {
    for (const p of sidebandPackets(buildPack(repo, plan.send))) parts.push(p);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  const acked = args.haves.filter((h) => repo.objects.has(h.toLowerCase()));
  if (acked.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const h of acked) parts.push(pktLine(`ACK ${h.toLowerCase()}\n`));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.unknownWant) {
    parts.push(
      pktLine(
        Buffer.concat([
          Buffer.from([3]),
          Buffer.from(`unknown object ${plan.unknownWant}\n`, 'utf8'),
        ]),
      ),
    );
  } else {
    for (const p of sidebandPackets(buildPack(repo, plan.send))) parts.push(p);
  }
  return Buffer.concat(parts);
}

function lsRefsResponse(
  store: Store,
  repo: Repo,
  args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const headOid = store.getRef(repo, MAIN_REF);
  const include = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  if (include('HEAD')) {
    if (headOid) {
      parts.push(
        pktLine(
          `${headOid} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`,
        ),
      );
    } else if (args.unborn) {
      parts.push(
        pktLine(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`),
      );
    }
  }
  for (const r of store.listRefs(repo)) {
    if (!include(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (args.peel) {
      const obj = repo.objects.get(r.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelTarget(repo, r.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(ctx: Ctx, res: ServerResponse, repo: Repo): boolean {
  let decoded: { packets: Pkt[]; end: number };
  try {
    decoded = decodePktLines(ctx.body);
  } catch {
    sendError(res, 400, 'malformed pkt-line stream');
    return true;
  }
  const packets = decoded.packets;
  const firstData = packets.find((p) => p.kind === 'data');
  if (!firstData) {
    sendError(res, 400, 'empty upload-pack request');
    return true;
  }
  const firstLine = firstData.data.toString('utf8').replace(/\n$/, '');
  if (firstLine.startsWith('command=')) {
    // ---- protocol v2 ----
    const command = firstLine.slice('command='.length).trim();
    const delimIdx = packets.findIndex((p) => p.kind === 'delim');
    const argStart = delimIdx >= 0 ? delimIdx + 1 : 1;
    const argLines: string[] = [];
    for (let i = argStart; i < packets.length; i++) {
      const p = packets[i] as Pkt;
      if (p.kind === 'flush') break;
      if (p.kind === 'data') argLines.push(p.data.toString('utf8'));
    }
    if (command === 'ls-refs') {
      const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const raw of argLines) {
        const line = raw.replace(/\n$/, '');
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(ctx.store, repo, args));
      return true;
    }
    if (command === 'fetch') {
      const args = parseFetchArgs(argLines);
      sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchV2Response(ctx.store, repo, args));
      return true;
    }
    sendError(res, 400, `unknown upload-pack command: ${command}`);
    return true;
  }
  // ---- protocol v0 ----
  const sections: string[][] = [];
  let cur: string[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') {
      sections.push(cur);
      cur = [];
    } else if (p.kind === 'data') {
      cur.push(p.data.toString('utf8'));
    }
  }
  if (cur.length > 0) sections.push(cur);
  const sec1 = sections[0] ?? [];
  const sec2 = sections[1] ?? [];
  const args = parseFetchArgs([...sec1, ...sec2]);
  if (args.wants.length === 0) {
    sendError(res, 400, 'fetch with no wants');
    return true;
  }
  sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchV0Response(ctx.store, repo, args));
  return true;
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

function handleReceivePack(ctx: Ctx, res: ServerResponse, repo: Repo): boolean {
  const fail = (detail: string): boolean => {
    sendRaw(
      res,
      200,
      'application/x-git-receive-pack-result',
      Buffer.concat(reportPackets([`unpack ${detail}\n`])),
    );
    return true;
  };
  let decoded: { packets: Pkt[]; end: number };
  try {
    decoded = decodePktLines(ctx.body, true);
  } catch {
    sendError(res, 400, 'malformed pkt-line stream');
    return true;
  }
  const commandLines: string[] = [];
  for (const p of decoded.packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'data') commandLines.push(p.data.toString('utf8'));
  }
  if (commandLines.length === 0) {
    sendError(res, 400, 'empty push');
    return true;
  }
  interface Cmd {
    old: string;
    nw: string;
    ref: string;
  }
  const cmds: Cmd[] = [];
  for (const raw of commandLines) {
    let line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities on the first line
    const parts = line.split(' ');
    if (
      parts.length !== 3 ||
      !OID_RE.test(parts[0] as string) ||
      !OID_RE.test(parts[1] as string) ||
      !(parts[2] as string).startsWith('refs/')
    ) {
      sendError(res, 400, 'malformed push command');
      return true;
    }
    cmds.push({ old: parts[0] as string, nw: parts[1] as string, ref: parts[2] as string });
  }
  const needsPack = cmds.some((c) => c.nw !== ZERO_OID);
  if (needsPack) {
    const packBytes = ctx.body.subarray(decoded.end);
    let packObjects: Map<string, GitObject>;
    try {
      if (packBytes.length < 32) throw new Error('pack too short');
      packObjects = parsePack(packBytes, repo);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'invalid pack');
    }
    const tips = cmds.filter((c) => c.nw !== ZERO_OID).map((c) => c.nw);
    const missing = verifyClosure(ctx.store, repo, packObjects, tips);
    if (missing) return fail(`missing object ${missing}`);
    for (const [oid, obj] of packObjects) ctx.store.putObjectKnown(repo, obj.type, obj.data, oid);
  }
  const lines: string[] = ['unpack ok\n'];
  for (const c of cmds) {
    if (ffAccept(ctx.store, repo, c.old, c.nw, c.ref)) {
      if (c.nw === ZERO_OID) ctx.store.deleteRef(repo, c.ref);
      else ctx.store.setRef(repo, c.ref, c.nw);
      lines.push(`ok ${c.ref}\n`);
    } else {
      lines.push(`ng ${c.ref} non-fast-forward\n`);
    }
  }
  sendRaw(
    res,
    200,
    'application/x-git-receive-pack-result',
    Buffer.concat(reportPackets(lines)),
  );
  return true;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function authorized(ctx: Ctx): boolean {
  const token = ctx.token ? ctx.token : bearerToken(ctx.headers);
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected) return token === expected;
  return true;
}

export async function handleGit(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(ctx.path);
  if (!m) return false;
  const owner = m[1] as string;
  const repoName = m[2] as string;
  const service = m[3] as string;
  if (!authorized(ctx)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  try {
    if (ctx.method === 'GET' && service === 'info/refs') {
      const svc = ctx.query.get('service');
      if (svc === 'git-upload-pack') {
        const v2 = (ctx.headers['git-protocol'] ?? '').includes('version=2');
        sendRaw(
          res,
          200,
          'application/x-git-upload-pack-advertisement',
          v2 ? v2Advertisement() : v0Advertisement(ctx.store, repo, 'upload-pack'),
        );
        return true;
      }
      if (svc === 'git-receive-pack') {
        sendRaw(
          res,
          200,
          'application/x-git-receive-pack-advertisement',
          v0Advertisement(ctx.store, repo, 'receive-pack'),
        );
        return true;
      }
      sendError(res, 400, 'unknown service');
      return true;
    }
    if (ctx.method === 'POST' && service === 'git-upload-pack') {
      return handleUploadPack(ctx, res, repo);
    }
    if (ctx.method === 'POST' && service === 'git-receive-pack') {
      return handleReceivePack(ctx, res, repo);
    }
    return false;
  } catch {
    // A git request must never crash the process (spec check 30).
    try {
      if (!res.headersSent) sendError(res, 400, 'Bad Request');
      else res.end();
    } catch {
      // Response already gone; nothing more to do.
    }
    return true;
  }
}
