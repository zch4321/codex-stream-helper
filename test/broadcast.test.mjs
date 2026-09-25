import test from 'node:test';
import assert from 'node:assert/strict';
import { Broadcast } from '../src/broadcast.mjs';

const message = id => ({ type: 'agentMessage', id, text: `message ${id}`, phase: 'final_answer' });
const thread = (id, ids) => ({ thread: { id, name: id, turns: [{ id: 'turn', items: ids.map(message) }] } });

test('pause freezes captions, clear survives polling, and later new messages appear', async () => {
  let ids = ['first'];
  const calls = [];
  const rpc = { request: async (method, params) => { calls.push(method); return thread(params.threadId, ids); } };
  const broadcast = new Broadcast(rpc);
  await broadcast.select('A');
  await broadcast.pause(true);
  ids = ['first', 'second']; await broadcast.poll();
  assert.deepEqual(broadcast.snapshot().messages.map(message => message.id), ['first']);
  await broadcast.clear();
  assert.deepEqual(broadcast.snapshot().messages, []);
  await broadcast.pause(false); await broadcast.poll();
  assert.deepEqual(broadcast.snapshot().messages, []);
  ids = ['first', 'second', 'third']; await broadcast.poll();
  assert.deepEqual(broadcast.snapshot().messages.map(message => message.id), ['third']);
  assert.ok(calls.every(method => method === 'thread/read'));
});

test('a slow poll from the previous task cannot overwrite the selected task', async () => {
  let release;
  let slow = false;
  const rpc = { request: async (_method, params) => {
    if (params.threadId === 'A' && slow) return new Promise(resolve => release = resolve);
    return thread(params.threadId, [params.threadId]);
  } };
  const broadcast = new Broadcast(rpc);
  await broadcast.select('A'); slow = true;
  const pendingPoll = broadcast.poll();
  await broadcast.select('B');
  release(thread('A', ['stale'])); await pendingPoll;
  assert.equal(broadcast.snapshot().selected.id, 'B');
  assert.deepEqual(broadcast.snapshot().messages.map(message => message.id), ['B']);
});

test('a failed selection leaves the previous task intact', async () => {
  const rpc = { request: async (_method, params) => { if (params.threadId === 'bad') throw new Error('missing'); return thread('A', ['A']); } };
  const broadcast = new Broadcast(rpc); await broadcast.select('A');
  await assert.rejects(broadcast.select('bad'));
  assert.equal(broadcast.snapshot().selected.id, 'A');
});
