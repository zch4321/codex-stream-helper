const captions = document.querySelector('#captions');
let lastSignature = '';

// A small, text-only Markdown presentation. No HTML, external images, or scripts.
function inline(text, target) {
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]]+)\]\([^\n]*?\)/g;
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(previous, match.index)));
    if (match[1] || match[2]) {
      const element = document.createElement(match[1] ? 'strong' : 'code');
      element.textContent = match[1] || match[2]; target.append(element);
    } else target.append(document.createTextNode(match[3]));
    previous = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(previous)));
}

function renderText(text, target) {
  const pieces = text.split(/```[^\n]*\n([\s\S]*?)```/g);
  pieces.forEach((piece, index) => {
    if (index % 2) {
      const code = document.createElement('span'); code.className = 'caption-code'; code.textContent = piece.trimEnd(); target.append(code);
    } else inline(piece.replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '• '), target);
  });
}

export function render(state) {
  const settings = state.settings;
  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--panel-opacity', settings.opacity / 100);
  captions.dataset.theme = settings.theme;
  const profileLabel = state.runtimeProfile?.label || '';
  const signature = JSON.stringify([state.messages, settings.showLabel, profileLabel]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  const existing = new Map([...captions.children].map(element => [element.dataset.id, element]));
  const children = state.messages.map(message => {
    const key = `${message.id}:${settings.showLabel}:${profileLabel}`;
    if (existing.has(key) && existing.get(key).dataset.text === message.text) return existing.get(key);
    const article = document.createElement('article'); article.className = 'caption'; article.dataset.id = key; article.dataset.text = message.text;
    if (settings.showLabel) {
      const label = document.createElement('div'); label.className = 'caption-label'; label.append(document.createTextNode('CODEX'));
      if (profileLabel) {
        const profile = document.createElement('span'); profile.className = 'caption-profile'; profile.textContent = profileLabel; profile.title = '当前任务设置'; label.append(profile);
      }
      const phase = document.createElement('span'); phase.className = 'caption-phase'; phase.textContent = message.phase === 'commentary' ? '进度' : '回答'; label.append(phase); article.append(label);
    }
    const text = document.createElement('div'); text.className = 'caption-text'; renderText(message.text, text); article.append(text);
    return article;
  });
  captions.replaceChildren(...children);
  requestAnimationFrame(() => {
    for (const element of captions.querySelectorAll('.caption-text')) element.scrollTop = element.scrollHeight;
  });
}

const events = new EventSource('/api/events?view=overlay');
events.addEventListener('state', event => {
  try { render(JSON.parse(event.data)); } catch { /* Retain the last good frame during reconnect. */ }
});
window.addEventListener('pagehide', () => events.close());
