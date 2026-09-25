import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMessages, visibleMessages, validateSettings, DEFAULT_SETTINGS } from '../src/messages.mjs';

test('only assistant display messages cross the output boundary', () => {
  const thread = { turns: [{ id: 'turn', items: [
    { id: 'secret', type: 'reasoning', text: 'not for captions' },
    { id: 'prompt', type: 'userMessage', text: 'private prompt' },
    { id: 'tool', type: 'commandExecution', text: 'tool output' },
    { id: 'hidden', type: 'agentMessage', phase: 'analysis', text: 'hidden content' },
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Working' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done' },
  ] }] };
  const messages = extractMessages(thread);
  assert.deepEqual(messages.map(message => message.id), ['progress', 'final']);
  assert.deepEqual(visibleMessages(messages, { ...DEFAULT_SETTINGS, showProgress: false }).map(message => message.id), ['final']);
  assert.deepEqual(visibleMessages(messages, DEFAULT_SETTINGS, new Set(['progress', 'final'])), []);
});

test('invalid settings cannot reach output CSS or inject unknown properties', () => {
  for (const bad of [{ accent: 'red;position:fixed' }, { fontSize: 10000 }, { theme: 'html' }, { showProgress: 'false' }, { unrelated: true }]) {
    assert.throws(() => validateSettings(bad));
  }
  assert.equal(validateSettings({ maxMessages: 1 }).maxMessages, 1);
});
