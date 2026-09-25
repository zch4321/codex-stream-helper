const $ = selector => document.querySelector(selector);
let state = null;
let threads = [];
let nextCursor = null;
let listRequest = 0;
let toastTimer;
const DEFAULTS = { fontSize: 28, maxMessages: 3, theme: 'glass', accent: '#c4f578', opacity: 80, showProgress: true, showLabel: true };

async function api(url, input) {
  const response = await fetch(url, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}

function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
function error(message) { $('#error-banner').textContent = message; $('#error-banner').hidden = !message; }
function timeAgo(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const diff = Math.max(0, Date.now() - date.getTime());
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function renderThreads() {
  const container = $('#thread-list'); container.replaceChildren();
  $('#thread-count').textContent = `${threads.length}${nextCursor ? '+' : ''}`;
  if (!threads.length) {
    const empty = document.createElement('p'); empty.className = 'list-empty'; empty.textContent = $('#search').value ? '没有找到匹配的任务' : '暂无本机任务。也可以通过任务 ID 连接。'; container.append(empty);
  }
  for (const thread of threads) {
    const button = document.createElement('button'); button.className = `thread${state?.selected?.id === thread.id ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(state?.selected?.id === thread.id));
    button.dataset.id = thread.id; button.title = thread.name;
    button.innerHTML = '<svg aria-hidden="true"><use href="#i-chat"/></svg><span class="thread-body"><span class="thread-name"></span><span class="thread-meta"><span class="thread-folder"></span><time></time></span></span>';
    button.querySelector('.thread-name').textContent = thread.name;
    button.querySelector('.thread-folder').textContent = thread.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '本机';
    button.querySelector('time').textContent = timeAgo(thread.updatedAt);
    button.addEventListener('click', () => selectThread(thread.id, button));
    container.append(button);
  }
  $('#load-more').hidden = !nextCursor;
}

async function loadThreads(append = false) {
  const sequence = ++listRequest;
  const params = new URLSearchParams({ q: $('#search').value.trim() });
  if (append && nextCursor) params.set('cursor', nextCursor);
  $('#refresh').disabled = true; $('#load-more').disabled = true;
  try {
    const result = await api(`/api/threads?${params}`);
    if (sequence !== listRequest) return;
    if (append) {
      const unique = new Map(threads.map(thread => [thread.id, thread]));
      for (const thread of result.data) if (!unique.has(thread.id)) unique.set(thread.id, thread);
      threads = [...unique.values()];
    } else threads = result.data;
    nextCursor = result.nextCursor; renderThreads();
  } catch (err) {
    if (sequence !== listRequest) return;
    const paragraph = document.createElement('p'); paragraph.className = 'list-empty'; paragraph.textContent = '任务读取失败，请点击刷新重试。';
    if (!threads.length) $('#thread-list').replaceChildren(paragraph);
    error(err.message);
  } finally {
    if (sequence === listRequest) { $('#refresh').disabled = false; $('#load-more').disabled = false; }
  }
}

async function selectThread(id, button) {
  if (button) button.disabled = true;
  try { render(await api('/api/select', { threadId: id })); error(''); toast('已连接任务，OBS 输出已同步'); }
  catch (err) { error(err.message); }
  finally { if (button) button.disabled = false; }
}

function render(value) {
  const oldId = state?.selected?.id;
  state = value;
  const { settings, selected, paused, messages, health } = state;
  $('#connection').className = `connection ${health.connected ? 'connected' : health.error ? 'error' : ''}`;
  $('#connection span:last-child').textContent = health.connected ? '本机已连接' : health.error ? '连接异常' : '连接中';
  const badge = $('#live-badge'); badge.textContent = !selected ? '等待选择' : paused ? '已暂停' : '同步中'; badge.className = `badge ${!selected ? 'neutral' : paused ? 'paused' : ''}`;
  $('#pause').disabled = !selected; $('#clear').disabled = !selected;
  $('#pause span').textContent = paused ? '继续同步' : '暂停同步';
  $('#selected-name').textContent = selected?.name || '尚未选择任务';
  $('#selected-name').title = selected?.name || '';
  $('#preview-count').textContent = `${messages.length} 条字幕`;
  $('#preview-empty').hidden = messages.length > 0;
  $('#preview-empty h3').textContent = !selected ? '让 Codex 的回答出现在画面里' : '等待下一条消息';
  $('#preview-empty p').textContent = !selected ? '从左侧选择一个任务，即可预览字幕。' : paused ? '同步已暂停，点击「继续同步」恢复。' : '任务有新的回答后，字幕会自动出现。';
  $('#sync-info').textContent = paused ? '画面已暂停' : health.lastCheckedAt ? `${(state.pollIntervalMs / 1000).toFixed(1)} 秒同步 · ${health.latencyMs} ms` : '按消息同步';
  $('#poll-interval').textContent = `${state.pollIntervalMs / 1000} 秒`;
  if (health.error) error(health.error); else error('');
  for (const [id, key, suffix] of [['font-size', 'fontSize', ' px'], ['opacity', 'opacity', '%']]) {
    if (document.activeElement !== $(`#${id}`)) $(`#${id}`).value = settings[key];
    $(`#${id}-value`).textContent = `${$(`#${id}`).value}${suffix}`;
  }
  $('#opacity').disabled = settings.theme === 'text';
  $('#max-messages').value = settings.maxMessages;
  $('#show-progress').checked = settings.showProgress; $('#show-label').checked = settings.showLabel; $('#accent').value = settings.accent;
  for (const button of document.querySelectorAll('[data-theme]')) { const active = button.dataset.theme === settings.theme; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); }
  for (const button of document.querySelectorAll('[data-color]')) { const active = button.dataset.color === settings.accent; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); }
  if (oldId !== selected?.id) renderThreads();
}

let settingsQueue = Promise.resolve();
function setting(patch) {
  settingsQueue = settingsQueue.then(async () => render(await api('/api/settings', patch))).catch(err => error(err.message));
  return settingsQueue;
}

async function copyUrl() {
  try { await navigator.clipboard.writeText($('#overlay-url').value); toast('OBS 地址已复制'); }
  catch { $('#overlay-url').focus(); $('#overlay-url').select(); toast('请按 Ctrl+C 复制选中的地址'); }
}

$('#overlay-url').value = `${location.origin}/overlay`;
$('#copy-top').addEventListener('click', copyUrl); $('#copy-url').addEventListener('click', copyUrl);
$('#refresh').addEventListener('click', () => loadThreads()); $('#load-more').addEventListener('click', () => loadThreads(true));
let searchTimer; $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadThreads(), 250); });
$('#manual-form').addEventListener('submit', async event => { event.preventDefault(); await selectThread($('#thread-id').value.trim(), event.submitter); });
$('#pause').addEventListener('click', async () => { try { render(await api('/api/pause', { paused: !state.paused })); } catch (err) { error(err.message); } });
$('#clear').addEventListener('click', async () => { try { render(await api('/api/clear', {})); toast('字幕已清空，后续新消息会继续显示'); } catch (err) { error(err.message); } });
$('#reset-style').addEventListener('click', () => setting(DEFAULTS));
$('#font-size').addEventListener('input', event => $('#font-size-value').textContent = `${event.target.value} px`);
$('#font-size').addEventListener('change', event => setting({ fontSize: Number(event.target.value) }));
$('#opacity').addEventListener('input', event => $('#opacity-value').textContent = `${event.target.value}%`);
$('#opacity').addEventListener('change', event => setting({ opacity: Number(event.target.value) }));
$('#max-messages').addEventListener('change', event => setting({ maxMessages: Number(event.target.value) }));
$('#show-progress').addEventListener('change', event => setting({ showProgress: event.target.checked }));
$('#show-label').addEventListener('change', event => setting({ showLabel: event.target.checked }));
$('#accent').addEventListener('change', event => setting({ accent: event.target.value }));
for (const button of document.querySelectorAll('[data-theme]')) button.addEventListener('click', () => setting({ theme: button.dataset.theme }));
for (const button of document.querySelectorAll('[data-color]')) button.addEventListener('click', () => setting({ accent: button.dataset.color }));
for (const button of document.querySelectorAll('[data-bg]')) button.addEventListener('click', () => {
  $('#stage').dataset.background = button.dataset.bg;
  for (const option of document.querySelectorAll('[data-bg]')) { const active = option === button; option.classList.toggle('active', active); option.setAttribute('aria-pressed', active); }
});

const resize = new ResizeObserver(() => $('#preview').style.transform = `scale(${$('#stage').clientWidth / 1280})`);
resize.observe($('#stage'));
const events = new EventSource('/api/events');
events.addEventListener('state', event => { try { render(JSON.parse(event.data)); } catch { error('收到的状态无法显示，请刷新页面。'); } });
events.addEventListener('error', () => {
  $('#connection').className = 'connection error'; $('#connection span:last-child').textContent = '正在重连';
  error('与本地服务的连接已断开，正在自动重连。请保持启动窗口运行。');
});
$('#diagnostics').addEventListener('toggle', async () => {
  if (!$('#diagnostics').open) return;
  try { const health = await api('/api/health'); $('#backend-version').textContent = health.version || '尚未连接'; } catch { $('#backend-version').textContent = '无法读取'; }
});
window.addEventListener('pagehide', () => { events.close(); resize.disconnect(); });
void loadThreads();
