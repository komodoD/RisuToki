'use strict';

const panelType = window.popoutAPI.getType();
const root = document.getElementById('popout-root');

if (panelType === 'terminal') {
  buildTerminalPopout();
} else if (panelType === 'sidebar') {
  buildSidebarPopout();
} else if (panelType === 'editor') {
  buildEditorPopout();
} else if (panelType === 'preview') {
  buildPreviewPopout();
} else if (panelType === 'refs') {
  buildRefsPopout();
}

// ==================== Terminal Popout (full TokiTalk UI) ====================

async function buildTerminalPopout() {
  // --- MomoTalk header (draggable) ---
  const header = document.createElement('div');
  header.id = 'terminal-header';
  header.className = 'popout-momo-header';
  header.innerHTML = `
    <div class="momo-header-left">
      <span class="momo-icon">💬</span>
      <span class="momo-title">TokiTalk</span>
    </div>
    <div class="momo-header-right">
      <button id="btn-rp-mode" title="RP 모드 (토키 말투)">🐰</button>
      <button id="btn-chat-mode" title="채팅 모드">💭</button>
      <button id="btn-terminal-bg" title="배경 이미지">🖼</button>
      <button id="btn-popout-dock" title="도킹 (복원)">📌</button>
      <button class="btn-close-popout" title="닫기">✕</button>
    </div>
  `;
  root.appendChild(header);

  // --- Body (avatar + terminal) ---
  const body = document.createElement('div');
  body.id = 'popout-body';

  // Avatar panel
  const avatar = document.createElement('div');
  avatar.id = 'popout-avatar';
  avatar.innerHTML = `
    <div id="popout-avatar-display">
      <img id="popout-avatar-img" src="../../assets/icon.png">
    </div>
    <div class="popout-status" id="popout-status">
      <span id="popout-status-icon">💤</span>
      <span id="popout-status-text">대기중~</span>
    </div>
  `;
  body.appendChild(avatar);

  // Terminal wrap (terminal + chat overlay)
  const termWrap = document.createElement('div');
  termWrap.id = 'popout-terminal-wrap';

  const termContainer = document.createElement('div');
  termContainer.id = 'terminal-container';
  termWrap.appendChild(termContainer);

  body.appendChild(termWrap);
  root.appendChild(body);

  // --- Wire header buttons ---
  header.querySelector('#btn-popout-dock').addEventListener('click', () => window.popoutAPI.dock());
  header.querySelector('.btn-close-popout').addEventListener('click', () => window.close());

  // --- Init terminal ---
  await initPopoutXterm(termContainer, termWrap);
}

// ==================== Xterm + Chat Mode ====================

let popoutTerm = null;
let popoutFitAddon = null;
let popoutChatMode = false;
let popoutChatMessages = [];
let popoutChatBuffer = '';
let popoutChatBufferTimer = null;
let popoutChatIsStreaming = false;
let popoutLastSentCmd = '';
let popoutIdleTimer = null;
let popoutChatWaitForInput = true;
let popoutChatMaxTimer = null;

async function initPopoutXterm(container, termWrap) {
  // Load xterm
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '../../node_modules/@xterm/xterm/css/xterm.css';
  document.head.appendChild(link);

  await loadScript('../../node_modules/@xterm/xterm/lib/xterm.js');
  await loadScript('../../node_modules/@xterm/addon-fit/lib/addon-fit.js');

  const Terminal = window.Terminal?.Terminal || window.Terminal;
  const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;

  popoutTerm = new Terminal({
    theme: {
      background: '#ffffff', foreground: '#2a323e', cursor: '#4a8ac6',
      cursorAccent: '#ffffff', selectionBackground: '#b3d4fc', selectionForeground: '#1a2740',
      black: '#4b5a6f', red: '#e53935', green: '#2e7d32', yellow: '#e65100',
      blue: '#3493f9', magenta: '#8e24aa', cyan: '#00838f', white: '#87929e',
      brightBlack: '#68788f', brightRed: '#fc96ab', brightGreen: '#66bb6a',
      brightYellow: '#ffb342', brightBlue: '#4a8ac6', brightMagenta: '#ba68c8',
      brightCyan: '#4dd0e1', brightWhite: '#ffffff'
    },
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true
  });

  popoutFitAddon = new FitAddon();
  popoutTerm.loadAddon(popoutFitAddon);
  popoutTerm.open(container);

  await new Promise(r => setTimeout(r, 50));
  popoutFitAddon.fit();

  // Start or resize pty
  const isRunning = await window.popoutAPI.terminalIsRunning();
  if (!isRunning) {
    await window.popoutAPI.terminalStart(popoutTerm.cols, popoutTerm.rows);
  } else {
    window.popoutAPI.terminalResize(popoutTerm.cols, popoutTerm.rows);
  }

  // Wire data
  popoutTerm.onData((data) => window.popoutAPI.terminalInput(data));

  window.popoutAPI.onTerminalData((data) => {
    popoutTerm.write(data);

    // Feed to chat if active
    if (popoutChatMode) onPopoutChatData(data);

    // Avatar active
    setPopoutActive(true);
    if (popoutIdleTimer) clearTimeout(popoutIdleTimer);
    popoutIdleTimer = setTimeout(() => setPopoutActive(false), 1500);
  });

  window.popoutAPI.onTerminalExit(() => {
    popoutTerm.writeln('\r\n[프로세스 종료]');
  });

  // Copy/Paste
  popoutTerm.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.key === 'c' && e.type === 'keydown' && popoutTerm.hasSelection()) {
      navigator.clipboard.writeText(popoutTerm.getSelection());
      popoutTerm.clearSelection();
      return false;
    }
    if (e.ctrlKey && e.key === 'v' && e.type === 'keydown') {
      navigator.clipboard.readText().then(t => { if (t) window.popoutAPI.terminalInput(t); });
      return false;
    }
    return true;
  });

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    navigator.clipboard.readText().then(t => { if (t) window.popoutAPI.terminalInput(t); });
  });

  // Resize
  const ro = new ResizeObserver(() => {
    if (popoutFitAddon && popoutTerm) {
      popoutFitAddon.fit();
      window.popoutAPI.terminalResize(popoutTerm.cols, popoutTerm.rows);
    }
  });
  ro.observe(container);

  // --- Build chat view (overlay inside termWrap) ---
  buildPopoutChatView(termWrap);

  // --- Wire RP mode button ---
  initPopoutRpMode();

  // --- Wire chat mode button ---
  document.getElementById('btn-chat-mode').addEventListener('click', togglePopoutChatMode);

  // --- Wire background button ---
  document.getElementById('btn-terminal-bg').addEventListener('click', async () => {
    // Simple: prompt-style isn't available; just toggle a subtle bg
    container.classList.toggle('has-bg');
  });
}

// ==================== RP Mode (shared via localStorage) ====================

function initPopoutRpMode() {
  const btn = document.getElementById('btn-rp-mode');
  if (!btn) return;

  let rpMode = localStorage.getItem('toki-rp-mode') === 'true';
  updatePopoutRpStyle(btn, rpMode);

  btn.addEventListener('click', () => {
    rpMode = !rpMode;
    localStorage.setItem('toki-rp-mode', rpMode);
    updatePopoutRpStyle(btn, rpMode);
  });

  // Sync when localStorage changes from main window
  window.addEventListener('storage', (e) => {
    if (e.key === 'toki-rp-mode') {
      rpMode = e.newValue === 'true';
      updatePopoutRpStyle(btn, rpMode);
    }
  });
}

function updatePopoutRpStyle(btn, active) {
  btn.style.background = active ? 'rgba(255,255,255,0.5)' : '';
  btn.title = active ? 'RP 모드 ON (토키 말투)' : 'RP 모드 OFF (토키 말투)';
}

// ==================== Avatar State ====================

const IDLE_IMG = '../../assets/icon.png';
const DANCING_IMG = '../../assets/toki_dancing.gif';

let _popoutIsActive = false;
let _poImg, _poStatus, _poIcon, _poText;
function setPopoutActive(active) {
  if (_popoutIsActive === active) return;
  if (!_poImg) {
    _poImg = document.getElementById('popout-avatar-img');
    _poStatus = document.getElementById('popout-status');
    _poIcon = document.getElementById('popout-status-icon');
    _poText = document.getElementById('popout-status-text');
  }
  if (!_poImg || !_poStatus) return;
  _popoutIsActive = active;

  if (active) {
    _poImg.src = DANCING_IMG;
    _poStatus.classList.add('working');
    _poIcon.textContent = '✨';
    _poText.textContent = '작업중~';
  } else {
    _poImg.src = IDLE_IMG;
    _poStatus.classList.remove('working');
    _poIcon.textContent = '💤';
    _poText.textContent = '대기중~';
  }
}

// ==================== Chat Mode ====================

function buildPopoutChatView(termWrap) {
  const chatView = document.createElement('div');
  chatView.id = 'chat-view';

  const chatMsgs = document.createElement('div');
  chatMsgs.id = 'chat-messages';

  const chatInputArea = document.createElement('div');
  chatInputArea.id = 'chat-input-area';

  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.id = 'chat-input';
  chatInput.placeholder = '메시지를 입력하세요...';

  const chatSendBtn = document.createElement('button');
  chatSendBtn.id = 'chat-send-btn';
  chatSendBtn.textContent = '전송';

  chatInputArea.appendChild(chatInput);
  chatInputArea.appendChild(chatSendBtn);
  chatView.appendChild(chatMsgs);
  chatView.appendChild(chatInputArea);
  termWrap.appendChild(chatView);

  chatSendBtn.addEventListener('click', popoutChatSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      popoutChatSend();
    }
  });
}

function togglePopoutChatMode() {
  popoutChatMode = !popoutChatMode;
  const termContainer = document.getElementById('terminal-container');
  const chatView = document.getElementById('chat-view');
  const btn = document.getElementById('btn-chat-mode');

  if (popoutChatMode) {
    popoutChatBuffer = '';
    popoutChatIsStreaming = false;
    popoutChatWaitForInput = true;
    if (popoutChatBufferTimer) { clearTimeout(popoutChatBufferTimer); popoutChatBufferTimer = null; }
    if (popoutChatMaxTimer) { clearTimeout(popoutChatMaxTimer); popoutChatMaxTimer = null; }

    termContainer.style.display = 'none';
    chatView.classList.add('active');
    btn.style.background = 'rgba(255,255,255,0.5)';
    document.getElementById('chat-input').focus();
  } else {
    // Toggling OFF — if streaming, finalize immediately so response isn't lost
    if (popoutChatIsStreaming) {
      finalizePopoutChat();
    }
    termContainer.style.display = '';
    chatView.classList.remove('active');
    btn.style.background = '';
    if (popoutFitAddon && popoutTerm) setTimeout(() => popoutFitAddon.fit(), 20);
  }
}

function popoutChatSend() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  if (popoutChatIsStreaming) {
    popoutChatIsStreaming = false;
    popoutChatBuffer = '';
    if (popoutChatBufferTimer) { clearTimeout(popoutChatBufferTimer); popoutChatBufferTimer = null; }
    if (popoutChatMaxTimer) { clearTimeout(popoutChatMaxTimer); popoutChatMaxTimer = null; }
  }

  popoutChatMessages.push({ type: 'user', text });
  popoutLastSentCmd = text;
  popoutChatWaitForInput = false;
  renderPopoutChat();

  window.popoutAPI.terminalInput(text);
  setTimeout(() => {
    window.popoutAPI.terminalInput('\r');
  }, 50);
}

function onPopoutChatData(rawData) {
  if (popoutChatWaitForInput) return;

  const text = stripAnsi(rawData);
  if (!text || text.trim().length < 2) return;
  if (isSpinnerNoise(text)) return;

  popoutChatBuffer += text;

  if (!popoutChatIsStreaming) {
    popoutChatIsStreaming = true;
    popoutChatMessages.push({ type: 'system', text: '' });
    renderPopoutChat();
    popoutChatMaxTimer = setTimeout(finalizePopoutChat, 4000);
  }

  if (popoutChatBufferTimer) clearTimeout(popoutChatBufferTimer);
  popoutChatBufferTimer = setTimeout(finalizePopoutChat, 1500);
}

function finalizePopoutChat() {
  if (!popoutChatIsStreaming) return;
  popoutChatIsStreaming = false;
  if (popoutChatBufferTimer) { clearTimeout(popoutChatBufferTimer); popoutChatBufferTimer = null; }
  if (popoutChatMaxTimer) { clearTimeout(popoutChatMaxTimer); popoutChatMaxTimer = null; }

  let display = popoutChatBuffer;
  if (popoutLastSentCmd) {
    const normalizedCmd = popoutLastSentCmd.replace(/\s+/g, '');
    display = display.split('\n').filter(l => {
      const clean = l.replace(/^[>❯]\s*/, '').replace(/\s+/g, '').trim();
      return clean !== normalizedCmd;
    }).join('\n');
  }
  display = cleanTuiOutput(display);

  const lastMsg = popoutChatMessages[popoutChatMessages.length - 1];
  if (lastMsg && lastMsg.type === 'system') {
    lastMsg.text = display.trim();
  }

  popoutChatBuffer = '';
  popoutLastSentCmd = '';
  popoutChatMessages = popoutChatMessages.filter(m => {
    if (!m.text.trim()) return false;
    if (m.type === 'user') return true;
    if (/[\uAC00-\uD7AF\u3130-\u318F\u4E00-\u9FFF]/.test(m.text)) return true;
    if (m.text.split('\n').some(l => l.trim().length >= 6)) return true;
    return false;
  });
  renderPopoutChat();
}

function renderPopoutChat() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';

  for (const msg of popoutChatMessages) {
    if (!msg.text && !popoutChatIsStreaming) continue;

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${msg.type}`;

    const name = document.createElement('div');
    name.className = 'chat-bubble-name';
    name.textContent = msg.type === 'user' ? 'You' : 'Toki';
    bubble.appendChild(name);

    const content = document.createElement('div');
    content.className = 'chat-bubble-text';
    content.textContent = msg.text || '...';
    bubble.appendChild(content);

    container.appendChild(bubble);

    // Detect numbered choices and render MomoTalk-style buttons (skip if already chosen)
    if (msg.type === 'system' && msg.text && !popoutChatIsStreaming && !msg._choiceMade) {
      const choices = extractPopoutChoices(msg.text);
      if (choices.length >= 2) {
        const choiceContainer = document.createElement('div');
        choiceContainer.className = 'chat-choices';
        for (const choice of choices) {
          const btn = document.createElement('button');
          btn.className = 'chat-choice-btn';
          btn.textContent = choice.label;
          btn.addEventListener('click', () => sendPopoutChoice(choice.value));
          choiceContainer.appendChild(btn);
        }
        container.appendChild(choiceContainer);
      }
    }
  }
  container.scrollTop = container.scrollHeight;
}

function extractPopoutChoices(text) {
  const lines = text.split('\n');
  const choices = [];
  for (const line of lines) {
    const stripped = line.replace(/^\s*>\s*/, '').trim();
    const m = stripped.match(/^(\d+)\s*[.)]\s*(.+)/);
    if (m) {
      choices.push({ value: m[1], label: `${m[1]}. ${m[2].trim()}` });
    }
  }
  if (choices.length < 2) return [];
  const nums = choices.map(c => parseInt(c.value, 10));
  if (nums[0] !== 1) return [];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) return [];
  }
  return choices;
}

function sendPopoutChoice(value) {
  // Remove choice buttons: find the system message and mark it, keep only selected
  for (let i = popoutChatMessages.length - 1; i >= 0; i--) {
    const m = popoutChatMessages[i];
    if (m.type === 'system' && m.text) {
      const ch = extractPopoutChoices(m.text);
      if (ch.length >= 2) {
        const selected = ch.find(c => c.value === value);
        const filtered = m.text.split('\n').filter(line => {
          const stripped = line.replace(/^\s*>\s*/, '').trim();
          return !(/^\d+\s*[.)]\s+/.test(stripped));
        }).join('\n').trim();
        m.text = filtered ? filtered + '\n\n> ' + (selected ? selected.label : value) : (selected ? selected.label : value);
        m._choiceMade = true;
        break;
      }
    }
  }
  popoutChatMessages.push({ type: 'user', text: value });
  popoutLastSentCmd = value;
  popoutChatWaitForInput = false;
  renderPopoutChat();
  window.popoutAPI.terminalInput(value);
  setTimeout(() => window.popoutAPI.terminalInput('\r'), 50);
}

// ==================== Sidebar Popout (MomoTalk style) ====================

async function buildSidebarPopout() {
  // MomoTalk-style header (blue gradient)
  const header = document.createElement('div');
  header.id = 'popout-sidebar-header';
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:18px;">📁</span>
      <span style="font-size:15px;font-weight:700;">항목</span>
    </div>
    <div class="sidebar-header-btns">
      <button id="btn-popout-dock" title="도킹 (복원)">📌</button>
      <button class="btn-close-popout" title="닫기">✕</button>
    </div>
  `;
  root.appendChild(header);

  // Wire buttons
  header.querySelector('#btn-popout-dock').addEventListener('click', () => window.popoutAPI.dock());
  header.querySelector('.btn-close-popout').addEventListener('click', () => window.close());

  // Content area
  const content = document.createElement('div');
  content.id = 'popout-sidebar-content';
  root.appendChild(content);

  // Load tree data
  const data = await window.popoutAPI.getSidebarData();
  if (!data || !data.items || data.items.length === 0) {
    content.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:13px;">파일을 먼저 열어주세요</div>';
    return;
  }

  for (const item of data.items) {
    const el = document.createElement('div');
    el.className = `tree-item${item.indent ? ' indent-' + item.indent : ''}`;

    if (item.isHeader) {
      el.style.cssText = 'color:var(--accent);font-weight:700;font-size:11px;letter-spacing:0.5px;padding:10px 8px 4px;cursor:default;text-transform:uppercase;';
    }

    if (item.icon) {
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = item.icon;
      el.appendChild(icon);
    }

    const label = document.createElement('span');
    label.textContent = item.label;
    el.appendChild(label);

    if (item.id) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        window.popoutAPI.sidebarClick(item.id);
        content.querySelectorAll('.tree-item').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
      });
    }

    content.appendChild(el);
  }
}

// ==================== Refs Popout ====================

async function buildRefsPopout() {
  // Header (blue gradient, draggable)
  const header = document.createElement('div');
  header.id = 'popout-sidebar-header';
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:18px;">📄</span>
      <span style="font-size:15px;font-weight:700;">참고자료</span>
    </div>
    <div class="sidebar-header-btns">
      <button id="btn-popout-dock" title="도킹 (복원)">📌</button>
      <button class="btn-close-popout" title="닫기">✕</button>
    </div>
  `;
  root.appendChild(header);

  header.querySelector('#btn-popout-dock').addEventListener('click', () => window.popoutAPI.dock());
  header.querySelector('.btn-close-popout').addEventListener('click', () => window.close());

  // Content area
  const content = document.createElement('div');
  content.id = 'popout-sidebar-content';
  root.appendChild(content);

  // Load data
  const data = await window.popoutAPI.getRefsData();
  if (!data) {
    content.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:13px;">데이터를 불러올 수 없습니다</div>';
    return;
  }

  // Guides folder
  if (data.guides && data.guides.length > 0) {
    const guideHeader = document.createElement('div');
    guideHeader.className = 'tree-item';
    guideHeader.style.cssText = 'color:var(--accent);font-weight:700;font-size:11px;letter-spacing:0.5px;padding:10px 8px 4px;cursor:default;text-transform:uppercase;';
    guideHeader.innerHTML = '<span class="icon">📖</span><span>가이드</span>';
    content.appendChild(guideHeader);

    for (const fileName of data.guides) {
      const el = document.createElement('div');
      el.className = 'tree-item indent-1';
      el.style.cursor = 'pointer';
      el.innerHTML = `<span class="icon">·</span><span>${fileName}</span>`;
      el.addEventListener('click', () => {
        window.popoutAPI.refsItemClick(`guide_${fileName}`);
        content.querySelectorAll('.tree-item').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
      });
      content.appendChild(el);
    }
  }

  // Reference files tree
  if (data.refs && data.refs.length > 0) {
    const refSep = document.createElement('div');
    refSep.className = 'tree-item';
    refSep.style.cssText = 'color:var(--accent);font-weight:700;font-size:11px;letter-spacing:0.5px;padding:10px 8px 4px;cursor:default;text-transform:uppercase;border-top:1px solid var(--border-color);margin-top:8px;';
    refSep.textContent = '── 참고 파일 ──';
    content.appendChild(refSep);

    for (const item of data.refs) {
      const el = document.createElement('div');
      el.className = `tree-item${item.indent ? ' indent-' + item.indent : ''}`;

      if (item.isHeader) {
        el.style.cssText = 'color:var(--accent);font-weight:700;font-size:11px;letter-spacing:0.5px;padding:10px 8px 4px;cursor:default;text-transform:uppercase;';
      }

      if (item.icon) {
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = item.icon;
        el.appendChild(icon);
      }

      const label = document.createElement('span');
      label.textContent = item.label;
      el.appendChild(label);

      if (item.id) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          window.popoutAPI.refsItemClick(item.id);
          content.querySelectorAll('.tree-item').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
        });
      }

      content.appendChild(el);
    }
  }

  if ((!data.guides || data.guides.length === 0) && (!data.refs || data.refs.length === 0)) {
    content.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:13px;">참고자료가 없습니다</div>';
  }
}

// ==================== Editor Popout ====================

async function buildEditorPopout() {
  // Header (draggable)
  const header = document.createElement('div');
  header.id = 'popout-editor-header';
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 14px;background:linear-gradient(135deg,#4a90d9 0%,#6fb3f2 100%);color:#fff;font-size:13px;font-weight:600;-webkit-app-region:drag;flex-shrink:0;';
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:16px;">✏️</span>
      <span id="popout-editor-title">에디터</span>
    </div>
    <div style="display:flex;gap:6px;-webkit-app-region:no-drag;">
      <button id="btn-editor-save" title="저장 (Ctrl+S)" style="-webkit-app-region:no-drag;background:rgba(255,255,255,0.2);border:none;color:#fff;cursor:pointer;font-size:12px;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;">💾</button>
      <button id="btn-popout-dock" title="도킹 (복원)" style="-webkit-app-region:no-drag;background:rgba(255,255,255,0.2);border:none;color:#fff;cursor:pointer;font-size:12px;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;">📌</button>
      <button class="btn-close-popout" title="닫기" style="-webkit-app-region:no-drag;background:rgba(255,255,255,0.2);border:none;color:#fff;cursor:pointer;font-size:12px;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;">✕</button>
    </div>
  `;
  root.appendChild(header);

  // Editor container
  const editorContainer = document.createElement('div');
  editorContainer.id = 'popout-editor-container';
  editorContainer.style.cssText = 'flex:1;overflow:hidden;';
  root.appendChild(editorContainer);

  // Wire buttons
  header.querySelector('#btn-popout-dock').addEventListener('click', () => window.popoutAPI.dock());
  header.querySelector('.btn-close-popout').addEventListener('click', () => window.close());
  header.querySelector('#btn-editor-save').addEventListener('click', () => window.popoutAPI.editorSave());

  // Get tab data from main process
  const data = await window.popoutAPI.getEditorData();
  if (!data) {
    editorContainer.innerHTML = '<div style="padding:16px;color:#888;font-size:13px;">탭 데이터를 불러올 수 없습니다</div>';
    return;
  }

  document.getElementById('popout-editor-title').textContent = data.label || '에디터';

  // Load Monaco
  const monacoPath = '../../node_modules/monaco-editor/min/vs';
  const loaderScript = document.createElement('script');
  loaderScript.src = `${monacoPath}/loader.js`;
  loaderScript.onload = () => {
    require.config({ paths: { vs: monacoPath } });
    require(['vs/editor/editor.main'], () => {
      // Define theme
      monaco.editor.defineTheme('blue-archive', {
        base: 'vs', inherit: true,
        rules: [
          { token: '', foreground: '2b3a52', background: 'f2f4f8' },
          { token: 'comment', foreground: '7a8ba5', fontStyle: 'italic' },
          { token: 'keyword', foreground: '4a90d9', fontStyle: 'bold' },
          { token: 'string', foreground: '2e7d32' },
          { token: 'number', foreground: 'e65100' },
          { token: 'type', foreground: '7b1fa2' },
          { token: 'function', foreground: '1565c0' },
          { token: 'variable', foreground: 'c62828' },
        ],
        colors: {
          'editor.background': '#f7f9fc',
          'editor.foreground': '#2b3a52',
          'editor.lineHighlightBackground': '#e3edf7',
          'editor.selectionBackground': '#b3d4fc',
          'editorCursor.foreground': '#4a90d9',
          'editorLineNumber.foreground': '#a0b4cc',
          'editorLineNumber.activeForeground': '#4a90d9',
        }
      });

      const editor = monaco.editor.create(editorContainer, {
        value: data.content || '',
        language: data.language || 'plaintext',
        theme: 'blue-archive',
        fontSize: 14,
        minimap: { enabled: true },
        wordWrap: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
        mouseWheelZoom: true,
        readOnly: !!data.readOnly
      });

      // Sync changes back to main window
      let changeTimer = null;
      editor.onDidChangeModelContent(() => {
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          window.popoutAPI.editorChange(data.tabId, editor.getValue());
        }, 300);
      });

      // Ctrl+S → save
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        // Send latest content first, then trigger save
        window.popoutAPI.editorChange(data.tabId, editor.getValue());
        window.popoutAPI.editorSave();
      });
    });
  };
  document.head.appendChild(loaderScript);
}

// ==================== Preview Popout ====================

async function buildPreviewPopout() {
  const charData = await window.popoutAPI.getPreviewData();
  if (!charData) {
    root.innerHTML = '<div style="padding:24px;color:#888;">프리뷰 데이터를 불러올 수 없습니다</div>';
    return;
  }

  // Load PreviewEngine
  await loadScript('preview-engine.js');

  PreviewEngine.resetVars();
  PreviewEngine.setCharName(charData.name || 'Character');
  PreviewEngine.setUserName('User');
  PreviewEngine.setDefaultVars(charData.defaultVariables || '');
  PreviewEngine.setCharDescription(charData.description || '');
  PreviewEngine.setCharFirstMessage(charData.firstMessage || '');
  PreviewEngine.setLorebook(charData.lorebook || []);

  let previewMessages = [];
  let msgIndex = 0;
  let luaInitialized = false;
  let _reloadQueued = false;

  PreviewEngine.onReloadDisplay(() => { _reloadQueued = true; });

  // ── Markdown ──
  function simpleMarkdown(text) {
    if (!text) return '';
    const htmlTags = [];
    text = text.replace(/<[^>]+>/g, (m) => { htmlTags.push(m); return `\x00HTAG${htmlTags.length - 1}\x00`; });
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');
    text = text.replace(/\u201C([^\u201D]+)\u201D/g, '<span style="color:var(--FontColorQuote2)">\u201C$1\u201D</span>');
    text = text.replace(/(?:^|(?<=[\s\n(]))\"([^"]+?)\"(?=[\s\n).,!?;:]|$)/gm, '<span style="color:var(--FontColorQuote2)">\u201C$1\u201D</span>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\n/g, '<br>');
    text = text.replace(/\x00HTAG(\d+)\x00/g, (_, i) => htmlTags[parseInt(i)]);
    return text;
  }

  function escapeHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function buildChatDoc() {
    const processedCSS = PreviewEngine.risuChatParser(charData.css || '', { runVar: true });
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data: blob:; media-src * data: blob:; connect-src * data: blob:;">
<style>
:root { --FontColorStandard:#fafafa; --FontColorBold:#e5e5e5; --FontColorItalic:#8c8d93; --FontColorItalicBold:#8c8d93; --FontColorQuote1:#8BE9FD; --FontColorQuote2:#FFB86C; --risu-theme-bgcolor:#282a36; --risu-theme-darkbg:#21222c; --risu-theme-textcolor:#f5f5f5; --risu-theme-textcolor2:#64748b; --risu-theme-borderc:#6272a4; --risu-theme-selected:#44475a; --risu-theme-draculared:#ff5555; --risu-theme-darkborderc:#4b5563; --risu-theme-darkbutton:#374151; --risu-font-family:Arial,sans-serif,serif; }
* { box-sizing:border-box;margin:0;padding:0; }
body { background:var(--risu-theme-bgcolor);color:var(--risu-theme-textcolor);font-family:var(--risu-font-family);min-height:100vh;overflow-x:hidden;overflow-y:auto; }
.background-dom { position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10; }
.background-dom * { pointer-events:auto; }
.default-chat-screen { position:relative;z-index:1;display:flex;flex-direction:column;min-height:100vh;padding:8px 0 80px; }
.risu-chat { display:flex;width:100%;max-width:100%;justify-content:center;box-sizing:border-box; }
.risu-chat-inner { display:flex;color:var(--risu-theme-textcolor);margin:4px 16px;padding:8px;flex-grow:1;align-items:flex-start;max-width:100%;width:100%;box-sizing:border-box; }
.chat-avatar { width:45px;height:45px;min-width:45px;border-radius:6px;background-color:var(--risu-theme-selected);background-size:cover;background-position:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);flex-shrink:0; }
.chat-content { display:flex;flex-direction:column;margin-left:16px;flex:1;min-width:0;overflow:hidden; }
.chat-name { font-size:1rem;font-weight:600;color:var(--risu-theme-textcolor);margin-bottom:4px; }
.flexium { display:flex;flex-direction:row;justify-content:flex-start; }
.chat-width { max-width:100%;word-break:normal;overflow-wrap:anywhere; }
.chattext { font-size:1rem;line-height:1.75;color:var(--FontColorStandard); }
.chattext p { color:var(--FontColorStandard);margin:0.25em 0; }
.chattext em { color:var(--FontColorItalic);font-style:italic; }
.chattext strong { color:var(--FontColorBold);font-weight:bold; }
.chattext img { max-width:100%;height:auto;border-radius:4px;margin:4px 0; }
.chattext code { background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:3px;font-size:0.9em; }
.chattext pre { background:rgba(0,0,0,0.3);padding:12px;border-radius:6px;overflow-x:auto;margin:8px 0; }
.chattext pre code { background:none;padding:0; }
.chattext blockquote { display:block;border-left:4px solid var(--FontColorQuote1);background:color-mix(in srgb,transparent 90%,var(--FontColorQuote1) 10%);padding:0.5rem 1rem;color:var(--FontColorQuote1);margin:4px 0; }
.cbs-button { display:inline-block;padding:6px 16px;margin:4px 2px;background:var(--risu-theme-selected);color:var(--risu-theme-textcolor);border:1px solid var(--risu-theme-borderc);border-radius:6px;cursor:pointer;font-size:0.9em;transition:background 0.15s; }
.cbs-button:hover { background:var(--risu-theme-borderc); }
::-webkit-scrollbar{width:8px} ::-webkit-scrollbar-track{background:var(--risu-theme-darkbg)} ::-webkit-scrollbar-thumb{background:var(--risu-theme-selected);border-radius:4px} ::-webkit-scrollbar-thumb:hover{background:var(--risu-theme-borderc)}
</style></head><body>
<div class="background-dom" id="bg-dom">${processedCSS}</div>
<div class="default-chat-screen" id="chat-container"></div>
<script>
function cbsClick(v,val){ window.parent.postMessage({type:'cbs-button',varName:v,value:val},'*'); }
document.addEventListener('click',function(e){
  var btn=e.target.closest('[risu-btn]');
  if(btn){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:'risu-btn',data:btn.getAttribute('risu-btn')},'*');return;}
  var trig=e.target.closest('[risu-trigger]');
  if(trig){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:'risu-trigger',name:trig.getAttribute('risu-trigger')},'*');}
});
</script></body></html>`;
  }

  async function addMessage(role, rawContent) {
    const doc = chatFrame.contentDocument;
    if (!doc) return;
    const container = doc.getElementById('chat-container');
    if (!container) return;
    const scripts = charData.regex || [];
    let content = rawContent;
    const cbsOpts = (runVar) => ({ runVar, chatID: msgIndex, messageCount: previewMessages.length + 1 });
    if (role === 'char') {
      content = PreviewEngine.processRegex(content, scripts, 'editoutput');
      if (luaInitialized) content = await PreviewEngine.runLuaTrigger('editOutput', content);
      content = PreviewEngine.risuChatParser(content, cbsOpts(true));
      content = PreviewEngine.processRegex(content, scripts, 'editdisplay');
      content = PreviewEngine.risuChatParser(content, cbsOpts(true));
      if (luaInitialized) content = await PreviewEngine.runLuaTrigger('editDisplay', content);
      content = PreviewEngine.risuChatParser(content, cbsOpts(false));
    } else {
      content = PreviewEngine.processRegex(content, scripts, 'editinput');
      if (luaInitialized) content = await PreviewEngine.runLuaTrigger('editInput', content);
      content = PreviewEngine.risuChatParser(content, cbsOpts(true));
    }
    content = simpleMarkdown(content);
    content = PreviewEngine.resolveAssetImages(content);
    const idx = msgIndex++;
    const wrapper = doc.createElement('div');
    wrapper.className = 'chat-message-container';
    wrapper.setAttribute('x-hashed', String(idx));
    const name = role === 'char' ? charData.name : 'User';
    const avatarBg = role === 'char' ? 'var(--risu-theme-selected)' : 'var(--risu-theme-borderc)';
    wrapper.innerHTML = `<div class="risu-chat" data-chat-index="${idx}"><div class="risu-chat-inner"><div class="chat-avatar" style="background-color:${avatarBg}"></div><span class="chat-content"><div class="flexium items-center chat-width"><div class="chat-width chat-name">${escapeHtml(name)}</div></div><span class="chattext chat-width prose">${content}</span></span></div></div>`;
    container.appendChild(wrapper);
    previewMessages.push({ role, content: rawContent });
    doc.documentElement.scrollTop = doc.documentElement.scrollHeight;
  }

  function refreshBackground() {
    const doc = chatFrame.contentDocument;
    if (!doc) return;
    const bgDom = doc.getElementById('bg-dom');
    if (bgDom) {
      let processed = PreviewEngine.risuChatParser(charData.css || '', { runVar: true });
      const luaHTML = PreviewEngine.getLuaOutputHTML();
      if (luaHTML) {
        let parsedLuaHTML = PreviewEngine.risuChatParser(luaHTML, { runVar: true });
        parsedLuaHTML = PreviewEngine.resolveAssetImages(parsedLuaHTML);
        processed += parsedLuaHTML;
      }
      bgDom.innerHTML = processed;
    }
  }

  async function handleSend() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    chatInput.style.height = 'auto';
    await addMessage('user', text);
    if (luaInitialized) { try { await PreviewEngine.runLuaTrigger('input', text); } catch (e) {} }
    let response;
    if (charData.firstMessage && previewMessages.length <= 2) { response = charData.firstMessage; }
    else { response = `${charData.name}: "${text}"에 대한 응답입니다.`; }
    if (luaInitialized) { try { await PreviewEngine.runLuaTrigger('output', response); } catch (e) {} }
    await addMessage('char', response);
    refreshBackground();
  }

  async function reRenderMessages() {
    const doc = chatFrame.contentDocument;
    if (!doc) return;
    const container = doc.getElementById('chat-container');
    if (!container) return;
    container.innerHTML = '';
    const saved = [...previewMessages];
    previewMessages = [];
    msgIndex = 0;
    for (const msg of saved) await addMessage(msg.role, msg.content);
    refreshBackground();
  }

  function onMessage(e) {
    if (!e.data) return;
    if (e.data.type === 'cbs-button') {
      PreviewEngine.setChatVar(e.data.varName, e.data.value);
      reRenderMessages();
    } else if (e.data.type === 'risu-btn') {
      (async () => {
        _reloadQueued = false;
        if (luaInitialized) { try { await PreviewEngine.runLuaTrigger('manual', null); } catch (e) {} }
        await reRenderMessages();
        _reloadQueued = false;
      })();
    } else if (e.data.type === 'risu-trigger') {
      (async () => {
        _reloadQueued = false;
        if (luaInitialized) { try { await PreviewEngine.runLuaTriggerByName(e.data.name); } catch (e) {} }
        await reRenderMessages();
        _reloadQueued = false;
      })();
    }
  }
  window.addEventListener('message', onMessage);

  // ── Build UI ──
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#21222c;color:#f5f5f5;font-weight:600;font-size:13px;flex-shrink:0;border-bottom:1px solid #44475a;-webkit-app-region:drag;';
  const headerLeft = document.createElement('span');
  headerLeft.textContent = `${charData.name} — 프리뷰`;
  headerLeft.style.cssText = '-webkit-app-region:drag;';
  const headerBtns = document.createElement('div');
  headerBtns.style.cssText = 'display:flex;gap:4px;align-items:center;-webkit-app-region:no-drag;';

  const resetBtn = document.createElement('button');
  resetBtn.textContent = '↻';
  resetBtn.title = '초기화';
  resetBtn.style.cssText = 'background:rgba(255,255,255,0.1);border:none;color:#f5f5f5;font-size:14px;cursor:pointer;border-radius:4px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;';
  resetBtn.addEventListener('click', async () => {
    PreviewEngine.resetVars();
    PreviewEngine.setDefaultVars(charData.defaultVariables);
    PreviewEngine.setCharDescription(charData.description);
    PreviewEngine.setCharFirstMessage(charData.firstMessage);
    previewMessages = [];
    msgIndex = 0;
    const doc = chatFrame.contentDocument;
    if (doc) {
      doc.open(); doc.write(buildChatDoc()); doc.close();
      if (charData.lua) {
        luaInitialized = await PreviewEngine.initLua(charData.lua);
        if (luaInitialized) { try { await PreviewEngine.runLuaTrigger('start', null); } catch(e) {} }
      }
      if (charData.firstMessage) await addMessage('char', charData.firstMessage);
      refreshBackground();
    }
  });

  // Debug toggle button
  const debugBtn = document.createElement('button');
  debugBtn.textContent = '🔧';
  debugBtn.title = '디버그 패널';
  debugBtn.style.cssText = resetBtn.style.cssText;
  let debugOpen = false;

  const dockBtn = document.createElement('button');
  dockBtn.textContent = '📌';
  dockBtn.title = '메인 창으로 도킹';
  dockBtn.style.cssText = resetBtn.style.cssText;
  dockBtn.addEventListener('click', () => window.popoutAPI.dock());

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = '닫기';
  closeBtn.style.cssText = resetBtn.style.cssText;
  closeBtn.addEventListener('click', () => window.close());

  headerBtns.appendChild(resetBtn);
  headerBtns.appendChild(debugBtn);
  headerBtns.appendChild(dockBtn);
  headerBtns.appendChild(closeBtn);
  header.appendChild(headerLeft);
  header.appendChild(headerBtns);

  const chatFrame = document.createElement('iframe');
  chatFrame.style.cssText = 'flex:1;width:100%;border:none;background:#282a36;min-height:0;';

  const inputBar = document.createElement('div');
  inputBar.style.cssText = 'display:flex;gap:6px;padding:8px 12px;background:#21222c;border-top:1px solid #44475a;flex-shrink:0;align-items:flex-end;';
  const chatInput = document.createElement('textarea');
  chatInput.placeholder = '메시지를 입력하세요...';
  chatInput.rows = 1;
  chatInput.style.cssText = 'flex:1;padding:8px 12px;border:1px solid #44475a;border-radius:8px;background:#282a36;color:#f5f5f5;font-size:13px;resize:none;outline:none;max-height:120px;font-family:inherit;';
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });
  chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'; });
  const sendBtn = document.createElement('button');
  sendBtn.textContent = '전송';
  sendBtn.style.cssText = 'padding:8px 16px;background:#4a90d9;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:13px;white-space:nowrap;';
  sendBtn.addEventListener('click', handleSend);
  inputBar.appendChild(chatInput);
  inputBar.appendChild(sendBtn);

  // ── Debug drawer ──
  function escapeHtmlDbg(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  const debugDrawer = document.createElement('div');
  debugDrawer.style.cssText = 'border-top:1px solid #44475a;background:#1c2340;height:220px;display:none;flex-direction:column;flex-shrink:0;overflow:hidden;';

  const debugTabs = document.createElement('div');
  debugTabs.style.cssText = 'display:flex;gap:2px;padding:4px 8px;background:#161b33;border-bottom:1px solid #44475a;flex-shrink:0;align-items:center;';
  let activeDebugTab = 'variables';
  const tabDefs = [
    { id: 'variables', label: '변수' },
    { id: 'lorebook', label: '로어북' },
    { id: 'lua', label: 'Lua' },
    { id: 'regex', label: '정규식' },
  ];
  const tabBtnStyle = 'padding:3px 10px;border:none;border-radius:4px;font-size:11px;cursor:pointer;color:#aaa;background:transparent;';
  const tabBtnActiveStyle = 'padding:3px 10px;border:none;border-radius:4px;font-size:11px;cursor:pointer;color:#fff;background:#44475a;';
  for (const td of tabDefs) {
    const tab = document.createElement('button');
    tab.style.cssText = td.id === activeDebugTab ? tabBtnActiveStyle : tabBtnStyle;
    tab.textContent = td.label;
    tab.addEventListener('click', () => {
      activeDebugTab = td.id;
      debugTabs.querySelectorAll('button').forEach(t => { if (t.dataset.debugTab) t.style.cssText = tabBtnStyle; });
      tab.style.cssText = tabBtnActiveStyle;
      updateDebugContent();
    });
    tab.dataset.debugTab = td.id;
    debugTabs.appendChild(tab);
  }

  const debugContentEl = document.createElement('div');
  debugContentEl.style.cssText = 'flex:1;overflow-y:auto;padding:6px 10px;font-size:11px;color:#ccc;';
  debugDrawer.appendChild(debugTabs);
  debugDrawer.appendChild(debugContentEl);

  function updateDebugContent() {
    debugContentEl.innerHTML = '';
    const vars = PreviewEngine.getVariables();
    const lore = charData.lorebook || [];
    const scripts = charData.regex || [];
    const tblStyle = 'width:100%;border-collapse:collapse;font-size:11px;';
    const thStyle = 'text-align:left;padding:3px 6px;border-bottom:1px solid #44475a;color:#8be9fd;font-weight:600;';
    const tdStyle = 'padding:3px 6px;border-bottom:1px solid #2a2e4a;';

    if (activeDebugTab === 'variables') {
      const keys = Object.keys(vars);
      if (!keys.length) { debugContentEl.innerHTML = '<div style="color:#666;padding:8px;">변수 없음</div>'; return; }
      let html = `<table style="${tblStyle}"><tr><th style="${thStyle}">이름</th><th style="${thStyle}">값</th></tr>`;
      for (const k of keys) html += `<tr><td style="${tdStyle}">${escapeHtmlDbg(k)}</td><td style="${tdStyle}">${escapeHtmlDbg(String(vars[k]))}</td></tr>`;
      html += '</table>';
      debugContentEl.innerHTML = html;
    } else if (activeDebugTab === 'lorebook') {
      if (!lore.length) { debugContentEl.innerHTML = '<div style="color:#666;padding:8px;">로어북 없음</div>'; return; }
      const matches = previewMessages.length > 0 ? PreviewEngine.matchLorebook(previewMessages, lore) : [];
      const matchSet = new Set(matches.map(m => m.index));
      let html = `<table style="${tblStyle}"><tr><th style="${thStyle}">#</th><th style="${thStyle}">이름</th><th style="${thStyle}">키</th><th style="${thStyle}">상태</th></tr>`;
      for (let i = 0; i < lore.length; i++) {
        const e = lore[i]; if (e.mode === 'folder') continue;
        const active = matchSet.has(i);
        const match = matches.find(m => m.index === i);
        const bg = active ? 'background:rgba(76,175,80,0.1);' : '';
        html += `<tr style="${bg}"><td style="${tdStyle}">${i}</td><td style="${tdStyle}">${escapeHtmlDbg(e.comment||'')}</td><td style="${tdStyle}">${escapeHtmlDbg(e.key||'')}</td><td style="${tdStyle}">${
          e.alwaysActive ? '🟢 항상' : active ? '🟢 '+escapeHtmlDbg(match.reason) : e.key ? '⚫' : '⬜'
        }</td></tr>`;
      }
      html += '</table>';
      debugContentEl.innerHTML = html;
    } else if (activeDebugTab === 'lua') {
      const output = PreviewEngine.getLuaOutput();
      let html = '';
      if (!luaInitialized) {
        html += '<button id="popout-lua-init" style="margin-bottom:6px;padding:4px 12px;background:#4a90d9;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Lua 초기화</button>';
      } else {
        html += '<div style="color:#4caf50;font-size:11px;margin-bottom:4px;">✅ Lua 활성</div>';
      }
      html += `<pre style="background:#161b33;padding:8px;border-radius:4px;overflow-x:auto;font-size:11px;min-height:50px;margin:0;">${output.length ? escapeHtmlDbg(output.join('\n')) : '(출력 없음)'}</pre>`;
      debugContentEl.innerHTML = html;
      if (!luaInitialized) {
        const btn = debugContentEl.querySelector('#popout-lua-init');
        if (btn) btn.addEventListener('click', async () => {
          btn.textContent = '초기화 중...'; btn.disabled = true;
          luaInitialized = await PreviewEngine.initLua(charData.lua);
          updateDebugContent();
        });
      }
    } else if (activeDebugTab === 'regex') {
      if (!scripts.length) { debugContentEl.innerHTML = '<div style="color:#666;padding:8px;">정규식 없음</div>'; return; }
      const types = ['editinput','editoutput','editdisplay','editrequest'];
      let html = '';
      for (const type of types) {
        const filtered = scripts.filter(s => s.type === type && s.ableFlag !== false);
        if (!filtered.length) continue;
        html += `<div style="font-weight:600;color:#4a90d9;margin:4px 0 2px;font-size:11px;">${type} (${filtered.length})</div>`;
        html += `<table style="${tblStyle}"><tr><th style="${thStyle}">이름</th><th style="${thStyle}">찾기</th><th style="${thStyle}">바꾸기</th></tr>`;
        for (const s of filtered) {
          html += `<tr><td style="${tdStyle}">${escapeHtmlDbg(s.comment||'')}</td><td style="${tdStyle}"><code>${escapeHtmlDbg(s.find||s.in||'')}</code></td><td style="${tdStyle}"><code>${escapeHtmlDbg((s.replace||s.out||'').substring(0,50))}</code></td></tr>`;
        }
        html += '</table>';
      }
      debugContentEl.innerHTML = html;
    }
  }

  debugBtn.addEventListener('click', () => {
    debugOpen = !debugOpen;
    debugDrawer.style.display = debugOpen ? 'flex' : 'none';
    if (debugOpen) updateDebugContent();
  });

  // ── Debug resizer ──
  const debugResizer = document.createElement('div');
  debugResizer.style.cssText = 'height:4px;background:#44475a;cursor:ns-resize;flex-shrink:0;display:none;';
  debugResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = debugDrawer.getBoundingClientRect().height;
    const onMove = (ev) => {
      const delta = startY - ev.clientY;
      debugDrawer.style.height = Math.max(80, startH + delta) + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Sync resizer visibility with debug
  const origDebugClick = debugBtn.onclick;
  debugBtn.addEventListener('click', () => {
    debugResizer.style.display = debugOpen ? '' : 'none';
  });

  root.style.cssText = 'display:flex;flex-direction:column;height:100%;background:#282a36;';
  root.appendChild(header);
  root.appendChild(chatFrame);
  root.appendChild(inputBar);
  root.appendChild(debugResizer);
  root.appendChild(debugDrawer);

  // Initialize iframe
  requestAnimationFrame(async () => {
    const doc = chatFrame.contentDocument || chatFrame.contentWindow.document;
    doc.open(); doc.write(buildChatDoc()); doc.close();
    if (charData.lua) {
      luaInitialized = await PreviewEngine.initLua(charData.lua);
      if (luaInitialized) { try { await PreviewEngine.runLuaTrigger('start', null); } catch(e) {} refreshBackground(); }
    }
    if (charData.firstMessage) {
      setTimeout(async () => { await addMessage('char', charData.firstMessage); refreshBackground(); }, 50);
    }
  });
}

// ==================== Shared Helpers ====================

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function stripAnsi(str) {
  return str
    // OSC sequences (title changes, hyperlinks) — MUST be first
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // Small cursor forward (1-2 cols) → space (word spacing in TUI)
    .replace(/\x1B\[[012]?C/g, ' ')
    // Other cursor moves → newline
    .replace(/\x1B\[\d*[ABDEFGHJKSTfn]/g, '\n')
    .replace(/\x1B\[\d+;\d+[Hf]/g, '\n')
    // Larger cursor forward (3+) → newline
    .replace(/\x1B\[\d+C/g, '\n')
    .replace(/\x1B\[\d*[JK]/g, '\n')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-_]/g, '')
    .replace(/\x1B[^a-zA-Z\n]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

function isSpinnerNoise(text) {
  const compact = text.replace(/[\s\n\r]/g, '');
  if (compact.length === 0) return true;
  const core = compact.replace(/[·✻✳✢✶✽✾✿*●○⊙❯❮►◄▶◀─━═╭╮╰╯│┃]/g, '');
  if (core.length === 0) return true;
  if (/^[A-Z][a-z]+…$/.test(core)) return true;
  if (/^[A-Z][a-z]+…?\s*\(thinking\)$/.test(core)) return true;
  if (/^\(thinking\)$/.test(core)) return true;
  if (/^[A-Za-z…]+$/.test(core) && core.length <= 8) return true;
  if (/^(esc|interrupt|Cursor)$/.test(core)) return true;
  return false;
}

function cleanTuiOutput(text) {
  // Detect Claude Code welcome screen — require ASCII art block chars as primary marker
  const hasAsciiArt = text.includes('▟█▙') || text.includes('▛▜') || text.includes('█▙');
  const hasWelcomeText = text.includes('Welcome') && text.includes('Claude');
  const isWelcomeScreen = hasAsciiArt || (hasWelcomeText && text.length > 200);

  if (isWelcomeScreen) {
    const modelMatch = text.match(/(Opus|Sonnet|Haiku)\s*[\d.]+/i);
    const pathMatch = text.match(/~[\/\\][^\s│╯╰\n]+|[A-Z]:\\[^\s│╯╰\n]+/);
    const emailMatch = text.match(/[\w.+-]+@[\w.-]+/);
    let clean = '--- Claude Code ---';
    if (modelMatch) clean += `\n${modelMatch[0]}`;
    if (emailMatch) clean += ` (${emailMatch[0]})`;
    if (pathMatch) clean += `\n${pathMatch[0].trim()}`;
    clean += '\n준비 완료!';
    return clean;
  }

  // General TUI cleanup
  let cleaned = text
    // Text-level noise removal (before line splitting)
    .replace(/esc\s+to\s+interrupt/gi, '')
    .replace(/\(thinking\)/g, '')
    // Remove box-drawing characters (including ⎿ Claude Code tree prefix)
    .replace(/[╭╮╰╯┌┐└┘├┤┬┴┼│─║═╔╗╚╝╠╣╦╩╬╟╢╤╧╪┃━┏┓┗┛┣┫┳┻╋⎿⎾⎡⎤⎣⎦]/g, '')
    // Remove block/braille characters (ASCII art / logos)
    .replace(/[▟▙▐▛▜▌▝█▘░▒▓▀▄▐▌✻✳⠀-⣿]/g, '')
    // Remove spinner/decoration (● KEPT as response marker, * added)
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·✢✶✽✾✿○◉⊙*]/g, '')
    // Prompt markers → >
    .replace(/[❯❮►◄▶◀]/g, '>')
    .replace(/ {3,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  // Filter lines: remove Claude Code TUI noise
  cleaned = cleaned.split('\n').map(l => l.trim()).filter((l, i, arr) => {
    if (i === 0 && l === '') return false;
    if (l === '' && i > 0 && arr[i - 1] === '') return false;
    if (/^>?\s*$/.test(l)) return false;
    // Short ASCII-only fragments (spinner animation: "dl", "ng", "ra sm", "fu in")
    if (/^[a-zA-Z]{1,2}$/.test(l)) return false;
    if (/^[a-zA-Z\s]+$/.test(l) && l.replace(/\s/g, '').length <= 5) return false;
    // Spinner words with … or ... (Germinating..., Billowing…, ciphering…, etc.)
    if (/^[a-zA-Z]+(…|\.{2,})\s*>?\s*$/.test(l)) return false;
    if (/^(Billowing|Thinking|Processing|Warming|Spinning|Bouncing|Crystallizing|Pondering|Meditating|Coalescing|Germinating)[.…]*\s*$/i.test(l)) return false;
    // Claude Code TUI hints/chrome
    if (/ctrl\+[a-z]/i.test(l) && l.length < 80) return false;
    if (/^\?.*shortcuts/i.test(l)) return false;
    if (/for shortcuts/.test(l)) return false;
    if (/Notepad\.exe/i.test(l)) return false;
    if (/^Try\s+"/.test(l)) return false;
    if (/^Tip:/i.test(l)) return false;
    if (/Tip:\s*You have/i.test(l)) return false;
    if (/\/passes\s*$/i.test(l)) return false;
    // MCP tool invocation/result lines
    if (/\(MCP\)/i.test(l)) return false;
    if (/^risutoki\s*-\s*/i.test(l)) return false;
    // Spinner words mixed with other content (e.g. "Tinkering... ⎿  Tip:")
    if (/^[A-Z][a-z]+(ing|ling|ting|ring)(…|\.{2,})/i.test(l)) return false;
    // JSON fragment lines (bare braces, brackets, "key": "value")
    if (/^[\[\]{},\s]*$/.test(l)) return false;
    if (/^"[^"]+"\s*:\s*(".*"|[\d\[\{])/.test(l) && l.length < 80) return false;
    if (/^"[^"]+"\s*:\s*\[?\s*$/.test(l)) return false;
    if (/Use\s+\/statusline/i.test(l)) return false;
    if (/^Run \/init/.test(l)) return false;
    if (/^Recent activity$/i.test(l)) return false;
    if (/^No recent activity$/i.test(l)) return false;
    if (/^Tips for getting started$/i.test(l)) return false;
    if (/fix lint errors/i.test(l) && l.length < 30) return false;
    if (/^0;/.test(l)) return false;
    if (/Claude Code has switched/i.test(l)) return false;
    if (/getting-started/i.test(l)) return false;
    if (/\/ide for/i.test(l)) return false;
    if (/^[-─━═~_.>*\s]+$/.test(l) && l.length > 0) return false;
    if (/^PS [A-Z]:\\/i.test(l)) return false;
    if (/aka\.ms\/PS/i.test(l)) return false;
    if (/^Windows PowerShell$/i.test(l)) return false;
    if (/^Copyright.*Microsoft/i.test(l)) return false;
    // Claude Code TUI permission/selection prompts
    if (/Would you like to proceed/i.test(l)) return false;
    if (/written up a plan/i.test(l)) return false;
    if (/ready to execute/i.test(l)) return false;
    if (/auto-accept edits/i.test(l)) return false;
    if (/manually approve edits/i.test(l)) return false;
    if (/clear context and/i.test(l)) return false;
    if (/Type here to tell Claude/i.test(l)) return false;
    if (/shift\+tab\)/i.test(l)) return false;
    if (/Enter to select/i.test(l)) return false;
    if (/Esc to cancel/i.test(l)) return false;
    if (/to navigate/i.test(l) && l.length < 50) return false;
    if (/^>\s*\d+\.\s*(Yes|No),?\s/i.test(l)) return false;
    // Lines starting with > that are Claude TUI chrome (selection options)
    if (/^>\s+\S/.test(l) && /\d\.\s+(Yes|Type|No)/i.test(l)) return false;
    // "(thought for Ns)" / "(thinking)" status lines
    if (/^\(thought\s+for\s/i.test(l)) return false;
    if (/^\(thinking\)/i.test(l)) return false;
    // □ checkbox TUI prefix (Claude Code permission prompts)
    if (/^□\s/.test(l)) return false;
    // "esc to interrupt" standalone
    if (/^esc\s+to\s+interrupt/i.test(l)) return false;
    // Cost/token usage lines
    if (/^\$[\d.]+\s+\d+k?\s+tokens?/i.test(l)) return false;
    if (/^Total cost/i.test(l)) return false;
    if (/^Total duration/i.test(l)) return false;
    // MCP tool permission prompts
    if (/^Tool use$/i.test(l)) return false;
    if (/^Do you want to proceed/i.test(l)) return false;
    if (/^Yes,?\s+and\s+don't\s+ask/i.test(l)) return false;
    if (/^\d+\.\s*Yes,?\s+(and\s+don't|allow)/i.test(l)) return false;
    if (/^Running…$/i.test(l)) return false;
    if (/^Allowed\s/i.test(l)) return false;
    return true;
  }).join('\n').trim();

  // Use ● as response marker — extract only text after the last ●
  // This cleanly separates the response from preceding noise (echo, spinner, etc.)
  if (cleaned.includes('●')) {
    const extracted = cleaned.slice(cleaned.lastIndexOf('●') + 1).trim();
    if (extracted.length > 0) cleaned = extracted;
  }
  cleaned = cleaned.replace(/●/g, '').trim();

  // Remove trailing prompt suggestions (❯/> followed by content = Claude's suggested next input)
  const lines = cleaned.split('\n');
  while (lines.length > 0 && /^>\s+\S/.test(lines[lines.length - 1])) {
    lines.pop();
  }
  cleaned = lines.join('\n').trim();

  return cleaned;
}
