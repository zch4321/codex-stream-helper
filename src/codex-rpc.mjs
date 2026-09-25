import { spawn, execFile } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const READ_METHODS = new Set(['thread/read', 'thread/list']);

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function findCodex(env = process.env) {
  if (env.CODEX_BINARY) {
    if (!await exists(env.CODEX_BINARY)) throw new Error('CODEX_BINARY 指向的程序不存在。');
    return env.CODEX_BINARY;
  }
  if (process.platform === 'win32') {
    // The desktop app may bundle a newer protocol than the CLI on PATH.
    try {
      const command = "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | Where-Object { $_.CommandLine -match '\\bapp-server\\b' } | Select-Object -ExpandProperty ExecutablePath -Unique";
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 8000 });
      for (const file of stdout.trim().split(/\r?\n/)) {
        if (file && await exists(file)) return file;
      }
    } catch { /* The desktop app can be closed; try its installed runtimes. */ }
    const runtimeRoot = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = await Promise.all((await readdir(runtimeRoot)).map(async name => {
        const file = path.join(runtimeRoot, name, 'codex.exe');
        try { return { file, modified: (await stat(file)).mtimeMs }; } catch { return null; }
      }));
      const newest = candidates.filter(Boolean).sort((a, b) => b.modified - a.modified)[0];
      if (newest) return newest.file;
    } catch { /* Fall back to the standalone CLI. */ }
  }
  if (process.platform === 'darwin') {
    for (const file of ['/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex']) {
      if (await exists(file)) return file;
    }
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

export class CodexRpc {
  constructor({ binary, args = ['app-server', '--listen', 'stdio://'], timeoutMs = 30000, env = process.env } = {}) {
    this.binary = binary;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.pending = new Map();
    this.nextId = 0;
    this.child = null;
    this.starting = null;
    this.version = null;
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error('连接已关闭。');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.launch();
    try { await this.starting; } finally { this.starting = null; }
  }

  async launch() {
    this.binary ||= await findCodex(this.env);
    const child = spawn(this.binary, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env,
    });
    this.child = child;
    child.stderr.resume(); // Never mirror stderr or tool output into the captions.
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'Codex 返回了错误。');
        error.code = message.error.code;
        request.reject(error);
      } else request.resolve(message.result);
    });
    const disconnected = error => {
      if (this.child !== child) return;
      this.child = null;
      lines.close();
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
    };
    child.on('error', error => disconnected(new Error(`无法启动 Codex：${error.message}`)));
    child.on('exit', () => disconnected(new Error('Codex 读取服务已断开，将自动重新连接。')));
    child.stdin.on('error', error => disconnected(new Error(`Codex 连接已断开：${error.message}`)));
    try {
      const info = await this.send('initialize', { clientInfo: { name: 'codex_stream_helper', title: 'Codex Stream Helper', version: '0.1.0' } });
      this.version = info?.userAgent || null;
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    } catch (error) {
      child.kill();
      disconnected(error);
      throw error;
    }
  }

  send(method, params) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Codex 尚未连接。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('读取 Codex 超时。可以稍后重试，或检查后端版本是否匹配。'));
        // Only terminate our own read-only child; the desktop process is separate.
        child.kill();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }

  async request(method, params) {
    if (!READ_METHODS.has(method)) throw new Error(`不允许调用非读取接口：${method}`);
    await this.start();
    return this.send(method, params);
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 1500); timer.unref(); }),
    ]);
  }
}
