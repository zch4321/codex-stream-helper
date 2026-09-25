import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS, extractMessages, visibleMessages, validateSettings, summarizeThread } from './messages.mjs';
import { RuntimeProfileReader } from './runtime-profile.mjs';

export class Broadcast extends EventEmitter {
  constructor(rpc, { stateFile, intervalMs = 1800 } = {}) {
    super();
    this.rpc = rpc;
    this.stateFile = stateFile;
    this.intervalMs = intervalMs;
    this.settings = { ...DEFAULT_SETTINGS };
    this.selected = null;
    this.messages = [];
    this.profileReader = new RuntimeProfileReader();
    this.runtimeProfile = null;
    this.clearedIds = new Set();
    this.paused = false;
    this.health = { connected: false, lastCheckedAt: null, latencyMs: null, error: null };
    this.timer = null;
    this.revision = 0;
    this.stopped = false;
    this.persistence = Promise.resolve();
  }

  async load() {
    if (!this.stateFile) return;
    try {
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8'));
      this.settings = validateSettings(saved.settings || {});
      if (saved.selected?.id && typeof saved.selected.id === 'string') this.selected = saved.selected;
      this.paused = Boolean(saved.paused);
      this.clearedIds = new Set(Array.isArray(saved.clearedIds) ? saved.clearedIds : []);
    } catch (error) {
      if (error.code !== 'ENOENT') this.health.error = '保存的设置无法读取，已使用默认设置。';
    }
  }

  snapshot() {
    return {
      selected: this.selected, settings: this.settings, paused: this.paused,
      messages: visibleMessages(this.messages, this.settings, this.clearedIds),
      runtimeProfile: this.runtimeProfile,
      health: this.health, pollIntervalMs: this.intervalMs,
    };
  }

  publish() { this.emit('state', this.snapshot()); }

  async save() {
    if (!this.stateFile) return;
    const data = JSON.stringify({ settings: this.settings, selected: this.selected, paused: this.paused, clearedIds: [...this.clearedIds] }, null, 2);
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    await this.persistence;
  }

  async select(id) {
    const revision = ++this.revision;
    // Keep the previous selection visible if the requested task cannot be read.
    const began = Date.now();
    const { thread } = await this.rpc.request('thread/read', { threadId: id, includeTurns: true });
    if (!thread?.id) throw new Error('Codex 没有返回这个任务。');
    const profile = await this.profileReader.read(thread);
    if (this.revision !== revision) return;
    this.selected = summarizeThread(thread);
    this.messages = extractMessages(thread);
    this.runtimeProfile = profile;
    this.clearedIds.clear();
    this.paused = false;
    this.health = { connected: true, lastCheckedAt: Date.now(), latencyMs: Date.now() - began, error: null };
    await this.save(); this.publish();
  }

  async updateSettings(patch) { this.settings = validateSettings(patch, this.settings); await this.save(); this.publish(); }
  async pause(value) {
    if (typeof value !== 'boolean') throw new Error('暂停状态无效。');
    this.paused = value;
    ++this.revision;
    await this.save(); this.publish();
    if (!value) await this.poll();
  }

  async clear() {
    // Include any newly persisted messages before establishing the clear boundary.
    const id = this.selected?.id;
    if (id) {
      const { thread } = await this.rpc.request('thread/read', { threadId: id, includeTurns: true });
      const profile = await this.profileReader.read(thread);
      if (id !== this.selected?.id) return;
      const current = extractMessages(thread);
      this.messages = current;
      this.runtimeProfile = profile;
      for (const message of current) this.clearedIds.add(message.id);
    }
    ++this.revision;
    await this.save(); this.publish();
  }

  async poll() {
    if (this.polling || this.stopped || this.paused || !this.selected) return;
    this.polling = true;
    const revision = this.revision;
    const id = this.selected.id;
    const began = Date.now();
    try {
      const { thread } = await this.rpc.request('thread/read', { threadId: id, includeTurns: true });
      const profile = await this.profileReader.read(thread);
      if (revision !== this.revision || id !== this.selected?.id || this.paused) return;
      this.messages = extractMessages(thread);
      this.runtimeProfile = profile;
      this.health = { connected: true, lastCheckedAt: Date.now(), latencyMs: Date.now() - began, error: null };
    } catch (error) {
      if (revision !== this.revision) return;
      this.health = { ...this.health, connected: false, error: error.message };
    } finally { this.polling = false; }
    this.publish();
  }

  start() {
    const tick = async () => {
      await this.poll();
      if (!this.stopped) this.timer = setTimeout(tick, this.health.error ? Math.max(5000, this.intervalMs) : this.intervalMs);
    };
    void tick();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }
}
