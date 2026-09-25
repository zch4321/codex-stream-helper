import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApplication } from '../src/server.mjs';

test('HTTP selection, transparent page, SSE, and local-only mutation boundaries', async t => {
  const calls = [];
  const rpc = {
    start: async () => {}, close: async () => {},
    request: async (method, params) => {
      calls.push(method);
      if (method === 'thread/list') return { data: [{ id: 'sample', name: 'Sample' }, { id: 'sample', name: 'Older snapshot' }], nextCursor: null };
      return { thread: { id: params.threadId, name: 'Sample', turns: [{ id: 'turn', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'hello <script>bad()</script>' }] }] } };
    },
  };
  const app = await createApplication({ rpc, stateFile: null, intervalMs: 60000 });
  const address = await app.listen(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const post = (endpoint, value, extra = {}) => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
  assert.equal((await fetch(base + '/overlay')).status, 200);
  assert.match(await (await fetch(base + '/overlay.css')).text(), /background:transparent!important/);
  const listed = await (await fetch(base + '/api/threads')).json();
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].name, 'Sample');
  const selection = await post('/api/select', { threadId: 'sample' });
  assert.equal(selection.status, 200);
  assert.equal((await selection.json()).messages[0].id, 'answer');
  assert.equal((await post('/api/settings', { fontSize: 900 })).status, 400);
  assert.equal((await post('/api/pause', { paused: true }, { Origin: 'https://outside.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/state', { headers: { Host: `evil.example:${address.port}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  const stream = await fetch(base + '/api/events?view=overlay');
  const reader = stream.body.getReader();
  let data = '';
  const decoder = new TextDecoder();
  while (!/event: state\ndata: [^\n]+\n\n/.test(data)) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    data += decoder.decode(value, { stream: true });
  }
  assert.match(data, /event: state/);
  assert.doesNotMatch(data, /selected|cwd|binary/);
  await reader.cancel();
  await post('/api/clear', {});
  assert.deepEqual((await (await fetch(base + '/api/state')).json()).messages, []);
  assert.ok(calls.every(method => ['thread/list', 'thread/read'].includes(method)));
});
