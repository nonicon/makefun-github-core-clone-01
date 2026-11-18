import { createApp } from './app.ts';
const port = Number(process.env.PORT ?? '18080');
const server = createApp();
server.listen(port, () => process.stdout.write(`[app] listening on ${port}\n`));
