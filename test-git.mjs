// Test for src/git.ts — plain node, no deps, no git binary.
// Spawns test-server-git.ts (node --experimental-strip-types), then drives
// it with raw HTTP + fetch only. Prints PASS/FAIL per case, exits non-zero
// on any failure.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';
const ZERO = '0'.repeat(40);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}
function gitHash(type, data) {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}
function pkt(data) {
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return Buffer.concat([Buffer.from((p.length + 4).toString(16).padStart(4, '0'), 'ascii'), p]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function decodePkts(buf) {
  const packets = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error(`bad pkt header ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; }
    else if (len === 1) { packets.push({ kind: 'delim' }); off += 4; }
    else if (len === 2) { packets.push({ kind: 'response-end' }); off += 4; }
    else if (len === 3) throw new Error('pkt 0003 invalid');
    else if (len > 65520) throw new Error('pkt too long');
    else {
      if (off + len > buf.length) throw new Error('pktline-truncated');
      packets.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return packets;
}

const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeEntryHeader(typeCode, size) {
  const bytes = [(typeCode << 4) | (size & 0x0f)];
  size >>= 4;
  while (size > 0) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(size & 0x7f);
    size >>= 7;
  }
  return Buffer.from(bytes);
}

function buildPack(entries) {
  const parts = [Buffer.from('PACK', 'ascii')];
  const counts = Buffer.alloc(8);
  counts.writeUInt32BE(2, 0);
  counts.writeUInt32BE(entries.length, 4);
  parts.push(counts);
  for (const e of entries) {
    parts.push(encodeEntryHeader(TYPE_CODES[e.type], e.data.length));
    parts.push(zlib.deflateSync(e.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

function inflateAt(buf, offset) {
  const slice = buf.subarray(offset);
  try {
    const res = zlib.inflateSync(slice, { info: true });
    const consumed = res.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed >= 1 && consumed <= slice.length) {
      return { data: res.buffer, consumed };
    }
  } catch { /* fallback */ }
  let lo = 1, hi = slice.length, ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try { zlib.inflateSync(slice.subarray(0, mid)); ans = mid; hi = mid - 1; }
    catch { lo = mid + 1; }
  }
  if (ans < 0) throw new Error('corrupt zlib stream');
  return { data: zlib.inflateSync(slice.subarray(0, ans)), consumed: ans };
}

function parsePack(buf) {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  if (sha1(buf.subarray(0, buf.length - 20)) !== buf.subarray(buf.length - 20).toString('hex')) {
    throw new Error('pack trailer checksum mismatch');
  }
  const objects = new Map();
  let off = 12;
  for (let i = 0; i < count; i++) {
    let b = buf[off]; off += 1;
    const typeCode = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off]; off += 1;
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode < 1 || typeCode > 4) throw new Error(`unexpected delta type ${typeCode} in server pack`);
    const type = CODE_TYPES[typeCode];
    const inf = inflateAt(buf, off);
    off += inf.consumed;
    if (inf.data.length !== size) throw new Error('pack-size mismatch');
    const oid = gitHash(type, inf.data);
    if (objects.has(oid)) throw new Error(`duplicate oid ${oid} in pack`);
    objects.set(oid, { type, data: inf.data });
  }
  if (off !== buf.length - 20) throw new Error('pack trailing bytes');
  if (objects.size !== count) throw new Error('declared count != entries');
  return objects;
}

function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function buildCommit(tree, parents, message, ts = 1735689600) {
  const who = `Conformance <conformance@make.fun> ${ts} +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`),
    `author ${who}`, `committer ${who}`, '', message.endsWith('\n') ? message : `${message}\n`];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// client request builders
// ---------------------------------------------------------------------------
function lsRefsBody({ peel = true, symrefs = true, unborn = true, prefixes = [] } = {}) {
  const parts = [pkt('command=ls-refs\n'), pkt('agent=test-client/1.0\n'), pkt('object-format=sha1\n'), DELIM];
  if (peel) parts.push(pkt('peel\n'));
  if (symrefs) parts.push(pkt('symrefs\n'));
  if (unborn) parts.push(pkt('unborn\n'));
  for (const p of prefixes) parts.push(pkt(`ref-prefix ${p}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV2Body({ wants, haves = [], shallow = [], depth } = {}) {
  const parts = [pkt('command=fetch\n'), pkt('agent=test-client/1.0\n'), pkt('object-format=sha1\n'), DELIM,
    pkt('thin-pack\n'), pkt('no-progress\n'), pkt('ofs-delta\n')];
  for (const w of wants) parts.push(pkt(`want ${w}\n`));
  for (const h of haves) parts.push(pkt(`have ${h}\n`));
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  if (depth !== undefined) parts.push(pkt(`deepen ${depth}\n`));
  parts.push(pkt('done\n'), FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Body({ wants, haves = [], shallow = [], depth } = {}) {
  const parts = [pkt(`want ${wants[0]} side-band-64k multi_ack_detailed thin-pack no-progress ofs-delta\n`)];
  for (const w of wants.slice(1)) parts.push(pkt(`want ${w}\n`));
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  if (depth !== undefined) parts.push(pkt(`deepen ${depth}\n`));
  parts.push(FLUSH);
  for (const h of haves) parts.push(pkt(`have ${h}\n`));
  parts.push(pkt('done\n'), FLUSH);
  return Buffer.concat(parts);
}

function pushBody(commands, pack) {
  const parts = [];
  commands.forEach((c, i) => {
    let line = `${c.old} ${c.nw} ${c.ref}`;
    if (i === 0) line += '\0report-status side-band-64k ofs-delta agent=test-client/1.0';
    parts.push(pkt(`${line}\n`));
  });
  parts.push(FLUSH);
  if (pack) parts.push(pack);
  return Buffer.concat(parts);
}

function parseV2Fetch(buf) {
  const packets = decodePkts(buf);
  let section = 'none';
  const out = { acks: [], nak: false, shallow: [], unshallow: [], pack: null };
  const chunks = [];
  for (const p of packets) {
    if (p.kind === 'flush' || p.kind === 'delim') { section = 'none'; continue; }
    const data = p.data;
    const text = data.toString('utf8');
    if (section === 'none' && (text === 'acknowledgments\n' || text === 'shallow-info\n' || text === 'packfile\n' || text === 'wanted-refs\n')) {
      section = text.trim();
      continue;
    }
    if (section === 'acknowledgments') {
      if (text === 'NAK\n') out.nak = true;
      else if (text.startsWith('ACK ')) out.acks.push(text.slice(4).trim());
      else if (text === 'ready\n') { /* ok */ }
      else throw new Error(`bad ack line ${JSON.stringify(text)}`);
    } else if (section === 'shallow-info') {
      if (text.startsWith('shallow ')) out.shallow.push(text.slice(8).trim());
      else if (text.startsWith('unshallow ')) out.unshallow.push(text.slice(10).trim());
      else throw new Error(`bad shallow-info line ${JSON.stringify(text)}`);
    } else if (section === 'packfile') {
      const band = data[0];
      if (band === 1) chunks.push(data.subarray(1));
      else if (band === 2) { /* progress */ }
      else if (band === 3) throw new Error(`sideband error: ${data.subarray(1).toString('utf8')}`);
      else throw new Error(`invalid sideband band ${band}`);
    } else if (section === 'wanted-refs') {
      // ignored
    } else {
      throw new Error(`packet in unknown section ${JSON.stringify(text)}`);
    }
  }
  if (chunks.length > 0) out.pack = Buffer.concat(chunks);
  return out;
}

function parseV0Fetch(buf) {
  const packets = decodePkts(buf);
  const out = { acks: [], nak: false, shallow: [], unshallow: [], pack: null };
  const chunks = [];
  let inPack = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const data = p.data;
    const b0 = data[0];
    if (!inPack && b0 !== 1 && b0 !== 2 && b0 !== 3) {
      const text = data.toString('utf8');
      if (text === 'NAK\n') out.nak = true;
      else if (text.startsWith('ACK ')) out.acks.push(text.slice(4).trim());
      else if (text.startsWith('shallow ')) out.shallow.push(text.slice(8).trim());
      else if (text.startsWith('unshallow ')) out.unshallow.push(text.slice(10).trim());
      else throw new Error(`bad v0 line ${JSON.stringify(text)}`);
    } else {
      inPack = true;
      if (b0 === 1) chunks.push(data.subarray(1));
      else if (b0 === 2) { /* progress */ }
      else if (b0 === 3) throw new Error(`sideband error: ${data.subarray(1).toString('utf8')}`);
      else throw new Error(`invalid sideband band ${b0}`);
    }
  }
  if (chunks.length > 0) out.pack = Buffer.concat(chunks);
  return out;
}

function parsePushReport(buf) {
  const packets = decodePkts(buf);
  let text = '';
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    if (p.data[0] !== 1) throw new Error(`report packet not band 1 (band ${p.data[0]})`);
    text += p.data.subarray(1).toString('utf8');
  }
  const inner = decodePkts(Buffer.from(text, 'utf8'));
  return inner.filter((p) => p.kind === 'data').map((p) => p.data.toString('utf8').replace(/\n$/, ''));
}

function parseLsRefs(buf) {
  const packets = decodePkts(buf);
  const refs = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('unborn ')) {
      const rest = line.slice(7);
      const [name, ...attrs] = rest.split(' ');
      refs.push({ oid: null, name, attrs });
    } else {
      const sp = line.indexOf(' ');
      if (sp < 0) throw new Error(`ls-refs line without space: ${JSON.stringify(line)}`);
      const oid = line.slice(0, sp);
      if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(`ls-refs bad oid: ${JSON.stringify(line)}`);
      const rest = line.slice(sp + 1);
      const [name, ...attrs] = rest.split(' ');
      refs.push({ oid, name, attrs });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// test runner
// ---------------------------------------------------------------------------
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

async function main() {
  const env = { ...process.env };
  delete env.MAKEFUN_SHOP_TOKEN;
  const child = spawn('node', ['--experimental-strip-types', join(DIR, 'test-server-git.ts')], {
    cwd: DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  let fixture = null;
  let port = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not become ready')), 15000);
    child.stdout.on('data', (d) => {
      serverOut += d.toString();
      for (const line of serverOut.split('\n')) {
        if (line.startsWith('READY ')) port = parseInt(line.slice(6), 10);
        if (line.startsWith('FIXTURE ')) fixture = JSON.parse(line.slice(8));
      }
      if (port && fixture) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (d) => { serverOut += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${serverOut}`)));
  });
  await ready;
  const base = `http://127.0.0.1:${port}`;
  const repoPath = `/${fixture.owner}/${fixture.repo}.git`;
  const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'makefun-git-client/1.0' };

  async function req(path, opts = {}) {
    const res = await fetch(`${base}${path}`, { ...opts, signal: AbortSignal.timeout(8000) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  }

  // Expected closure of c3 (no tag): commits, trees, blobs.
  const srcTree = gitHash('tree', buildTree([{ mode: '100644', name: 'c.txt', oid: Object.keys(fixture.blobContents).find((k) => fixture.blobContents[k] === 'gamma\n') }]));
  const closureC3 = new Set([fixture.c1, fixture.c2, fixture.c3, fixture.tree1, fixture.tree2, fixture.tree3, srcTree,
    ...Object.keys(fixture.blobContents)]);

  await check('advertise-v2', async () => {
    const { res, buf } = await req(`${repoPath}/info/refs?service=git-upload-pack`, {
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', Accept: '*/*' },
    });
    assertEq(res.status, 200, 'status');
    assert((res.headers.get('content-type') || '').includes('application/x-git-upload-pack-advertisement'), 'content-type');
    const packets = decodePkts(buf);
    const first = packets.find((p) => p.kind === 'data');
    assertEq(first.data.toString('utf8'), 'version 2\n', 'first packet');
    const caps = packets.filter((p) => p.kind === 'data').slice(1).map((p) => p.data.toString('utf8').trim());
    assert(caps.some((c) => c.startsWith('fetch')), `fetch cap missing (saw ${caps})`);
    assert(caps.some((c) => c.startsWith('ls-refs')), `ls-refs cap missing (saw ${caps})`);
    assert(caps.some((c) => c === 'object-format=sha1'), `object-format=sha1 missing (saw ${caps})`);
    assert(caps.some((c) => c === 'fetch=shallow'), `fetch=shallow missing (saw ${caps})`);
    assert(caps.some((c) => c === 'ls-refs=unborn'), `ls-refs=unborn missing (saw ${caps})`);
  });

  await check('advertise-v0-upload', async () => {
    const { res, buf } = await req(`${repoPath}/info/refs?service=git-upload-pack`, {
      headers: { ...authHeaders, Accept: '*/*' },
    });
    assertEq(res.status, 200, 'status');
    const packets = decodePkts(buf);
    const first = packets.find((p) => p.kind === 'data');
    assertEq(first.data.toString('utf8'), '# service=git-upload-pack\n', 'preamble');
    const text = buf.toString('utf8');
    assert(text.includes('side-band-64k'), 'side-band-64k cap');
    assert(text.includes('symref=HEAD:refs/heads/main'), 'symref cap');
    assert(text.includes(`${fixture.c3} refs/heads/main`), 'main ref line');
    assert(text.includes(`${fixture.c2} refs/tags/v1^{}`), 'peeled tag line');
  });

  await check('advertise-receive', async () => {
    const { res, buf } = await req(`${repoPath}/info/refs?service=git-receive-pack`, {
      headers: { ...authHeaders, Accept: '*/*' },
    });
    assertEq(res.status, 200, 'status');
    assert((res.headers.get('content-type') || '').includes('application/x-git-receive-pack-advertisement'), 'content-type');
    const packets = decodePkts(buf);
    assertEq(packets.find((p) => p.kind === 'data').data.toString('utf8'), '# service=git-receive-pack\n', 'preamble');
    const text = buf.toString('utf8');
    for (const cap of ['report-status', 'side-band-64k', 'delete-refs']) {
      assert(text.includes(cap), `missing cap ${cap}`);
    }
    assert(text.includes(`${fixture.c3} refs/heads/main`), 'main ref line');
  });

  await check('ls-refs', async () => {
    const { res, buf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' },
      body: lsRefsBody({}),
    });
    assertEq(res.status, 200, 'status');
    const refs = parseLsRefs(buf);
    const main = refs.find((r) => r.name === 'refs/heads/main');
    assert(main && main.oid === fixture.c3, `main at ${main?.oid}, want ${fixture.c3}`);
    const head = refs.find((r) => r.name === 'HEAD');
    assert(head && head.oid === fixture.c3, 'HEAD oid');
    assert(head.attrs.includes('symref-target:refs/heads/main'), `HEAD symref attrs ${head.attrs}`);
    const tag = refs.find((r) => r.name === 'refs/tags/v1');
    assert(tag && tag.oid === fixture.tag, 'tag oid');
    assert(tag.attrs.includes(`peeled:${fixture.c2}`), `tag peeled attrs ${tag.attrs}`);
  });

  await check('ls-refs-prefix', async () => {
    const post = async (prefixes) => {
      const { buf } = await req(`${repoPath}/git-upload-pack`, {
        method: 'POST',
        headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
        body: lsRefsBody({ prefixes }),
      });
      return parseLsRefs(buf);
    };
    const heads = await post(['refs/heads/']);
    assert(heads.every((r) => r.name.startsWith('refs/heads/')), `heads answer leaked ${JSON.stringify(heads)}`);
    assert(heads.some((r) => r.name === 'refs/heads/main' && r.oid === fixture.c3), 'main in heads answer');
    const tags = await post(['refs/tags/']);
    assert(tags.every((r) => r.name.startsWith('refs/tags/')), 'tags answer leaked');
    assert(tags.some((r) => r.name === 'refs/tags/v1' && r.oid === fixture.tag), 'v1 in tags answer');
    const none = await post(['refs/does-not-exist/']);
    assertEq(none.length, 0, 'unmatched prefix ref count');
  });

  await check('fetch-v2-full', async () => {
    const { res, buf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' },
      body: fetchV2Body({ wants: [fixture.c3, fixture.tag] }),
    });
    assertEq(res.status, 200, 'status');
    assert((res.headers.get('content-type') || '').includes('application/x-git-upload-pack-result'), 'content-type');
    const parsed = parseV2Fetch(buf);
    assert(parsed.nak, 'expected NAK with no haves');
    assert(parsed.pack, 'no packfile section');
    const objects = parsePack(parsed.pack);
    const expected = new Set([...closureC3, fixture.tag]);
    assertEq(objects.size, expected.size, `object count (got ${[...objects.keys()]})`);
    for (const oid of expected) assert(objects.has(oid), `missing object ${oid}`);
    for (const [oid, content] of Object.entries(fixture.blobContents)) {
      assert(objects.get(oid).data.equals(Buffer.from(content, 'utf8')), `blob ${oid} bytes differ`);
    }
  });

  await check('fetch-v0-full', async () => {
    const { res, buf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' },
      body: fetchV0Body({ wants: [fixture.c3] }),
    });
    assertEq(res.status, 200, 'status');
    const parsed = parseV0Fetch(buf);
    assert(parsed.nak, 'expected NAK');
    assert(parsed.pack, 'no pack data');
    const objects = parsePack(parsed.pack);
    assertEq(objects.size, closureC3.size, `object count (got ${objects.size}, want ${closureC3.size})`);
    for (const oid of closureC3) assert(objects.has(oid), `missing object ${oid}`);
    assert(!objects.has(fixture.tag), 'v0 fetch of c3 should not include the tag object');
  });

  await check('fetch-nothing-new', async () => {
    const { buf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: fetchV2Body({ wants: [fixture.c3], haves: [fixture.c3] }),
    });
    const parsed = parseV2Fetch(buf);
    if (parsed.pack) {
      const objects = parsePack(parsed.pack);
      assertEq(objects.size, 0, `expected 0 objects, got ${objects.size}`);
    }
    // No packfile section at all is also acceptable.
  });

  // Build a new commit c4 (child of c3) client-side and push it.
  const blobD = gitHash('blob', Buffer.from('delta\n', 'utf8'));
  const blobDData = Buffer.from('delta\n', 'utf8');
  const srcTreeBytes = buildTree([{ mode: '100644', name: 'c.txt', oid: Object.keys(fixture.blobContents).find((k) => fixture.blobContents[k] === 'gamma\n') }]);
  const srcTreeOid = gitHash('tree', srcTreeBytes);
  const blobA3 = Object.keys(fixture.blobContents).find((k) => fixture.blobContents[k] === 'alpha revision 3\n');
  const blobA2 = Object.keys(fixture.blobContents).find((k) => fixture.blobContents[k] === 'alpha revision 2\n');
  const blobOld = Object.keys(fixture.blobContents).find((k) => fixture.blobContents[k] === 'old file\n');
  const blobB = Object.keys(fixture.blobContents).find((k) => fixture.blobContents[k] === 'beta\n');
  const tree4Bytes = buildTree([
    { mode: '100644', name: 'a.txt', oid: blobA3 },
    { mode: '100644', name: 'b.txt', oid: blobB },
    { mode: '100644', name: 'd.txt', oid: blobD },
    { mode: '40000', name: 'src', oid: srcTreeOid },
  ]);
  const tree4 = gitHash('tree', tree4Bytes);
  const c4Bytes = buildCommit(tree4, [fixture.c3], 'fourth commit');
  const c4 = gitHash('commit', c4Bytes);

  await check('push-new-commit', async () => {
    const pack = buildPack([
      { type: 'blob', data: blobDData },
      { type: 'tree', data: tree4Bytes },
      { type: 'commit', data: c4Bytes },
    ]);
    const { res, buf } = await req(`${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' },
      body: pushBody([{ old: fixture.c3, nw: c4, ref: 'refs/heads/main' }], pack),
    });
    assertEq(res.status, 200, 'status');
    assert((res.headers.get('content-type') || '').includes('application/x-git-receive-pack-result'), 'content-type');
    const lines = parsePushReport(buf);
    assert(lines.includes('unpack ok'), `unpack line: ${JSON.stringify(lines)}`);
    assert(lines.includes('ok refs/heads/main'), `ok line: ${JSON.stringify(lines)}`);
    const { buf: lsBuf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: lsRefsBody({}),
    });
    const refs = parseLsRefs(lsBuf);
    const main = refs.find((r) => r.name === 'refs/heads/main');
    assertEq(main.oid, c4, 'main after push');
  });

  await check('push-non-fast-forward', async () => {
    const blobSib = gitHash('blob', Buffer.from('delta sibling\n', 'utf8'));
    const treeSibBytes = buildTree([
      { mode: '100644', name: 'a.txt', oid: blobA3 },
      { mode: '100644', name: 'b.txt', oid: blobB },
      { mode: '100644', name: 'd.txt', oid: blobSib },
      { mode: '40000', name: 'src', oid: srcTreeOid },
    ]);
    const treeSib = gitHash('tree', treeSibBytes);
    const sibBytes = buildCommit(treeSib, [fixture.c3], 'sibling commit');
    const sib = gitHash('commit', sibBytes);
    const pack = buildPack([
      { type: 'blob', data: Buffer.from('delta sibling\n', 'utf8') },
      { type: 'tree', data: treeSibBytes },
      { type: 'commit', data: sibBytes },
    ]);
    const { res, buf } = await req(`${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-receive-pack-request' },
      body: pushBody([{ old: c4, nw: sib, ref: 'refs/heads/main' }], pack),
    });
    assertEq(res.status, 200, 'status even for refused refs');
    const lines = parsePushReport(buf);
    assert(lines.includes('unpack ok'), `unpack line: ${JSON.stringify(lines)}`);
    assert(lines.includes('ng refs/heads/main non-fast-forward'), `ng line: ${JSON.stringify(lines)}`);
    const { buf: lsBuf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: lsRefsBody({}),
    });
    const main = parseLsRefs(lsBuf).find((r) => r.name === 'refs/heads/main');
    assertEq(main.oid, c4, 'ref must not move on refused push');
  });

  await check('shallow-depth1', async () => {
    const { buf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: fetchV2Body({ wants: [c4], depth: 1 }),
    });
    const parsed = parseV2Fetch(buf);
    assert(parsed.shallow.includes(c4), `shallow-info must name the tip (saw ${parsed.shallow})`);
    assert(parsed.pack, 'no pack data');
    const objects = parsePack(parsed.pack);
    assert(objects.has(c4), 'tip missing from shallow pack');
    assert(objects.has(tree4), 'tip tree missing');
    assert(objects.has(blobD), 'tip blob missing');
    assert(objects.has(srcTreeOid), 'nested subtree missing');
    assert(!objects.has(fixture.c3), 'shallow pack carried the parent');
    assert(!objects.has(fixture.c2), 'shallow pack carried the grandparent');
    assertEq(objects.size, 7, `shallow pack object count (got ${[...objects.keys()]})`);
  });

  await check('delete-branch', async () => {
    // Create refs/heads/feature at c4 (no new objects: empty pack).
    const emptyPack = buildPack([]);
    let r = await req(`${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-receive-pack-request' },
      body: pushBody([{ old: ZERO, nw: c4, ref: 'refs/heads/feature' }], emptyPack),
    });
    let lines = parsePushReport(r.buf);
    assert(lines.includes('unpack ok'), `create unpack: ${JSON.stringify(lines)}`);
    assert(lines.includes('ok refs/heads/feature'), `create ok: ${JSON.stringify(lines)}`);
    // Delete it (delete-only: no pack bytes).
    r = await req(`${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-receive-pack-request' },
      body: pushBody([{ old: c4, nw: ZERO, ref: 'refs/heads/feature' }], null),
    });
    lines = parsePushReport(r.buf);
    assert(lines.includes('unpack ok'), `delete unpack: ${JSON.stringify(lines)}`);
    assert(lines.includes('ok refs/heads/feature'), `delete ok: ${JSON.stringify(lines)}`);
    const { buf: lsBuf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: lsRefsBody({}),
    });
    const refs = parseLsRefs(lsBuf);
    assert(!refs.some((x) => x.name === 'refs/heads/feature'), 'feature ref still listed');
    assert(refs.some((x) => x.name === 'refs/heads/main' && x.oid === c4), 'main disturbed by delete');
  });

  await check('clone-empty', async () => {
    const emptyPath = `/${fixture.owner}/${fixture.emptyRepo}.git`;
    const { res, buf } = await req(`${emptyPath}/info/refs?service=git-upload-pack`, {
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', Accept: '*/*' },
    });
    assertEq(res.status, 200, 'status');
    const { buf: v0buf } = await req(`${emptyPath}/info/refs?service=git-upload-pack`, {
      headers: { ...authHeaders, Accept: '*/*' },
    });
    assert(v0buf.toString('utf8').includes(`${ZERO} capabilities^{}`), 'v0 empty repo capabilities^{} line');
    const { buf: lsBuf } = await req(`${emptyPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: lsRefsBody({}),
    });
    const refs = parseLsRefs(lsBuf);
    assertEq(refs.length, 1, `empty ls-refs count (got ${JSON.stringify(refs)})`);
    assertEq(refs[0].oid, null, 'HEAD must be unborn');
    assertEq(refs[0].name, 'HEAD', 'HEAD name');
    assert(refs[0].attrs.includes('symref-target:refs/heads/main'), `unborn HEAD symref ${refs[0].attrs}`);
  });

  await check('fetch-incremental', async () => {
    const { buf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: fetchV2Body({ wants: [c4], haves: [fixture.c3] }),
    });
    const parsed = parseV2Fetch(buf);
    assert(parsed.pack, 'no pack data');
    const objects = parsePack(parsed.pack);
    assertEq(objects.size, 3, `incremental object count (got ${[...objects.keys()]})`);
    for (const oid of [c4, tree4, blobD]) assert(objects.has(oid), `missing new object ${oid}`);
    assert(!objects.has(fixture.c3), 'incremental fetch re-sent the old tip');
  });

  await check('fetch-shallow-deepen', async () => {
    const { buf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: fetchV2Body({ wants: [c4], haves: [c4], shallow: [c4], depth: 2 }),
    });
    const parsed = parseV2Fetch(buf);
    assert(parsed.shallow.includes(fixture.c3), `deepen shallow-info must name c3 (saw ${parsed.shallow})`);
    assert(parsed.unshallow.includes(c4), `deepen unshallow must name c4 (saw ${parsed.unshallow})`);
    assert(parsed.pack, 'no pack data');
    const objects = parsePack(parsed.pack);
    assertEq(objects.size, 3, `deepen object count (got ${[...objects.keys()]})`);
    for (const oid of [fixture.c3, fixture.tree3, blobOld]) assert(objects.has(oid), `missing deepened object ${oid}`);
    assert(!objects.has(fixture.c2), 'deepen 2 delivered the grandparent');
  });

  await check('push-mixed-report', async () => {
    const emptyPack = buildPack([]);
    let r = await req(`${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-receive-pack-request' },
      body: pushBody([{ old: ZERO, nw: c4, ref: 'refs/heads/side' }], emptyPack),
    });
    assert(parsePushReport(r.buf).includes('ok refs/heads/side'), 'side setup push failed');
    const blobE = gitHash('blob', Buffer.from('echo\n', 'utf8'));
    const tree5Bytes = buildTree([
      { mode: '100644', name: 'a.txt', oid: blobA3 },
      { mode: '100644', name: 'b.txt', oid: blobB },
      { mode: '100644', name: 'd.txt', oid: blobD },
      { mode: '100644', name: 'e.txt', oid: blobE },
      { mode: '40000', name: 'src', oid: srcTreeOid },
    ]);
    const tree5 = gitHash('tree', tree5Bytes);
    const c5Bytes = buildCommit(tree5, [c4], 'fifth commit');
    const c5 = gitHash('commit', c5Bytes);
    const blobF = gitHash('blob', Buffer.from('foxtrot sibling\n', 'utf8'));
    const treeSib2Bytes = buildTree([
      { mode: '100644', name: 'a.txt', oid: blobA3 },
      { mode: '100644', name: 'b.txt', oid: blobB },
      { mode: '100644', name: 'd.txt', oid: blobD },
      { mode: '100644', name: 'f.txt', oid: blobF },
      { mode: '40000', name: 'src', oid: srcTreeOid },
    ]);
    const treeSib2 = gitHash('tree', treeSib2Bytes);
    const sib2Bytes = buildCommit(treeSib2, [fixture.c3], 'sibling2 commit');
    const sib2 = gitHash('commit', sib2Bytes);
    const pack = buildPack([
      { type: 'blob', data: Buffer.from('echo\n', 'utf8') },
      { type: 'tree', data: tree5Bytes },
      { type: 'commit', data: c5Bytes },
      { type: 'blob', data: Buffer.from('foxtrot sibling\n', 'utf8') },
      { type: 'tree', data: treeSib2Bytes },
      { type: 'commit', data: sib2Bytes },
    ]);
    r = await req(`${repoPath}/git-receive-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-receive-pack-request' },
      body: pushBody([
        { old: c4, nw: c5, ref: 'refs/heads/main' },
        { old: c4, nw: sib2, ref: 'refs/heads/side' },
      ], pack),
    });
    assertEq(r.res.status, 200, 'status');
    const lines = parsePushReport(r.buf);
    assertEq(JSON.stringify(lines), JSON.stringify(['unpack ok', 'ok refs/heads/main', 'ng refs/heads/side non-fast-forward']), `mixed report lines ${JSON.stringify(lines)}`);
    const { buf: lsBuf } = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Git-protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: lsRefsBody({}),
    });
    const refs = parseLsRefs(lsBuf);
    assertEq(refs.find((x) => x.name === 'refs/heads/main').oid, c5, 'FF half must move main');
    assertEq(refs.find((x) => x.name === 'refs/heads/side').oid, c4, 'refused half must not move side');
  });

  await check('missing-repo-404', async () => {
    const up = await req(`/${fixture.owner}/${fixture.repo}-missing.git/info/refs?service=git-upload-pack`, {
      headers: { ...authHeaders, Accept: '*/*' },
    });
    assertEq(up.res.status, 404, 'upload-pack 404');
    const rp = await req(`/${fixture.owner}/${fixture.repo}-missing.git/info/refs?service=git-receive-pack`, {
      headers: { ...authHeaders, Accept: '*/*' },
    });
    assertEq(rp.res.status, 404, 'receive-pack 404');
    const known = await req(`${repoPath}/info/refs?service=git-upload-pack`, {
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', Accept: '*/*' },
    });
    assertEq(known.res.status, 200, 'known repo still 200 afterwards');
  });

  await check('missing-token-401', async () => {
    const { res } = await req(`${repoPath}/info/refs?service=git-upload-pack`, {
      headers: { 'User-Agent': 'makefun-git-client/1.0', 'Git-Protocol': 'version=2', Accept: '*/*' },
    });
    assertEq(res.status, 401, 'status without token');
  });

  await check('malformed-post-survives', async () => {
    const bad = await req(`${repoPath}/git-upload-pack`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-git-upload-pack-request' },
      body: Buffer.from('zzzznot-a-pkt-line'),
    });
    assert(bad.res.status >= 400 && bad.res.status < 600, `unexpected status ${bad.res.status}`);
    const known = await req(`${repoPath}/info/refs?service=git-upload-pack`, {
      headers: { ...authHeaders, 'Git-Protocol': 'version=2', Accept: '*/*' },
    });
    assertEq(known.res.status, 200, 'server must survive malformed POST');
  });

  child.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`FAIL harness: ${e.message}`);
  process.exit(1);
});
