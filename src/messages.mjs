import { createHash } from 'node:crypto';

export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 28, maxMessages: 3, theme: 'glass', accent: '#c4f578',
  opacity: 80, showProgress: true, showLabel: true,
});

export function validateSettings(input, previous = DEFAULT_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('字幕设置格式无效。');
  const result = { ...previous };
  const ranges = { fontSize: [18, 56], maxMessages: [1, 5], opacity: [0, 100] };
  for (const [key, value] of Object.entries(input)) {
    if (ranges[key]) {
      if (!Number.isInteger(value) || value < ranges[key][0] || value > ranges[key][1]) throw new Error(`${key} 超出可用范围。`);
    } else if (['showProgress', 'showLabel'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值。`);
    } else if (key === 'theme') {
      if (!['glass', 'text'].includes(value)) throw new Error('未知字幕样式。');
    } else if (key === 'accent') {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('颜色格式无效。');
    } else throw new Error(`未知字幕设置：${key}`);
    result[key] = value;
  }
  return result;
}

export function extractMessages(thread) {
  const messages = [];
  const seen = new Set();
  for (const [turnIndex, turn] of (thread?.turns || []).entries()) {
    for (const [itemIndex, item] of (turn.items || []).entries()) {
      // A whitelist: reasoning, prompts, tools, and commands never leave the server.
      if (item.type !== 'agentMessage' || typeof item.text !== 'string' || !item.text.trim()) continue;
      if (item.phase && !['commentary', 'final_answer', 'final'].includes(item.phase)) continue;
      const id = item.id || createHash('sha256').update(`${turn.id || turnIndex}:${itemIndex}:${item.text}`).digest('hex');
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, turnId: turn.id || String(turnIndex), phase: item.phase === 'commentary' ? 'commentary' : 'final_answer', text: item.text });
    }
  }
  return messages;
}

export function visibleMessages(messages, settings, clearedIds = new Set()) {
  return messages.filter(message => !clearedIds.has(message.id) && (settings.showProgress || message.phase !== 'commentary')).slice(-settings.maxMessages);
}

export function summarizeThread(thread) {
  return {
    id: thread.id,
    name: thread.name?.trim() || thread.preview?.trim().slice(0, 90) || '未命名任务',
    cwd: thread.cwd || '',
    updatedAt: thread.updatedAt || thread.createdAt || 0,
    source: typeof thread.source === 'string' ? thread.source : '',
  };
}
