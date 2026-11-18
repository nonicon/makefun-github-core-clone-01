// Tiny test server for the REST module: dispatches only to handleRest.
// Run: node --experimental-strip-types test-server.ts [port]
// The server prints the bound port on stdout, then serves until killed.
import { createServer } from 'node:http';
import { Store } from './src/store.ts';
import { handleRest, type Ctx } from './src/rest.ts';
import { bearerToken, lowerHeaders, readBody } from './src/util.ts';

const store = new Store();
const port = Number(process.argv[2] ?? '0');

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const body = await readBody(req);
    const headers = lowerHeaders(req);
    const ctx: Ctx = {
      store,
      method: req.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      headers,
      body,
      token: bearerToken(headers),
    };
    const handled = await handleRest(ctx, res);
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: String(err) }));
    }
  }
});

server.listen(port, () => {
  const addr = server.address();
  const p = typeof addr === 'object' && addr !== null ? addr.port : port;
  process.stdout.write(`listening ${p}\n`);
});
