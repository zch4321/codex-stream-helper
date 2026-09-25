import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../src/codex-rpc.mjs';

test('RPC frames partial lines and allows only the read interfaces', async t => {
  const rpc = new CodexRpc({ binary: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url))], timeoutMs: 1000 });
  t.after(() => rpc.close());
  const result = await rpc.request('thread/read', { threadId: 'sample' });
  assert.equal(result.thread.id, 'sample');
  assert.equal(result.thread.initialized, true);
  await assert.rejects(rpc.request('thread/resume', {}), /非读取/);
  await assert.rejects(rpc.request('turn/start', {}), /非读取/);
});
