// The entry's HTTP server: routes every request to the module that owns it.
// One Store per process, shared by git, REST, GraphQL and MCP.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type Ctx } from './src/rest.ts';
import { Store } from './src/store.ts';
import { bearerToken, lowerHeaders, readBody, sendError, sendJson } from './src/util.ts';

function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
    return { path, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { path, query } = parseUrl(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const headers = lowerHeaders(req);
        // GET/HEAD never carry a body in this suite; skipping the stream
        // read saves a promise + listener setup on every read-bench request.
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const ctx: Ctx = {
          store,
          method,
          path,
          query,
          headers,
          body,
          token: bearerToken(headers),
        };

        // Git smart HTTP first: /<owner>/<repo>.git/...
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGit(ctx, res)) return;
        } else if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
          if (await handleGraphql(ctx, res)) return;
        } else if (path === '/mcp' || path.startsWith('/mcp/')) {
          if (await handleMcp(ctx, res)) return;
        } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(ctx, res)) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendError(res, 404, 'Not Found');
      } catch (err) {
        // Never crash the process on a request: answer 500 JSON.
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });
}
