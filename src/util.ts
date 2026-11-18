// Shared HTTP + crypto helpers. No wall clock, no randomness here:
// request ids and timestamps are deterministic counters (see clock below).
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Deterministic logical clock. Base: MAKEFUN_TRIAL_NOW when set, else the
 * competition opening (2026-11-14T06:30:00Z). +1s per issuance so created
 * order is strict and identical across runs. */
const BASE_SEC: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw ? Date.parse(raw) / 1000 : NaN;
  if (Number.isFinite(parsed)) return Math.floor(parsed);
  return Math.floor(Date.parse('2026-11-14T06:30:00Z') / 1000);
})();
let tick = 0;
export const clock = {
  /** Next unix timestamp (seconds), strictly increasing. */
  nowSec(): number {
    return BASE_SEC + (tick += 1);
  },
  /** Next ISO-8601 timestamp, strictly increasing. */
  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  },
};

let reqCounter = 0;
/** Next deterministic request id for X-GitHub-Request-Id. */
export function nextRequestId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Git object id: sha1("<type> <len>\0" + payload). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function b64encode(data: Buffer): string {
  return data.toString('base64');
}
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]/g, ''), 'base64');
}
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
export function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

/** Read the full request body as a Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON body. Returns `{ ok: true, value }` or `{ ok: false }`
 * (caller answers 400). An empty body parses as `{}` when `emptyOk` is set.
 */
export function parseJsonBody(
  body: Buffer,
  emptyOk = false,
): { ok: true; value: unknown } | { ok: false } {
  const text = body.toString('utf8').trim();
  if (text === '') {
    return emptyOk ? { ok: true, value: {} } : { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Answer with a JSON body (adds X-GitHub-Request-Id when asked). */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  requestId = true,
): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    ...extraHeaders,
  };
  if (requestId) headers['x-github-request-id'] = nextRequestId();
  res.writeHead(status, headers);
  res.end(text);
}

/** Answer with a JSON error body: {"message": "<non-empty>"}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Lower-cased header map for a request. */
export function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

/** Bearer token from an Authorization header, or null. */
export function bearerToken(headers: Record<string, string>): string | null {
  const h = headers['authorization'] ?? '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? (m[1] as string).trim() : null;
}
