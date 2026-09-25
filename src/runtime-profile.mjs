import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const EFFORT_LABELS = {
  none: '无', minimal: '最低', low: '低', medium: '中', high: '高',
  xhigh: '极高', max: '最高', ultra: '极致',
};
const TIER_LABELS = { fast: '快速', priority: '快速', default: '标准', standard: '标准', auto: '自动', flex: '弹性' };
const own = (object, key) => Object.hasOwn(object || {}, key);

export function formatRuntimeProfile(thread, saved = {}) {
  const model = thread.model || saved.model || null;
  const effort = thread.reasoningEffort || saved.reasoningEffort || null;
  const tier = own(thread, 'serviceTier') ? thread.serviceTier : saved.serviceTier;
  const modelLabel = typeof model === 'string' ? model.replace(/^gpt-\d+(?:\.\d+)?-(astra|sol|luna|terra)(?:-\d{4}-\d{2}-\d{2})?$/, '$1') : '';
  const effortLabel = EFFORT_LABELS[effort] || effort || '';
  // Unknown speed stays unknown. It must never be inferred from polling latency.
  const speedLabel = tier === null ? '标准' : TIER_LABELS[tier] || (typeof tier === 'string' ? tier : '');
  return { model, reasoningEffort: effort, serviceTier: tier ?? null, label: [modelLabel, effortLabel, speedLabel].filter(Boolean).join('·') };
}

/**
 * Optional metadata adapter for versions whose thread/read omits serviceTier.
 * The app server supplies the current shard path; we never discover or merge
 * transcript shards. Only explicit settings events are parsed, never messages.
 */
export class RuntimeProfileReader {
  constructor() { this.entries = new Map(); }

  async read(thread) {
    if (own(thread, 'serviceTier') || !thread.path) return formatRuntimeProfile(thread);
    const key = `${thread.id}:${thread.path}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { offset: 0, inode: null, saved: {}, partial: '', skipping: false, decoder: new StringDecoder('utf8'), queue: Promise.resolve() };
      this.entries.set(key, entry);
      if (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value);
    }
    const operation = entry.queue.catch(() => {}).then(() => this.readNewRecords(thread, entry));
    entry.queue = operation;
    try { await operation; return formatRuntimeProfile(thread, entry.saved); }
    catch { return formatRuntimeProfile(thread); } // Optional metadata cannot interrupt captions.
  }

  async readNewRecords(thread, entry) {
    const file = await open(thread.path, 'r');
    try {
      const info = await file.stat();
      if (entry.inode !== info.ino || info.size < entry.offset) {
        Object.assign(entry, { offset: 0, inode: info.ino, saved: {}, partial: '', skipping: false, decoder: new StringDecoder('utf8') });
      }
      const buffer = Buffer.alloc(64 * 1024);
      while (entry.offset < info.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - entry.offset), entry.offset);
        if (!bytesRead) break;
        entry.offset += bytesRead;
        const pieces = entry.decoder.write(buffer.subarray(0, bytesRead)).split('\n');
        for (let index = 0; index < pieces.length; index++) {
          const complete = index < pieces.length - 1;
          if (!entry.skipping) {
            entry.partial += pieces[index];
            // Large tool/prompt records are irrelevant to the metadata adapter.
            if (entry.partial.length > 256 * 1024) { entry.partial = ''; entry.skipping = true; }
          }
          if (complete) {
            if (!entry.skipping) this.consume(entry.partial, thread.id, entry);
            entry.partial = ''; entry.skipping = false;
          }
        }
      }
    } finally { await file.close(); }
  }

  consume(line, threadId, entry) {
    if (!line.includes('thread_settings_applied')) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const event = record.payload;
    if (record.type !== 'event_msg' || event?.type !== 'thread_settings_applied' || event.thread_id !== threadId) return;
    const settings = event.thread_settings;
    if (!settings || typeof settings !== 'object') return;
    if (typeof settings.model === 'string') entry.saved.model = settings.model;
    if (typeof settings.reasoning_effort === 'string') entry.saved.reasoningEffort = settings.reasoning_effort;
    if (own(settings, 'service_tier') && (settings.service_tier === null || typeof settings.service_tier === 'string')) entry.saved.serviceTier = settings.service_tier;
  }
}
