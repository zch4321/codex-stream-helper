import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { CodexRpc } from './codex-rpc.mjs';
import { Broadcast } from './broadcast.mjs';
import { summarizeThread } from './messages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = new Map([
  ['/', ['index.html', 'text/html']], ['/overlay', ['overlay.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/overlay.js', ['overlay.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']], ['/overlay.css', ['overlay.css', 'text/css']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('需要 JSON 请求。');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('请求格式无效。');
  return result;
}

export async function createApplication({ rpc = new CodexRpc(), stateFile = path.join(ROOT, '.local', 'settings.json'), intervalMs = 1800 } = {}) {
  const broadcast = new Broadcast(rpc, { stateFile, intervalMs });
  await broadcast.load();
  const streams = new Set();
  const server = http.createServer(async (request, response) => {
    const actualPort = server.address()?.port;
    const allowed = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    let origin;
    try { origin = request.headers.origin && new URL(request.headers.origin); } catch { origin = { host: '' }; }
    if (!allowed.has(request.headers.host) || (origin && (origin.protocol !== 'http:' || !allowed.has(origin.host))) || request.headers['sec-fetch-site'] === 'cross-site') {
      return json(response, 403, { error: '只接受本机页面的请求。' });
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === 'GET' && ASSETS.has(url.pathname)) {
        const [file, type] = ASSETS.get(url.pathname);
        const data = await readFile(path.join(ROOT, 'public', file));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return response.end(data);
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, broadcast.snapshot());
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json(response, 200, { ...broadcast.health, binary: rpc.binary, version: rpc.version, mode: 'read-only-snapshots' });
      }
      if (request.method === 'GET' && url.pathname === '/api/threads') {
        const search = (url.searchParams.get('q') || '').trim().slice(0, 200);
        const params = { limit: 30, sortKey: 'updated_at', sortDirection: 'desc', archived: false, sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'] };
        if (search) params.searchTerm = search;
        const cursor = url.searchParams.get('cursor');
        if (cursor) params.cursor = cursor.slice(0, 2048);
        const result = await rpc.request('thread/list', params);
        // Some desktop backends return both live and persisted rows for one ID.
        const unique = new Map();
        for (const thread of result.data || []) {
          if (!unique.has(thread.id)) unique.set(thread.id, summarizeThread(thread));
        }
        return json(response, 200, { data: [...unique.values()], nextCursor: result.nextCursor || null });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
        response.write('retry: 2000\n\n');
        const outputOnly = url.searchParams.get('view') === 'overlay';
        const send = state => {
          const value = outputOnly ? { settings: state.settings, messages: state.messages, paused: state.paused, runtimeProfile: state.runtimeProfile } : state;
          if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
          response.write(`event: state\ndata: ${JSON.stringify(value)}\n\n`);
        };
        send(broadcast.snapshot());
        broadcast.on('state', send);
        streams.add(response);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
        request.on('close', () => { clearInterval(heartbeat); broadcast.off('state', send); streams.delete(response); });
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        const input = await body(request);
        if (url.pathname === '/api/select') {
          if (typeof input.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.threadId)) throw new Error('任务 ID 无效。');
          await broadcast.select(input.threadId);
        } else if (url.pathname === '/api/settings') await broadcast.updateSettings(input);
        else if (url.pathname === '/api/pause') await broadcast.pause(input.paused);
        else if (url.pathname === '/api/clear') await broadcast.clear();
        else return json(response, 404, { error: '接口不存在。' });
        return json(response, 200, broadcast.snapshot());
      }
      return json(response, 404, { error: '页面不存在。' });
    } catch (error) {
      return json(response, request.method === 'POST' ? 400 : 503, { error: error.message || '请求失败，请稍后重试。' });
    }
  });

  return {
    server, broadcast, rpc,
    async listen(port = 4318) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      broadcast.start();
      void rpc.start().then(() => {
        if (!broadcast.health.error) broadcast.health.connected = true;
        broadcast.publish();
      }).catch(error => { broadcast.health.error = error.message; broadcast.publish(); });
      return server.address();
    },
    async close() {
      broadcast.stop();
      for (const stream of streams) stream.end();
      await rpc.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4318);
  const intervalMs = Number(process.env.POLL_INTERVAL_MS || 1800);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(intervalMs) || intervalMs < 500) {
    console.error('PORT 必须是 1–65535 的整数；POLL_INTERVAL_MS 必须不小于 500。'); process.exit(1);
  }
  const app = await createApplication({ intervalMs });
  try {
    await app.listen(port);
    console.log(`Codex Stream Helper\n控制台  http://127.0.0.1:${port}/\nOBS     http://127.0.0.1:${port}/overlay`);
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请打开已有页面，或用 PORT 指定其他端口。` : error.message);
    await app.rpc.close(); process.exit(1);
  }
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
