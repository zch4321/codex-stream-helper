import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeProfileReader, formatRuntimeProfile } from '../src/runtime-profile.mjs';

const settingsEvent = (id, tier) => JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: id, thread_settings: { service_tier: tier } } });

test('profile displays actual values and never guesses a missing speed', () => {
  assert.equal(formatRuntimeProfile({ model: 'gpt-6-astra', reasoningEffort: 'xhigh', serviceTier: 'fast' }).label, 'astra·极高·快速');
  assert.equal(formatRuntimeProfile({ model: 'gpt-6-astra', reasoningEffort: 'max', serviceTier: 'default' }).label, 'astra·最高·标准');
  assert.equal(formatRuntimeProfile({ model: 'gpt-6-astra', reasoningEffort: 'max' }).label, 'astra·最高');
  assert.equal(formatRuntimeProfile({ model: 'custom-model', serviceTier: 'priority' }).label, 'custom-model·快速');
});

test('metadata follows supplied shard paths and tolerates partial writes without mixing tasks', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-stream-profile-'));
  t.after(async () => {
    await Promise.all(['one.jsonl', 'two.jsonl'].map(name => rm(path.join(directory, name), { force: true })));
    await rmdir(directory);
  });
  const file = path.join(directory, 'one.jsonl');
  const thread = { id: 'A', path: file, model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
  const reader = new RuntimeProfileReader();
  await writeFile(file, settingsEvent('A', 'default') + '\n' + settingsEvent('B', 'fast') + '\n');
  assert.equal((await reader.read(thread)).label, 'astra·极高·标准');
  const next = settingsEvent('A', 'fast');
  await appendFile(file, next.slice(0, 30));
  assert.equal((await reader.read(thread)).label, 'astra·极高·标准');
  await appendFile(file, next.slice(30) + '\n');
  assert.equal((await reader.read(thread)).label, 'astra·极高·快速');
  const newFile = path.join(directory, 'two.jsonl');
  await writeFile(newFile, settingsEvent('A', 'default') + '\n');
  assert.equal((await reader.read({ ...thread, path: newFile })).label, 'astra·极高·标准');
  assert.equal((await reader.read({ ...thread, path: path.join(directory, 'missing.jsonl') })).label, 'astra·极高');
});
