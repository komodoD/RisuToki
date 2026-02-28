'use strict';

// ==================== State ====================
let fileData = null;       // Current charx data
let openTabs = [];         // { id, label, language, getValue, setValue }
let activeTabId = null;
let editorInstance = null;  // Monaco editor instance
let monacoReady = false;
let dirtyFields = new Set();

// Lua section management
let luaSections = []; // [{ name, content }]

// Reference files (read-only)
let referenceFiles = []; // [{ fileName, data }]

// Backup store
const MAX_BACKUPS = 20;
const backupStore = {}; // { tabId: [{ time, content }] }

// RP mode: 'off' | 'toki' | 'aris' | 'custom'
// Migrate old boolean value
let rpMode = (() => {
  const v = localStorage.getItem('toki-rp-mode');
  if (v === 'true') return darkMode ? 'aris' : 'toki'; // migrate old boolean
  if (v === 'toki' || v === 'aris' || v === 'custom') return v;
  return 'off';
})();
let rpCustomText = localStorage.getItem('toki-rp-custom') || '';

// Form editor mini-Monaco instances (lorebook/regex)
let formEditors = [];

// Dark mode (Risu theme)
let darkMode = localStorage.getItem('toki-dark-mode') === 'true';

// BGM state
let bgmEnabled = localStorage.getItem('toki-bgm-enabled') === 'true';
let bgmAudio = null;
let bgmFilePath = localStorage.getItem('toki-bgm-path') || '../../assets/Usagi_Flap.mp3';
let bgmSilenceTimer = null;
const BGM_SILENCE_MS = 3000; // pause after 3s of silence
let bgmBurstCount = 0;
let bgmBurstTimer = null;
const BGM_BURST_THRESHOLD = 3;  // need 3+ data events within window to start
const BGM_BURST_WINDOW = 500;   // ms

// Autosave state
let autosaveEnabled = localStorage.getItem('toki-autosave') === 'true';
let autosaveInterval = parseInt(localStorage.getItem('toki-autosave-interval'), 10) || 60000;
let autosaveDir = localStorage.getItem('toki-autosave-dir') || ''; // empty = same as file
let autosaveTimer = null;


// Chat mode state
let chatMode = false;
let chatMessages = [];
let chatBuffer = '';
let chatBufferTimer = null;
let chatMaxTimer = null;   // hard cap timer (non-extendable)
let chatIsStreaming = false;
let lastSentCmd = '';
let chatWaitForInput = true;

// Background buffer: always collects terminal data for chat mode switchover
let bgBuffer = '';
let bgBufferTimer = null;
const BG_BUFFER_MAX = 8000; // max chars to keep
// Snapshot of last completed response (survives finalizeChatResponse clearing)
let lastResponseSnapshot = '';

// Layout state for panel management (slot-based)
// Positions: 'left' | 'right' | 'far-left' | 'far-right' | 'top' | 'bottom'
const SLOT_IDS = ['far-left', 'left', 'right', 'far-right', 'top', 'bottom'];
const V_SLOTS = new Set(['far-left', 'left', 'right', 'far-right']);
const H_SLOTS = new Set(['top', 'bottom']);
const DEFAULT_SLOT_SIZES = { 'far-left': 260, 'left': 260, 'right': 260, 'far-right': 350, 'top': 250, 'bottom': 250 };

// Xterm terminal theme constants (shared by initTerminal + applyDarkMode)
const TERM_THEME_DARK = {
  background: '#141a31', foreground: '#d8dce8', cursor: '#4a90d9', cursorAccent: '#141a31',
  selectionBackground: '#4a90d944', selectionForeground: '#f0f2f8',
  black: '#2e3a56', red: '#ef5350', green: '#66bb6a', yellow: '#ffca28',
  blue: '#4a90d9', magenta: '#ba68c8', cyan: '#4dd0e1', white: '#d8dce8',
  brightBlack: '#7a8ba5', brightRed: '#fc96ab', brightGreen: '#81c784', brightYellow: '#ffb342',
  brightBlue: '#6fb3f2', brightMagenta: '#ce93d8', brightCyan: '#80deea', brightWhite: '#f0f2f8'
};
const TERM_THEME_LIGHT = {
  background: '#ffffff', foreground: '#2a323e', cursor: '#4a8ac6', cursorAccent: '#ffffff',
  selectionBackground: '#b3d4fc', selectionForeground: '#1a2740',
  black: '#4b5a6f', red: '#e53935', green: '#2e7d32', yellow: '#e65100',
  blue: '#3493f9', magenta: '#8e24aa', cyan: '#00838f', white: '#87929e',
  brightBlack: '#68788f', brightRed: '#fc96ab', brightGreen: '#66bb6a', brightYellow: '#ffb342',
  brightBlue: '#4a8ac6', brightMagenta: '#ba68c8', brightCyan: '#4dd0e1', brightWhite: '#ffffff'
};

// Form tab types that use special editors (not Monaco)
const FORM_TAB_TYPES = new Set(['_image', '_loreform', '_regexform']);

const layoutState = {
  itemsPos: 'left',         // where the items (sidebar) panel goes
  refsPos: 'sidebar',       // 'sidebar' = combined with items, or any slot position
  terminalPos: 'bottom',    // where the terminal panel goes
  itemsVisible: true,
  terminalVisible: true,
  avatarVisible: true,
  slotSizes: { ...DEFAULT_SLOT_SIZES },
};

// Restore saved layout from localStorage (with migration from old format)
(function restoreLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('toki-layout-state'));
    if (saved) {
      // Migrate from old format
      if (saved.sidebarPos && !saved.itemsPos) saved.itemsPos = saved.sidebarPos;
      if (saved.sidebarVisible !== undefined && saved.itemsVisible === undefined) saved.itemsVisible = saved.sidebarVisible;

      if (saved.itemsPos) layoutState.itemsPos = saved.itemsPos;
      if (saved.refsPos && saved.refsPos !== '_popout') layoutState.refsPos = saved.refsPos;
      if (saved.terminalPos) layoutState.terminalPos = saved.terminalPos;
      if (saved.itemsVisible !== undefined) layoutState.itemsVisible = saved.itemsVisible;
      if (saved.terminalVisible !== undefined) layoutState.terminalVisible = saved.terminalVisible;
      if (saved.avatarVisible !== undefined) layoutState.avatarVisible = saved.avatarVisible;
      if (saved.slotSizes) Object.assign(layoutState.slotSizes, saved.slotSizes);
    }
  } catch (e) {}
})();

function saveLayout() {
  try { localStorage.setItem('toki-layout-state', JSON.stringify(layoutState)); } catch (e) {}
}

// ==================== Custom Confirm (MomoTalk style) ====================
let confirmAllowAll = false; // "전부 허용" toggle for current batch

function showConfirm(message) {
  if (confirmAllowAll) return Promise.resolve(true);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.className = 'settings-popup';
    box.style.cssText += 'min-width:320px;max-width:400px;';

    const header = document.createElement('div');
    header.className = 'help-popup-header';
    header.innerHTML = '<span>확인</span>';

    const body = document.createElement('div');
    body.style.cssText = 'padding:16px;';

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:13px;color:var(--text-primary);margin-bottom:14px;line-height:1.5;white-space:pre-wrap;';
    msg.textContent = message;
    body.appendChild(msg);

    // "전부 허용" toggle
    const toggleRow = document.createElement('label');
    toggleRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);margin-bottom:14px;cursor:pointer;user-select:none;';
    const toggleCb = document.createElement('input');
    toggleCb.type = 'checkbox';
    toggleRow.appendChild(toggleCb);
    toggleRow.appendChild(document.createTextNode('이번 작업 동안 전부 허용'));
    body.appendChild(toggleRow);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const btnNo = document.createElement('button');
    btnNo.textContent = '아니오';
    btnNo.style.cssText = 'padding:6px 20px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';
    const btnYes = document.createElement('button');
    btnYes.textContent = '예';
    btnYes.style.cssText = 'padding:6px 20px;border:none;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;';
    btns.appendChild(btnNo);
    btns.appendChild(btnYes);
    body.appendChild(btns);

    box.appendChild(header);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    btnYes.focus();

    const close = (val) => {
      if (val && toggleCb.checked) confirmAllowAll = true;
      overlay.remove();
      resolve(val);
    };
    btnYes.addEventListener('click', () => close(true));
    btnNo.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    // Keyboard
    const onKey = (e) => {
      if (e.key === 'Enter') close(true);
      if (e.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey, { once: true });
  });
}

// Reset "전부 허용" — call when a high-level action completes
function resetConfirmAllowAll() { confirmAllowAll = false; }

// ==================== MCP Confirm Handler ====================
// Listen for MCP confirm requests from main process → show MomoTalk popup
window.tokiAPI.onMcpConfirmRequest(async (id, title, message) => {
  const result = await showConfirm(`[${title}]\n${message}`);
  window.tokiAPI.sendMcpConfirmResponse(id, result);
});

// ==================== Close Confirm (3-button MomoTalk popup) ====================
function showCloseConfirm() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.className = 'settings-popup';
    box.style.cssText += 'min-width:340px;max-width:420px;';

    const header = document.createElement('div');
    header.className = 'help-popup-header';
    header.innerHTML = '<span>종료 확인</span>';

    const body = document.createElement('div');
    body.style.cssText = 'padding:16px;';

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:13px;color:var(--text-primary);margin-bottom:16px;line-height:1.5;';
    msg.textContent = '저장하지 않은 변경사항이 있을 수 있습니다.\n종료하시겠습니까?';
    body.appendChild(msg);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = '취소';
    btnCancel.style.cssText = 'padding:6px 16px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';

    const btnNoSave = document.createElement('button');
    btnNoSave.textContent = '저장하지 않고 닫기';
    btnNoSave.style.cssText = 'padding:6px 16px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:#e74c3c;cursor:pointer;font-size:13px;';

    const btnSave = document.createElement('button');
    btnSave.textContent = '저장하고 닫기';
    btnSave.style.cssText = 'padding:6px 16px;border:none;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;';

    btns.appendChild(btnCancel);
    btns.appendChild(btnNoSave);
    btns.appendChild(btnSave);
    body.appendChild(btns);

    box.appendChild(header);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    btnSave.focus();

    const close = (val) => { overlay.remove(); resolve(val); };
    btnSave.addEventListener('click', () => close(0));
    btnNoSave.addEventListener('click', () => close(1));
    btnCancel.addEventListener('click', () => close(2));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(2); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(2);
    }, { once: true });
  });
}

window.tokiAPI.onCloseConfirmRequest(async (id) => {
  const choice = await showCloseConfirm();
  window.tokiAPI.sendCloseConfirmResponse(id, choice);
});

// ==================== Custom Prompt (Electron has no window.prompt) ====================
function showPrompt(message, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-primary);border:1px solid var(--border-color);border-radius:8px;padding:16px;min-width:320px;box-shadow:0 4px 16px rgba(0,0,0,0.3);';
    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'margin-bottom:8px;font-size:13px;color:var(--text-primary);';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue || '';
    input.style.cssText = 'width:100%;padding:6px 8px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px;box-sizing:border-box;';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';
    const btnOk = document.createElement('button');
    btnOk.textContent = '확인';
    btnOk.style.cssText = 'padding:4px 16px;border:none;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = '취소';
    btnCancel.style.cssText = 'padding:4px 16px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';
    btns.appendChild(btnCancel);
    btns.appendChild(btnOk);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
    const close = (val) => { overlay.remove(); resolve(val); };
    btnOk.addEventListener('click', () => close(input.value));
    btnCancel.addEventListener('click', () => close(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
  });
}

// ==================== Context Menu ====================
let ctxMenu = null;

function showContextMenu(x, y, items) {
  hideContextMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';

  for (const item of items) {
    if (item === '---') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item';
    el.textContent = item.label;
    el.addEventListener('click', () => { hideContextMenu(); item.action(); });
    ctxMenu.appendChild(el);
  }

  document.body.appendChild(ctxMenu);

  // Keep menu in viewport
  const rect = ctxMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) ctxMenu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) ctxMenu.style.top = (y - rect.height) + 'px';

  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 0);
}

function hideContextMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

// ==================== Monaco Loader ====================
const monacoPath = '../../node_modules/monaco-editor/min/vs';

function loadMonaco() {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `${monacoPath}/loader.js`;
    script.onload = () => {
      require.config({ paths: { vs: monacoPath } });
      require(['vs/editor/editor.main'], () => {
        monacoReady = true;
        resolve();
      });
    };
    document.head.appendChild(script);
  });
}

// ==================== Editor ====================
function initEditor() {
  const container = document.getElementById('editor-container');
  container.innerHTML = '<div class="empty-state">파일을 열어주세요 (Ctrl+O)</div>';
}

function createOrSwitchEditor(tabInfo) {
  const container = document.getElementById('editor-container');

  if (!monacoReady) return;

  // Special tab types: image, lorebook form, regex form

  if (tabInfo.language === '_image') {
    disposeFormEditors();
    activeTabId = tabInfo.id;
    showImageViewer(tabInfo.id, tabInfo._assetPath);
    updateTabUI();
    updateSidebarActive();
    return;
  }

  if (tabInfo.language === '_loreform') {
    activeTabId = tabInfo.id;
    showLoreEditor(tabInfo);
    updateTabUI();
    updateSidebarActive();
    return;
  }

  if (tabInfo.language === '_regexform') {
    activeTabId = tabInfo.id;
    showRegexEditor(tabInfo);
    updateTabUI();
    updateSidebarActive();
    return;
  }

  // Save current editor content before switching + backup if dirty
  if (editorInstance && activeTabId) {
    const curTab = openTabs.find(t => t.id === activeTabId);
    if (curTab && !FORM_TAB_TYPES.has(curTab.language) && curTab.setValue) {
      curTab._lastValue = editorInstance.getValue();
      curTab.setValue(curTab._lastValue);
      if (dirtyFields.has(curTab.id)) {
        createBackup(curTab.id, curTab._lastValue);
      }
    }
  }

  disposeFormEditors();
  container.innerHTML = '';
  if (editorInstance) { editorInstance.dispose(); }

  // Define Blue Archive theme if not yet defined
  if (!window._baThemeDefined) {
    monaco.editor.defineTheme('blue-archive', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: '2b3a52', background: 'f2f4f8' },
        { token: 'comment', foreground: '7a8ba5', fontStyle: 'italic' },
        { token: 'keyword', foreground: '4a90d9', fontStyle: 'bold' },
        { token: 'string', foreground: '2e7d32' },
        { token: 'number', foreground: 'e65100' },
        { token: 'type', foreground: '7b1fa2' },
        { token: 'function', foreground: '1565c0' },
        { token: 'variable', foreground: 'c62828' },
        { token: 'operator', foreground: 'f06292' },
        { token: 'delimiter', foreground: '546e7a' },
        { token: 'tag', foreground: '4a90d9' },
        { token: 'attribute.name', foreground: 'e65100' },
        { token: 'attribute.value', foreground: '2e7d32' },
      ],
      colors: {
        'editor.background': '#f7f9fc',
        'editor.foreground': '#2b3a52',
        'editor.lineHighlightBackground': '#e3edf7',
        'editor.selectionBackground': '#b3d4fc',
        'editor.inactiveSelectionBackground': '#d6e4f0',
        'editorCursor.foreground': '#4a90d9',
        'editorLineNumber.foreground': '#a0b4cc',
        'editorLineNumber.activeForeground': '#4a90d9',
        'editor.findMatchBackground': '#ffca2855',
        'editor.findMatchHighlightBackground': '#ffca2833',
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#c8d6e5',
        'editorSuggestWidget.background': '#ffffff',
        'editorSuggestWidget.border': '#c8d6e5',
        'editorSuggestWidget.selectedBackground': '#e3edf7',
        'minimap.background': '#f2f4f8',
        'scrollbarSlider.background': '#c8d6e544',
        'scrollbarSlider.hoverBackground': '#4a90d966',
        'scrollbarSlider.activeBackground': '#4a90d9aa',
      }
    });
    window._baThemeDefined = true;
  }

  if (darkMode) defineDarkMonacoTheme();

  const isReadOnly = !tabInfo.setValue;
  editorInstance = monaco.editor.create(container, {
    value: tabInfo.getValue(),
    language: tabInfo.language,
    theme: darkMode ? 'blue-archive-dark' : 'blue-archive',
    fontSize: 14,
    minimap: { enabled: true },
    wordWrap: 'on',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    tabSize: 2,
    mouseWheelZoom: true,
    readOnly: isReadOnly
  });

  editorInstance.onDidChangeModelContent(() => {
    const curTab = openTabs.find(t => t.id === activeTabId);
    if (curTab && curTab.setValue) {
      // Auto-backup on first change (save original before modification)
      if (!dirtyFields.has(curTab.id)) {
        createBackup(curTab.id, curTab.getValue());
      }
      curTab.setValue(editorInstance.getValue());
      dirtyFields.add(curTab.id);
      updateTabUI();
      setStatus('수정됨');
    }
  });

  activeTabId = tabInfo.id;
  updateTabUI();
  updateSidebarActive();
}

// ==================== Tab Management ====================
function openTab(id, label, language, getValue, setValue) {
  let tab = openTabs.find(t => t.id === id);
  if (!tab) {
    tab = { id, label, language, getValue, setValue, _lastValue: null };
    openTabs.push(tab);
  }
  createOrSwitchEditor(tab);
  return tab;
}

function closeTab(id) {
  const idx = openTabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  openTabs.splice(idx, 1);
  dirtyFields.delete(id);

  if (activeTabId === id) {
    disposeFormEditors();
    if (openTabs.length > 0) {
      const newTab = openTabs[Math.max(0, idx - 1)];
      createOrSwitchEditor(newTab);
    } else {
      activeTabId = null;
      document.getElementById('editor-container').innerHTML =
        '<div class="empty-state">항목을 선택하세요</div>';
      editorInstance = null;
      updateTabUI();
    }
  } else {
    updateTabUI();
  }
}

function updateTabUI() {
  const tabBar = document.getElementById('editor-tabs');
  tabBar.innerHTML = '';

  for (let i = 0; i < openTabs.length; i++) {
    const tab = openTabs[i];
    const el = document.createElement('div');
    el.className = 'editor-tab' + (tab.id === activeTabId ? ' active' : '');

    // Drag-and-drop reorder
    el.draggable = true;
    el.dataset.tabIdx = i;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/tab-index', String(i));
      el.classList.add('tab-dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('tab-dragging'));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('tab-drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('tab-drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/tab-index'), 10);
      const toIdx = i;
      if (fromIdx !== toIdx && !isNaN(fromIdx)) {
        const [moved] = openTabs.splice(fromIdx, 1);
        openTabs.splice(toIdx, 0, moved);
        updateTabUI();
      }
    });

    const labelSpan = document.createElement('span');
    labelSpan.textContent = tab.label;
    el.appendChild(labelSpan);

    if (dirtyFields.has(tab.id)) {
      const dot = document.createElement('span');
      dot.className = 'modified';
      dot.textContent = '●';
      el.appendChild(dot);
    }

    const closeBtn = document.createElement('span');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    // Per-tab popout button (text tabs including readonly, not images)
    if (tab.language !== '_image' && !isPanelPoppedOut('editor')) {
      const popBtn = document.createElement('span');
      popBtn.className = 'tab-popout-btn';
      popBtn.title = '팝아웃 (분리)';
      popBtn.textContent = '↗';
      popBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        popOutEditorPanel(tab.id);
      });
      el.appendChild(popBtn);
    }

    el.addEventListener('click', () => createOrSwitchEditor(tab));
    tabBar.appendChild(el);
  }
}

// ==================== Sidebar ====================
function buildSidebar() {
  const tree = document.getElementById('sidebar-tree');
  tree.innerHTML = '';

  // Always build refs sidebar regardless of fileData
  buildRefsSidebar();

  if (!fileData) return;

  // ---- Lua folder (split/merge system) ----
  luaSections = parseLuaSections(fileData.lua);

  const luaFolder = createFolderItem('Lua', '{}', 0);
  tree.appendChild(luaFolder.header);
  tree.appendChild(luaFolder.children);

  // Right-click on Lua folder: add new section
  luaFolder.header.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: '새 하위항목 추가', action: () => addLuaSection() },
    ]);
  });

  // Combined Lua view
  const luaCombinedEl = createTreeItem('통합 보기', '📋', 1);
  luaCombinedEl.dataset.label = 'Lua';
  luaCombinedEl.addEventListener('click', () => {
    fileData.lua = combineLuaSections();
    openTab('lua', 'Lua (통합)', 'lua',
      () => fileData.lua,
      (v) => {
        fileData.lua = v;
        luaSections = parseLuaSections(v);
      }
    );
  });
  luaCombinedEl.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const items = [
      { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText('read_field("lua")'); setStatus('복사됨: read_field("lua")'); } },
    ];
    const store = backupStore['lua'] || [];
    if (store.length > 0) {
      items.push('---');
      items.push({ label: '백업 불러오기', action: () => showBackupMenu('lua', e.clientX, e.clientY) });
    }
    showContextMenu(e.clientX, e.clientY, items);
  });
  luaFolder.children.appendChild(luaCombinedEl);

  // Individual Lua sections
  for (let i = 0; i < luaSections.length; i++) {
    const section = luaSections[i];
    const sectionEl = createTreeItem(section.name, '·', 1);
    const idx = i;
    sectionEl.addEventListener('click', () => {
      openTab(`lua_s${idx}`, section.name, 'lua',
        () => luaSections[idx].content,
        (v) => {
          luaSections[idx].content = v;
          fileData.lua = combineLuaSections();
        }
      );
    });
    sectionEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = [
        { label: '이름 변경', action: () => renameLuaSection(idx) },
        { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_lua(${idx})`); setStatus(`복사됨: read_lua(${idx})`); } },
      ];
      const store = backupStore[`lua_s${idx}`] || [];
      if (store.length > 0) {
        items.push('---');
        items.push({ label: '백업 불러오기', action: () => showBackupMenu(`lua_s${idx}`, e.clientX, e.clientY) });
      }
      items.push('---');
      items.push({ label: '삭제', action: () => deleteLuaSection(idx) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    luaFolder.children.appendChild(sectionEl);
  }

  // ---- File type check ----
  const isRisum = fileData._fileType === 'risum';

  // ---- CSS folder (section-based, like Lua) — charx only ----
  cssSections = parseCssSections(fileData.css);
  if (!isRisum) {
  const cssFolder = createFolderItem('CSS', '🎨', 0);
  tree.appendChild(cssFolder.header);
  tree.appendChild(cssFolder.children);

  // Right-click on CSS folder: add new section
  cssFolder.header.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: '새 하위항목 추가', action: () => addCssSection() },
    ]);
  });

  // Combined CSS view
  const cssCombinedEl = createTreeItem('통합 보기', '📋', 1);
  cssCombinedEl.addEventListener('click', () => {
    openTab('css', 'CSS (통합)', 'css',
      () => fileData.css,
      (v) => {
        fileData.css = v;
        cssSections = parseCssSections(v);
      }
    );
  });
  cssCombinedEl.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const items = [
      { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText('read_field("css")'); setStatus('복사됨: read_field("css")'); } },
    ];
    const store = backupStore['css'] || [];
    if (store.length > 0) {
      items.push('---');
      items.push({ label: '백업 불러오기', action: () => showBackupMenu('css', e.clientX, e.clientY) });
    }
    showContextMenu(e.clientX, e.clientY, items);
  });
  cssFolder.children.appendChild(cssCombinedEl);

  // Individual CSS sections
  for (let i = 0; i < cssSections.length; i++) {
    const section = cssSections[i];
    const sectionEl = createTreeItem(section.name, '·', 1);
    const idx = i;
    sectionEl.addEventListener('click', () => {
      openTab(`css_s${idx}`, section.name, 'css',
        () => cssSections[idx].content,
        (v) => {
          cssSections[idx].content = v;
          fileData.css = combineCssSections();
        }
      );
    });
    sectionEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = [
        { label: '이름 변경', action: () => renameCssSection(idx) },
        { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_css(${idx})`); setStatus(`복사됨: read_css(${idx})`); } },
      ];
      const store = backupStore[`css_s${idx}`] || [];
      if (store.length > 0) {
        items.push('---');
        items.push({ label: '백업 불러오기', action: () => showBackupMenu(`css_s${idx}`, e.clientX, e.clientY) });
      }
      items.push('---');
      items.push({ label: '삭제', action: () => deleteCssSection(idx) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    cssFolder.children.appendChild(sectionEl);
  }
  } // end if (!isRisum) — CSS folder

  // ---- Single items ----
  const charxOnlyFields = ['globalNote', 'firstMessage', 'defaultVariables'];
  const singles = [
    { id: 'globalNote', label: '글로벌노트', icon: '📝', lang: 'plaintext', field: 'globalNote' },
    { id: 'firstMessage', label: '첫 메시지', icon: '💬', lang: 'html', field: 'firstMessage' },
    { id: 'defaultVariables', label: '기본변수', icon: '⚙', lang: 'plaintext', field: 'defaultVariables' },
    { id: 'description', label: '설명', icon: '📄', lang: 'plaintext', field: 'description' },
  ].filter(item => !isRisum || !charxOnlyFields.includes(item.id));

  for (const item of singles) {
    const el = createTreeItem(item.label, item.icon, 0);
    el.addEventListener('click', () => {
      openTab(item.id, item.label, item.lang,
        () => fileData[item.field],
        (v) => { fileData[item.field] = v; }
      );
    });
    // Single item right-click: MCP path / backup
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = [
        { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_field("${item.field}")`); setStatus(`복사됨: read_field("${item.field}")`); } },
      ];
      const store = backupStore[item.id] || [];
      if (store.length > 0) {
        items.push('---');
        items.push({ label: '백업 불러오기', action: () => showBackupMenu(item.id, e.clientX, e.clientY) });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
    tree.appendChild(el);
  }

  // Lorebook folder
  const lbFolder = createFolderItem('로어북', '📚', 0);
  tree.appendChild(lbFolder.header);
  tree.appendChild(lbFolder.children);

  // Lorebook folder right-click: add folder/entry / import / bulk delete
  lbFolder.header.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const items = [
      { label: '새 항목 추가', action: () => addNewLorebook() },
      { label: '새 폴더 추가', action: () => addNewLorebookFolder() },
      '---',
      { label: 'JSON 파일 가져오기', action: () => importLorebook() },
    ];
    if (fileData.lorebook.length > 0) {
      items.push('---');
      items.push({ label: `전체 삭제 (${fileData.lorebook.length}개)`, action: async () => {
        if (!await showConfirm(`로어북 전체 ${fileData.lorebook.length}개 항목을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
        // Close all lorebook tabs
        for (let i = fileData.lorebook.length - 1; i >= 0; i--) closeTab(`lore_${i}`);
        fileData.lorebook = [];
        dirtyFields.add('lorebook');
        buildSidebar();
        setStatus('로어북 전체 삭제됨');
      }});
    }
    showContextMenu(e.clientX, e.clientY, items);
  });

  // Group lorebook by folder (robust multi-key matching)
  const folderDataList = []; // { entry, index, children }
  const folderLookup = {};   // multiple keys → same folderData
  const rootEntries = [];
  for (let i = 0; i < fileData.lorebook.length; i++) {
    const entry = fileData.lorebook[i];
    if (entry.mode === 'folder') {
      const fd = { entry, index: i, children: [] };
      folderDataList.push(fd);
      // Map by all possible IDs a child might reference
      const k = entry.key || '';
      const c = entry.comment || '';
      if (k) { folderLookup[`folder:${k}`] = fd; folderLookup[k] = fd; }
      if (c) { folderLookup[`folder:${c}`] = fd; folderLookup[c] = fd; }
      folderLookup[`folder:${i}`] = fd;
      folderLookup[String(i)] = fd;
    }
  }
  for (let i = 0; i < fileData.lorebook.length; i++) {
    const entry = fileData.lorebook[i];
    if (entry.mode === 'folder') continue;
    const folderId = entry.folder;
    const matched = folderId ? folderLookup[folderId] || folderLookup[String(folderId)] : null;
    if (matched) {
      matched.children.push({ entry, index: i });
    } else {
      rootEntries.push({ entry, index: i });
    }
  }

  for (const folder of folderDataList) {
    const subFolder = createFolderItem(folder.entry.comment || `folder_${folder.index}`, '📁', 1);
    lbFolder.children.appendChild(subFolder.header);
    lbFolder.children.appendChild(subFolder.children);

    // Lorebook folder right-click: rename / add entry / delete contents / delete folder
    const folderIdx = folder.index;
    const folderChildren = folder.children;
    subFolder.header.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const fEntry = fileData.lorebook[folderIdx];
      const folderId = `folder:${fEntry.key || fEntry.comment || folderIdx}`;
      showContextMenu(e.clientX, e.clientY, [
        { label: '이름 변경', action: async () => {
          const newName = await showPrompt('폴더 이름', fEntry.comment || '');
          if (!newName) return;
          fEntry.comment = newName;
          dirtyFields.add('lorebook');
          buildSidebar();
          setStatus(`폴더 이름 변경: ${newName}`);
        }},
        { label: '새 항목 추가', action: () => {
          const newEntry = {
            key: '', content: '', comment: `new_entry_${fileData.lorebook.length}`,
            mode: 'normal', insertorder: 100, alwaysActive: false, forceActivation: false,
            selective: false, secondkey: '', constant: false,
            order: fileData.lorebook.length, folder: folderId
          };
          fileData.lorebook.push(newEntry);
          dirtyFields.add('lorebook');
          buildSidebar();
          const idx = fileData.lorebook.length - 1;
          openTab(`lore_${idx}`, newEntry.comment, '_loreform',
            () => fileData.lorebook[idx], (v) => { Object.assign(fileData.lorebook[idx], v); });
          setStatus('폴더에 새 항목 추가됨');
        }},
        '---',
        ...(folderChildren.length > 0 ? [{ label: `내용 일괄 삭제 (${folderChildren.length}개)`, action: async () => {
          if (!await showConfirm(`"${fEntry.comment}" 폴더 내 ${folderChildren.length}개 항목을 모두 삭제하시겠습니까?`)) return;
          const indices = folderChildren.map(c => c.index).sort((a, b) => b - a);
          for (const i of indices) {
            closeTab(`lore_${i}`);
            fileData.lorebook.splice(i, 1);
          }
          dirtyFields.add('lorebook');
          buildSidebar();
          setStatus(`${indices.length}개 항목 삭제됨`);
        }}] : []),
        { label: '폴더 삭제 (폴더만)', action: async () => {
          if (!await showConfirm(`"${fEntry.comment}" 폴더를 삭제하시겠습니까?\n내부 항목은 루트로 이동됩니다.`)) return;
          // Move children to root
          for (const child of folderChildren) {
            fileData.lorebook[child.index].folder = '';
          }
          closeTab(`lore_${folderIdx}`);
          fileData.lorebook.splice(folderIdx, 1);
          dirtyFields.add('lorebook');
          buildSidebar();
          setStatus(`폴더 삭제됨: ${fEntry.comment}`);
        }},
        { label: '폴더+내용 전체 삭제', action: async () => {
          const total = folderChildren.length + 1;
          if (!await showConfirm(`"${fEntry.comment}" 폴더와 내부 ${folderChildren.length}개 항목을 모두 삭제하시겠습니까?`)) return;
          const indices = [folderIdx, ...folderChildren.map(c => c.index)].sort((a, b) => b - a);
          for (const i of indices) {
            closeTab(`lore_${i}`);
            fileData.lorebook.splice(i, 1);
          }
          dirtyFields.add('lorebook');
          buildSidebar();
          setStatus(`폴더+내용 삭제됨 (${total}개)`);
        }},
      ]);
    });

    for (const child of folder.children) {
      const entryEl = createLoreEntryItem(child, 2);
      subFolder.children.appendChild(entryEl);
    }
  }

  for (const child of rootEntries) {
    const entryEl = createLoreEntryItem(child, 1);
    lbFolder.children.appendChild(entryEl);
  }

  // Regex folder
  const rxFolder = createFolderItem('정규식', '⚡', 0);
  tree.appendChild(rxFolder.header);
  tree.appendChild(rxFolder.children);

  // Regex folder right-click: add / import / bulk delete
  rxFolder.header.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const items = [
      { label: '새 항목 추가', action: () => addNewRegex() },
      { label: 'JSON 파일 가져오기', action: () => importRegex() },
    ];
    if (fileData.regex.length > 0) {
      items.push('---');
      items.push({ label: `전체 삭제 (${fileData.regex.length}개)`, action: async () => {
        if (!await showConfirm(`정규식 전체 ${fileData.regex.length}개 항목을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
        for (let i = fileData.regex.length - 1; i >= 0; i--) closeTab(`regex_${i}`);
        fileData.regex = [];
        dirtyFields.add('regex');
        buildSidebar();
        setStatus('정규식 전체 삭제됨');
      }});
    }
    showContextMenu(e.clientX, e.clientY, items);
  });

  for (let i = 0; i < fileData.regex.length; i++) {
    const rx = fileData.regex[i];
    const label = rx.comment || `regex_${i}`;
    const el = createTreeItem(label, '·', 1);
    const idx = i;
    el.addEventListener('click', () => {
      openTab(`regex_${idx}`, label, '_regexform',
        () => fileData.regex[idx],
        (v) => { Object.assign(fileData.regex[idx], v); }
      );
    });
    // Regex item right-click: rename / copy path / backup / delete
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = [
        { label: '이름 변경', action: () => renameRegex(idx) },
        { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_regex(${idx})`); setStatus(`복사됨: read_regex(${idx})`); } },
      ];
      const store = backupStore[`regex_${idx}`] || [];
      if (store.length > 0) {
        items.push('---');
        items.push({ label: '백업 불러오기', action: () => showBackupMenu(`regex_${idx}`, e.clientX, e.clientY) });
      }
      items.push('---');
      items.push({ label: '삭제', action: () => deleteRegex(idx) });
      showContextMenu(e.clientX, e.clientY, items);
    });
    rxFolder.children.appendChild(el);
  }

  // Assets (images) folder
  buildAssetsSidebar(tree);
}

async function buildAssetsSidebar(tree) {
  const assetList = await window.tokiAPI.getAssetList();

  const assetsFolder = createFolderItem('에셋 (이미지)', '🖼', 0);
  tree.appendChild(assetsFolder.header);
  tree.appendChild(assetsFolder.children);

  // Group assets by folder
  const groups = { icon: [], other: [] };
  if (assetList) {
    for (const asset of assetList) {
      const parts = asset.path.split('/');
      const group = parts[1] === 'icon' ? 'icon' : 'other';
      groups[group].push(asset);
    }
  }

  // Always show icon and other folders
  const folderDefs = [
    { key: 'icon', label: '아이콘 (icon)', icon: '⭐' },
    { key: 'other', label: '기타 (other)', icon: '📁' },
  ];

  for (const def of folderDefs) {
    const subFolder = createFolderItem(def.label, def.icon, 1);
    assetsFolder.children.appendChild(subFolder.header);
    assetsFolder.children.appendChild(subFolder.children);

    // Right-click on subfolder: add to this folder
    const targetFolder = def.key;
    subFolder.header.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '이미지 추가', action: () => addAssetFromDialog(targetFolder) },
      ]);
    });

    // Add existing assets under this folder
    for (const asset of groups[def.key]) {
      const fileName = asset.path.split('/').pop();
      const el = createTreeItem(`${fileName} (${(asset.size/1024).toFixed(0)}KB)`, '·', 2);
      el.addEventListener('click', () => openImageTab(asset.path, fileName));
      attachAssetContextMenu(el, asset.path, fileName);
      subFolder.children.appendChild(el);
    }
  }
}


async function addReferenceFile() {
  const result = await window.tokiAPI.openReference();
  if (!result) return;

  // Handle both single and multiple results
  const refs = Array.isArray(result) ? result : [result];
  let added = 0;
  for (const ref of refs) {
    if (referenceFiles.some(r => r.fileName === ref.fileName)) continue;
    referenceFiles.push(ref);
    added++;
  }
  if (added > 0) {
    buildRefsSidebar();
    setStatus(`참고 파일 추가: ${added}개`);
  } else {
    setStatus('이미 로드된 파일입니다');
  }
}

// ==================== Sidebar Refs Tab ====================

async function buildRefsSidebar() {
  const refsEl = document.getElementById('sidebar-refs');
  if (!refsEl) return;
  refsEl.innerHTML = '';

  // Guides folder
  const guideData = await window.tokiAPI.listGuides();
  // Support both old (string[]) and new ({ builtIn, session }) format
  const builtInFiles = guideData?.builtIn || (Array.isArray(guideData) ? guideData : []);
  const sessionFiles = guideData?.session || [];
  const guideFolder = createFolderItem('가이드', '📖', 0);
  refsEl.appendChild(guideFolder.header);
  refsEl.appendChild(guideFolder.children);

  // Right-click on guide folder: new / import
  guideFolder.header.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: '새 가이드 작성', action: async () => {
        const name = await showPrompt('파일 이름 (예: guide.md)', 'new_guide.md');
        if (!name) return;
        const fn = name.endsWith('.md') ? name : name + '.md';
        await window.tokiAPI.writeGuide(fn, '');
        buildRefsSidebar();
        openTab(`guide_${fn}`, `[가이드] ${fn}`, 'plaintext',
          () => '', (val) => { window.tokiAPI.writeGuide(fn, val); });
        setStatus(`가이드 생성: ${fn}`);
      }},
      { label: '가이드 불러오기 (세션 전용)', action: async () => {
        const imported = await window.tokiAPI.importGuide();
        if (imported.length > 0) {
          buildRefsSidebar();
          setStatus(`가이드 불러옴 (세션): ${imported.join(', ')}`);
        }
      }},
    ]);
  });

  // Helper: create guide item with click + context menu
  function addGuideItem(fileName, isSession) {
    const prefix = isSession ? '⏳ ' : '';
    const el = createTreeItem(prefix + fileName, '·', 1);
    el.addEventListener('click', async () => {
      const tabId = `guide_${fileName}`;
      const existing = openTabs.find(t => t.id === tabId);
      if (existing) {
        activeTabId = tabId;
        createOrSwitchEditor(existing);
        updateTabUI();
        return;
      }
      const content = await window.tokiAPI.readGuide(fileName);
      if (content == null) { setStatus('가이드 파일 읽기 실패'); return; }
      openTab(tabId, `[가이드] ${fileName}`, 'plaintext',
        () => content,
        (val) => { window.tokiAPI.writeGuide(fileName, val); }
      );
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = [
        { label: '이름 복사', action: () => { navigator.clipboard.writeText(fileName); setStatus(`복사됨: ${fileName}`); } },
      ];
      if (!isSession) {
        items.push({ label: '경로 복사', action: async () => {
          const guidesDir = await window.tokiAPI.getGuidesPath();
          const fullPath = guidesDir ? `${guidesDir.replace(/\\/g, '/')}/${fileName}` : `guides/${fileName}`;
          navigator.clipboard.writeText(fullPath);
          setStatus(`복사됨: ${fullPath}`);
        }});
      }
      items.push('---');
      items.push({ label: isSession ? '제거' : '삭제', action: async () => {
        const msg = isSession ? `"${fileName}" 세션 가이드를 제거하시겠습니까?` : `"${fileName}" 가이드를 삭제하시겠습니까?`;
        if (!await showConfirm(msg)) return;
        closeTab(`guide_${fileName}`);
        await window.tokiAPI.deleteGuide(fileName);
        buildRefsSidebar();
        setStatus(isSession ? `가이드 제거됨: ${fileName}` : `가이드 삭제됨: ${fileName}`);
      }});
      showContextMenu(e.clientX, e.clientY, items);
    });
    guideFolder.children.appendChild(el);
  }

  for (const fileName of builtInFiles) addGuideItem(fileName, false);
  if (sessionFiles.length > 0) {
    // Separator between built-in and session guides
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--border-color);margin:4px 8px;';
    guideFolder.children.appendChild(sep);
    for (const fileName of sessionFiles) addGuideItem(fileName, true);
  }

  // Reference files section
  const refHeader = document.createElement('div');
  refHeader.className = 'tree-item indent-0 ref-section-header';
  refHeader.style.cssText = 'color:var(--accent);font-weight:700;font-size:11px;letter-spacing:0.5px;padding:10px 8px 4px;cursor:pointer;text-transform:uppercase;border-top:1px solid var(--border-color);margin-top:8px;';
  refHeader.textContent = '── 참고 파일 ──';
  refHeader.title = '클릭하여 참고 파일 추가';
  refHeader.addEventListener('click', addReferenceFile);
  refHeader.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: '참고 파일 추가', action: addReferenceFile },
      ...(referenceFiles.length > 0 ? ['---', { label: '모두 제거', action: () => { referenceFiles = []; window.tokiAPI.removeAllReferences(); buildRefsSidebar(); } }] : []),
    ]);
  });
  refsEl.appendChild(refHeader);

  // Render each reference file
  for (let ri = 0; ri < referenceFiles.length; ri++) {
    const ref = referenceFiles[ri];
    const refFolder = createFolderItem(ref.fileName, '📎', 0);
    refsEl.appendChild(refFolder.header);
    refsEl.appendChild(refFolder.children);

    const refIdx = ri;
    refFolder.header.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const items = [
        { label: '이름 복사', action: () => { navigator.clipboard.writeText(ref.fileName); setStatus(`복사됨: ${ref.fileName}`); } },
      ];
      if (ref.filePath) {
        items.push({ label: '경로 복사', action: () => { navigator.clipboard.writeText(ref.filePath); setStatus(`복사됨: ${ref.filePath}`); } });
      }
      items.push('---');
      items.push({ label: '참고 파일 제거', action: () => { const name = referenceFiles[refIdx].fileName; referenceFiles.splice(refIdx, 1); window.tokiAPI.removeReference(name); buildRefsSidebar(); } });
      showContextMenu(e.clientX, e.clientY, items);
    });

    // Lua — split into sections like main sidebar
    if (ref.data.lua) {
      const refLuaSections = parseLuaSections(ref.data.lua);
      if (refLuaSections.length <= 1) {
        // Single section — just show as a single item
        const el = createTreeItem('Lua', '·', 1);
        el.addEventListener('click', () => {
          openTab(`ref_${refIdx}_lua`, `[참고] ${ref.fileName} - Lua`, 'lua', () => ref.data.lua, null);
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "lua")`); setStatus(`복사됨: read_reference_field(${refIdx}, "lua")`); } },
          ]);
        });
        refFolder.children.appendChild(el);
      } else {
        // Multiple sections — show as folder
        const luaFolder = createFolderItem('Lua', '{}', 1);
        refFolder.children.appendChild(luaFolder.header);
        refFolder.children.appendChild(luaFolder.children);
        // Combined view
        const combinedEl = createTreeItem('통합 보기', '📋', 2);
        combinedEl.addEventListener('click', () => {
          openTab(`ref_${refIdx}_lua`, `[참고] ${ref.fileName} - Lua (통합)`, 'lua', () => ref.data.lua, null);
        });
        combinedEl.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "lua")`); setStatus(`복사됨: read_reference_field(${refIdx}, "lua")`); } },
          ]);
        });
        luaFolder.children.appendChild(combinedEl);
        // Individual sections
        for (let si = 0; si < refLuaSections.length; si++) {
          const sec = refLuaSections[si];
          const secEl = createTreeItem(sec.name, '·', 2);
          const secIdx = si;
          secEl.addEventListener('click', () => {
            openTab(`ref_${refIdx}_lua_s${secIdx}`, `[참고] ${ref.fileName} - ${sec.name}`, 'lua', () => refLuaSections[secIdx].content, null);
          });
          secEl.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, [
              { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "lua") → 섹션 "${sec.name}" (index ${secIdx})`); setStatus(`복사됨: 참고자료[${refIdx}] Lua 섹션[${secIdx}]`); } },
            ]);
          });
          luaFolder.children.appendChild(secEl);
        }
      }
    }

    const refFields = [
      { id: 'globalNote', label: '글로벌노트', lang: 'plaintext' },
      { id: 'firstMessage', label: '첫 메시지', lang: 'html' },
      { id: 'description', label: '설명', lang: 'plaintext' },
    ];

    for (const f of refFields) {
      if (!ref.data[f.id]) continue;
      const el = createTreeItem(f.label, '·', 1);
      const tabId = `ref_${refIdx}_${f.id}`;
      el.addEventListener('click', () => {
        openTab(tabId, `[참고] ${ref.fileName} - ${f.label}`, f.lang, () => ref.data[f.id], null);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "${f.id}")`); setStatus(`복사됨: read_reference_field(${refIdx}, "${f.id}")`); } },
        ]);
      });
      refFolder.children.appendChild(el);
    }

    // CSS — split into sections like main sidebar
    if (ref.data.css) {
      const refCssSections = parseCssSections(ref.data.css);
      if (refCssSections.length <= 1) {
        const el = createTreeItem('CSS', '·', 1);
        el.addEventListener('click', () => {
          openTab(`ref_${refIdx}_css`, `[참고] ${ref.fileName} - CSS`, 'css', () => ref.data.css, null);
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "css")`); setStatus(`복사됨: read_reference_field(${refIdx}, "css")`); } },
          ]);
        });
        refFolder.children.appendChild(el);
      } else {
        const cssFolderRef = createFolderItem('CSS', '🎨', 1);
        refFolder.children.appendChild(cssFolderRef.header);
        refFolder.children.appendChild(cssFolderRef.children);
        const combinedEl = createTreeItem('통합 보기', '📋', 2);
        combinedEl.addEventListener('click', () => {
          openTab(`ref_${refIdx}_css`, `[참고] ${ref.fileName} - CSS (통합)`, 'css', () => ref.data.css, null);
        });
        combinedEl.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "css")`); setStatus(`복사됨: read_reference_field(${refIdx}, "css")`); } },
          ]);
        });
        cssFolderRef.children.appendChild(combinedEl);
        for (let si = 0; si < refCssSections.length; si++) {
          const sec = refCssSections[si];
          const secEl = createTreeItem(sec.name, '·', 2);
          const secIdx = si;
          secEl.addEventListener('click', () => {
            openTab(`ref_${refIdx}_css_s${secIdx}`, `[참고] ${ref.fileName} - ${sec.name}`, 'css', () => refCssSections[secIdx].content, null);
          });
          secEl.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, [
              { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "css") → 섹션 "${sec.name}" (index ${secIdx})`); setStatus(`복사됨: 참고자료[${refIdx}] CSS 섹션[${secIdx}]`); } },
            ]);
          });
          cssFolderRef.children.appendChild(secEl);
        }
      }
    }

    // Lorebook — folder structure + _loreform (readonly)
    if (ref.data.lorebook && ref.data.lorebook.length > 0) {
      const lbFolder = createFolderItem(`로어북 (${ref.data.lorebook.length})`, '📚', 1);
      refFolder.children.appendChild(lbFolder.header);
      refFolder.children.appendChild(lbFolder.children);

      // Group by folder (same logic as main sidebar)
      const refFolderDataList = [];
      const refFolderLookup = {};
      const refRootEntries = [];
      for (let li = 0; li < ref.data.lorebook.length; li++) {
        const entry = ref.data.lorebook[li];
        if (entry.mode === 'folder') {
          const fd = { entry, index: li, children: [] };
          refFolderDataList.push(fd);
          const k = entry.key || '', c = entry.comment || '';
          if (k) { refFolderLookup[`folder:${k}`] = fd; refFolderLookup[k] = fd; }
          if (c) { refFolderLookup[`folder:${c}`] = fd; refFolderLookup[c] = fd; }
          refFolderLookup[`folder:${li}`] = fd;
          refFolderLookup[String(li)] = fd;
        }
      }
      for (let li = 0; li < ref.data.lorebook.length; li++) {
        const entry = ref.data.lorebook[li];
        if (entry.mode === 'folder') continue;
        const folderId = entry.folder;
        const matched = folderId ? refFolderLookup[folderId] || refFolderLookup[String(folderId)] : null;
        if (matched) { matched.children.push({ entry, index: li }); }
        else { refRootEntries.push({ entry, index: li }); }
      }

      const refLorebook = ref.data.lorebook;
      function makeRefLoreItem(child, indent) {
        const lbLabel = child.entry.comment || child.entry.key || `#${child.index}`;
        const lbEl = createTreeItem(lbLabel, '·', indent);
        const li = child.index;
        const lbTabId = `ref_${refIdx}_lb_${li}`;
        lbEl.addEventListener('click', () => {
          const tab = openTab(lbTabId, `[참고] ${ref.fileName} - ${lbLabel}`, '_loreform', () => refLorebook[li], null);
          if (tab) tab._refLorebook = refLorebook;
        });
        lbEl.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: '키 복사', action: () => { navigator.clipboard.writeText(child.entry.key || ''); setStatus(`복사됨: ${child.entry.key}`); } },
            { label: '내용 복사', action: () => { navigator.clipboard.writeText(child.entry.content || ''); setStatus('내용 복사됨'); } },
            { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "lorebook") → index ${li}`); setStatus(`복사됨: 참고자료[${refIdx}] 로어북[${li}]`); } },
          ]);
        });
        return lbEl;
      }

      for (const folder of refFolderDataList) {
        const subFolder = createFolderItem(folder.entry.comment || `folder_${folder.index}`, '📁', 2);
        lbFolder.children.appendChild(subFolder.header);
        lbFolder.children.appendChild(subFolder.children);
        for (const child of folder.children) {
          subFolder.children.appendChild(makeRefLoreItem(child, 3));
        }
      }
      for (const child of refRootEntries) {
        lbFolder.children.appendChild(makeRefLoreItem(child, 2));
      }
    }

    // Regex — _regexform (readonly)
    if (ref.data.regex && ref.data.regex.length > 0) {
      const rxFolder = createFolderItem(`정규식 (${ref.data.regex.length})`, '⚡', 1);
      refFolder.children.appendChild(rxFolder.header);
      refFolder.children.appendChild(rxFolder.children);
      for (let xi = 0; xi < ref.data.regex.length; xi++) {
        const rx = ref.data.regex[xi];
        const rxLabel = rx.comment || `#${xi}`;
        const rxEl = createTreeItem(rxLabel, '·', 2);
        const rxTabId = `ref_${refIdx}_rx_${xi}`;
        const rxIdx = xi;
        rxEl.addEventListener('click', () => {
          openTab(rxTabId, `[참고] ${ref.fileName} - ${rxLabel}`, '_regexform', () => ref.data.regex[rxIdx], null);
        });
        rxEl.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            { label: '패턴 복사', action: () => { navigator.clipboard.writeText(rx.in || rx.findRegex || ''); setStatus('패턴 복사됨'); } },
            { label: '내용 복사', action: () => { navigator.clipboard.writeText(JSON.stringify(rx, null, 2)); setStatus('내용 복사됨'); } },
            { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_reference_field(${refIdx}, "regex") → index ${rxIdx}`); setStatus(`복사됨: 참고자료[${refIdx}] 정규식[${rxIdx}]`); } },
          ]);
        });
        rxFolder.children.appendChild(rxEl);
      }
    }
  }
}

function initSidebarSplitResizer() {
  const resizer = document.getElementById('sidebar-split-resizer');
  const itemsSection = document.getElementById('sidebar-items-section');
  const refsSection = document.getElementById('sidebar-refs-section');
  if (!resizer || !itemsSection || !refsSection) return;

  let startY = 0;
  let startItemsH = 0;
  let startRefsH = 0;

  const onMove = (e) => {
    const dy = e.clientY - startY;
    const newItemsH = Math.max(60, startItemsH + dy);
    const newRefsH = Math.max(60, startRefsH - dy);
    itemsSection.style.flex = `0 0 ${newItemsH}px`;
    refsSection.style.flex = `0 0 ${newRefsH}px`;
  };
  const onUp = () => {
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startItemsH = itemsSection.offsetHeight;
    startRefsH = refsSection.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // --- Refs section buttons ---
  // refsSection already declared above
  const refsContent = document.getElementById('sidebar-refs');
  const collapseBtn = document.getElementById('btn-refs-collapse');
  const closeBtn = document.getElementById('btn-refs-close');
  const separateBtn = document.getElementById('btn-refs-separate');
  const extPopoutBtn = document.getElementById('btn-refs-extpopout');

  if (collapseBtn && refsContent) {
    let refsCollapsed = false;
    collapseBtn.addEventListener('click', () => {
      refsCollapsed = !refsCollapsed;
      refsContent.style.display = refsCollapsed ? 'none' : '';
      collapseBtn.textContent = refsCollapsed ? '▶' : '▼';
      collapseBtn.title = refsCollapsed ? '참고자료 펼치기' : '참고자료 접기';
    });
  }
  if (closeBtn && refsSection && resizer) {
    closeBtn.addEventListener('click', () => {
      refsSection.style.display = 'none';
      resizer.style.display = 'none';
      itemsSection.style.flex = '1';
    });
  }
  if (separateBtn) {
    separateBtn.addEventListener('click', () => {
      moveRefs('right');
    });
  }
  if (extPopoutBtn) {
    extPopoutBtn.addEventListener('click', () => {
      if (isPanelPoppedOut('refs')) {
        dockPanel('refs');
      } else {
        popOutPanel('refs');
      }
    });
  }
  // Right-click on refs header for position options
  const refsHeader = document.querySelector('.sidebar-header-refs');
  if (refsHeader) {
    refsHeader.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '→ 사이드바', action: () => moveRefs('sidebar') },
        { label: '→ 좌측', action: () => moveRefs('left') },
        { label: '→ 우측', action: () => moveRefs('right') },
        { label: '→ 좌끝', action: () => moveRefs('far-left') },
        { label: '→ 우끝', action: () => moveRefs('far-right') },
        { label: '→ 상단', action: () => moveRefs('top') },
        { label: '→ 하단', action: () => moveRefs('bottom') },
      ]);
    });
  }
}

function createTreeItem(label, icon, indent) {
  const el = document.createElement('div');
  el.className = `tree-item indent-${indent}`;
  el.dataset.label = label;

  const iconSpan = document.createElement('span');
  iconSpan.className = 'icon';
  iconSpan.textContent = icon;
  el.appendChild(iconSpan);

  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  el.appendChild(labelSpan);

  return el;
}

function createFolderItem(label, icon, indent) {
  const header = document.createElement('div');
  header.className = `tree-item indent-${indent}`;

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '▶';
  header.appendChild(arrow);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'icon';
  iconSpan.textContent = icon;
  header.appendChild(iconSpan);

  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  header.appendChild(labelSpan);

  const children = document.createElement('div');
  children.className = 'tree-children';

  header.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = children.classList.toggle('expanded');
    arrow.textContent = expanded ? '▼' : '▶';
  });

  return { header, children };
}

function createLoreEntryItem(child, indent) {
  const label = child.entry.comment || `entry_${child.index}`;
  const el = createTreeItem(label, '·', indent);
  const idx = child.index;
  el.addEventListener('click', () => {
    openTab(`lore_${idx}`, label, '_loreform',
      () => fileData.lorebook[idx],
      (v) => { Object.assign(fileData.lorebook[idx], v); }
    );
  });
  // Lorebook entry right-click: rename / copy path / backup / delete
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const items = [
      { label: '이름 변경', action: () => renameLorebook(idx) },
      { label: 'MCP 경로 복사', action: () => { navigator.clipboard.writeText(`read_lorebook(${idx})`); setStatus(`복사됨: read_lorebook(${idx})`); } },
    ];
    const store = backupStore[`lore_${idx}`] || [];
    if (store.length > 0) {
      items.push('---');
      items.push({ label: '백업 불러오기', action: () => showBackupMenu(`lore_${idx}`, e.clientX, e.clientY) });
    }
    items.push('---');
    items.push({ label: '삭제', action: () => deleteLorebook(idx) });
    showContextMenu(e.clientX, e.clientY, items);
  });
  return el;
}

function updateSidebarActive() {
  const items = document.querySelectorAll('.tree-item');
  const tab = activeTabId ? openTabs.find(t => t.id === activeTabId) : null;
  const targetLabel = tab ? tab.label : null;
  items.forEach(el => {
    el.classList.toggle('active', targetLabel !== null && el.dataset.label === targetLabel);
  });
}

// ==================== Sidebar Actions ====================

// --- Lorebook ---
function addNewLorebook() {
  if (!fileData) return;
  const newEntry = {
    key: '',
    content: '',
    comment: `new_entry_${fileData.lorebook.length}`,
    mode: 'normal',
    insertorder: 100,
    alwaysActive: false,
    forceActivation: false,
    selective: false,
    secondkey: '',
    constant: false,
    order: fileData.lorebook.length,
    folder: ''
  };
  fileData.lorebook.push(newEntry);
  dirtyFields.add('lorebook');
  buildSidebar();
  const idx = fileData.lorebook.length - 1;
  openTab(`lore_${idx}`, newEntry.comment, '_loreform',
    () => fileData.lorebook[idx],
    (v) => { Object.assign(fileData.lorebook[idx], v); }
  );
  setStatus('새 로어북 항목 추가됨');
}

async function addNewLorebookFolder() {
  if (!fileData) return;
  const name = await showPrompt('폴더 이름을 입력하세요', '새 폴더');
  if (!name) return;
  const folderId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const newFolder = {
    key: folderId,
    content: '',
    comment: name,
    mode: 'folder',
    insertorder: 100,
    alwaysActive: false,
    forceActivation: false,
    selective: false,
    secondkey: '',
    constant: false,
    order: fileData.lorebook.length,
    folder: ''
  };
  fileData.lorebook.push(newFolder);
  buildSidebar();
  dirtyFields.add('lorebook');
  setStatus(`로어북 폴더 추가: ${name}`);
}

async function importLorebook() {
  if (!fileData) return;
  const imported = await window.tokiAPI.importJson();
  if (!imported || imported.length === 0) return;

  let addedCount = 0;
  for (const { fileName, data } of imported) {
    const entries = Array.isArray(data) ? data : (data.entries || [data]);
    for (const entry of entries) {
      fileData.lorebook.push({
        key: entry.key || (entry.keys ? entry.keys.join(', ') : ''),
        content: entry.content || '',
        comment: entry.comment || entry.name || fileName.replace('.json', ''),
        mode: entry.mode || 'normal',
        insertorder: entry.insertorder || entry.insertion_order || 100,
        alwaysActive: entry.alwaysActive || entry.constant || false,
        forceActivation: entry.forceActivation || false,
        selective: entry.selective || false,
        secondkey: entry.secondkey || (entry.secondary_keys ? entry.secondary_keys.join(', ') : ''),
        constant: entry.constant || false,
        order: fileData.lorebook.length,
        folder: entry.folder || ''
      });
      addedCount++;
    }
  }

  buildSidebar();
  setStatus(`로어북 ${addedCount}개 항목 가져옴`);
}

async function deleteLorebook(idx) {
  if (!fileData || idx < 0 || idx >= fileData.lorebook.length) return;
  const name = fileData.lorebook[idx].comment || `entry_${idx}`;
  if (!await showConfirm(`"${name}" 로어북 항목을 삭제하시겠습니까?`)) return;

  closeTab(`lore_${idx}`);
  fileData.lorebook.splice(idx, 1);
  buildSidebar();
  setStatus(`로어북 항목 삭제됨: ${name}`);
}

async function renameLorebook(idx) {
  if (!fileData || idx < 0 || idx >= fileData.lorebook.length) return;
  const oldName = fileData.lorebook[idx].comment || `entry_${idx}`;
  const newName = await showPrompt('새 이름:', oldName);
  if (!newName || newName === oldName) return;
  fileData.lorebook[idx].comment = newName;
  buildSidebar();
  setStatus(`로어북 항목 이름 변경: ${newName}`);
}

// --- Regex ---
function addNewRegex() {
  if (!fileData) return;
  const newRegex = {
    comment: `new_regex_${fileData.regex.length}`,
    in: '',
    out: '',
    type: 'editInput',
    ableFlag: true,
    flag: '',
    replaceOrder: 0
  };
  fileData.regex.push(newRegex);
  buildSidebar();
  const idx = fileData.regex.length - 1;
  openTab(`regex_${idx}`, newRegex.comment, '_regexform',
    () => fileData.regex[idx],
    (v) => { Object.assign(fileData.regex[idx], v); }
  );
  setStatus('새 정규식 항목 추가됨');
}

async function importRegex() {
  if (!fileData) return;
  const imported = await window.tokiAPI.importJson();
  if (!imported || imported.length === 0) return;

  let addedCount = 0;
  for (const { fileName, data } of imported) {
    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
      fileData.regex.push({
        comment: entry.comment || entry.name || fileName.replace('.json', ''),
        in: entry.in || entry.findRegex || '',
        out: entry.out || entry.replaceString || '',
        type: entry.type || 'editDisplay',
        ableFlag: entry.ableFlag !== undefined ? entry.ableFlag : true
      });
      addedCount++;
    }
  }

  buildSidebar();
  setStatus(`정규식 ${addedCount}개 항목 가져옴`);
}

async function deleteRegex(idx) {
  if (!fileData || idx < 0 || idx >= fileData.regex.length) return;
  const name = fileData.regex[idx].comment || `regex_${idx}`;
  if (!await showConfirm(`"${name}" 정규식을 삭제하시겠습니까?`)) return;

  closeTab(`regex_${idx}`);
  fileData.regex.splice(idx, 1);
  buildSidebar();
  setStatus(`정규식 삭제됨: ${name}`);
}

async function renameRegex(idx) {
  if (!fileData || idx < 0 || idx >= fileData.regex.length) return;
  const oldName = fileData.regex[idx].comment || `regex_${idx}`;
  const newName = await showPrompt('새 이름:', oldName);
  if (!newName || newName === oldName) return;
  fileData.regex[idx].comment = newName;
  buildSidebar();
  setStatus(`정규식 이름 변경: ${newName}`);
}

// --- Assets ---
async function addAssetFromDialog(targetFolder) {
  const added = await window.tokiAPI.addAsset(targetFolder || 'other');
  if (!added || added.length === 0) return;
  buildSidebar();
  setStatus(`에셋 ${added.length}개 추가됨`);
}

function attachAssetContextMenu(el, assetPath, fileName) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: '이름 변경', action: async () => {
        const newName = await showPrompt('새 파일명:', fileName);
        if (!newName || newName === fileName) return;
        const newPath = await window.tokiAPI.renameAsset(assetPath, newName);
        if (newPath) {
          buildSidebar();
          setStatus(`에셋 이름 변경: ${newName}`);
        }
      }},
      '---',
      { label: '삭제', action: async () => {
        if (!await showConfirm(`"${fileName}" 에셋을 삭제하시겠습니까?`)) return;
        const ok = await window.tokiAPI.deleteAsset(assetPath);
        if (ok) {
          closeTab(`img_${assetPath}`);
          buildSidebar();
          setStatus(`에셋 삭제됨: ${fileName}`);
        }
      }}
    ]);
  });
}

// --- Lua Sections ---

// Flexible section delimiter detection
// Supports: -- ===== name =====
//           -- ================== name ==================
//           -- ==========================================  (standalone)
//           --====================================       (no space)
//           --- ===== name =====                         (triple hyphen)
function detectLuaSection(line) {
  const trimmed = line.trim();
  // Must start with -- (2 or 3 hyphens)
  if (!/^-{2,3}/.test(trimmed)) return null;

  // Check for = signs (at least 3 consecutive)
  const eqGroups = trimmed.match(/={3,}/g);
  if (!eqGroups) return null;

  // Total = count must be at least 6 to be a real delimiter
  const totalEq = eqGroups.reduce((sum, m) => sum + m.length, 0);
  if (totalEq < 6) return null;

  // Try inline name: -- ===== name =====
  const inlineMatch = trimmed.match(/^-{2,3}\s*={3,}\s+(.+?)\s+={3,}\s*$/);
  if (inlineMatch) return inlineMatch[1].trim();

  // Standalone separator: -- ==================== (no name)
  if (/^-{2,3}\s*={6,}\s*$/.test(trimmed)) return '';

  return null;
}

function parseLuaSections(luaCode) {
  if (!luaCode || !luaCode.trim()) {
    return [{ name: 'main', content: '' }];
  }

  const lines = luaCode.split('\n');
  const sections = [];
  let currentName = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionName = detectLuaSection(line);

    if (sectionName !== null) {
      // Save previous section
      if (currentName !== null) {
        sections.push({ name: currentName, content: currentLines.join('\n').trim() });
      }

      if (sectionName === '') {
        // Standalone separator — look at next line for a comment-based name
        const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
        const commentMatch = nextLine.match(/^--\s*(.+)$/);
        if (commentMatch && detectLuaSection(nextLine) === null) {
          currentName = commentMatch[1].trim();
          i++; // skip the name line (it becomes part of the section header)
          // Also skip closing separator if present: -- ====\n-- name\n-- ====
          const closingLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
          if (detectLuaSection(closingLine) !== null) {
            i++; // skip the closing separator
          }
        } else {
          currentName = `section_${sections.length}`;
        }
      } else {
        // Inline name: -- ===== name =====
        // Also skip closing separator if next line is one
        const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
        if (nextLine && detectLuaSection(nextLine) === '') {
          i++; // skip redundant closing separator
        }
        currentName = sectionName;
      }
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Save last section
  if (currentName !== null) {
    sections.push({ name: currentName, content: currentLines.join('\n').trim() });
  }

  // No section markers found → single "main" section
  if (sections.length === 0) {
    sections.push({ name: 'main', content: luaCode.trim() });
  }

  // Post-process: merge empty sections with the following section
  // This handles the pattern where a named header is followed by a "section_N" header
  // e.g. "-- ===== 이름 =====\n\n-- ===== section_1 =====" → named section is empty
  const merged = [];
  for (let i = 0; i < sections.length; i++) {
    if (!sections[i].content && i + 1 < sections.length) {
      // Empty section: give its name to the next section (which has the actual content)
      merged.push({ name: sections[i].name, content: sections[i + 1].content });
      i++; // skip next
    } else {
      merged.push(sections[i]);
    }
  }

  return merged;
}

function combineLuaSections() {
  return luaSections
    .map(s => `-- ===== ${s.name} =====\n${s.content}`)
    .join('\n\n');
}

// --- CSS Sections ---
// Supports two header formats:
// 1) Single-line: /* ===== name ===== */
// 2) Multi-line block:
//    /* ============================================================
//       Section Name
//       ============================================================ */

function detectCssSectionInline(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/*') || !trimmed.endsWith('*/')) return null;
  const inner = trimmed.slice(2, -2).trim();
  const eqGroups = inner.match(/={3,}/g);
  if (!eqGroups) return null;
  const totalEq = eqGroups.reduce((sum, m) => sum + m.length, 0);
  if (totalEq < 6) return null;
  const inlineMatch = inner.match(/^={3,}\s+(.+?)\s+={3,}$/);
  if (inlineMatch) return inlineMatch[1].trim();
  return null;
}

function detectCssBlockOpen(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/*')) return false;
  if (trimmed.endsWith('*/')) return false;
  const after = trimmed.slice(2).trim();
  return /^={6,}$/.test(after);
}

function detectCssBlockClose(line) {
  const trimmed = line.trim();
  if (!trimmed.endsWith('*/')) return false;
  const before = trimmed.slice(0, -2).trim();
  return /^={6,}$/.test(before);
}

let _cssStylePrefix = '';
let _cssStyleSuffix = '';

function parseCssSections(cssCode) {
  _cssStylePrefix = '';
  _cssStyleSuffix = '';
  if (!cssCode || !cssCode.trim()) return [{ name: 'main', content: '' }];

  // Preserve <style> wrapper if present
  let work = cssCode;
  const openMatch = work.match(/^(\s*<style[^>]*>\s*\n?)/i);
  const closeMatch = work.match(/(\n?\s*<\/style>\s*)$/i);
  if (openMatch && closeMatch) {
    _cssStylePrefix = openMatch[1];
    _cssStyleSuffix = closeMatch[1];
    work = work.slice(openMatch[1].length, work.length - closeMatch[1].length);
  }

  const lines = work.split('\n');
  const sections = [];
  let currentName = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check single-line: /* ===== name ===== */
    const inlineName = detectCssSectionInline(line);
    if (inlineName !== null) {
      if (currentName !== null) {
        sections.push({ name: currentName, content: currentLines.join('\n').trim() });
      }
      currentName = inlineName;
      currentLines = [];
      continue;
    }

    // Check multi-line block open: /* ====...====
    if (detectCssBlockOpen(line)) {
      const nameLines = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (detectCssBlockClose(lines[j])) {
          closed = true;
          break;
        }
        const text = lines[j].trim();
        if (text) nameLines.push(text);
        j++;
      }
      if (closed && nameLines.length > 0) {
        if (currentName !== null) {
          sections.push({ name: currentName, content: currentLines.join('\n').trim() });
        }
        currentName = nameLines[0];
        currentLines = [];
        i = j;
        continue;
      }
    }

    currentLines.push(line);
  }

  if (currentName !== null) {
    sections.push({ name: currentName, content: currentLines.join('\n').trim() });
  }
  if (sections.length === 0) {
    sections.push({ name: 'main', content: cssCode.trim() });
  }
  const merged = [];
  for (let i = 0; i < sections.length; i++) {
    if (!sections[i].content && i + 1 < sections.length) {
      merged.push({ name: sections[i].name, content: sections[i + 1].content });
      i++;
    } else {
      merged.push(sections[i]);
    }
  }
  return merged;
}

let cssSections = [];

function combineCssSections() {
  const eq = '============================================================';
  const body = cssSections.map(s =>
    `/* ${eq}\n   ${s.name}\n   ${eq} */\n${s.content}`
  ).join('\n\n');
  const prefix = _cssStylePrefix || '<style>\n';
  const suffix = _cssStyleSuffix || '\n</style>';
  return prefix + body + suffix;
}

async function addLuaSection() {
  if (!fileData) return;
  const name = await showPrompt('새 Lua 섹션 이름:', `section_${luaSections.length}`);
  if (!name) return;

  luaSections.push({ name, content: '' });
  fileData.lua = combineLuaSections();
  buildSidebar();

  const idx = luaSections.length - 1;
  openTab(`lua_s${idx}`, name, 'lua',
    () => luaSections[idx].content,
    (v) => {
      luaSections[idx].content = v;
      fileData.lua = combineLuaSections();
    }
  );
  setStatus(`Lua 섹션 추가됨: ${name}`);
}

async function renameLuaSection(idx) {
  if (idx < 0 || idx >= luaSections.length) return;
  const oldName = luaSections[idx].name;
  const newName = await showPrompt('새 이름:', oldName);
  if (!newName || newName === oldName) return;

  luaSections[idx].name = newName;
  fileData.lua = combineLuaSections();
  buildSidebar();
  setStatus(`Lua 섹션 이름 변경: ${newName}`);
}

async function deleteLuaSection(idx) {
  if (idx < 0 || idx >= luaSections.length) return;
  const name = luaSections[idx].name;
  if (!await showConfirm(`"${name}" Lua 섹션을 삭제하시겠습니까?`)) return;

  closeTab(`lua_s${idx}`);
  luaSections.splice(idx, 1);
  fileData.lua = combineLuaSections();
  buildSidebar();
  setStatus(`Lua 섹션 삭제됨: ${name}`);
}

// --- CSS Section Management ---

async function addCssSection() {
  if (!fileData) return;
  const name = await showPrompt('새 CSS 섹션 이름:', `section_${cssSections.length}`);
  if (!name) return;

  cssSections.push({ name, content: '' });
  fileData.css = combineCssSections();
  buildSidebar();

  const idx = cssSections.length - 1;
  openTab(`css_s${idx}`, name, 'css',
    () => cssSections[idx].content,
    (v) => {
      cssSections[idx].content = v;
      fileData.css = combineCssSections();
    }
  );
  setStatus(`CSS 섹션 추가됨: ${name}`);
}

async function renameCssSection(idx) {
  if (idx < 0 || idx >= cssSections.length) return;
  const oldName = cssSections[idx].name;
  const newName = await showPrompt('새 이름:', oldName);
  if (!newName || newName === oldName) return;

  cssSections[idx].name = newName;
  fileData.css = combineCssSections();
  buildSidebar();
  setStatus(`CSS 섹션 이름 변경: ${newName}`);
}

async function deleteCssSection(idx) {
  if (idx < 0 || idx >= cssSections.length) return;
  const name = cssSections[idx].name;
  if (!await showConfirm(`"${name}" CSS 섹션을 삭제하시겠습니까?`)) return;

  closeTab(`css_s${idx}`);
  cssSections.splice(idx, 1);
  fileData.css = combineCssSections();
  buildSidebar();
  setStatus(`CSS 섹션 삭제됨: ${name}`);
}

// ==================== Backup System ====================

function createBackup(tabId, content) {
  if (!content && content !== '') return;
  if (!backupStore[tabId]) backupStore[tabId] = [];
  const store = backupStore[tabId];

  // Deep copy objects to prevent reference mutation
  const stored = (typeof content === 'object' && content !== null) ? JSON.parse(JSON.stringify(content)) : content;

  // Skip duplicate of same content
  const lastStr = store.length > 0 ? (typeof store[store.length - 1].content === 'object' ? JSON.stringify(store[store.length - 1].content) : store[store.length - 1].content) : null;
  const curStr = typeof stored === 'object' ? JSON.stringify(stored) : stored;
  if (lastStr !== null && lastStr === curStr) return;

  store.push({ time: new Date(), content: stored });
  while (store.length > MAX_BACKUPS) store.shift();
}

function showBackupMenu(tabId, x, y) {
  const store = backupStore[tabId] || [];
  if (store.length === 0) {
    setStatus('백업이 없습니다');
    return;
  }

  // Show as MomoTalk popup with preview
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;';
  const popup = document.createElement('div');
  popup.className = 'settings-popup';
  popup.style.cssText += 'width:520px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;';

  const header = document.createElement('div');
  header.className = 'help-popup-header';
  header.innerHTML = `<span>백업 불러오기 — ${tabId}</span>`;
  const closeBtn = document.createElement('span');
  closeBtn.className = 'help-popup-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.style.cssText = 'padding:8px;overflow-y:auto;flex:1;min-height:0;';

  // Preview area
  const previewBox = document.createElement('pre');
  previewBox.style.cssText = 'background:var(--bg-primary);border:1px solid var(--border-color);border-radius:4px;padding:8px;font-size:11px;color:var(--text-primary);max-height:180px;overflow:auto;margin:0 0 8px;white-space:pre-wrap;word-break:break-all;';
  previewBox.textContent = '항목을 선택하면 미리보기가 표시됩니다.';

  // List of backup versions
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-bottom:8px;';

  function getPreviewText(content) {
    if (typeof content === 'string') return content;
    try { return JSON.stringify(content, null, 2); } catch { return String(content); }
  }

  let selectedIdx = null;
  const rows = [];

  for (let i = store.length - 1; i >= 0; i--) {
    const backup = store[i];
    const ver = i + 1;
    const preview = getPreviewText(backup.content);
    const snippet = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;
    const lenStr = typeof backup.content === 'string' ? `${backup.content.length}자` : '';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;font-size:12px;color:var(--text-primary);border:1px solid var(--border-color);transition:background 0.15s;';
    row.innerHTML = `<span style="font-weight:700;min-width:28px;color:var(--accent);">v${ver}</span>`
      + `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:11px;">${snippet}</span>`
      + `<span style="font-size:10px;color:var(--text-secondary);white-space:nowrap;">${lenStr} · ${formatBackupTime(backup.time)}</span>`;

    const idx = i;
    row.addEventListener('click', () => {
      selectedIdx = idx;
      previewBox.textContent = getPreviewText(store[idx].content).slice(0, 2000);
      rows.forEach(r => r.style.background = '');
      row.style.background = 'var(--accent-light)';
    });
    row.addEventListener('mouseenter', () => { if (selectedIdx !== idx) row.style.background = 'var(--bg-secondary)'; });
    row.addEventListener('mouseleave', () => { if (selectedIdx !== idx) row.style.background = ''; });
    list.appendChild(row);
    rows.push(row);
  }

  // Restore button
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:4px 0;';
  const btnRestore = document.createElement('button');
  btnRestore.textContent = '복원';
  btnRestore.style.cssText = 'padding:6px 20px;border:none;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;';
  btnRestore.addEventListener('click', () => {
    if (selectedIdx === null) { setStatus('버전을 선택하세요'); return; }
    overlay.remove();
    restoreBackup(tabId, selectedIdx);
  });
  const btnCancel = document.createElement('button');
  btnCancel.textContent = '취소';
  btnCancel.style.cssText = 'padding:6px 20px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;';
  btnCancel.addEventListener('click', () => overlay.remove());
  btnRow.appendChild(btnCancel);
  btnRow.appendChild(btnRestore);

  body.appendChild(list);
  body.appendChild(previewBox);
  body.appendChild(btnRow);
  popup.appendChild(header);
  popup.appendChild(body);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function restoreBackup(tabId, backupIdx) {
  const store = backupStore[tabId];
  if (!store || !store[backupIdx]) return;

  const backup = store[backupIdx];

  // Find the matching tab or open it
  const tab = openTabs.find(t => t.id === tabId);
  if (tab) {
    // Backup current content before restoring
    if (editorInstance && activeTabId === tabId) {
      createBackup(tabId, editorInstance.getValue());
    }
    tab.setValue(backup.content);
    // Refresh editor if it's the active tab
    if (activeTabId === tabId && editorInstance) {
      editorInstance.setValue(backup.content);
    }
  } else {
    // Tab not open - need to update the data directly
    // For lua sections
    if (tabId.startsWith('lua_s')) {
      const idx = parseInt(tabId.replace('lua_s', ''), 10);
      if (luaSections[idx]) {
        luaSections[idx].content = backup.content;
        fileData.lua = combineLuaSections();
      }
    } else if (tabId === 'lua') {
      fileData.lua = backup.content;
      luaSections = parseLuaSections(backup.content);
    } else if (tabId === 'css') {
      fileData.css = backup.content;
      cssSections = parseCssSections(backup.content);
    } else if (tabId.startsWith('lore_')) {
      const idx = parseInt(tabId.replace('lore_', ''), 10);
      if (fileData.lorebook[idx]) {
        if (typeof backup.content === 'object') {
          Object.assign(fileData.lorebook[idx], backup.content);
        } else {
          fileData.lorebook[idx].content = backup.content;
        }
      }
    } else if (tabId.startsWith('regex_')) {
      const idx = parseInt(tabId.replace('regex_', ''), 10);
      if (fileData.regex[idx]) {
        if (typeof backup.content === 'object') {
          Object.assign(fileData.regex[idx], backup.content);
        } else {
          try { Object.assign(fileData.regex[idx], JSON.parse(backup.content)); } catch (e) { /* skip */ }
        }
      }
    } else if (fileData[tabId] !== undefined) {
      fileData[tabId] = backup.content;
    }
  }

  setStatus(`백업 v${backupIdx + 1} 복원됨 (${formatBackupTime(backup.time)})`);
}

function formatBackupTime(date) {
  const mon = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${mon}/${day} ${h}:${m}:${s}`;
}

// ==================== Drag & Drop ====================
function readFileAsBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
}

function initDragDrop() {
  const sidebar = document.getElementById('sidebar');

  sidebar.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sidebar.classList.add('drop-highlight');
  });

  sidebar.addEventListener('dragleave', (e) => {
    e.preventDefault();
    sidebar.classList.remove('drop-highlight');
  });

  sidebar.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    sidebar.classList.remove('drop-highlight');

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    let jsonCount = 0, imgCount = 0, charxCount = 0;

    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();

      // .charx/.risum files → add as reference (works even without main file open)
      if (ext === 'charx' || ext === 'risum') {
        if (referenceFiles.some(r => r.fileName === file.name)) {
          setStatus(`이미 로드됨: ${file.name}`);
          continue;
        }
        const ref = await window.tokiAPI.openReferencePath(file.path);
        if (ref) {
          referenceFiles.push(ref);
          charxCount++;
        }
        continue;
      }

      if (!fileData) {
        setStatus('파일을 먼저 열어주세요');
        return;
      }

      if (ext === 'json') {
        const text = await file.text();
        try {
          const data = JSON.parse(text);
          const entries = Array.isArray(data) ? data : [data];
          // Detect regex vs lorebook: regex has "in"/"findRegex" or type "editDisplay"/"editInput"
          const isRegex = entries.some(e =>
            e.in !== undefined || e.findRegex !== undefined ||
            e.type === 'editDisplay' || e.type === 'editInput'
          );

          if (isRegex) {
            for (const entry of entries) {
              fileData.regex.push({
                comment: entry.comment || entry.name || file.name.replace('.json', ''),
                in: entry.in || entry.findRegex || '',
                out: entry.out || entry.replaceString || '',
                type: entry.type || 'editDisplay',
                ableFlag: entry.ableFlag !== undefined ? entry.ableFlag : true
              });
            }
          } else {
            const lbEntries = data.entries || entries;
            for (const entry of lbEntries) {
              fileData.lorebook.push({
                key: entry.key || (entry.keys ? entry.keys.join(', ') : ''),
                content: entry.content || '',
                comment: entry.comment || entry.name || file.name.replace('.json', ''),
                mode: entry.mode || 'normal',
                insertorder: entry.insertorder || entry.insertion_order || 100,
                alwaysActive: entry.alwaysActive || entry.constant || false,
                forceActivation: entry.forceActivation || false,
                selective: entry.selective || false,
                secondkey: entry.secondkey || (entry.secondary_keys ? entry.secondary_keys.join(', ') : ''),
                constant: entry.constant || false,
                order: fileData.lorebook.length,
                folder: entry.folder || ''
              });
            }
          }
          jsonCount++;
        } catch (err) {
          console.warn('[drag-drop] Invalid JSON:', file.name, err);
        }
      } else if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
        const base64 = await readFileAsBase64(file);
        const result = await window.tokiAPI.addAssetBuffer(file.name, base64);
        if (result) imgCount++;
      }
    }

    buildSidebar();
    const parts = [];
    if (charxCount > 0) parts.push(`참고 파일 ${charxCount}개`);
    if (jsonCount > 0) parts.push(`JSON ${jsonCount}개`);
    if (imgCount > 0) parts.push(`이미지 ${imgCount}개`);
    if (parts.length > 0) {
      setStatus(`드래그 드롭: ${parts.join(', ')} 추가됨`);
    }
  });
}

// ==================== Terminal (xterm.js + node-pty) ====================
let term = null;
let fitAddon = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadXtermCSS() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '../../node_modules/@xterm/xterm/css/xterm.css';
  document.head.appendChild(link);
}

async function initTerminal() {
  loadXtermCSS();

  // Temporarily hide AMD define so xterm doesn't conflict with Monaco's loader
  const savedDefine = window.define;
  const savedRequire = window.require;
  window.define = undefined;
  window.require = undefined;

  await loadScript('../../node_modules/@xterm/xterm/lib/xterm.js');
  await loadScript('../../node_modules/@xterm/addon-fit/lib/addon-fit.js');

  const Terminal = window.Terminal?.Terminal || window.Terminal;
  const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;

  // Restore AMD loader
  window.define = savedDefine;
  window.require = savedRequire;

  const container = document.getElementById('terminal-container');
  container.innerHTML = '';

  term = new Terminal({
    theme: darkMode ? TERM_THEME_DARK : TERM_THEME_LIGHT,
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
    cursorBlink: true,
    scrollback: 5000,
    rightClickSelectsWord: true,
    allowTransparency: true
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Make xterm scrollbar draggable: viewport is z-index:1 (on top),
  // forward content-area clicks to the screen element below
  const vp = container.querySelector('.xterm-viewport');
  if (vp) {
    ['mousedown', 'dblclick', 'contextmenu', 'auxclick'].forEach(evt => {
      vp.addEventListener(evt, (e) => {
        const sw = vp.offsetWidth - vp.clientWidth;
        const rect = vp.getBoundingClientRect();
        if (e.clientX >= rect.right - sw - 2) return; // scrollbar area — let native handle
        e.stopPropagation();
        e.preventDefault();
        vp.style.pointerEvents = 'none';
        const el = document.elementFromPoint(e.clientX, e.clientY);
        vp.style.pointerEvents = '';
        if (el) el.dispatchEvent(new MouseEvent(evt, e));
      });
    });
  }

  // Wait a frame for layout
  await new Promise(r => setTimeout(r, 50));
  fitAddon.fit();

  // Start pty
  await window.tokiAPI.terminalStart(term.cols, term.rows);

  // Wire data
  let tokiIdleTimer = null;
  term.onData((data) => {
    lastUserInputTime = Date.now();
    window.tokiAPI.terminalInput(data);
  });
  window.tokiAPI.onTerminalData((data) => {
    term.write(data);
    // Feed data to chat view if active
    if (chatMode) onChatData(data);
    // Always collect in background buffer for chat switchover
    feedBgBuffer(data);
    // Echo filter: only activate avatar when Claude is responding (not user typing echo)
    const isEcho = (Date.now() - lastUserInputTime) < 300;
    if (!isEcho) {
      setTokiActive(true);
      if (tokiIdleTimer) clearTimeout(tokiIdleTimer);
      tokiIdleTimer = setTimeout(() => setTokiActive(false), 1500);
      // BGM: play during terminal activity (only for Claude responses)
      bgmOnTerminalData();
    }
  });

  // Copy/Paste: Ctrl+C (when selection exists) = copy, Ctrl+Shift+V or Ctrl+V = paste, right-click = paste
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+C with selection → copy
    if (e.ctrlKey && e.key === 'c' && e.type === 'keydown' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false; // prevent sending to pty
    }
    // Ctrl+V → paste (block both keydown and keyup to prevent double paste)
    if (e.ctrlKey && e.key === 'v') {
      if (e.type === 'keydown') {
        navigator.clipboard.readText().then(text => {
          if (text) window.tokiAPI.terminalInput(text);
        });
      }
      return false;
    }
    return true;
  });

  // Right-click → paste
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    navigator.clipboard.readText().then(text => {
      if (text) window.tokiAPI.terminalInput(text);
    });
  });

  window.tokiAPI.onTerminalExit(() => {
    term.writeln('\r\n[프로세스 종료]');
  });

  // Resize observer
  const resizeObs = new ResizeObserver(() => {
    if (fitAddon && term) {
      fitAddon.fit();
      window.tokiAPI.terminalResize(term.cols, term.rows);
    }
  });
  resizeObs.observe(container);
}

// ==================== Form Editors (Lorebook / Regex) ====================

function disposeFormEditors() {
  for (const ed of formEditors) {
    try { ed.dispose(); } catch (e) { /* ignore */ }
  }
  formEditors = [];
}

function createMiniMonaco(container, value, language, onChange) {
  if (!monacoReady) return null;

  // Ensure theme is defined
  if (!window._baThemeDefined) {
    // Theme will be defined when createOrSwitchEditor runs for a normal tab
    // For now define a minimal version
    monaco.editor.defineTheme('blue-archive', { base: 'vs', inherit: true, rules: [], colors: {} });
    window._baThemeDefined = true;
  }
  if (darkMode && !window._baDarkThemeDefined) {
    defineDarkMonacoTheme();
  }

  const ed = monaco.editor.create(container, {
    value: value || '',
    language: language,
    theme: darkMode ? 'blue-archive-dark' : 'blue-archive',
    fontSize: 13,
    minimap: { enabled: false },
    wordWrap: 'on',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    glyphMargin: false,
    folding: false,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: { vertical: 'auto', horizontal: 'auto' },
    tabSize: 2,
  });

  ed.onDidChangeModelContent(() => {
    if (onChange) onChange(ed.getValue());
  });

  formEditors.push(ed);
  return ed;
}

function showLoreEditor(tabInfo) {
  const container = document.getElementById('editor-container');

  // Save current Monaco state
  if (editorInstance && activeTabId !== tabInfo.id) {
    const curTab = openTabs.find(t => t.id === activeTabId);
    if (curTab && !FORM_TAB_TYPES.has(curTab.language) && curTab.setValue) {
      curTab._lastValue = editorInstance.getValue();
      curTab.setValue(curTab._lastValue);
    }
  }

  disposeFormEditors();
  container.innerHTML = '';
  if (editorInstance) { editorInstance.dispose(); editorInstance = null; }

  const data = tabInfo.getValue();
  if (!data) return;

  const readonly = !tabInfo.setValue;
  const markDirty = () => {
    if (readonly) return;
    // First-change backup (save original before modification)
    if (!dirtyFields.has(tabInfo.id)) {
      createBackup(tabInfo.id, data);
    }
    tabInfo.setValue(data);
    dirtyFields.add(tabInfo.id);
    updateTabUI();
  };

  // Build form HTML
  const form = document.createElement('div');
  form.className = 'form-editor';

  // Header
  const header = document.createElement('div');
  header.className = 'form-editor-header';
  header.innerHTML = `<span>📚 로어북: ${data.comment || tabInfo.label}</span>`;
  if (readonly) {
    const badge = document.createElement('span');
    badge.style.cssText = 'font-size:10px;color:var(--accent);margin-left:8px;';
    badge.textContent = '[읽기 전용]';
    header.querySelector('span').appendChild(badge);
  }

  // Body
  const body = document.createElement('div');
  body.className = 'form-editor-body';

  // Helper: create text input row
  function addTextRow(labelText, field) {
    const row = document.createElement('div');
    row.className = 'form-row';
    const lbl = document.createElement('span');
    lbl.className = 'form-label';
    lbl.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'form-input';
    input.type = 'text';
    input.value = data[field] || '';
    if (readonly) { input.readOnly = true; } else {
      input.addEventListener('input', () => {
        data[field] = input.value;
        markDirty();
      });
    }
    row.appendChild(lbl);
    row.appendChild(input);
    body.appendChild(row);
    return input;
  }

  // Helper: create number input
  function addNumberRow(labelText, field) {
    const row = document.createElement('div');
    row.className = 'form-row';
    const lbl = document.createElement('span');
    lbl.className = 'form-label';
    lbl.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'form-input form-number';
    input.type = 'number';
    input.value = data[field] ?? 100;
    if (readonly) { input.readOnly = true; } else {
      input.addEventListener('input', () => {
        data[field] = parseInt(input.value, 10) || 0;
        markDirty();
      });
    }
    row.appendChild(lbl);
    row.appendChild(input);
    return row;
  }

  addTextRow('이름', 'comment');

  // Folder dropdown (show folder names, not UUIDs)
  const folderRow = document.createElement('div');
  folderRow.className = 'form-row';
  const folderLbl = document.createElement('span');
  folderLbl.className = 'form-label';
  folderLbl.textContent = '폴더';
  const folderSelect = document.createElement('select');
  folderSelect.className = 'form-select';
  folderSelect.style.flex = '1';
  if (readonly) folderSelect.disabled = true;

  // Build folder options from lorebook (use ref source if readonly)
  const loreSource = tabInfo._refLorebook || (fileData ? fileData.lorebook : []) || [];
  const folderEntries = loreSource
    .map((e, i) => ({ entry: e, index: i }))
    .filter(f => f.entry.mode === 'folder');

  // "(없음)" = root
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = '(없음)';
  folderSelect.appendChild(optNone);

  // "+ 새 폴더 추가" (바로 아래)
  const optNew = document.createElement('option');
  optNew.value = '__new__';
  optNew.textContent = '+ 새 폴더 추가';
  folderSelect.appendChild(optNew);

  // Existing folders
  for (const f of folderEntries) {
    const opt = document.createElement('option');
    const folderId = `folder:${f.entry.key || f.index}`;
    opt.value = folderId;
    opt.textContent = f.entry.comment || folderId;
    folderSelect.appendChild(opt);
  }

  // Select current value (match by ID or find by comment)
  if (data.folder) {
    let matched = false;
    for (const opt of folderSelect.options) {
      if (opt.value === data.folder) { opt.selected = true; matched = true; break; }
    }
    if (!matched) {
      // Try matching by stripping prefix or by comment
      for (const f of folderEntries) {
        const folderId = `folder:${f.entry.key || f.index}`;
        if (data.folder === folderId || data.folder === f.entry.key || data.folder === f.entry.comment) {
          for (const opt of folderSelect.options) {
            if (opt.value === folderId) { opt.selected = true; matched = true; break; }
          }
          if (matched) break;
        }
      }
    }
  }

  folderSelect.addEventListener('change', async () => {
    if (folderSelect.value === '__new__') {
      const name = await showPrompt('새 폴더 이름을 입력하세요', '새 폴더');
      if (!name) {
        // Revert to previous selection
        folderSelect.value = data.folder || '';
        return;
      }
      const folderId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const newFolder = {
        key: folderId, content: '', comment: name, mode: 'folder',
        insertorder: 100, alwaysActive: false, forceActivation: false,
        selective: false, secondkey: '', constant: false,
        order: fileData.lorebook.length, folder: ''
      };
      fileData.lorebook.push(newFolder);
      // Add new option before the "+ 새 폴더" option
      const newOpt = document.createElement('option');
      newOpt.value = `folder:${folderId}`;
      newOpt.textContent = name;
      folderSelect.insertBefore(newOpt, optNew);
      folderSelect.value = `folder:${folderId}`;
      data.folder = `folder:${folderId}`;
      markDirty();
      buildSidebar();
    } else {
      data.folder = folderSelect.value;
      markDirty();
    }
  });

  folderRow.appendChild(folderLbl);
  folderRow.appendChild(folderSelect);
  body.appendChild(folderRow);

  addTextRow('활성화 키', 'key');
  addTextRow('멀티플 키', 'secondkey');

  // Insert order row
  const orderRow = document.createElement('div');
  orderRow.className = 'form-row';
  const orderLbl = document.createElement('span');
  orderLbl.className = 'form-label';
  orderLbl.textContent = '배치 순서';
  const orderInput = document.createElement('input');
  orderInput.className = 'form-input form-number';
  orderInput.type = 'number';
  orderInput.value = data.insertorder ?? 100;
  if (readonly) { orderInput.readOnly = true; } else {
    orderInput.addEventListener('input', () => {
      data.insertorder = parseInt(orderInput.value, 10) || 0;
      markDirty();
    });
  }
  orderRow.appendChild(orderLbl);
  orderRow.appendChild(orderInput);
  body.appendChild(orderRow);

  // Checkboxes row
  const checks = document.createElement('div');
  checks.className = 'form-checks';

  function addCheck(labelText, field) {
    const item = document.createElement('label');
    item.className = 'form-check-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!data[field];
    if (readonly) { cb.disabled = true; } else {
      cb.addEventListener('change', () => {
        data[field] = cb.checked;
        markDirty();
      });
    }
    item.appendChild(cb);
    item.appendChild(document.createTextNode(labelText));
    checks.appendChild(item);
  }

  addCheck('언제나 활성화', 'alwaysActive');
  addCheck('강제 활성화', 'forceActivation');
  addCheck('선택적', 'selective');
  body.appendChild(checks);

  // Content label
  const contentLabel = document.createElement('div');
  contentLabel.className = 'form-section-label';
  contentLabel.textContent = '프롬프트 (content)';
  body.appendChild(contentLabel);

  // Mini Monaco for content
  const monacoContainer = document.createElement('div');
  monacoContainer.className = 'form-monaco form-monaco-lore';
  body.appendChild(monacoContainer);

  form.appendChild(header);
  form.appendChild(body);
  container.appendChild(form);

  // Create mini Monaco after DOM insertion
  setTimeout(() => {
    const ed = createMiniMonaco(monacoContainer, data.content || '', 'plaintext', readonly ? null : (val) => {
      data.content = val;
      markDirty();
    });
    if (ed && readonly) ed.updateOptions({ readOnly: true });
  }, 10);
}

function showRegexEditor(tabInfo) {
  const container = document.getElementById('editor-container');

  // Save current Monaco state
  if (editorInstance && activeTabId !== tabInfo.id) {
    const curTab = openTabs.find(t => t.id === activeTabId);
    if (curTab && !FORM_TAB_TYPES.has(curTab.language) && curTab.setValue) {
      curTab._lastValue = editorInstance.getValue();
      curTab.setValue(curTab._lastValue);
    }
  }

  disposeFormEditors();
  container.innerHTML = '';
  if (editorInstance) { editorInstance.dispose(); editorInstance = null; }

  const data = tabInfo.getValue();
  if (!data) return;

  const readonly = !tabInfo.setValue;
  const markDirty = () => {
    if (readonly) return;
    // First-change backup (save original before modification)
    if (!dirtyFields.has(tabInfo.id)) {
      createBackup(tabInfo.id, data);
    }
    tabInfo.setValue(data);
    dirtyFields.add(tabInfo.id);
    updateTabUI();
  };

  // Build form
  const form = document.createElement('div');
  form.className = 'form-editor';

  // Header
  const header = document.createElement('div');
  header.className = 'form-editor-header';
  header.innerHTML = `<span>⚡ 정규식: ${data.comment || tabInfo.label}</span>`;
  if (readonly) {
    const badge = document.createElement('span');
    badge.style.cssText = 'font-size:10px;color:var(--accent);margin-left:8px;';
    badge.textContent = '[읽기 전용]';
    header.querySelector('span').appendChild(badge);
  }

  // Toggle (ableFlag)
  const toggle = document.createElement('div');
  toggle.className = 'form-toggle' + (data.ableFlag !== false ? ' active' : '');
  toggle.title = '활성화 토글';
  if (!readonly) {
    toggle.addEventListener('click', () => {
      data.ableFlag = !toggle.classList.contains('active');
      toggle.classList.toggle('active');
      markDirty();
    });
  }
  header.appendChild(toggle);

  // Body
  const body = document.createElement('div');
  body.className = 'form-editor-body';

  // Name
  const nameRow = document.createElement('div');
  nameRow.className = 'form-row';
  const nameLbl = document.createElement('span');
  nameLbl.className = 'form-label';
  nameLbl.textContent = '이름';
  const nameInput = document.createElement('input');
  nameInput.className = 'form-input';
  nameInput.type = 'text';
  nameInput.value = data.comment || '';
  if (readonly) { nameInput.readOnly = true; } else {
    nameInput.addEventListener('input', () => {
      data.comment = nameInput.value;
      markDirty();
    });
  }
  nameRow.appendChild(nameLbl);
  nameRow.appendChild(nameInput);
  body.appendChild(nameRow);

  // Modification Type
  const typeRow = document.createElement('div');
  typeRow.className = 'form-row';
  const typeLbl = document.createElement('span');
  typeLbl.className = 'form-label';
  typeLbl.textContent = 'Type';
  const typeSelect = document.createElement('select');
  typeSelect.className = 'form-select';
  if (readonly) typeSelect.disabled = true;
  const types = [
    { value: 'editInput', label: '입력문 수정' },
    { value: 'editOutput', label: '출력문 수정' },
    { value: 'editRequest', label: '리퀘스트 데이터 수정' },
    { value: 'editDisplay', label: '디스플레이 수정' },
    { value: 'editTranslation', label: '번역문 수정' },
    { value: 'disabled', label: '비활성화됨' },
  ];
  for (const t of types) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    if (data.type === t.value) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  if (!readonly) {
    typeSelect.addEventListener('change', () => {
      data.type = typeSelect.value;
      markDirty();
    });
  }
  typeRow.appendChild(typeLbl);
  typeRow.appendChild(typeSelect);
  body.appendChild(typeRow);

  // Find (in) label + mini Monaco
  const findLabel = document.createElement('div');
  findLabel.className = 'form-section-label';
  findLabel.textContent = 'Find (in)';
  body.appendChild(findLabel);

  const findContainer = document.createElement('div');
  findContainer.className = 'form-monaco form-monaco-regex';
  body.appendChild(findContainer);

  // Replace (out) label + mini Monaco (resizable)
  const replaceLabel = document.createElement('div');
  replaceLabel.className = 'form-section-label';
  replaceLabel.textContent = 'Replace (out)';
  body.appendChild(replaceLabel);

  const replaceContainer = document.createElement('div');
  replaceContainer.className = 'form-monaco form-monaco-regex form-monaco-resizable';
  body.appendChild(replaceContainer);

  // Resize handle for replace out
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'form-monaco-resize-handle';
  body.appendChild(resizeHandle);

  // === FLAGS PANEL ===
  const flagsPanel = document.createElement('div');
  flagsPanel.className = 'regex-flags-panel';

  // Parse current flag string
  const flagStr = data.flag || '';
  const normalFlags = [
    { key: 'g', label: 'Global (g)' },
    { key: 'i', label: 'Case Insensitive (i)' },
    { key: 'm', label: 'Multi Line (m)' },
    { key: 'u', label: 'Unicode (u)' },
    { key: 's', label: 'Dot All (s)' },
  ];
  const specialFlags = [
    { key: 'T', label: 'Move Top' },
    { key: 'B', label: 'Move Bottom' },
    { key: 'R', label: 'Repeat Back' },
    { key: 'C', label: 'IN CBS Parsing' },
    { key: 'N', label: 'No Newline Suffix' },
  ];

  // Track active flags
  const activeFlags = new Set(flagStr.split(''));
  const knownKeys = new Set([...normalFlags.map(f => f.key), ...specialFlags.map(f => f.key)]);
  const customChars = flagStr.split('').filter(c => !knownKeys.has(c)).join('');
  // Determine if custom flags section should be open
  // Default closed unless there are non-default flags (more than just 'g') or custom chars
  const nonDefaultFlags = [...activeFlags].filter(f => f !== 'g');
  const hasAnyFlag = nonDefaultFlags.length > 0 || customChars.length > 0;

  // Custom flag text input (declared early for rebuildFlagString)
  const customFlagInput = document.createElement('input');
  customFlagInput.className = 'form-input';
  customFlagInput.type = 'text';
  customFlagInput.placeholder = '직접 입력...';
  customFlagInput.value = customChars;
  customFlagInput.style.cssText = 'flex:1;margin-left:8px;';

  function rebuildFlagString() {
    let result = '';
    for (const f of normalFlags) { if (activeFlags.has(f.key)) result += f.key; }
    for (const f of specialFlags) { if (activeFlags.has(f.key)) result += f.key; }
    if (customFlagInput.value) result += customFlagInput.value;
    data.flag = result;
    markDirty();
  }

  // Toggle button: "커스텀 플래그" — controls visibility of flag sections
  const flagsToggleBtn = document.createElement('button');
  flagsToggleBtn.className = 'regex-flags-toggle-btn' + (hasAnyFlag ? ' active' : '');
  flagsToggleBtn.innerHTML = `<span class="toggle-indicator">${hasAnyFlag ? '▼' : '▶'}</span> 커스텀 플래그`;
  flagsPanel.appendChild(flagsToggleBtn);

  // Flag content wrapper (hidden by default, shown when toggle ON)
  const flagsContent = document.createElement('div');
  flagsContent.style.display = hasAnyFlag ? '' : 'none';

  // Normal Flag section
  const normalLabel = document.createElement('div');
  normalLabel.className = 'regex-flags-title';
  normalLabel.textContent = 'Normal Flag';
  flagsContent.appendChild(normalLabel);

  const normalGrid = document.createElement('div');
  normalGrid.className = 'regex-flags-grid';
  for (const f of normalFlags) {
    const btn = document.createElement('button');
    btn.className = 'regex-flag-btn' + (activeFlags.has(f.key) ? ' active' : '');
    btn.textContent = f.label;
    if (readonly) { btn.disabled = true; } else {
      btn.addEventListener('click', () => {
        if (activeFlags.has(f.key)) activeFlags.delete(f.key);
        else activeFlags.add(f.key);
        btn.classList.toggle('active');
        rebuildFlagString();
      });
    }
    normalGrid.appendChild(btn);
  }
  flagsContent.appendChild(normalGrid);

  // Special Flag (Other Flag) section
  const specialLabel = document.createElement('div');
  specialLabel.className = 'regex-flags-title';
  specialLabel.textContent = 'Other Flag';
  flagsContent.appendChild(specialLabel);

  const specialGrid = document.createElement('div');
  specialGrid.className = 'regex-flags-grid';
  for (const f of specialFlags) {
    const btn = document.createElement('button');
    btn.className = 'regex-flag-btn' + (activeFlags.has(f.key) ? ' active' : '');
    btn.textContent = f.label;
    if (readonly) { btn.disabled = true; } else {
      btn.addEventListener('click', () => {
        if (activeFlags.has(f.key)) activeFlags.delete(f.key);
        else activeFlags.add(f.key);
        btn.classList.toggle('active');
        rebuildFlagString();
      });
    }
    specialGrid.appendChild(btn);
  }
  flagsContent.appendChild(specialGrid);

  // Order Flag
  const orderLabel = document.createElement('div');
  orderLabel.className = 'regex-flags-title';
  orderLabel.textContent = 'Order Flag';
  flagsContent.appendChild(orderLabel);

  const orderInput = document.createElement('input');
  orderInput.className = 'form-input form-number';
  orderInput.type = 'number';
  orderInput.value = data.replaceOrder ?? 0;
  orderInput.style.width = '100%';
  if (readonly) { orderInput.readOnly = true; } else {
    orderInput.addEventListener('input', () => {
      data.replaceOrder = parseInt(orderInput.value, 10) || 0;
      markDirty();
    });
  }
  flagsContent.appendChild(orderInput);

  // Custom Flag text row
  const customRow = document.createElement('div');
  customRow.className = 'regex-custom-flag-row';
  const customFlagLabel = document.createElement('span');
  customFlagLabel.textContent = 'Custom';
  customFlagLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
  if (readonly) { customFlagInput.readOnly = true; } else {
    customFlagInput.addEventListener('input', () => rebuildFlagString());
  }
  customRow.appendChild(customFlagLabel);
  customRow.appendChild(customFlagInput);
  flagsContent.appendChild(customRow);

  flagsPanel.appendChild(flagsContent);

  // Toggle button click handler
  flagsToggleBtn.addEventListener('click', () => {
    const isActive = flagsToggleBtn.classList.toggle('active');
    flagsContent.style.display = isActive ? '' : 'none';
    flagsToggleBtn.querySelector('.toggle-indicator').textContent = isActive ? '▼' : '▶';
  });

  body.appendChild(flagsPanel);

  form.appendChild(header);
  form.appendChild(body);
  container.appendChild(form);

  // Drag-to-resize for replace out
  let startY = 0;
  let startH = 0;
  const onResizeMove = (e) => {
    const dy = e.clientY - startY;
    replaceContainer.style.height = Math.max(40, startH + dy) + 'px';
    for (const fe of formEditors) {
      if (fe && typeof fe.getDomNode === 'function' && replaceContainer.contains(fe.getDomNode())) {
        fe.layout();
      }
    }
  };
  const onResizeUp = () => {
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
  };
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = replaceContainer.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeUp);
  });

  // Create mini Monacos after DOM insertion
  setTimeout(() => {
    const edFind = createMiniMonaco(findContainer, data.in || '', 'plaintext', readonly ? null : (val) => {
      data.in = val;
      markDirty();
    });
    const edReplace = createMiniMonaco(replaceContainer, data.out || '', 'plaintext', readonly ? null : (val) => {
      data.out = val;
      markDirty();
    });
    if (readonly) {
      if (edFind) edFind.updateOptions({ readOnly: true });
      if (edReplace) edReplace.updateOptions({ readOnly: true });
    }
  }, 10);
}

// ==================== Image Viewer ====================
function openImageTab(assetPath, fileName) {
  const tabId = `img_${assetPath}`;
  // Check if already open
  if (openTabs.find(t => t.id === tabId)) {
    activeTabId = tabId;
    showImageViewer(tabId, assetPath);
    updateTabUI();
    updateSidebarActive();
    return;
  }

  // Add tab manually (not Monaco editor)
  const tab = {
    id: tabId,
    label: fileName,
    language: '_image',
    getValue: () => '',
    setValue: () => {},
    _lastValue: null,
    _assetPath: assetPath
  };
  openTabs.push(tab);
  activeTabId = tabId;
  showImageViewer(tabId, assetPath);
  updateTabUI();
  updateSidebarActive();
}

async function showImageViewer(tabId, assetPath) {
  // Save current Monaco editor
  if (editorInstance && activeTabId !== tabId) {
    const curTab = openTabs.find(t => t.id === activeTabId);
    if (curTab && curTab.language !== '_image' && curTab.setValue) {
      curTab._lastValue = editorInstance.getValue();
      curTab.setValue(curTab._lastValue);
    }
  }

  const container = document.getElementById('editor-container');
  container.innerHTML = '';
  if (editorInstance) { editorInstance.dispose(); editorInstance = null; }

  const base64 = await window.tokiAPI.getAssetData(assetPath);
  if (!base64) {
    container.innerHTML = '<div class="empty-state">이미지를 불러올 수 없습니다</div>';
    return;
  }

  // Detect type from path
  const ext = assetPath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' :
               ext === 'webp' ? 'image/webp' :
               ext === 'gif' ? 'image/gif' : 'image/jpeg';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;width:100%;height:100%;background:#e8edf5;overflow:hidden;cursor:grab;';

  const img = document.createElement('img');
  img.src = `data:${mime};base64,${base64}`;
  img.style.cssText = 'position:absolute;top:50%;left:50%;transform-origin:0 0;border:1px solid #c8d6e5;border-radius:6px;pointer-events:none;box-shadow:0 4px 16px rgba(74,144,217,0.12);';
  img.draggable = false;
  img.title = assetPath;

  const info = document.createElement('div');
  info.style.cssText = 'position:absolute;bottom:8px;right:8px;color:#4a6a8a;font-size:11px;background:rgba(255,255,255,0.9);padding:5px 10px;border-radius:6px;z-index:10;border:1px solid #c8d6e5;';

  // Pan & Zoom state
  let scale = 1, panX = 0, panY = 0;
  let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;

  function updateTransform() {
    img.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${scale})`;
    info.textContent = `${assetPath} (${(base64.length * 0.75 / 1024).toFixed(1)} KB) — ${Math.round(scale * 100)}%`;
  }
  updateTransform();

  // Ctrl+Wheel zoom
  wrapper.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      scale = Math.max(0.05, Math.min(20, scale * factor));
      updateTransform();
    }
  }, { passive: false });

  // Left-click drag to pan (listeners added/removed per drag to avoid leaks)
  const onMove = (e) => {
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    updateTransform();
  };
  const onUp = () => {
    dragging = false;
    wrapper.style.cursor = 'grab';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  wrapper.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    wrapper.style.cursor = 'grabbing';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Double-click to reset
  wrapper.addEventListener('dblclick', () => {
    scale = 1; panX = 0; panY = 0;
    updateTransform();
  });

  wrapper.appendChild(img);
  wrapper.appendChild(info);
  container.appendChild(wrapper);
}

// ==================== Menu Bar ====================
let openMenuId = null;

function initMenuBar() {
  const menuItems = document.querySelectorAll('.menu-item');

  for (const item of menuItems) {
    const label = item.querySelector('.menu-label');

    // Click to open/close menu
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      const menuId = item.dataset.menu;
      if (openMenuId === menuId) {
        closeAllMenus();
      } else {
        openMenu(menuId);
      }
    });

    // Hover to switch when another is open
    label.addEventListener('mouseenter', () => {
      if (openMenuId && openMenuId !== item.dataset.menu) {
        openMenu(item.dataset.menu);
      }
    });
  }

  // Click menu actions
  document.querySelectorAll('.menu-action').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      executeMenuAction(el.dataset.action);
    });
  });

  // Prevent submenu parent from closing menu
  document.querySelectorAll('.menu-sub').forEach(el => {
    el.addEventListener('click', (e) => e.stopPropagation());
  });

  // Click outside closes menus
  document.addEventListener('click', () => closeAllMenus());
}

function openMenu(menuId) {
  closeAllMenus();
  const item = document.querySelector(`.menu-item[data-menu="${menuId}"]`);
  if (item) {
    item.classList.add('open');
    openMenuId = menuId;
  }
}

function closeAllMenus() {
  if (openMenuId) {
    const el = document.querySelector(`.menu-item[data-menu="${openMenuId}"]`);
    if (el) el.classList.remove('open');
  }
  openMenuId = null;
}

function executeMenuAction(action) {
  switch (action) {
    // File
    case 'new': handleNew(); break;
    case 'open': handleOpen(); break;
    case 'save': handleSave(); break;
    case 'save-as': handleSaveAs(); break;
    case 'close-tab': if (activeTabId) closeTab(activeTabId); break;

    // Edit (Monaco editor commands)
    case 'undo': if (editorInstance) editorInstance.trigger('menu', 'undo'); break;
    case 'redo': if (editorInstance) editorInstance.trigger('menu', 'redo'); break;
    case 'cut': document.execCommand('cut'); break;
    case 'copy': document.execCommand('copy'); break;
    case 'paste': document.execCommand('paste'); break;
    case 'select-all':
      if (editorInstance) editorInstance.trigger('menu', 'editor.action.selectAll');
      break;
    case 'find':
      if (editorInstance) editorInstance.trigger('menu', 'actions.find');
      break;
    case 'replace':
      if (editorInstance) editorInstance.trigger('menu', 'editor.action.startFindReplaceAction');
      break;

    // View — toggles
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'toggle-terminal': toggleTerminal(); break;
    case 'toggle-avatar': toggleAvatar(); break;
    // Items position
    case 'items-left': moveItems('left'); break;
    case 'items-right': moveItems('right'); break;
    case 'items-far-left': moveItems('far-left'); break;
    case 'items-far-right': moveItems('far-right'); break;
    case 'items-top': moveItems('top'); break;
    case 'items-bottom': moveItems('bottom'); break;
    // Refs position
    case 'refs-sidebar': moveRefs('sidebar'); break;
    case 'refs-left': moveRefs('left'); break;
    case 'refs-right': moveRefs('right'); break;
    case 'refs-far-left': moveRefs('far-left'); break;
    case 'refs-far-right': moveRefs('far-right'); break;
    case 'refs-top': moveRefs('top'); break;
    case 'refs-bottom': moveRefs('bottom'); break;
    // Terminal position
    case 'terminal-bottom': moveTerminal('bottom'); break;
    case 'terminal-left': moveTerminal('left'); break;
    case 'terminal-right': moveTerminal('right'); break;
    case 'terminal-far-left': moveTerminal('far-left'); break;
    case 'terminal-far-right': moveTerminal('far-right'); break;
    case 'terminal-top': moveTerminal('top'); break;
    // Reset
    case 'layout-reset': resetLayout(); break;
    case 'zoom-in':
      if (editorInstance) {
        const sz = editorInstance.getOption(monaco.editor.EditorOption.fontSize);
        editorInstance.updateOptions({ fontSize: sz + 1 });
      }
      break;
    case 'zoom-out':
      if (editorInstance) {
        const sz2 = editorInstance.getOption(monaco.editor.EditorOption.fontSize);
        editorInstance.updateOptions({ fontSize: Math.max(8, sz2 - 1) });
      }
      break;
    case 'zoom-reset':
      if (editorInstance) editorInstance.updateOptions({ fontSize: 14 });
      break;
    case 'toggle-dark': toggleDarkMode(); break;
    case 'preview-test': showPreviewPanel(); break;
    case 'devtools': window.tokiAPI.toggleDevTools(); break;

    // Terminal
    case 'claude-start': handleClaudeStart(); break;
    case 'codex-start': handleCodexStart(); break;
    case 'terminal-clear': if (term) term.clear(); break;
    case 'terminal-restart': restartTerminal(); break;
  }
}

// ==================== Layout Management ====================

// ==================== Slot-Based Layout System ====================

// Cached layout DOM elements (populated once)
const EL = {};
function _cacheLayoutEls() {
  if (EL._ready) return;
  EL.sidebar = document.getElementById('sidebar');
  EL.refsPanel = document.getElementById('refs-panel');
  EL.bottomArea = document.getElementById('bottom-area');
  EL.refsSection = document.getElementById('sidebar-refs-section');
  EL.splitResizer = document.getElementById('sidebar-split-resizer');
  EL.refsPanelContent = document.getElementById('refs-panel-content');
  EL.avatar = document.getElementById('toki-avatar');
  EL.termBtn = document.getElementById('btn-terminal-toggle');
  EL.sidebarExpand = document.getElementById('sidebar-expand');
  EL.sidebarRefs = document.getElementById('sidebar-refs');
  // Cache slot & resizer elements
  EL.slots = {};
  EL.resizers = {};
  for (const s of SLOT_IDS) {
    EL.slots[s] = document.getElementById('slot-' + s);
    EL.resizers[s] = document.getElementById('resizer-' + s);
  }
  EL._ready = true;
}
function getSlotEl(slotName) { return EL._ready ? EL.slots[slotName] : document.getElementById('slot-' + slotName); }
function getResizerEl(slotName) { return EL._ready ? EL.resizers[slotName] : document.getElementById('resizer-' + slotName); }

// Debounced layout refit
let _layoutRefitTimer = null;
function scheduleLayoutRefit() {
  if (_layoutRefitTimer) clearTimeout(_layoutRefitTimer);
  _layoutRefitTimer = setTimeout(() => {
    _layoutRefitTimer = null;
    if (editorInstance) editorInstance.layout();
    if (fitAddon && term) fitAddon.fit();
  }, 20);
}

function rebuildLayout() {
  _cacheLayoutEls();
  const { sidebar, refsPanel, bottomArea, refsSection, splitResizer, refsPanelContent, avatar, termBtn, sidebarExpand, sidebarRefs } = EL;

  // 1. Clear all slots
  for (const slotName of SLOT_IDS) {
    const slot = EL.slots[slotName];
    const resizer = EL.resizers[slotName];
    if (slot) { slot.innerHTML = ''; slot.classList.remove('active'); }
    if (resizer) resizer.classList.remove('active');
  }

  // 2. Determine which panels go into which slots
  const slotContents = {};
  for (const s of SLOT_IDS) slotContents[s] = [];

  // Items panel (sidebar)
  if (layoutState.itemsVisible) {
    slotContents[layoutState.itemsPos].push(sidebar);
    if (layoutState.refsPos === 'sidebar') {
      refsSection.style.display = '';
      splitResizer.style.display = '';
      refsPanel.style.display = 'none';
    } else {
      refsSection.style.display = 'none';
      splitResizer.style.display = 'none';
    }
  } else {
    sidebar.style.display = 'none';
  }

  // Refs panel (when separated) — move DOM nodes instead of innerHTML copy
  if (layoutState.refsPos === '_popout') {
    // Hidden — popped out to external window
    refsPanel.style.display = 'none';
    refsSection.style.display = 'none';
    splitResizer.style.display = 'none';
  } else if (layoutState.refsPos !== 'sidebar') {
    if (sidebarRefs && refsPanelContent) {
      refsPanelContent.innerHTML = '';
      while (sidebarRefs.firstChild) {
        refsPanelContent.appendChild(sidebarRefs.firstChild);
      }
    }
    refsPanel.style.display = 'flex';
    slotContents[layoutState.refsPos].push(refsPanel);
  } else {
    // Move nodes back to sidebar-refs if they were moved out
    if (sidebarRefs && refsPanelContent && refsPanelContent.firstChild) {
      while (refsPanelContent.firstChild) {
        sidebarRefs.appendChild(refsPanelContent.firstChild);
      }
    }
    refsPanel.style.display = 'none';
  }

  // Terminal panel
  if (layoutState.terminalVisible) {
    slotContents[layoutState.terminalPos].push(bottomArea);
    bottomArea.style.display = 'flex';
    const isV = V_SLOTS.has(layoutState.terminalPos);
    bottomArea.classList.remove('panel-in-h', 'panel-in-v');
    bottomArea.classList.add(isV ? 'panel-in-v' : 'panel-in-h');
  } else {
    bottomArea.style.display = 'none';
  }

  // Avatar visibility
  if (avatar) avatar.style.display = layoutState.avatarVisible ? '' : 'none';
  if (termBtn) termBtn.textContent = layoutState.terminalVisible ? '━' : '▲';

  // 3. Place panels into their slots
  for (const slotName of SLOT_IDS) {
    const panels = slotContents[slotName];
    if (panels.length === 0) continue;

    const slot = EL.slots[slotName];
    const resizer = EL.resizers[slotName];
    if (!slot) continue;

    slot.classList.add('active');
    if (resizer) resizer.classList.add('active');

    const isV = V_SLOTS.has(slotName);
    if (isV) {
      slot.style.width = (layoutState.slotSizes[slotName] || DEFAULT_SLOT_SIZES[slotName]) + 'px';
      slot.style.height = '';
    } else {
      slot.style.height = (layoutState.slotSizes[slotName] || DEFAULT_SLOT_SIZES[slotName]) + 'px';
      slot.style.width = '';
    }

    for (const panel of panels) {
      panel.style.display = panel === bottomArea ? 'flex' : (panel === refsPanel ? 'flex' : '');
      slot.appendChild(panel);
    }
  }

  // 4. Sidebar expand strip
  if (sidebarExpand) {
    sidebarExpand.style.display = layoutState.itemsVisible ? 'none' : 'block';
  }

  // 5. Init slot resizers
  initSlotResizers();

  // 6. Debounced refit
  scheduleLayoutRefit();

  saveLayout();
}

// Slot resizer drag handlers — stored for proper removal
const _resizerHandlers = {};
function initSlotResizers() {
  for (const slotName of SLOT_IDS) {
    const resizer = getResizerEl(slotName);
    if (!resizer || !resizer.classList.contains('active')) continue;

    // Remove previously registered handler if any
    if (_resizerHandlers[slotName]) {
      resizer.removeEventListener('mousedown', _resizerHandlers[slotName]);
    }

    const isV = V_SLOTS.has(slotName);
    const handler = (e) => {
      e.preventDefault();
      const slot = getSlotEl(slotName);
      if (!slot) return;
      const startPos = isV ? e.clientX : e.clientY;
      const startSize = isV ? slot.getBoundingClientRect().width : slot.getBoundingClientRect().height;

      const growsReverse = (slotName === 'right' || slotName === 'far-right');
      const growsReverseV = (slotName === 'bottom');

      resizer.classList.add('dragging');
      const onMove = (ev) => {
        const delta = isV ? (ev.clientX - startPos) : (ev.clientY - startPos);
        let dir = 1;
        if (isV && growsReverse) dir = -1;
        if (!isV && growsReverseV) dir = -1;
        const newSize = Math.max(100, startSize + delta * dir);
        if (isV) { slot.style.width = newSize + 'px'; }
        else { slot.style.height = newSize + 'px'; }
        layoutState.slotSizes[slotName] = newSize;
      };
      const onUp = () => {
        resizer.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveLayout();
        if (editorInstance) setTimeout(() => editorInstance.layout(), 10);
        if (fitAddon && term) setTimeout(() => fitAddon.fit(), 10);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    _resizerHandlers[slotName] = handler;
    resizer.addEventListener('mousedown', handler);
  }
}

function toggleSidebar() {
  layoutState.itemsVisible = !layoutState.itemsVisible;
  rebuildLayout();
}

function toggleTerminal() {
  layoutState.terminalVisible = !layoutState.terminalVisible;
  rebuildLayout();
}

function toggleAvatar() {
  layoutState.avatarVisible = !layoutState.avatarVisible;
  rebuildLayout();
}

const POS_LABELS = {
  'left': '좌측', 'right': '우측', 'far-left': '좌끝', 'far-right': '우끝',
  'top': '상단', 'bottom': '하단', 'sidebar': '사이드바'
};

function moveItems(pos) {
  if (pos === 'hide') {
    layoutState.itemsVisible = false;
    rebuildLayout();
    setStatus('항목 숨김');
    return;
  }
  layoutState.itemsPos = pos;
  layoutState.itemsVisible = true;
  rebuildLayout();
  setStatus(`항목 → ${POS_LABELS[pos] || pos}`);
}

function moveTerminal(pos) {
  layoutState.terminalPos = pos;
  layoutState.terminalVisible = true;
  rebuildLayout();
  setStatus(`터미널 → ${POS_LABELS[pos] || pos}`);
}

function moveRefs(pos) {
  layoutState.refsPos = pos;
  rebuildLayout();
  setStatus(`참고자료 → ${POS_LABELS[pos] || pos}`);
}

function resetLayout() {
  layoutState.itemsPos = 'left';
  layoutState.terminalPos = 'bottom';
  layoutState.refsPos = 'sidebar';
  layoutState.itemsVisible = true;
  layoutState.terminalVisible = true;
  layoutState.avatarVisible = true;
  layoutState.slotSizes = { ...DEFAULT_SLOT_SIZES };
  rebuildLayout();
  setStatus('레이아웃 초기화 완료');
}

async function restartTerminal() {
  if (!term) return;
  await window.tokiAPI.terminalStop();
  // Wait for pty to fully terminate before starting a new one
  await new Promise(r => setTimeout(r, 200));
  term.clear();
  await window.tokiAPI.terminalStart(term.cols, term.rows);
  setStatus('터미널 재시작됨');
}

// ==================== Actions ====================
async function handleNew() {
  const data = await window.tokiAPI.newFile();
  if (!data) return;
  fileData = data;
  dirtyFields.clear();
  openTabs = [];
  activeTabId = null;
  if (editorInstance) { editorInstance.dispose(); editorInstance = null; }

  document.getElementById('file-label').textContent = 'New Character';
  document.getElementById('editor-container').innerHTML =
    '<div class="empty-state">항목을 선택하세요</div>';
  document.getElementById('editor-tabs').innerHTML = '';

  buildSidebar();
  setStatus('새 파일 생성됨');
}

// ==================== RP Mode ====================

// Load RP persona text (from file or custom)
async function loadRpPersona() {
  if (rpMode === 'off') return '';
  if (rpMode === 'custom') return rpCustomText;
  // 'toki' or 'aris' — read from file
  const text = await window.tokiAPI.readPersona(rpMode);
  return text || '';
}

function getRpLabel() {
  if (rpMode === 'off') return 'OFF';
  if (rpMode === 'toki') return '토키';
  if (rpMode === 'aris') return '아리스';
  if (rpMode === 'custom') return '커스텀';
  return 'OFF';
}

function initRpModeButton() {
  const btn = document.getElementById('btn-rp-mode');
  if (!btn) return;
  updateRpButtonStyle(btn);
  // Click: quick toggle ON/OFF (auto picks toki/aris based on dark mode)
  btn.addEventListener('click', () => {
    if (rpMode === 'off') {
      rpMode = darkMode ? 'aris' : 'toki';
    } else {
      rpMode = 'off';
    }
    localStorage.setItem('toki-rp-mode', rpMode);
    updateRpButtonStyle(btn);
    setStatus(rpMode === 'off' ? 'RP 모드 OFF' : `RP 모드 ON (${getRpLabel()}) — 다음 Claude 시작 시 적용`);
  });
}

function updateRpButtonStyle(btn) {
  const isOn = rpMode !== 'off';
  btn.style.background = isOn ? 'rgba(255,255,255,0.5)' : '';
  btn.title = isOn ? `RP: ${getRpLabel()} (클릭: OFF)` : 'RP 모드 OFF (클릭: ON)';
}

async function handleClaudeStart() {
  // (debug log removed)
  if (!term) {
    setStatus('터미널이 준비되지 않았습니다');
    return;
  }

  const promptInfo = await window.tokiAPI.getClaudePrompt();
  const mcpConfigPath = await window.tokiAPI.writeMcpConfig();

  // Build the initial prompt
  let initPrompt = '';
  if (promptInfo) {
    const lines = [
      `당신은 RisuToki에 내장된 AI 어시스턴트입니다.`,
      ``,
      `== 현재 파일 ==`,
      `파일: ${promptInfo.fileName}`,
      `캐릭터: ${promptInfo.name}`,
      `구성: ${promptInfo.stats}`,
      ``,
      `== .charx 파일 구조 ==`,
      `.charx = ZIP 아카이브 (card.json + module.risum + assets/)`,
      `card.json: V3 캐릭터 카드 스펙 (name, description, firstMessage, personality 등)`,
      `module.risum: RPack 인코딩된 바이너리 (Lua 트리거, 정규식 스크립트, 로어북)`,
      `assets/: 이미지 리소스 (icon/, other/image/)`,
      ``,
      `== 편집 가능 필드 ==`,
      `- lua: Lua 5.4 트리거 스크립트 (RisuAI CBS API 사용). "-- ===== 섹션명 =====" 구분자로 섹션 분리됨`,
      `- globalNote: 포스트 히스토리 인스트럭션 (시스템 프롬프트 뒤에 삽입됨)`,
      `- firstMessage: 첫 메시지 (HTML/마크다운 혼용 가능)`,
      `- description: 캐릭터 설명`,
      `- css: 커스텀 CSS (RisuAI 채팅 UI에 적용)`,
      `- defaultVariables: 기본 변수 (평문)`,
      `- name: 캐릭터 이름`,
      ``,
      `== 로어북 항목 구조 ==`,
      `{ key: "트리거키워드", secondkey: "", comment: "설명", content: "본문",`,
      `  order: 100, priority: 0, selective: false, alwaysActive: false, mode: "normal" }`,
      ``,
      `== 정규식 스크립트 구조 ==`,
      `{ comment: "설명", type: "editoutput"|"editinput"|"editdisplay",`,
      `  find: "정규식패턴", replace: "치환문자열", flag: "g"|"gi"|"gm" }`,
    ];
    if (mcpConfigPath) {
      lines.push(``);
      lines.push(`== RisuToki MCP 도구 ==`);
      lines.push(`연결됨. 다음 도구로 에디터 데이터를 직접 읽기/쓰기할 수 있습니다:`);
      lines.push(`- list_fields: 필드 목록 + 크기 확인`);
      lines.push(`- read_field(field) / write_field(field, content): 필드 읽기/쓰기`);
      lines.push(`- list_lorebook / read_lorebook(index) / write_lorebook(index, data): 로어북 관리`);
      lines.push(`- add_lorebook(data) / delete_lorebook(index): 로어북 추가/삭제`);
      lines.push(`- list_regex / read_regex(index) / write_regex(index, data): 정규식 관리`);
      lines.push(`- add_regex(data) / delete_regex(index): 정규식 추가/삭제`);
      lines.push(`- list_lua / read_lua(index) / write_lua(index, content): Lua 섹션별 읽기/쓰기 (-- ===== 섹션명 ===== 구분자 기준)`);
      lines.push(`- replace_in_lua(index, find, replace, regex?, flags?): Lua 섹션 내 문자열 치환 (서버에서 직접 처리)`);
      lines.push(`- insert_in_lua(index, content, position?, anchor?): Lua 섹션에 코드 삽입 (end/start/after/before)`);
      lines.push(`- list_css / read_css(index) / write_css(index, content): CSS 섹션별 읽기/쓰기 (/* ===== 섹션명 ===== */ 구분자 기준)`);
      lines.push(`- replace_in_css(index, find, replace, regex?, flags?): CSS 섹션 내 문자열 치환 (서버에서 직접 처리)`);
      lines.push(`- insert_in_css(index, content, position?, anchor?): CSS 섹션에 코드 삽입 (end/start/after/before)`);
      lines.push(`- list_references: 로드된 참고 자료 파일 목록 (읽기 전용)`);
      lines.push(`- read_reference_field(index, field): 참고 파일의 필드 읽기 (읽기 전용)`);
      lines.push(`write/add/delete 도구 사용 시 에디터에서 사용자 확인 팝업이 뜹니다.`);
      lines.push(`도구를 적극 활용하여 사용자의 요청을 수행하세요.`);
      lines.push(``);
      lines.push(`== 중요: 읽기 규칙 ==`);
      lines.push(`- lua, css 필드는 반드시 섹션 단위로 읽으세요: list_lua → read_lua(index)`);
      lines.push(`- read_field("lua")나 read_field("css")는 전체를 한번에 반환하므로 사용하지 마세요`);
      lines.push(`- 로어북도 list_lorebook → read_lorebook(index) 순서로 개별 읽기`);
      lines.push(`- 정규식도 list_regex → read_regex(index) 순서로 개별 읽기`);
    } else {
      lines.push(`편집 중인 항목의 내용을 알려주면 수정을 도와드리겠습니다.`);
    }
    // Append RP persona if enabled
    const rpText = await loadRpPersona();
    if (rpText) {
      lines.push(``);
      lines.push(`== Response Persona ==`);
      lines.push(rpText);
    }

    initPrompt = lines.join('\n');
  } else if (rpMode !== 'off') {
    // No file open, but RP mode enabled — just the persona prompt
    initPrompt = await loadRpPersona();
  }

  // Write system prompt to temp file and pass via --append-system-prompt
  // Note: --append-system-prompt-file only works in print (-p) mode;
  // for interactive mode, read the file via shell and pass inline
  let cmd;
  if (initPrompt) {
    const { filePath, platform } = await window.tokiAPI.writeSystemPrompt(initPrompt);
    // (debug log removed)
    if (platform === 'win32') {
      // PowerShell: subexpression returns file content as single string argument
      cmd = `claude --append-system-prompt (Get-Content -Raw '${filePath}')\r`;
    } else {
      // bash: command substitution
      cmd = `claude --append-system-prompt "$(cat '${filePath}')"\r`;
    }
  } else {
    cmd = `claude\r`;
  }

  window.tokiAPI.terminalInput(cmd);
  setStatus('Claude Code 시작 중...');
}

async function handleCodexStart() {
  if (!term) {
    setStatus('터미널이 준비되지 않았습니다');
    return;
  }

  const promptInfo = await window.tokiAPI.getClaudePrompt();

  // Write Codex MCP config (~/.codex/config.toml)
  await window.tokiAPI.writeCodexMcpConfig();

  // Build system prompt (reuse same content as Claude)
  let initPrompt = '';
  if (promptInfo) {
    const lines = [
      `당신은 RisuToki에 내장된 AI 어시스턴트입니다.`,
      ``,
      `== 현재 파일 ==`,
      `파일: ${promptInfo.fileName}`,
      `캐릭터: ${promptInfo.name}`,
      `구성: ${promptInfo.stats}`,
      ``,
      `== .charx 파일 구조 ==`,
      `.charx = ZIP 아카이브 (card.json + module.risum + assets/)`,
      `card.json: V3 캐릭터 카드 스펙 (name, description, firstMessage, personality 등)`,
      `module.risum: RPack 인코딩된 바이너리 (Lua 트리거, 정규식 스크립트, 로어북)`,
      `assets/: 이미지 리소스 (icon/, other/image/)`,
      ``,
      `== 편집 가능 필드 ==`,
      `- lua: Lua 5.4 트리거 스크립트 (RisuAI CBS API 사용). "-- ===== 섹션명 =====" 구분자로 섹션 분리됨`,
      `- globalNote: 포스트 히스토리 인스트럭션 (시스템 프롬프트 뒤에 삽입됨)`,
      `- firstMessage: 첫 메시지 (HTML/마크다운 혼용 가능)`,
      `- description: 캐릭터 설명`,
      `- css: 커스텀 CSS (RisuAI 채팅 UI에 적용)`,
      `- defaultVariables: 기본 변수 (평문)`,
      `- name: 캐릭터 이름`,
      ``,
      `== 로어북 항목 구조 ==`,
      `{ key: "트리거키워드", secondkey: "", comment: "설명", content: "본문",`,
      `  order: 100, priority: 0, selective: false, alwaysActive: false, mode: "normal" }`,
      ``,
      `== 정규식 스크립트 구조 ==`,
      `{ comment: "설명", type: "editoutput"|"editinput"|"editdisplay",`,
      `  find: "정규식패턴", replace: "치환문자열", flag: "g"|"gi"|"gm" }`,
      ``,
      `== RisuToki MCP 도구 ==`,
      `연결됨. 다음 도구로 에디터 데이터를 직접 읽기/쓰기할 수 있습니다:`,
      `- list_fields: 필드 목록 + 크기 확인`,
      `- read_field(field) / write_field(field, content): 필드 읽기/쓰기`,
      `- list_lorebook / read_lorebook(index) / write_lorebook(index, data): 로어북 관리`,
      `- add_lorebook(data) / delete_lorebook(index): 로어북 추가/삭제`,
      `- list_regex / read_regex(index) / write_regex(index, data): 정규식 관리`,
      `- add_regex(data) / delete_regex(index): 정규식 추가/삭제`,
      `- list_lua / read_lua(index) / write_lua(index, content): Lua 섹션별 읽기/쓰기`,
      `- replace_in_lua(index, find, replace, regex?, flags?): Lua 섹션 내 문자열 치환`,
      `- insert_in_lua(index, content, position?, anchor?): Lua 섹션에 코드 삽입`,
      `- list_css / read_css(index) / write_css(index, content): CSS 섹션별 읽기/쓰기`,
      `- replace_in_css(index, find, replace, regex?, flags?): CSS 섹션 내 문자열 치환`,
      `- insert_in_css(index, content, position?, anchor?): CSS 섹션에 코드 삽입`,
      `- list_references: 로드된 참고 자료 파일 목록 (읽기 전용)`,
      `- read_reference_field(index, field): 참고 파일의 필드 읽기 (읽기 전용)`,
      `write/add/delete 도구 사용 시 에디터에서 사용자 확인 팝업이 뜹니다.`,
      `도구를 적극 활용하여 사용자의 요청을 수행하세요.`,
      ``,
      `== 중요: 읽기 규칙 ==`,
      `- lua, css 필드는 반드시 섹션 단위로 읽으세요: list_lua → read_lua(index)`,
      `- read_field("lua")나 read_field("css")는 전체를 한번에 반환하므로 사용하지 마세요`,
      `- 로어북도 list_lorebook → read_lorebook(index) 순서로 개별 읽기`,
      `- 정규식도 list_regex → read_regex(index) 순서로 개별 읽기`,
    ];
    // Append RP persona if enabled
    const rpText = await loadRpPersona();
    if (rpText) {
      lines.push(``);
      lines.push(`== Response Persona ==`);
      lines.push(rpText);
    }
    initPrompt = lines.join('\n');
  } else if (rpMode !== 'off') {
    initPrompt = await loadRpPersona();
  }

  // Write AGENTS.md for Codex to pick up
  if (initPrompt) {
    await window.tokiAPI.writeCodexAgentsMd(initPrompt);
  }

  // Launch codex CLI
  window.tokiAPI.terminalInput('codex\r');
  setStatus('Codex 시작 중...');
}

async function handleOpen() {
  try {
    setStatus('파일 열기 중...');
    const data = await window.tokiAPI.openFile();
    if (!data) { setStatus('준비'); return; }
    fileData = data;
    dirtyFields.clear();
    openTabs = [];
    activeTabId = null;
    if (editorInstance) { editorInstance.dispose(); editorInstance = null; }

    document.getElementById('file-label').textContent = `${data.name || 'Untitled'}`;
    document.getElementById('editor-container').innerHTML =
      '<div class="empty-state">항목을 선택하세요</div>';
    document.getElementById('editor-tabs').innerHTML = '';

    buildSidebar();
    setStatus(`파일 열림: ${data.name}`);
  } catch (err) {
    console.error('[renderer] handleOpen error:', err);
    setStatus(`열기 실패: ${err.message}`);
  }
}

async function handleSave() {
  if (!fileData) return;
  // Sync current editor content (skip form/image tabs)
  if (editorInstance && activeTabId) {
    const curTab = openTabs.find(t => t.id === activeTabId);
    if (curTab && !FORM_TAB_TYPES.has(curTab.language) && curTab.setValue) {
      curTab.setValue(editorInstance.getValue());
    }
  }
  const result = await window.tokiAPI.saveFile(fileData);
  if (result.success) {
    dirtyFields.clear();
    updateTabUI();
    setStatus('저장 완료');
    // Cleanup autosave temp file after successful save
    window.tokiAPI.cleanupAutosave(autosaveDir || undefined);
  } else {
    setStatus(`저장 실패: ${result.error}`);
  }
}

async function handleSaveAs() {
  if (!fileData) return;
  if (editorInstance && activeTabId) {
    const curTab = openTabs.find(t => t.id === activeTabId);
    if (curTab && !FORM_TAB_TYPES.has(curTab.language) && curTab.setValue) {
      curTab.setValue(editorInstance.getValue());
    }
  }
  const result = await window.tokiAPI.saveFileAs(fileData);
  if (result.success) {
    dirtyFields.clear();
    updateTabUI();
    setStatus(`저장 완료: ${result.path}`);
  } else {
    setStatus(`저장 취소`);
  }
}

// ==================== Terminal Background ====================
async function handleTerminalBg() {
  const dataUrl = await window.tokiAPI.pickBgImage();
  const container = document.getElementById('terminal-container');
  if (dataUrl) {
    container.style.backgroundImage = `url("${dataUrl}")`;
    container.classList.add('has-bg');
  } else {
    // Clicked cancel → remove background
    container.style.backgroundImage = '';
    container.classList.remove('has-bg');
  }
}

// ==================== Resizers ====================
function initResizers() {
  // Slot resizers are initialized by rebuildLayout() → initSlotResizers()
  // Only avatar-terminal resizer needs static init here

  const avatarResizer = document.getElementById('avatar-resizer');
  const avatar = document.getElementById('toki-avatar');
  if (avatarResizer) {
    avatarResizer.addEventListener('mousedown', (e) => {
      if (!V_SLOTS.has(layoutState.terminalPos)) return; // only in vertical slots
      e.preventDefault();
      avatarResizer.classList.add('active');
      const startY = e.clientY;
      const startH = avatar.offsetHeight;
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        avatar.style.height = Math.max(60, Math.min(400, startH + dy)) + 'px';
      };
      const onUp = () => {
        avatarResizer.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (fitAddon && term) fitAddon.fit();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Terminal toggle
  document.getElementById('btn-terminal-toggle').addEventListener('click', () => toggleTerminal());
}

// ==================== Status (auto-hide) ====================
let statusTimer = null;
let _statusBar, _statusSpan;

function setStatus(text) {
  if (!_statusBar) {
    _statusBar = document.getElementById('statusbar');
    _statusSpan = document.getElementById('status-text');
  }
  _statusSpan.textContent = text;
  _statusBar.classList.add('visible');

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    _statusBar.classList.remove('visible');
  }, 3000);
}

// ==================== Dark Mode ====================

const RISU_IDLE = '../../assets/icon_risu.png';
const RISU_DANCING = '../../assets/Dancing_risu.gif';


function defineDarkMonacoTheme() {
  if (window._baDarkThemeDefined) return;
  if (!monacoReady) return;
  monaco.editor.defineTheme('blue-archive-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'd8dce8', background: '1c2340' },
      { token: 'comment', foreground: '7a8ba5', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6fb3f2', fontStyle: 'bold' },
      { token: 'string', foreground: '66bb6a' },
      { token: 'number', foreground: 'ffca28' },
      { token: 'type', foreground: 'f06292' },
      { token: 'function', foreground: '74b9ff' },
      { token: 'variable', foreground: 'ef9a9a' },
      { token: 'operator', foreground: 'f06292' },
      { token: 'delimiter', foreground: '7a8ba5' },
    ],
    colors: {
      'editor.background': '#181e34',
      'editor.foreground': '#d8dce8',
      'editor.lineHighlightBackground': '#1e2844',
      'editor.selectionBackground': '#4a90d944',
      'editorCursor.foreground': '#4a90d9',
      'editorLineNumber.foreground': '#3a4a68',
      'editorLineNumber.activeForeground': '#4a90d9',
      'editorWidget.background': '#1c2340',
      'editorWidget.border': '#2e3a56',
      'minimap.background': '#141a31',
      'scrollbarSlider.background': '#2e3a5644',
      'scrollbarSlider.hoverBackground': '#4a90d966',
    }
  });
  window._baDarkThemeDefined = true;
}

function toggleDarkMode() {
  darkMode = !darkMode;
  localStorage.setItem('toki-dark-mode', darkMode);
  applyDarkMode();
  setStatus(darkMode ? '다크 모드 ON (Aris)' : '라이트 모드 ON (Toki)');
}

function applyDarkMode() {
  document.body.classList.toggle('dark-mode', darkMode);

  // Update TokiTalk title
  const titleEl = document.querySelector('.momo-title');
  if (titleEl) titleEl.textContent = darkMode ? 'ArisTalk' : 'TokiTalk';

  // Update status text with character dialogue
  const statusText = document.getElementById('toki-status-text');
  if (statusText) {
    if (tokiActive) {
      statusText.textContent = darkMode ? randomLine(RISU_WORKING_LINES) : randomLine(TOKI_WORKING_LINES);
    } else {
      statusText.textContent = darkMode ? randomLine(RISU_IDLE_LINES) : randomLine(TOKI_IDLE_LINES);
    }
  }

  // Switch avatar image
  if (tokiImg) {
    if (tokiActive) {
      if (darkMode) loadTokiImage(RISU_DANCING);
      else loadTokiImage(TOKI_DANCING);
    } else {
      if (darkMode) loadTokiImage(RISU_IDLE);
      else loadTokiImage(TOKI_IDLE);
    }
  }

  // Switch terminal (xterm) theme
  if (typeof term !== 'undefined' && term) {
    term.options.theme = darkMode ? TERM_THEME_DARK : TERM_THEME_LIGHT;
  }

  // Switch Monaco theme (global — affects all editor instances)
  if (monacoReady) {
    defineDarkMonacoTheme();
    monaco.editor.setTheme(darkMode ? 'blue-archive-dark' : 'blue-archive');
  }

  // Auto-switch RP persona on dark mode toggle (if not custom/off)
  if (rpMode === 'toki' || rpMode === 'aris') {
    rpMode = darkMode ? 'aris' : 'toki';
    localStorage.setItem('toki-rp-mode', rpMode);
  }
  const rpBtn = document.getElementById('btn-rp-mode');
  if (rpBtn) updateRpButtonStyle(rpBtn);

  // Update avatar right-click menu character name in context
  // (handled dynamically when contextmenu is shown)
}

// ==================== BGM (Terminal Response Music) ====================

function initBgm() {
  bgmAudio = new Audio(bgmFilePath);
  bgmAudio.loop = true;
  bgmAudio.volume = 0.3;

  const btn = document.getElementById('btn-bgm');
  if (!btn) return;

  updateBgmButtonStyle(btn);

  // Left-click: toggle on/off
  btn.addEventListener('click', () => {
    bgmEnabled = !bgmEnabled;
    localStorage.setItem('toki-bgm-enabled', bgmEnabled);
    updateBgmButtonStyle(btn);
    if (!bgmEnabled && bgmAudio) {
      bgmAudio.pause();
    }
    setStatus(bgmEnabled ? 'BGM ON' : 'BGM OFF');
  });

  // Right-click: pick new BGM file
  btn.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const filePath = await window.tokiAPI.pickBgm();
    if (!filePath) return;
    bgmFilePath = filePath;
    localStorage.setItem('toki-bgm-path', filePath);
    bgmAudio.src = filePath;
    setStatus(`BGM 변경: ${filePath.split(/[/\\]/).pop()}`);
  });
}

function updateBgmButtonStyle(btn) {
  btn.textContent = bgmEnabled ? '🔊' : '🔇';
  btn.title = bgmEnabled ? 'BGM ON (우클릭: 파일 변경)' : 'BGM OFF (우클릭: 파일 변경)';
  btn.style.background = bgmEnabled ? 'rgba(255,255,255,0.5)' : '';
}

function bgmOnTerminalData() {
  if (!bgmEnabled || !bgmAudio) return;

  // Burst detection: only play BGM during sustained output (Claude streaming)
  // Single data events (shell prompt, short command output) won't trigger
  bgmBurstCount++;
  if (bgmBurstTimer) clearTimeout(bgmBurstTimer);
  bgmBurstTimer = setTimeout(() => { bgmBurstCount = 0; }, BGM_BURST_WINDOW);

  // Don't start playing until we see sustained output
  if (bgmBurstCount < BGM_BURST_THRESHOLD && bgmAudio.paused) return;

  // Start or resume playing
  if (bgmAudio.paused) {
    bgmAudio.play().catch(() => { /* autoplay blocked, ignore */ });
  }

  // Reset silence timer
  if (bgmSilenceTimer) clearTimeout(bgmSilenceTimer);
  bgmSilenceTimer = setTimeout(() => {
    if (bgmAudio && !bgmAudio.paused) {
      bgmAudio.pause();
    }
    bgmBurstCount = 0;
  }, BGM_SILENCE_MS);
}

// ==================== Toki Avatar ====================
const TOKI_IDLE = '../../assets/icon.png';
const TOKI_CUTE = '../../assets/toki-cute.gif';
const TOKI_DANCING = '../../assets/Dancing_toki.gif';
let tokiActive = false;

// Echo filter: ignore terminal data within 300ms of user input
let lastUserInputTime = 0;

// Character dialogue lines
const TOKI_IDLE_LINES = [
  '분부대로.',
  '완벽한 보좌를 약속드립니다.',
  '대기 중입니다.',
  '지시를 기다리겠습니다.',
];
const TOKI_WORKING_LINES = [
  '신속히 처리하겠습니다.',
  '...집중하고 있습니다.',
  '작업 진행 중입니다.',
  '완벽하게 수행하겠습니다.',
];
const RISU_IDLE_LINES = [
  '오늘은 어떤 모험을 떠나실 건가요?',
  '아리스, 대기 중입니다!',
  '선생님! 지시를!',
  '다음 퀘스트는 뭔가요?',
];
const RISU_WORKING_LINES = [
  '아리스, 전력으로 갑니다!',
  '마력 충전 중...!',
  '퀘스트 진행 중입니다!',
  '빛이여, 힘을 빌려줘...!',
];

function randomLine(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
let tokiImg = null;
let tokiCurrentSrc = TOKI_IDLE;

function initTokiAvatar() {
  const display = document.getElementById('toki-avatar-display');

  // Img directly displays everything (static PNG + animated GIF)
  tokiImg = document.createElement('img');
  tokiImg.id = 'toki-img-source';
  tokiImg.style.cssText = 'width:100%;height:auto;';
  display.appendChild(tokiImg);

  tokiImg.addEventListener('error', () => {
    console.error('[Toki] Image load error:', tokiCurrentSrc);
  });

  // Load saved idle image or default
  const savedIdleInit = JSON.parse(localStorage.getItem('toki-avatar-idle') || 'null');
  if (savedIdleInit) {
    loadTokiImage(savedIdleInit.src);
  } else {
    loadTokiImage(darkMode ? RISU_IDLE : TOKI_IDLE);
  }

  // Set initial dialogue
  const initStatusText = document.getElementById('toki-status-text');
  if (initStatusText) {
    initStatusText.textContent = darkMode ? randomLine(RISU_IDLE_LINES) : randomLine(TOKI_IDLE_LINES);
  }

  // Right-click to switch avatar
  const avatar = document.getElementById('toki-avatar');
  avatar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showAvatarPicker();
  });
}

function showAvatarPicker() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;';
  const popup = document.createElement('div');
  popup.className = 'settings-popup';
  popup.style.cssText += 'width:520px;max-width:90vw;';

  const header = document.createElement('div');
  header.className = 'help-popup-header';
  header.innerHTML = '<span>아바타 이미지 선택</span>';
  const closeBtn = document.createElement('span');
  closeBtn.className = 'help-popup-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'help-popup-body';
  body.style.cssText = 'padding:12px;';

  // Built-in images
  const images = [
    { src: TOKI_IDLE, label: '토키 (기본)' },
    { src: TOKI_CUTE, label: '토키 (cute)' },
    { src: TOKI_DANCING, label: '토키 (dancing)' },
    { src: RISU_IDLE, label: '아리스 (기본)' },
    { src: RISU_DANCING, label: '아리스 (dancing)' },
  ];

  const savedIdle = JSON.parse(localStorage.getItem('toki-avatar-idle') || 'null');
  const savedWork = JSON.parse(localStorage.getItem('toki-avatar-working') || 'null');

  // Helper: create image card
  function makeCard(img, currentSrc, onClick) {
    const card = document.createElement('div');
    card.style.cssText = 'border:2px solid var(--border-color);border-radius:8px;padding:6px;cursor:pointer;text-align:center;transition:border-color 0.2s;';
    const preview = document.createElement('img');
    preview.src = img.src;
    preview.style.cssText = 'width:60px;height:60px;object-fit:contain;display:block;margin:0 auto 4px;';
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:10px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px;';
    lbl.textContent = img.label;
    card.appendChild(preview);
    card.appendChild(lbl);
    if (currentSrc === img.src) card.style.borderColor = 'var(--accent)';
    card.addEventListener('click', onClick);
    card.addEventListener('mouseenter', () => card.style.borderColor = 'var(--accent)');
    card.addEventListener('mouseleave', () => { if (currentSrc !== img.src) card.style.borderColor = 'var(--border-color)'; });
    return card;
  }

  // Helper: "추가" card (file picker)
  function makeAddCard(onPick) {
    const card = document.createElement('div');
    card.style.cssText = 'border:2px dashed var(--border-color);border-radius:8px;padding:6px;cursor:pointer;text-align:center;transition:border-color 0.2s;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80px;';
    card.innerHTML = '<div style="font-size:24px;color:var(--text-secondary);">+</div><div style="font-size:10px;color:var(--text-secondary);">이미지 추가</div>';
    card.addEventListener('click', onPick);
    card.addEventListener('mouseenter', () => card.style.borderColor = 'var(--accent)');
    card.addEventListener('mouseleave', () => card.style.borderColor = 'var(--border-color)');
    return card;
  }

  // === Section: 대기 이미지 ===
  const idleLabel = document.createElement('div');
  idleLabel.style.cssText = 'font-weight:700;font-size:12px;margin-bottom:8px;color:var(--text-primary);';
  idleLabel.textContent = '대기 이미지';
  body.appendChild(idleLabel);

  const idleGrid = document.createElement('div');
  idleGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;';
  const idleSrc = savedIdle ? savedIdle.src : (tokiCurrentSrc || '');
  for (const img of images) {
    idleGrid.appendChild(makeCard(img, idleSrc, () => {
      localStorage.setItem('toki-avatar-idle', JSON.stringify({ src: img.src }));
      if (!tokiActive) loadTokiImage(img.src);
      overlay.remove();
      setStatus(`대기 이미지: ${img.label}`);
    }));
  }
  // Add custom image card
  idleGrid.appendChild(makeAddCard(async () => {
    const dataUri = await window.tokiAPI.pickBgImage();
    if (!dataUri) return;
    localStorage.setItem('toki-avatar-idle', JSON.stringify({ src: dataUri }));
    if (!tokiActive) loadTokiImage(dataUri);
    overlay.remove();
    setStatus('대기 이미지: 커스텀');
  }));
  body.appendChild(idleGrid);

  // === Section: 작업중 이미지 ===
  const workLabel = document.createElement('div');
  workLabel.style.cssText = 'font-weight:700;font-size:12px;margin-bottom:8px;color:var(--text-primary);';
  workLabel.textContent = '작업중 이미지';
  body.appendChild(workLabel);

  const workGrid = document.createElement('div');
  workGrid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;';
  const workSrc = savedWork ? savedWork.src : '';
  for (const img of images) {
    workGrid.appendChild(makeCard(img, workSrc, () => {
      localStorage.setItem('toki-avatar-working', JSON.stringify({ src: img.src }));
      if (tokiActive) loadTokiImage(img.src);
      overlay.remove();
      setStatus(`작업중 이미지: ${img.label}`);
    }));
  }
  // Add custom image card
  workGrid.appendChild(makeAddCard(async () => {
    const dataUri = await window.tokiAPI.pickBgImage();
    if (!dataUri) return;
    localStorage.setItem('toki-avatar-working', JSON.stringify({ src: dataUri }));
    if (tokiActive) loadTokiImage(dataUri);
    overlay.remove();
    setStatus('작업중 이미지: 커스텀');
  }));
  body.appendChild(workGrid);

  popup.appendChild(header);
  popup.appendChild(body);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function loadTokiImage(src) {
  const prevSrc = tokiCurrentSrc;
  tokiCurrentSrc = src;

  // If same src is already loaded, do nothing
  if (prevSrc === src && tokiImg.complete && tokiImg.naturalWidth > 0) return;

  // Force GIF reload to restart animation from frame 1
  if (src.endsWith('.gif')) {
    tokiImg.src = '';
    tokiImg.src = src + '?t=' + Date.now();
  } else {
    tokiImg.src = src;
  }
}

// Cached avatar DOM elements (populated on first call)
let _avatarEl, _statusEl, _statusIconEl, _statusTextEl;
function setTokiActive(active) {
  if (!_avatarEl) {
    _avatarEl = document.getElementById('toki-avatar');
    _statusEl = document.getElementById('toki-status');
    _statusIconEl = document.getElementById('toki-status-icon');
    _statusTextEl = document.getElementById('toki-status-text');
  }
  const avatar = _avatarEl;
  const statusEl = _statusEl;
  const statusIcon = _statusIconEl;
  const statusText = _statusTextEl;

  if (active && !tokiActive) {
    tokiActive = true;
    avatar.classList.add('active');
    statusEl.classList.add('working');
    statusIcon.textContent = '✨';
    // Read saved working image from localStorage, fallback to defaults
    const savedWork = JSON.parse(localStorage.getItem('toki-avatar-working') || 'null');
    if (savedWork) {
      loadTokiImage(savedWork.src);
    } else if (darkMode) {
      loadTokiImage(RISU_DANCING);
    } else {
      loadTokiImage(TOKI_DANCING);
    }
    statusText.textContent = darkMode ? randomLine(RISU_WORKING_LINES) : randomLine(TOKI_WORKING_LINES);
  } else if (!active && tokiActive) {
    tokiActive = false;
    avatar.classList.remove('active');
    statusEl.classList.remove('working');
    statusIcon.textContent = '💤';
    // Read saved idle image from localStorage, fallback to defaults
    const savedIdle = JSON.parse(localStorage.getItem('toki-avatar-idle') || 'null');
    if (savedIdle) {
      loadTokiImage(savedIdle.src);
    } else if (darkMode) {
      loadTokiImage(RISU_IDLE);
    } else {
      loadTokiImage(TOKI_IDLE);
    }
    statusText.textContent = darkMode ? randomLine(RISU_IDLE_LINES) : randomLine(TOKI_IDLE_LINES);
  }
}

// ==================== Chat Mode (TokiTalk Bubbles) ====================

function initChatMode() {
  const termArea = document.getElementById('terminal-area');

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
  termArea.appendChild(chatView);

  chatSendBtn.addEventListener('click', chatSendInput);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatSendInput();
    }
  });

  document.getElementById('btn-chat-mode').addEventListener('click', toggleChatMode);
}

function toggleChatMode() {
  chatMode = !chatMode;
  const termContainer = document.getElementById('terminal-container');
  const chatView = document.getElementById('chat-view');
  const btn = document.getElementById('btn-chat-mode');

  if (chatMode) {
    chatBuffer = '';
    chatIsStreaming = false;
    chatWaitForInput = true;
    if (chatBufferTimer) { clearTimeout(chatBufferTimer); chatBufferTimer = null; }
    if (chatMaxTimer) { clearTimeout(chatMaxTimer); chatMaxTimer = null; }

    // Recovery: if there's ongoing response in bgBuffer (user toggled mid-response),
    // try to extract it. Remove old recovery messages first.
    chatMessages = chatMessages.filter(m => !m._recovery);

    const recoverySource = (bgBuffer.trim() || lastResponseSnapshot.trim());
    if (recoverySource) {
      const cleaned = cleanTuiOutput(bgBuffer.trim() ? bgBuffer : lastResponseSnapshot);
      const isWelcome = /^---\s*Claude Code\s*---/i.test(cleaned.trim());

      if (!isWelcome && cleaned.trim().length > 5) {
        chatMessages.push({ type: 'system', text: cleaned.trim(), _recovery: true });
      }
      bgBuffer = '';
      lastResponseSnapshot = '';
      if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }
    }

    termContainer.style.display = 'none';
    chatView.classList.add('active');
    btn.style.background = 'rgba(255,255,255,0.5)';
    renderChatMessages();
    document.getElementById('chat-input').focus();
  } else {
    // Toggling OFF — if streaming, finalize immediately so response isn't lost
    if (chatIsStreaming) {
      finalizeChatResponse();
    }
    termContainer.style.display = '';
    chatView.classList.remove('active');
    btn.style.background = '';
    if (fitAddon && term) setTimeout(() => fitAddon.fit(), 20);
  }
}

function chatSendInput() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';

  // Finalize any ongoing streaming
  if (chatIsStreaming) {
    chatIsStreaming = false;
    chatBuffer = '';
    if (chatBufferTimer) { clearTimeout(chatBufferTimer); chatBufferTimer = null; }
    if (chatMaxTimer) { clearTimeout(chatMaxTimer); chatMaxTimer = null; }
  }

  chatMessages.push({ type: 'user', text });
  lastSentCmd = text;
  chatWaitForInput = false; // start capturing response data
  // Clear bgBuffer so new response starts clean
  bgBuffer = '';
  lastResponseSnapshot = '';
  if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }
  renderChatMessages();

  // Send to pty: text first, then Enter after short delay
  // Claude Code TUI needs separate text input and Enter key
  window.tokiAPI.terminalInput(text);
  setTimeout(() => {
    window.tokiAPI.terminalInput('\r');
  }, 50);
}

function onChatData(rawData) {
  // Don't capture until user sends a message
  if (chatWaitForInput) return;

  const text = stripAnsi(rawData);
  if (!text) return;

  // Show typing indicator as soon as any data arrives
  if (!chatIsStreaming) {
    chatIsStreaming = true;
    chatMessages.push({ type: 'system', text: '' });
    renderChatMessages();

  }

  // Detect ❯ prompt = Claude finished responding → grab complete response from bgBuffer
  if (/❯/.test(text) || /\?\s*for\s+shortcuts/i.test(text)) {

    if (chatBufferTimer) clearTimeout(chatBufferTimer);
    chatBufferTimer = setTimeout(finalizeChatResponse, 500);
  }
}

function finalizeChatResponse() {
  if (!chatIsStreaming) return; // already finalized
  chatIsStreaming = false;
  if (chatBufferTimer) { clearTimeout(chatBufferTimer); chatBufferTimer = null; }
  if (chatMaxTimer) { clearTimeout(chatMaxTimer); chatMaxTimer = null; }

  // Read complete response from bgBuffer (contains ALL terminal output)
  const source = bgBuffer || lastResponseSnapshot;


  let display = cleanTuiOutput(source);

  // Filter welcome screen
  if (/^---\s*Claude Code\s*---/i.test(display.trim())) {
    display = '';
  }



  const lastMsg = chatMessages[chatMessages.length - 1];
  if (lastMsg && lastMsg.type === 'system') {
    lastMsg.text = display.trim();
  }

  chatBuffer = '';
  lastSentCmd = '';
  chatWaitForInput = true; // ready for next input
  // Clear buffers
  bgBuffer = '';
  lastResponseSnapshot = '';
  if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }
  // Filter empty messages
  chatMessages = chatMessages.filter(m => {
    if (!m.text || !m.text.trim()) return false;
    if (m.type === 'user') return true;
    // System messages: keep if has Korean/CJK or substantial content
    if (/[\uAC00-\uD7AF\u3130-\u318F\u4E00-\u9FFF]/.test(m.text)) return true;
    if (m.text.split('\n').some(l => l.trim().length >= 6)) return true;
    return false;
  });
  renderChatMessages();
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  container.innerHTML = '';

  for (const msg of chatMessages) {
    if (!msg.text && !chatIsStreaming) continue;

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

    // Detect numbered choices in system message and render buttons (skip if already chosen)
    if (msg.type === 'system' && msg.text && !chatIsStreaming && !msg._choiceMade) {
      const choices = extractChoices(msg.text);
      if (choices.length >= 2) {
        const choiceContainer = document.createElement('div');
        choiceContainer.className = 'chat-choices';
        for (const choice of choices) {
          const btn = document.createElement('button');
          btn.className = 'chat-choice-btn';
          btn.textContent = choice.label;
          btn.addEventListener('click', () => sendChatChoice(choice.value));
          choiceContainer.appendChild(btn);
        }
        container.appendChild(choiceContainer);
      }
    }
  }

  container.scrollTop = container.scrollHeight;
}

// Extract numbered choices from text: "1. xxx\n2. yyy" or "1) xxx\n2) yyy"
function extractChoices(text) {
  const lines = text.split('\n');
  const choices = [];
  for (const line of lines) {
    // Strip > prefix and leading whitespace
    const stripped = line.replace(/^\s*>\s*/, '').trim();
    const m = stripped.match(/^(\d+)\s*[.)]\s*(.+)/);
    if (m) {
      choices.push({ value: m[1], label: `${m[1]}. ${m[2].trim()}` });
    }
    // Skip non-numbered lines (descriptions between options) — don't break sequence
  }
  // Only return if we found 2+ consecutive numbered choices
  if (choices.length < 2) return [];
  // Check that numbers are sequential starting from 1
  const nums = choices.map(c => parseInt(c.value, 10));
  if (nums[0] !== 1) return [];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) return [];
  }
  return choices;
}

function sendChatChoice(value) {
  if (!term) return;
  // Remove the choice buttons from the system message that spawned them
  // Find the last system message with choices and strip numbered lines, keep only selected
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const m = chatMessages[i];
    if (m.type === 'system' && m.text) {
      const ch = extractChoices(m.text);
      if (ch.length >= 2) {
        // Find the selected choice label
        const selected = ch.find(c => c.value === value);
        // Remove all numbered choice lines from the message text
        const filtered = m.text.split('\n').filter(line => {
          const stripped = line.replace(/^\s*>\s*/, '').trim();
          return !(/^\d+\s*[.)]\s+/.test(stripped));
        }).join('\n').trim();
        // Replace message: remaining text + selected indicator
        m.text = filtered ? filtered + '\n\n> ' + (selected ? selected.label : value) : (selected ? selected.label : value);
        m._choiceMade = true;
        break;
      }
    }
  }
  chatMessages.push({ type: 'user', text: value });
  lastSentCmd = value;
  chatWaitForInput = false;
  bgBuffer = '';
  lastResponseSnapshot = '';
  if (bgBufferTimer) { clearTimeout(bgBufferTimer); bgBufferTimer = null; }
  renderChatMessages();
  window.tokiAPI.terminalInput(value);
  setTimeout(() => window.tokiAPI.terminalInput('\r'), 50);
}

// Background buffer: always collects terminal output so chat mode can show recent data
function feedBgBuffer(rawData) {
  const text = stripAnsi(rawData);
  if (!text) return;
  // Always keep ● response marker (critical for separating user echo from Claude response)
  const hasMarker = text.includes('●');
  if (!hasMarker && text.trim().length < 2) return;
  if (!hasMarker && isSpinnerNoise(text)) return;
  bgBuffer += text;
  // Trim to max size
  if (bgBuffer.length > BG_BUFFER_MAX) {
    bgBuffer = bgBuffer.slice(-BG_BUFFER_MAX);
  }
  // Save snapshot when buffer contains a ● response marker (for recovery after finalize clears)
  if (bgBuffer.includes('●')) {
    lastResponseSnapshot = bgBuffer;

  }
  // Reset on silence (new conversation segment)
  if (bgBufferTimer) clearTimeout(bgBufferTimer);
  bgBufferTimer = setTimeout(() => { bgBuffer = ''; lastResponseSnapshot = ''; }, 30000);
}

function stripAnsi(str) {
  return str
    // OSC sequences (title changes, hyperlinks) — MUST be first to prevent partial matches
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // Small cursor forward (1-2 cols) → space (word spacing in TUI, e.g. "esc[1Cto" → "esc to")
    .replace(/\x1B\[[012]?C/g, ' ')
    // Other cursor moves → newline (different screen areas)
    .replace(/\x1B\[\d*[ABDEFGHJKSTfn]/g, '\n')
    // Cursor position set (row;col H/f) → newline
    .replace(/\x1B\[\d+;\d+[Hf]/g, '\n')
    // Larger cursor forward (3+) → newline
    .replace(/\x1B\[\d+C/g, '\n')
    // Erase line/screen → newline
    .replace(/\x1B\[\d*[JK]/g, '\n')
    // CSI sequences (colors, styles, modes)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    // Single-character Fe escape sequences
    .replace(/\x1B[@-_]/g, '')
    // Remaining escape codes
    .replace(/\x1B[^a-zA-Z\n]*[a-zA-Z]/g, '')
    // Control characters (except newline/tab)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

// Detect pure Claude Code spinner/TUI noise (no actual content)
function isSpinnerNoise(text) {
  const compact = text.replace(/[\s\n\r]/g, '');
  if (compact.length === 0) return true;
  // Remove all TUI decoration characters
  const core = compact.replace(/[·✻✳✢✶✽✾✿*●○⊙❯❮►◄▶◀─━═╭╮╰╯│┃]/g, '');
  if (core.length === 0) return true;
  // Spinner animation word: "Billowing…", "Coalescing…", "Thinking…", etc.
  if (/^[A-Z][a-z]+…$/.test(core)) return true;
  // Spinner word with (thinking) tag
  if (/^[A-Z][a-z]+…?\s*\(thinking\)$/.test(core)) return true;
  // Just "(thinking)" by itself
  if (/^\(thinking\)$/.test(core)) return true;
  // Partial spinner word fragments from char-by-char animation (e.g. "B", "il", "low")
  if (/^[A-Za-z…]+$/.test(core) && core.length <= 8) return true;
  // TUI chrome words that appear as individual fragments
  if (/^(esc|interrupt|Cursor)$/.test(core)) return true;
  return false;
}

// Clean TUI output (box-drawing, ASCII art) for chat mode display
function cleanTuiOutput(text) {
  // Detect Claude Code welcome screen — require ASCII art block chars (▟█▙) as primary marker
  // These block characters are unique to the Claude Code TUI welcome banner
  const hasAsciiArt = text.includes('▟█▙') || text.includes('▛▜') || text.includes('█▙');
  const hasWelcomeText = text.includes('Welcome') && text.includes('Claude');
  const isWelcomeScreen = hasAsciiArt || (hasWelcomeText && text.length > 200);

  if (isWelcomeScreen) {
    // Extract useful info from welcome screen
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

// ==================== Help Popup ====================

function showHelpPopup() {
  // Remove existing popup if any
  const existing = document.querySelector('.help-popup-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'help-popup-overlay';

  const popup = document.createElement('div');
  popup.className = 'help-popup';

  const header = document.createElement('div');
  header.className = 'help-popup-header';
  header.innerHTML = '<span>💬 RisuToki 도움말</span>';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'help-popup-body';
  body.innerHTML = `
    <h3>📁 파일</h3>
    <div class="help-shortcut"><span>새로만들기</span><kbd>Ctrl+N</kbd></div>
    <div class="help-shortcut"><span>열기</span><kbd>Ctrl+O</kbd></div>
    <div class="help-shortcut"><span>저장</span><kbd>Ctrl+S</kbd></div>
    <div class="help-shortcut"><span>다른이름저장</span><kbd>Ctrl+Shift+S</kbd></div>
    <div class="help-shortcut"><span>탭 닫기</span><kbd>Ctrl+W</kbd></div>

    <h3>✏️ 편집</h3>
    <div class="help-shortcut"><span>실행취소 / 다시실행</span><kbd>Ctrl+Z / Ctrl+Y</kbd></div>
    <div class="help-shortcut"><span>찾기 / 바꾸기</span><kbd>Ctrl+F / Ctrl+H</kbd></div>

    <h3>👁️ 보기</h3>
    <div class="help-shortcut"><span>사이드바 토글</span><kbd>Ctrl+B</kbd></div>
    <div class="help-shortcut"><span>터미널 토글</span><kbd>Ctrl+\`</kbd></div>
    <div class="help-shortcut"><span>확대 / 축소 / 기본</span><kbd>Ctrl++ / Ctrl+- / Ctrl+0</kbd></div>

    <h3>💬 TokiTalk 터미널</h3>
    <div class="help-shortcut"><span>채팅 모드 전환</span><span>💭 버튼</span></div>
    <div class="help-shortcut"><span>배경 이미지 설정</span><span>🖼 버튼</span></div>
    <div class="help-shortcut"><span>Claude Code 시작</span><span>터미널 메뉴</span></div>
    <div class="help-shortcut"><span>Codex 시작</span><span>터미널 메뉴</span></div>

    <h3>🔘 터미널 헤더 버튼</h3>
    <div class="help-shortcut"><span>🐰 RP 모드</span><span>클릭: Claude에 캐릭터 말투 적용</span></div>
    <div class="help-shortcut"><span>🔇 BGM</span><span>클릭: ON/OFF, 우클릭: 파일 변경</span></div>
    <div class="help-shortcut"><span>🖼 배경</span><span>터미널 배경 이미지 설정</span></div>
    <div class="help-shortcut"><span>━ 토글</span><span>터미널 표시/숨김</span></div>

    <h3>🖱️ 패널 관리</h3>
    <div class="help-shortcut"><span>패널 이동</span><span>헤더 드래그</span></div>
    <div class="help-shortcut"><span>팝아웃 (분리)</span><span>우클릭 → 팝아웃</span></div>
    <div class="help-shortcut"><span>사이드바 위치</span><span>보기 메뉴</span></div>
    <div class="help-shortcut"><span>터미널 위치</span><span>보기 메뉴</span></div>
    <div class="help-shortcut"><span>아바타 우클릭</span><span>이미지 수동 변경</span></div>
    <div class="help-shortcut"><span>다크 모드</span><span>보기 메뉴 → 다크 모드 토글</span></div>

    <h3>🔧 편집 항목 안내</h3>
    <div class="help-shortcut"><span>Lua</span><span>트리거 스크립트 (게임 로직)</span></div>
    <div class="help-shortcut"><span>글로벌노트</span><span>AI에 항상 전달되는 지시문</span></div>
    <div class="help-shortcut"><span>첫 메시지</span><span>대화 시작 시 표시 (HTML/CBS)</span></div>
    <div class="help-shortcut"><span>CSS</span><span>Background Embedding (채팅 UI 스타일)</span></div>
    <div class="help-shortcut"><span>로어북</span><span>조건부 프롬프트 (키워드 매칭)</span></div>
    <div class="help-shortcut"><span>정규식</span><span>입출력 텍스트 변환 스크립트</span></div>
    <div class="help-shortcut"><span>에셋</span><span>.charx 내부 이미지 파일</span></div>
    <div class="help-shortcut"><span>참고 자료</span><span>다른 .charx 읽기 전용 참조</span></div>

    <h3>📦 .charx 파일 구조</h3>
    <p style="margin:4px 0;color:var(--text-secondary);font-size:12px;">
      .charx = ZIP 파일 (card.json + module.risum + assets/)<br>
      module.risum에 Lua, 정규식, 로어북이 RPack 인코딩으로 저장됩니다.
    </p>

    <div style="margin-top:10px;border-top:1px solid var(--border-color);padding-top:8px;">
      <button id="btn-syntax-ref" style="width:100%;padding:8px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">📖 문법 레퍼런스 보기</button>
    </div>
  `;

  // Syntax reference button
  setTimeout(() => {
    const syntaxBtn = popup.querySelector('#btn-syntax-ref');
    if (syntaxBtn) syntaxBtn.addEventListener('click', () => { overlay.remove(); showSyntaxReference(); });
  }, 0);

  popup.appendChild(header);
  popup.appendChild(body);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  // Click overlay background to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ==================== Syntax Reference Popout ====================

function showSyntaxReference() {
  const overlay = document.createElement('div');
  overlay.className = 'help-popup-overlay';

  const popup = document.createElement('div');
  popup.className = 'syntax-ref-popup';

  const header = document.createElement('div');
  header.className = 'help-popup-header';
  header.innerHTML = '<span>📖 문법 레퍼런스</span>';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  // Navigation tabs
  const nav = document.createElement('div');
  nav.className = 'syntax-nav';
  const sections = [
    { id: 'cbs', label: 'CBS 매크로' },
    { id: 'lua', label: 'Lua API' },
    { id: 'lorebook', label: '로어북' },
    { id: 'regex', label: '정규식' },
    { id: 'html', label: 'HTML/CSS' },
    { id: 'patterns', label: '핵심 패턴' },
    { id: 'tips', label: '팁' },
  ];

  const body = document.createElement('div');
  body.className = 'syntax-ref-body';

  function showSection(sectionId) {
    for (const btn of nav.children) btn.classList.remove('active');
    nav.querySelector(`[data-id="${sectionId}"]`).classList.add('active');
    body.innerHTML = syntaxContent[sectionId] || '';
  }

  for (const s of sections) {
    const btn = document.createElement('button');
    btn.className = 'syntax-nav-btn';
    btn.dataset.id = s.id;
    btn.textContent = s.label;
    btn.addEventListener('click', () => showSection(s.id));
    nav.appendChild(btn);
  }

  popup.appendChild(header);
  popup.appendChild(nav);
  popup.appendChild(body);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  showSection('cbs');
}

const syntaxContent = {
  cbs: `
<h3>변수</h3>
<table class="syn-table">
  <tr><td><code>{{getvar::이름}}</code></td><td>변수 읽기</td></tr>
  <tr><td><code>{{setvar::이름::값}}</code></td><td>변수 쓰기</td></tr>
  <tr><td><code>{{addvar::이름::값}}</code></td><td>숫자 더하기</td></tr>
  <tr><td><code>{{getglobalvar::이름}}</code></td><td>전역 변수 읽기</td></tr>
  <tr><td><code>{{setglobalvar::이름::값}}</code></td><td>전역 변수 쓰기</td></tr>
</table>

<h3>임시 변수 (Temp Var)</h3>
<table class="syn-table">
  <tr><td><code>{{settempvar::이름::값}}</code></td><td>임시 변수 설정 (현재 턴만)</td></tr>
  <tr><td><code>{{gettempvar::이름}}</code></td><td>임시 변수 읽기</td></tr>
</table>
<p class="syn-tip">💡 임시 변수는 현재 턴/파싱 내에서만 유효, 저장 안됨</p>

<h3>딕셔너리 (Dict)</h3>
<table class="syn-table">
  <tr><td><code>{{dict::A=값1::B=값2}}</code></td><td>딕셔너리 생성</td></tr>
  <tr><td><code>{{dict_element::dict::키}}</code></td><td>딕셔너리에서 값 조회</td></tr>
  <tr><td><code>{{dict_assert::dict::키::값}}</code></td><td>키의 값이 맞는지 확인 (true/false)</td></tr>
</table>

<h3>조건문</h3>
<div class="syn-code">{{#if {{getvar::hp}} &gt; 0}}
  살아있음
{{#else}}
  사망
{{/if}}</div>

<div class="syn-code">{{#when A is B}}...{{/when}}
{{#when A isnot B}}...{{/when}}
{{#when A > B}}...{{/when}}</div>
<p class="syn-tip">💡 <code>#when</code>이 <code>#if</code>보다 직관적. 연산자: is, isnot, &gt;, &lt;, &gt;=, &lt;=, and, or, not</p>

<table class="syn-table">
  <tr><td><code>{{all::A::B::C}}</code></td><td>A, B, C 모두 true면 true</td></tr>
  <tr><td><code>{{any::A::B::C}}</code></td><td>하나라도 true면 true</td></tr>
  <tr><td><code>{{isfirstmsg}}</code></td><td>첫 메시지인지 확인</td></tr>
</table>

<h3>수학</h3>
<table class="syn-table">
  <tr><td><code>{{calc::A+B}}</code></td><td>계산 (+ - * / %)</td></tr>
  <tr><td><code>{{floor::}}</code> <code>{{ceil::}}</code> <code>{{round::}}</code></td><td>올림/내림/반올림</td></tr>
  <tr><td><code>{{min::A::B}}</code> <code>{{max::A::B}}</code></td><td>최소/최대</td></tr>
  <tr><td><code>{{pow::A::B}}</code></td><td>A의 B제곱</td></tr>
  <tr><td><code>{{average::A::B::C}}</code></td><td>평균값</td></tr>
  <tr><td><code>{{fix_number::값::소수점}}</code></td><td>소수점 자릿수 고정</td></tr>
  <tr><td><code>{{? 수식}}</code></td><td><code>{{calc::}}</code>의 약어</td></tr>
  <tr><td><code>{{tonumber::텍스트}}</code></td><td>문자열 → 숫자 변환</td></tr>
</table>

<h3>문자열</h3>
<table class="syn-table">
  <tr><td><code>{{replace::대상::찾기::바꾸기}}</code></td><td>치환</td></tr>
  <tr><td><code>{{contains::텍스트::검색}}</code></td><td>포함 여부 (true/false)</td></tr>
  <tr><td><code>{{length::텍스트}}</code></td><td>글자 수</td></tr>
  <tr><td><code>{{split::텍스트::구분자}}</code></td><td>분할 → 배열</td></tr>
  <tr><td><code>{{endswith::텍스트::접미사}}</code></td><td>접미사 확인</td></tr>
  <tr><td><code>{{capitalize::텍스트}}</code></td><td>첫 글자 대문자</td></tr>
  <tr><td><code>{{trim::텍스트}}</code></td><td>앞뒤 공백 제거</td></tr>
</table>

<h3>배열 조작</h3>
<table class="syn-table">
  <tr><td><code>{{array_push::배열::값}}</code></td><td>배열 끝에 추가</td></tr>
  <tr><td><code>{{array_pop::배열}}</code></td><td>배열 끝 제거 + 반환</td></tr>
  <tr><td><code>{{array_shift::배열}}</code></td><td>배열 앞 제거 + 반환</td></tr>
  <tr><td><code>{{array_splice::배열::시작::삭제수}}</code></td><td>배열 잘라내기</td></tr>
  <tr><td><code>{{filter::배열::조건}}</code></td><td>조건에 맞는 요소만</td></tr>
</table>

<h3>랜덤</h3>
<table class="syn-table">
  <tr><td><code>{{random::A::B::C}}</code></td><td>A, B, C 중 랜덤</td></tr>
  <tr><td><code>{{randint::1::100}}</code></td><td>1~100 랜덤 정수</td></tr>
  <tr><td><code>{{roll::2d6}}</code></td><td>주사위 (2d6 = 6면체 2개)</td></tr>
  <tr><td><code>{{pick::시드::A::B::C}}</code></td><td>결정적 랜덤 (시드 고정 = 같은 결과)</td></tr>
  <tr><td><code>{{rollp::시드::2d6}}</code></td><td>결정적 주사위 (시드 고정)</td></tr>
</table>

<h3>데이터 참조</h3>
<table class="syn-table">
  <tr><td><code>{{personality}}</code></td><td>캐릭터 personality 필드</td></tr>
  <tr><td><code>{{description}}</code></td><td>캐릭터 description 필드</td></tr>
  <tr><td><code>{{char}}</code></td><td>캐릭터 이름</td></tr>
  <tr><td><code>{{user}}</code></td><td>유저 이름</td></tr>
  <tr><td><code>{{previous_chat_log::N}}</code></td><td>최근 N개 채팅 로그</td></tr>
  <tr><td><code>{{lastmessage}}</code></td><td>마지막 메시지 내용</td></tr>
  <tr><td><code>{{lastmessageid}}</code></td><td>마지막 메시지 인덱스</td></tr>
  <tr><td><code>{{chat_index}}</code></td><td>현재 메시지 인덱스</td></tr>
</table>

<h3>반복</h3>
<div class="syn-code">{{#each {{split::a,b,c::,}} as item}}
  항목: {{item}}
{{/each}}</div>

<h3>함수</h3>
<div class="syn-code">{{#func 함수명 param}}
  결과: {{param}}
{{/func}}
{{call::함수명::인자}}</div>

<h3>제어</h3>
<table class="syn-table">
  <tr><td><code>{{return::메시지}}</code></td><td>현재 메시지를 대체 + CBS 중단</td></tr>
</table>
<p class="syn-tip">💡 <code>{{return::}}</code>은 남은 CBS 처리를 모두 중단하고 지정 텍스트로 대체</p>

<h3>버튼</h3>
<div class="syn-code">{{button::버튼이름::함수명}}</div>
<p class="syn-tip">💡 Lua에서 <code>onButtonClick(id, data)</code>로 받음</p>
  `,

  lua: `
<h3>이벤트 함수</h3>
<table class="syn-table">
  <tr><td><code>onStart(id)</code></td><td>프롬프트 생성 전 (매 턴)</td></tr>
  <tr><td><code>onOutput(id)</code></td><td>AI 응답 후 (표시 전)</td></tr>
  <tr><td><code>onInput(id)</code></td><td>유저 입력 확인 후</td></tr>
  <tr><td><code>onButtonClick(id, data)</code></td><td>버튼 클릭 시</td></tr>
  <tr><td><code>editDisplay(id)</code></td><td>UI 표시 변경 (데이터 불변)</td></tr>
</table>

<h3>채팅 API</h3>
<table class="syn-table">
  <tr><td><code>getChat(id, idx)</code></td><td>메시지 읽기 (0-based)</td></tr>
  <tr><td><code>setChat(id, idx, data)</code></td><td>메시지 수정</td></tr>
  <tr><td><code>addChat(id, data)</code></td><td>메시지 추가</td></tr>
  <tr><td><code>removeChat(id, idx)</code></td><td>메시지 삭제</td></tr>
  <tr><td><code>getChatLength(id)</code></td><td>메시지 수 <b>(1-based!)</b></td></tr>
</table>
<p class="syn-tip">⚠️ <code>getChatLength</code>는 1-based, <code>getChat/setChat</code>은 0-based. 마지막: <code>getChat(id, getChatLength(id)-1)</code></p>

<h3>변수 API</h3>
<table class="syn-table">
  <tr><td><code>getChatVar(id, "key")</code></td><td>채팅 변수 읽기 (문자열)</td></tr>
  <tr><td><code>setChatVar(id, "key", val)</code></td><td>채팅 변수 쓰기</td></tr>
  <tr><td><code>getState(id, "key")</code></td><td>상태 읽기 (자동 JSON 파싱)</td></tr>
  <tr><td><code>setState(id, "key", val)</code></td><td>상태 쓰기 (자동 JSON 직렬화)</td></tr>
</table>

<h3>LLM 호출</h3>
<div class="syn-code">local result = LLM(id, "질문 내용"):await()
-- simpleLLM: 시스템 프롬프트 없이 간단한 호출
local text = simpleLLM(id, "간단한 질문"):await()</div>
<p class="syn-tip">⚠️ 비동기 함수는 반드시 <code>:await()</code> 필요</p>

<h3>UI 알림</h3>
<table class="syn-table">
  <tr><td><code>alertNormal(id, "메시지")</code></td><td>일반 알림</td></tr>
  <tr><td><code>alertError(id, "메시지")</code></td><td>에러 알림</td></tr>
  <tr><td><code>alertInput(id, "질문"):await()</code></td><td>입력 받기</td></tr>
  <tr><td><code>alertSelect(id, {"옵션1","옵션2"}):await()</code></td><td>선택지</td></tr>
  <tr><td><code>alertConfirm(id, "질문"):await()</code></td><td>확인/취소</td></tr>
</table>

<h3>로어북 조작</h3>
<div class="syn-code">local books = getLoreBooks(id)  -- 전체 로어북
loadLoreBooks(id):await()        -- 리로드
upsertLocalLoreBook(id, {        -- 추가/수정
  key = "키",
  content = "내용",
  alwaysActive = true
})</div>

<h3>기타</h3>
<table class="syn-table">
  <tr><td><code>getTokens(id, "텍스트")</code></td><td>토큰 수 계산</td></tr>
  <tr><td><code>reloadDisplay(id)</code></td><td>화면 갱신</td></tr>
  <tr><td><code>stopChat(id)</code></td><td>응답 중단 (현재 불안정)</td></tr>
</table>
  `,

  lorebook: `
<h3>기본 필드</h3>
<table class="syn-table">
  <tr><td><b>이름</b></td><td>관리용 코멘트 (AI에 안 보임)</td></tr>
  <tr><td><b>활성화 키</b></td><td>쉼표(,) 구분, 하나라도 매칭되면 활성화</td></tr>
  <tr><td><b>멀티플 키</b></td><td>"선택적" 체크 시, 활성화 키 + 멀티플 키 <b>둘 다</b> 매칭 필요</td></tr>
  <tr><td><b>배치 순서</b></td><td>숫자가 클수록 프롬프트 뒤쪽에 배치</td></tr>
</table>

<h3>체크박스</h3>
<table class="syn-table">
  <tr><td><b>언제나 활성화</b></td><td>키워드 매칭 없이 항상 삽입</td></tr>
  <tr><td><b>강제 활성화</b></td><td>토큰 제한 무시하고 강제 삽입</td></tr>
  <tr><td><b>선택적</b></td><td>활성화 키 + 멀티플 키 동시 매칭 필요</td></tr>
</table>

<h3>데코레이터 (content 첫 줄에 작성)</h3>
<div class="syn-code">@@depth 0              삽입 깊이 (0=최하단)
@@role system          역할 (system/user/assistant)
@@activate_only_after 5   5턴 이후부터 활성화
@@activate_only_every 3   3턴마다 활성화
@@probability 50       50% 확률로 활성화
@@exclude_keys A,B     A 또는 B 존재 시 비활성화
@@dont_activate        수동 활성화 전용 (Lua로 제어)</div>

<h3>역할 지정 데코레이터</h3>
<table class="syn-table">
  <tr><td><code>@@@system</code></td><td>system 역할로 삽입</td></tr>
  <tr><td><code>@@@user</code></td><td>user 역할로 삽입</td></tr>
  <tr><td><code>@@@assistant</code></td><td>assistant 역할로 삽입</td></tr>
  <tr><td><code>@@@end</code></td><td>프롬프트 최하단에 강제 배치</td></tr>
</table>
<p class="syn-tip">💡 <code>@@@end</code>는 @@depth 0보다 더 아래. 최종 지시문에 사용</p>

<h3>CBS 사용</h3>
<p class="syn-tip">💡 로어북 content 안에서 CBS 매크로 전부 사용 가능</p>
<div class="syn-code">{{#if {{getvar::phase}} is battle}}
  전투 관련 설정...
{{/if}}</div>
  `,

  regex: `
<h3>Modification Type</h3>
<table class="syn-table">
  <tr><td><b>입력문 수정</b></td><td>유저 입력 → LLM 전송 전에 변환</td></tr>
  <tr><td><b>출력문 수정</b></td><td>AI 응답 → 저장 전에 변환 (데이터 변경됨)</td></tr>
  <tr><td><b>리퀘스트 데이터 수정</b></td><td>프롬프트 전체 → LLM 전송 전에 변환</td></tr>
  <tr><td><b>디스플레이 수정</b></td><td>표시만 변경 (원본 데이터 불변)</td></tr>
  <tr><td><b>번역문 수정</b></td><td>번역 후에 적용</td></tr>
</table>

<h3>Normal Flag</h3>
<table class="syn-table">
  <tr><td><code>g</code> Global</td><td>전체 매칭 (첫 번째만 X)</td></tr>
  <tr><td><code>i</code> Case Insensitive</td><td>대소문자 무시</td></tr>
  <tr><td><code>m</code> Multi Line</td><td>^ $ 가 각 줄에 매칭</td></tr>
  <tr><td><code>s</code> Dot All</td><td>. 이 줄바꿈도 매칭</td></tr>
  <tr><td><code>u</code> Unicode</td><td>유니코드 지원</td></tr>
</table>

<h3>Special Flag</h3>
<table class="syn-table">
  <tr><td><b>Move Top</b></td><td>매칭 결과를 최상단으로 이동</td></tr>
  <tr><td><b>Move Bottom</b></td><td>매칭 결과를 최하단으로 이동</td></tr>
  <tr><td><b>Repeat Back</b></td><td>역방향으로 반복 적용</td></tr>
  <tr><td><b>IN CBS Parsing</b></td><td>CBS 파싱 단계에서 적용</td></tr>
  <tr><td><b>No Newline Suffix</b></td><td>치환 후 줄바꿈 미추가</td></tr>
</table>

<h3>OUT에서 CBS/HTML 사용</h3>
<div class="syn-code">IN:  \\{STATUS\\|([^}]+)\\}
OUT: &lt;div class="status"&gt;$1&lt;/div&gt;</div>
<p class="syn-tip">💡 <code>$&amp;</code> = 매칭된 전체 문자열, <code>$1</code> = 첫 번째 캡처 그룹</p>

<h3>특수 치환 명령 (OUT)</h3>
<table class="syn-table">
  <tr><td><code>@@emo 이름</code></td><td>감정 이미지 설정 (아바타 변경)</td></tr>
  <tr><td><code>@@repeat_back 위치</code></td><td>미매칭 시 이전 결과 복사 (위치: before/after)</td></tr>
</table>

<h3>토큰 최적화 패턴</h3>
<div class="syn-code">IN:  패턴
OUT: {{#if {{greater_equal::{{chat_index}}::
       {{? {{lastmessageid}}-5}}}}}}$&amp;{{/if}}</div>
<p class="syn-tip">💡 최근 5개 메시지만 표시, 이전 것은 숨김 → 토큰 절약</p>

<h3>처리 순서</h3>
<div class="syn-code">CBS 파싱 → Lua 트리거 → CBS 재파싱 → 정규식(CBS포함) → 표시</div>
  `,

  html: `
<h3>제약사항</h3>
<table class="syn-table">
  <tr><td>❌ <code>:root</code></td><td>사용 금지</td></tr>
  <tr><td>❌ <code>&lt;script&gt;</code></td><td>사용 금지</td></tr>
  <tr><td>❌ 빈 줄</td><td>태그 사이에 <b>빈 줄 금지</b> (파싱 깨짐)</td></tr>
  <tr><td>❌ <code>&lt;input type="radio"&gt;</code></td><td>파싱 버그 있음</td></tr>
  <tr><td>✅ CSS</td><td><b>Background Embedding</b>에 작성 (정규식 X)</td></tr>
</table>

<h3>CSS 클래스 자동 변환</h3>
<p class="syn-tip">⚠️ RisuAI가 모든 클래스에 <code>x-risu-</code> 접두사 자동 추가</p>
<div class="syn-code">/* 작성 */
.status { color: red; }
/* 실제 적용 */
.x-risu-status { color: red; }

/* 인접 셀렉터 (수동 접두사 필요) */
.status.x-risu-active { ... }

/* 부모-자식은 자동 변환됨 */
.parent .child { ... }</div>

<h3>HTML 패턴 예시</h3>
<div class="syn-code">&lt;div class="panel"&gt;
  &lt;div class="panel stat"&gt;
    &lt;span&gt;HP:&lt;/span&gt;
    &lt;span&gt;{{getvar::hp}}/{{getvar::max_hp}}&lt;/span&gt;
  &lt;/div&gt;
&lt;/div&gt;</div>
<p class="syn-tip">💡 CBS 매크로를 HTML 안에서 직접 사용 가능</p>

<h3>버튼 연동</h3>
<div class="syn-code">&lt;button risu-btn="attack"&gt;공격&lt;/button&gt;
&lt;button risu-trigger="onButton"&gt;트리거&lt;/button&gt;</div>
<p class="syn-tip">💡 <code>risu-btn</code>: Lua <code>onButtonClick(id, "attack")</code>으로 전달</p>
  `,

  patterns: `
<h3>1. 버튼 → 변수 → 표시</h3>
<div class="syn-code">-- HTML에서 risu-btn="start" 클릭
function onButtonClick(id, data)
  if data == "start" then
    setChatVar(id, "cv_phase", "battle")
    reloadDisplay(id)
  end
end</div>

<h3>2. 단계별 UI (Step)</h3>
<div class="syn-code">{{#if {{getvar::cv_step}} is 0}}
  [시작 화면]
  {{button::다음::nextStep}}
{{/if}}
{{#if {{getvar::cv_step}} is 1}}
  [두 번째 화면]
{{/if}}</div>

<h3>3. AI 응답 태그 파싱</h3>
<div class="syn-code">-- 글로벌노트에 지시: {DAMAGE|30} 형식 출력
-- Lua에서 파싱:
local msg = getChat(id, getChatLength(id)-1)
local dmg = msg.data:match("{DAMAGE|(%d+)}")
if dmg then
  local hp = getState(id, "hp") - tonumber(dmg)
  setState(id, "hp", hp)
end</div>

<h3>4. 동적 로어북</h3>
<div class="syn-code">-- @@dont_activate로 미리 만들어 두고
-- Lua에서 필요할 때 활성화
upsertLocalLoreBook(id, {
  key = "battle_info",
  content = "현재 전투 상태...",
  alwaysActive = true
})</div>

<h3>5. 비동기 입력</h3>
<div class="syn-code">-- async() 래퍼 필수
async(function()
  local name = alertInput(id, "이름 입력"):await()
  setState(id, "player_name", name)
end)</div>

<h3>6. 접두사 기반 버튼 처리</h3>
<div class="syn-code">function onButtonClick(id, data)
  if data:match("^item%-") then
    local itemId = data:sub(6) -- "item-" 이후
    -- 아이템 처리...
  elseif data:match("^skill%-") then
    local skillId = data:sub(7)
    -- 스킬 처리...
  end
end</div>

<h3>7. 사이드 패널</h3>
<p class="syn-tip">💡 첫 메시지에 태그 삽입 → 정규식으로 매 표시마다 렌더링 → CSS <code>position: fixed</code></p>
  `,

  tips: `
<h3>⚠️ 흔한 실수</h3>
<table class="syn-table">
  <tr><td><code>getChatLength</code></td><td><b>1-based</b>! 마지막 인덱스 = length-1</td></tr>
  <tr><td>비동기 함수</td><td><code>:await()</code> 빼먹으면 nil 반환</td></tr>
  <tr><td>HTML 빈 줄</td><td>태그 사이 빈 줄 → 파싱 깨짐</td></tr>
  <tr><td>CSS :root</td><td>사용하면 전체 UI 깨짐</td></tr>
  <tr><td>Lua % 이스케이프</td><td>패턴에서 <code>.</code>은 <code>%.</code>, <code>-</code>은 <code>%-</code></td></tr>
  <tr><td><code>stopChat(id)</code></td><td>현재 불안정 — 사용 주의</td></tr>
</table>

<h3>🚀 성능 팁</h3>
<table class="syn-table">
  <tr><td>토큰 최적화</td><td>이미지/UI를 최근 N개만 표시 (정규식 + chat_index)</td></tr>
  <tr><td>CSS 위치</td><td>Background Embedding에 작성 (정규식 OUT X)</td></tr>
  <tr><td>로어북 분리</td><td>긴 내용은 여러 항목으로 분할</td></tr>
  <tr><td>상태 변수</td><td>장기 상태(HP, 아이템)는 토큰 최적화에서 제외</td></tr>
</table>

<h3>📐 처리 순서</h3>
<div class="syn-code">1. CBS 매크로 파싱
2. Lua 트리거 실행 (onStart/onOutput/onInput)
3. CBS 재파싱 (Lua가 변경한 내용)
4. 정규식 적용 (CBS 포함)
5. 화면 표시</div>

<h3>🔧 디버깅</h3>
<table class="syn-table">
  <tr><td><code>alertNormal(id, tostring(val))</code></td><td>변수값 확인</td></tr>
  <tr><td><code>print()</code></td><td>Lua 콘솔 출력 (개발자 도구)</td></tr>
  <tr><td>정규식 테스트</td><td>디스플레이 수정 타입으로 먼저 테스트</td></tr>
</table>
  `
};

// ==================== Autosave ====================

function startAutosave() {
  stopAutosave();
  if (!autosaveEnabled) return;
  autosaveTimer = setInterval(async () => {
    if (dirtyFields.size === 0 || !fileData) return;
    const filePath = await window.tokiAPI.getFilePath();
    if (!filePath && !autosaveDir) return;
    const updatedFields = collectDirtyFields();
    if (autosaveDir) updatedFields._autosaveDir = autosaveDir;
    const result = await window.tokiAPI.autosaveFile(updatedFields);
    if (result && result.success) {
      setStatus(`자동 저장됨: ${result.path.split(/[/\\]/).pop()}`);
    }
  }, autosaveInterval);
}

function stopAutosave() {
  if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
}

function collectDirtyFields() {
  const fields = {};
  for (const tab of openTabs) {
    if (tab.getValue) {
      const val = tab.getValue();
      if (val !== undefined && val !== null) {
        // Map tab id to data field
        if (tab.id === 'lua' || tab.id.startsWith('lua_s')) {
          fields.lua = fileData.lua;
        } else if (tab.id.startsWith('css_s')) {
          // CSS 개별 섹션 → combineCssSections()로 이미 fileData.css에 <style> 포함
          fields.css = fileData.css;
        } else if (tab.id === 'css') {
          // CSS 저장 시 <style> 태그 없으면 강제 감싸기
          let cssVal = val;
          if (cssVal && cssVal.trim() && !/<style[\s>]/i.test(cssVal)) {
            cssVal = '<style>\n' + cssVal + '\n</style>';
          }
          fields.css = cssVal;
        } else if (['globalNote', 'firstMessage', 'defaultVariables', 'description', 'name'].includes(tab.id)) {
          fields[tab.id] = val;
        }
      }
    }
  }
  // Always include lorebook and regex if dirty
  if (dirtyFields.has('lorebook') || [...dirtyFields].some(f => f.startsWith('lore_'))) {
    fields.lorebook = fileData.lorebook;
  }
  if (dirtyFields.has('regex') || [...dirtyFields].some(f => f.startsWith('regex_'))) {
    fields.regex = fileData.regex;
  }
  return fields;
}

// ==================== Settings Popup ====================

function showSettingsPopup() {
  const existing = document.querySelector('.help-popup-overlay.settings-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'help-popup-overlay settings-overlay';

  const popup = document.createElement('div');
  popup.className = 'settings-popup';

  const header = document.createElement('div');
  header.className = 'help-popup-header';
  header.innerHTML = '<span>⚙ 설정</span>';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'help-popup-body';
  body.style.padding = '16px';

  // Helper: create toggle
  function createToggle(isOn) {
    const btn = document.createElement('button');
    btn.className = 'settings-toggle' + (isOn ? ' on' : '');
    btn.addEventListener('click', () => btn.classList.toggle('on'));
    return btn;
  }

  // --- Autosave ON/OFF ---
  const autoRow = document.createElement('div');
  autoRow.className = 'settings-row';
  const autoLeft = document.createElement('div');
  autoLeft.innerHTML = '<div class="settings-label">자동 저장</div><div class="settings-desc">일정 간격으로 임시 파일에 저장</div>';
  const autoToggle = createToggle(autosaveEnabled);
  autoToggle.addEventListener('click', () => {
    autosaveEnabled = autoToggle.classList.contains('on');
    localStorage.setItem('toki-autosave', autosaveEnabled);
    if (autosaveEnabled) startAutosave();
    else stopAutosave();
  });
  autoRow.appendChild(autoLeft);
  autoRow.appendChild(autoToggle);
  body.appendChild(autoRow);

  // --- Autosave Interval ---
  const intervalRow = document.createElement('div');
  intervalRow.className = 'settings-row';
  const intervalLeft = document.createElement('div');
  intervalLeft.innerHTML = '<div class="settings-label">저장 간격</div><div class="settings-desc">자동 저장 실행 주기</div>';
  const intervalSelect = document.createElement('select');
  intervalSelect.className = 'settings-select';
  const intervals = [
    { value: 60000, label: '1분' },
    { value: 300000, label: '5분' },
    { value: 600000, label: '10분' },
    { value: 1200000, label: '20분' },
    { value: 1800000, label: '30분' },
  ];
  for (const iv of intervals) {
    const opt = document.createElement('option');
    opt.value = iv.value;
    opt.textContent = iv.label;
    if (autosaveInterval === iv.value) opt.selected = true;
    intervalSelect.appendChild(opt);
  }
  intervalSelect.addEventListener('change', () => {
    autosaveInterval = parseInt(intervalSelect.value, 10);
    localStorage.setItem('toki-autosave-interval', autosaveInterval);
    if (autosaveEnabled) startAutosave(); // restart with new interval
  });
  intervalRow.appendChild(intervalLeft);
  intervalRow.appendChild(intervalSelect);
  body.appendChild(intervalRow);

  // --- Autosave Location ---
  const autoPathRow = document.createElement('div');
  autoPathRow.className = 'settings-row';
  autoPathRow.style.cssText = 'flex-direction:column;align-items:stretch;gap:4px;';
  const autoPathLabel = document.createElement('div');
  autoPathLabel.innerHTML = '<div class="settings-label">저장 위치</div><div class="settings-desc">비어있으면 파일과 같은 폴더에 저장</div>';
  const autoPathDisplay = document.createElement('div');
  autoPathDisplay.style.cssText = 'font-size:11px;color:var(--text-secondary);word-break:break-all;padding:4px 6px;background:var(--bg-tertiary);border-radius:4px;min-height:18px;';
  autoPathDisplay.textContent = autosaveDir || '(파일과 같은 폴더)';
  const autoPathBtns = document.createElement('div');
  autoPathBtns.style.cssText = 'display:flex;gap:6px;margin-top:2px;';
  const pickDirBtn = document.createElement('button');
  pickDirBtn.className = 'settings-btn';
  pickDirBtn.textContent = '폴더 선택';
  pickDirBtn.addEventListener('click', async () => {
    const dir = await window.tokiAPI.pickAutosaveDir();
    if (dir) {
      autosaveDir = dir;
      localStorage.setItem('toki-autosave-dir', dir);
      autoPathDisplay.textContent = dir;
    }
  });
  const resetDirBtn = document.createElement('button');
  resetDirBtn.className = 'settings-btn';
  resetDirBtn.textContent = '초기화';
  resetDirBtn.addEventListener('click', () => {
    autosaveDir = '';
    localStorage.removeItem('toki-autosave-dir');
    autoPathDisplay.textContent = '(파일과 같은 폴더)';
  });
  const openDirBtn = document.createElement('button');
  openDirBtn.className = 'settings-btn';
  openDirBtn.textContent = '폴더 열기';
  openDirBtn.addEventListener('click', async () => {
    if (autosaveDir) {
      window.tokiAPI.openFolder(autosaveDir);
    } else {
      const info = await window.tokiAPI.getAutosaveInfo();
      if (info) window.tokiAPI.openFolder(info.dir);
      else setStatus('파일을 먼저 열어주세요');
    }
  });
  autoPathBtns.appendChild(pickDirBtn);
  autoPathBtns.appendChild(resetDirBtn);
  autoPathBtns.appendChild(openDirBtn);
  autoPathRow.appendChild(autoPathLabel);
  autoPathRow.appendChild(autoPathDisplay);
  autoPathRow.appendChild(autoPathBtns);
  body.appendChild(autoPathRow);

  // --- Dark Mode ---
  const darkRow = document.createElement('div');
  darkRow.className = 'settings-row';
  const darkLeft = document.createElement('div');
  darkLeft.innerHTML = '<div class="settings-label">다크 모드</div><div class="settings-desc">아리스 테마 (다크)</div>';
  const darkToggle = createToggle(darkMode);
  darkToggle.addEventListener('click', () => {
    toggleDarkMode();
    // Sync toggle state
    if (darkMode !== darkToggle.classList.contains('on')) {
      darkToggle.classList.toggle('on');
    }
  });
  darkRow.appendChild(darkLeft);
  darkRow.appendChild(darkToggle);
  body.appendChild(darkRow);

  // --- BGM ---
  const bgmRow = document.createElement('div');
  bgmRow.className = 'settings-row';
  const bgmLeft = document.createElement('div');
  bgmLeft.innerHTML = '<div class="settings-label">BGM</div><div class="settings-desc">터미널 응답 시 배경음악 재생</div>';
  const bgmToggle = createToggle(bgmEnabled);
  bgmToggle.addEventListener('click', () => {
    bgmEnabled = bgmToggle.classList.contains('on');
    localStorage.setItem('toki-bgm-enabled', bgmEnabled);
    const bgmBtn = document.getElementById('btn-bgm');
    if (bgmBtn) updateBgmButtonStyle(bgmBtn);
    if (!bgmEnabled && bgmAudio && !bgmAudio.paused) bgmAudio.pause();
  });
  bgmRow.appendChild(bgmLeft);
  bgmRow.appendChild(bgmToggle);
  body.appendChild(bgmRow);

  // --- RP Mode (dropdown + custom editor) ---
  const rpRow = document.createElement('div');
  rpRow.className = 'settings-row';
  const rpLeft = document.createElement('div');
  rpLeft.innerHTML = `<div class="settings-label">RP 모드</div><div class="settings-desc">Claude 응답에 캐릭터 페르소나 적용</div>`;
  const rpSelect = document.createElement('select');
  rpSelect.className = 'settings-select';
  const rpOptions = [
    { value: 'off', label: 'OFF' },
    { value: 'toki', label: '토키 (라이트)' },
    { value: 'aris', label: '아리스 (다크)' },
    { value: 'custom', label: '커스텀' },
  ];
  for (const opt of rpOptions) {
    const o = document.createElement('option');
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === rpMode) o.selected = true;
    rpSelect.appendChild(o);
  }
  rpRow.appendChild(rpLeft);
  rpRow.appendChild(rpSelect);
  body.appendChild(rpRow);

  // Custom persona textarea (shown only when 'custom' selected)
  const rpCustomRow = document.createElement('div');
  rpCustomRow.className = 'settings-row';
  rpCustomRow.style.cssText = 'flex-direction:column;align-items:stretch;gap:6px;';
  if (rpMode !== 'custom') rpCustomRow.style.display = 'none';
  const rpCustomLabel = document.createElement('div');
  rpCustomLabel.innerHTML = '<div class="settings-label">커스텀 페르소나</div>';
  const rpCustomArea = document.createElement('textarea');
  rpCustomArea.className = 'settings-textarea';
  rpCustomArea.rows = 8;
  rpCustomArea.placeholder = '캐릭터 페르소나를 직접 작성하세요...';
  rpCustomArea.value = rpCustomText;
  rpCustomRow.appendChild(rpCustomLabel);
  rpCustomRow.appendChild(rpCustomArea);
  body.appendChild(rpCustomRow);

  // Preview/edit built-in persona button
  const rpEditRow = document.createElement('div');
  rpEditRow.className = 'settings-row';
  rpEditRow.style.cssText = 'justify-content:flex-end;';
  if (rpMode === 'off' || rpMode === 'custom') rpEditRow.style.display = 'none';
  const rpEditBtn = document.createElement('button');
  rpEditBtn.className = 'settings-btn';
  rpEditBtn.textContent = '페르소나 파일 편집';
  rpEditBtn.addEventListener('click', async () => {
    const name = rpSelect.value;
    if (name === 'off' || name === 'custom') return;
    const tabId = `persona_${name}`;
    const existing = openTabs.find(t => t.id === tabId);
    if (existing) { activeTabId = tabId; createOrSwitchEditor(existing); updateTabUI(); }
    else {
      const content = await window.tokiAPI.readPersona(name);
      openTab(tabId, `[페르소나] ${name}.txt`, 'plaintext',
        () => content || '',
        (val) => { window.tokiAPI.writePersona(name, val); setStatus(`페르소나 저장: ${name}.txt`); }
      );
    }
    overlay.remove();
  });
  rpEditRow.appendChild(rpEditBtn);
  body.appendChild(rpEditRow);

  rpSelect.addEventListener('change', () => {
    rpMode = rpSelect.value;
    localStorage.setItem('toki-rp-mode', rpMode);
    const btn = document.getElementById('btn-rp-mode');
    if (btn) updateRpButtonStyle(btn);
    rpCustomRow.style.display = rpMode === 'custom' ? '' : 'none';
    rpEditRow.style.display = (rpMode !== 'off' && rpMode !== 'custom') ? '' : 'none';
  });
  rpCustomArea.addEventListener('input', () => {
    rpCustomText = rpCustomArea.value;
    localStorage.setItem('toki-rp-custom', rpCustomText);
  });

  popup.appendChild(header);
  popup.appendChild(body);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ==================== Preview Test Panel ====================

async function showPreviewPanel() {
  if (!fileData) { setStatus('파일을 먼저 열어주세요'); return; }

  // Remove existing
  const existing = document.querySelector('.preview-overlay');
  if (existing) existing.remove();

  const charData = {
    name: fileData.name || 'Character',
    description: fileData.description || '',
    firstMessage: fileData.firstMessage || '',
    globalNote: fileData.globalNote || '',
    css: fileData.css || '',
    defaultVariables: fileData.defaultVariables || '',
    lua: fileData.lua || '',
    lorebook: fileData.lorebook || [],
    regex: fileData.regex || [],
  };

  // Load all assets (name → data URI)
  let assetMapForEngine = {};
  try {
    const assetResult = await window.tokiAPI.getAllAssetsMap();
    assetMapForEngine = assetResult.assets || assetResult;
    const d = assetResult.debug || {};
    // (debug log removed)
  } catch (e) {
    console.warn('[Preview] Asset loading error:', e);
  }

  // Initialize preview engine
  PreviewEngine.resetVars();
  PreviewEngine.setCharName(charData.name);
  PreviewEngine.setUserName('User');
  PreviewEngine.setDefaultVars(charData.defaultVariables);
  PreviewEngine.setCharDescription(charData.description);
  PreviewEngine.setCharFirstMessage(charData.firstMessage);
  PreviewEngine.setAssets(assetMapForEngine);
  PreviewEngine.setLorebook(charData.lorebook || []);

  let previewMessages = [];
  let msgIndex = 0;
  let debugOpen = false;
  let activeDebugTab = 'variables';
  let luaInitialized = false;
  let _reloadQueued = false;

  // reloadDisplay callback — queue a re-render after current Lua execution
  PreviewEngine.onReloadDisplay(() => { _reloadQueued = true; });

  // ── Simple Markdown ──
  function simpleMarkdown(text) {
    if (!text) return '';
    // Preserve existing HTML tags and entities
    const htmlTags = [];
    text = text.replace(/<[^>]+>/g, (m) => { htmlTags.push(m); return `\x00HTAG${htmlTags.length - 1}\x00`; });
    // Bold **text** and __text__
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic *text* and _text_
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    text = text.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');
    // RisuAI quote styling: "text" → colored (curly quotes)
    text = text.replace(/\u201C([^\u201D]+)\u201D/g, '<span style="color:var(--FontColorQuote2)">\u201C$1\u201D</span>');
    // Straight quotes — only match when quotes appear at text boundaries (not inside placeholders)
    text = text.replace(/(?:^|(?<=[\s\n(]))\"([^"]+?)\"(?=[\s\n).,!?;:]|$)/gm, '<span style="color:var(--FontColorQuote2)">\u201C$1\u201D</span>');
    // Code `text`
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Newlines to <br>
    text = text.replace(/\n/g, '<br>');
    // Restore HTML tags
    text = text.replace(/\x00HTAG(\d+)\x00/g, (_, i) => htmlTags[parseInt(i)]);
    return text;
  }

  // ── Wrap CSS in <style> if not already wrapped ──
  function wrapCssForPreview(raw) {
    if (!raw || !raw.trim()) return '';
    // Check raw input for <style> tag BEFORE CBS processing
    const hasStyleTag = /<style[\s>]/i.test(raw);
    const processed = PreviewEngine.risuChatParser(raw, { runVar: true });
    // Already has <style> tag → use as-is (backgroundHTML with mixed HTML+CSS)
    if (hasStyleTag) return processed;
    // Pure CSS → wrap in <style>
    return '<style>\n' + processed + '\n</style>';
  }

  // ── Build iframe HTML document ──
  function buildChatDoc() {
    const processedCSS = wrapCssForPreview(charData.css || '');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data: blob:; media-src * data: blob:; connect-src * data: blob:;">
<style>
:root {
  --FontColorStandard: #fafafa;
  --FontColorBold: #e5e5e5;
  --FontColorItalic: #8c8d93;
  --FontColorItalicBold: #8c8d93;
  --FontColorQuote1: #8BE9FD;
  --FontColorQuote2: #FFB86C;
  --risu-theme-bgcolor: #282a36;
  --risu-theme-darkbg: #21222c;
  --risu-theme-textcolor: #f5f5f5;
  --risu-theme-textcolor2: #64748b;
  --risu-theme-borderc: #6272a4;
  --risu-theme-selected: #44475a;
  --risu-theme-draculared: #ff5555;
  --risu-theme-darkborderc: #4b5563;
  --risu-theme-darkbutton: #374151;
  --risu-font-family: Arial, sans-serif, serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--risu-theme-bgcolor);
  color: var(--risu-theme-textcolor);
  font-family: var(--risu-font-family);
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
}
/* Background DOM (charx CSS/HTML overlay) */
.background-dom {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  z-index: 10;
}
.background-dom * { pointer-events: auto; }
/* Chat container */
.default-chat-screen {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 8px 0 80px;
}
/* Individual message */
.risu-chat {
  display: flex;
  width: 100%;
  max-width: 100%;
  justify-content: center;
  box-sizing: border-box;
}
.chat-message-container { }
.chat-message-container:last-child .dyna-icon { display: block; }
.risu-chat-inner {
  display: flex;
  color: var(--risu-theme-textcolor);
  margin: 4px 16px 4px 16px;
  padding: 8px;
  flex-grow: 1;
  align-items: flex-start;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
}
.chat-avatar {
  width: 45px;
  height: 45px;
  min-width: 45px;
  border-radius: 6px;
  background-color: var(--risu-theme-selected);
  background-size: cover;
  background-position: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  flex-shrink: 0;
}
.chat-content {
  display: flex;
  flex-direction: column;
  margin-left: 16px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.chat-name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--risu-theme-textcolor);
  margin-bottom: 4px;
}
.flexium { display: flex; flex-direction: row; justify-content: flex-start; }
.chat-width {
  max-width: 100%;
  word-break: normal;
  overflow-wrap: anywhere;
}
/* Chattext (message body) — main styling target */
.chattext {
  font-size: 1rem;
  line-height: 1.75;
  color: var(--FontColorStandard);
}
.chattext p { color: var(--FontColorStandard); margin: 0.25em 0; }
.chattext em { color: var(--FontColorItalic); font-style: italic; }
.chattext strong { color: var(--FontColorBold); font-weight: bold; }
.chattext strong em, .chattext em strong { color: var(--FontColorItalicBold); font-weight: bold; font-style: italic; }
.chattext mark[risu-mark="quote1"] { background: transparent; color: var(--FontColorQuote1); }
.chattext mark[risu-mark="quote2"] { background: transparent; color: var(--FontColorQuote2); }
.chattext img { max-width: 100%; height: auto; border-radius: 4px; margin: 4px 0; }
.chattext a { color: #8BE9FD; text-decoration: underline; }
.chattext code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; font-family: 'Cascadia Code','Consolas',monospace; }
.chattext pre { background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
.chattext pre code { background: none; padding: 0; }
.chattext hr { border: none; border-top: 1px solid var(--risu-theme-borderc); margin: 8px 0; }
.chattext blockquote, .chattext mark[risu-mark="blockquote1"] {
  display: block;
  border-left: 4px solid var(--FontColorQuote1);
  background: color-mix(in srgb, transparent 90%, var(--FontColorQuote1) 10%);
  padding: 0.5rem 1rem;
  color: var(--FontColorQuote1);
  margin: 4px 0;
}
/* CBS Button */
.cbs-button {
  display: inline-block;
  padding: 6px 16px;
  margin: 4px 2px;
  background: var(--risu-theme-selected);
  color: var(--risu-theme-textcolor);
  border: 1px solid var(--risu-theme-borderc);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9em;
  transition: background 0.15s;
}
.cbs-button:hover { background: var(--risu-theme-borderc); }
/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: var(--risu-theme-darkbg); }
::-webkit-scrollbar-thumb { background: var(--risu-theme-selected); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--risu-theme-borderc); }
</style>
</head><body>
<div class="background-dom" id="bg-dom">${processedCSS}</div>
<div class="default-chat-screen" id="chat-container"></div>
<script>
function cbsClick(varName, value) {
  window.parent.postMessage({ type: 'cbs-button', varName: varName, value: value }, '*');
}
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[risu-btn]');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    var data = btn.getAttribute('risu-btn');
    window.parent.postMessage({ type: 'risu-btn', data: data }, '*');
    return;
  }
  var trig = e.target.closest('[risu-trigger]');
  if (trig) {
    e.preventDefault();
    e.stopPropagation();
    var name = trig.getAttribute('risu-trigger');
    window.parent.postMessage({ type: 'risu-trigger', name: name }, '*');
  }
});
</script>
</body></html>`;
  }

  // ── Add message to iframe ──
  async function addMessage(role, rawContent) {
    const doc = chatFrame.contentDocument;
    if (!doc) return;
    const container = doc.getElementById('chat-container');
    if (!container) return;

    const scripts = charData.regex || [];

    // Process content through pipeline
    let content = rawContent;
    // (debug log removed)
    // CBS options with message context (for {{chat_index}}, {{lastmessageid}} etc.)
    const cbsOpts = (runVar) => ({
      runVar,
      chatID: msgIndex,
      messageCount: previewMessages.length + 1,
    });

    if (role === 'char') {
      content = PreviewEngine.processRegex(content, scripts, 'editoutput');
      if (luaInitialized) content = await PreviewEngine.runLuaTrigger('editOutput', content);
      content = PreviewEngine.risuChatParser(content, cbsOpts(true));
      content = PreviewEngine.processRegex(content, scripts, 'editdisplay');
      // Second CBS pass — regex(editdisplay) may output {{#if}}/{{getvar}} tags
      content = PreviewEngine.risuChatParser(content, cbsOpts(true));
      if (luaInitialized) content = await PreviewEngine.runLuaTrigger('editDisplay', content);
      content = PreviewEngine.risuChatParser(content, cbsOpts(false));
    } else {
      content = PreviewEngine.processRegex(content, scripts, 'editinput');
      if (luaInitialized) content = await PreviewEngine.runLuaTrigger('editInput', content);
      content = PreviewEngine.risuChatParser(content, cbsOpts(true));
    }

    // Markdown
    content = simpleMarkdown(content);

    // Resolve asset image src to data URIs
    content = PreviewEngine.resolveAssetImages(content);

    const idx = msgIndex++;
    const wrapper = doc.createElement('div');
    wrapper.className = 'chat-message-container';
    wrapper.setAttribute('x-hashed', String(idx));

    const name = role === 'char' ? charData.name : 'User';
    const avatarBg = role === 'char' ? 'var(--risu-theme-selected)' : 'var(--risu-theme-borderc)';

    wrapper.innerHTML = `<div class="risu-chat" data-chat-index="${idx}">
  <div class="risu-chat-inner">
    <div class="chat-avatar" style="background-color:${avatarBg}"></div>
    <span class="chat-content">
      <div class="flexium items-center chat-width">
        <div class="chat-width chat-name">${escapeHtmlPreview(name)}</div>
      </div>
      <span class="chattext chat-width prose">${content}</span>
    </span>
  </div>
</div>`;

    container.appendChild(wrapper);
    previewMessages.push({ role, content: rawContent });

    // Scroll to bottom
    doc.documentElement.scrollTop = doc.documentElement.scrollHeight;
  }

  function escapeHtmlPreview(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Refresh backgroundHTML + Lua output (after variable changes) ──
  function refreshBackground() {
    const doc = chatFrame.contentDocument;
    if (!doc) return;
    const bgDom = doc.getElementById('bg-dom');
    if (bgDom) {
      let processed = wrapCssForPreview(charData.css || '');
      // Append Lua setOutput HTML
      const luaHTML = PreviewEngine.getLuaOutputHTML();
      if (luaHTML) {
        let parsedLuaHTML = PreviewEngine.risuChatParser(luaHTML, { runVar: true });
        parsedLuaHTML = PreviewEngine.resolveAssetImages(parsedLuaHTML);
        processed += parsedLuaHTML;
      }
      bgDom.innerHTML = processed;
    }
  }

  // ── Handle user send ──
  async function handleSend() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';

    // User message
    await addMessage('user', text);

    // Lorebook matching
    const loreMatches = PreviewEngine.matchLorebook(previewMessages, charData.lorebook || []);

    // Lua trigger (input)
    if (luaInitialized) {
      try { await PreviewEngine.runLuaTrigger('input', text); } catch (e) { /* */ }
    }

    // Simulated character response
    let response;
    if (charData.firstMessage && previewMessages.length <= 2) {
      response = charData.firstMessage;
    } else {
      response = `${charData.name}: "${text}"에 대한 응답입니다.`;
    }

    // Lua trigger (output)
    if (luaInitialized) {
      try { await PreviewEngine.runLuaTrigger('output', response); } catch (e) { /* */ }
    }

    await addMessage('char', response);
    refreshBackground();
    if (debugOpen) updateDebugPanel();
  }

  // ── Re-render all messages (after variable changes) ──
  async function reRenderMessages() {
    const doc = chatFrame.contentDocument;
    if (!doc) return;
    const container = doc.getElementById('chat-container');
    if (!container) return;
    container.innerHTML = '';
    const saved = [...previewMessages];
    previewMessages = [];
    msgIndex = 0;
    for (const msg of saved) {
      await addMessage(msg.role, msg.content);
    }
    refreshBackground();
    if (debugOpen) updateDebugPanel();
  }

  // ── Listen for button clicks from iframe ──
  function onMessage(e) {
    if (!e.data) return;
    if (e.data.type === 'cbs-button') {
      PreviewEngine.setChatVar(e.data.varName, e.data.value);
      reRenderMessages();
    } else if (e.data.type === 'risu-btn') {
      (async () => {
        _reloadQueued = false;
        const chatId = previewMessages.length > 0 ? previewMessages.length - 1 : 0;
        if (luaInitialized) {
          try {
            await PreviewEngine.runLuaButtonClick(chatId, e.data.data);
          } catch (err) { console.warn('[risu-btn] Lua error:', err); }
        }
        await reRenderMessages();
        _reloadQueued = false; // consumed by reRender
      })();
    } else if (e.data.type === 'risu-trigger') {
      (async () => {
        _reloadQueued = false;
        if (luaInitialized) {
          try {
            await PreviewEngine.runLuaTriggerByName(e.data.name);
          } catch (err) { console.warn('[risu-trigger] Lua error:', err); }
        }
        await reRenderMessages();
        _reloadQueued = false;
      })();
    }
  }
  window.addEventListener('message', onMessage);

  // ══════════════ Build UI ══════════════

  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'preview-panel';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'preview-header';
  const headerLeft = document.createElement('span');
  headerLeft.textContent = `${charData.name} — 프리뷰`;
  const headerBtns = document.createElement('div');
  headerBtns.style.cssText = 'display:flex;gap:4px;align-items:center;';

  const popoutPreviewBtn = document.createElement('button');
  popoutPreviewBtn.textContent = '↗';
  popoutPreviewBtn.title = '팝아웃 (별도 창)';
  popoutPreviewBtn.addEventListener('click', async () => {
    // Collect charData for popout
    await window.tokiAPI.setPreviewPopoutData({
      name: charData.name,
      description: charData.description,
      firstMessage: charData.firstMessage,
      defaultVariables: charData.defaultVariables,
      lua: charData.lua,
      css: charData.css,
      lorebook: charData.lorebook,
      regex: charData.regex,
      assets: null // assets handled via IPC separately
    });
    await window.tokiAPI.popoutPanel('preview');
    // Close the inline preview
    window.removeEventListener('message', onMessage);
    overlay.remove();
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = '↻';
  resetBtn.title = '초기화';
  resetBtn.addEventListener('click', async () => {
    PreviewEngine.resetVars();
    PreviewEngine.setDefaultVars(charData.defaultVariables);
    PreviewEngine.setCharDescription(charData.description);
    PreviewEngine.setCharFirstMessage(charData.firstMessage);
    previewMessages = [];
    msgIndex = 0;
    const doc = chatFrame.contentDocument;
    if (doc) {
      doc.open();
      doc.write(buildChatDoc());
      doc.close();
      // Re-init Lua
      if (charData.lua) {
        luaInitialized = await PreviewEngine.initLua(charData.lua);
        if (luaInitialized) {
          try { await PreviewEngine.runLuaTrigger('start', null); } catch(e) {}
        }
      }
      if (charData.firstMessage) await addMessage('char', charData.firstMessage);
      refreshBackground();
    }
    if (debugOpen) updateDebugPanel();
  });

  const debugBtn = document.createElement('button');
  debugBtn.textContent = '🔧';
  debugBtn.title = '디버그 패널';
  debugBtn.addEventListener('click', () => {
    debugOpen = !debugOpen;
    debugDrawer.style.display = debugOpen ? '' : 'none';
    if (debugOpen) updateDebugPanel();
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => {
    window.removeEventListener('message', onMessage);
    if (debugDetached) debugDrawer.remove();
    overlay.remove();
  });

  headerBtns.appendChild(popoutPreviewBtn);
  headerBtns.appendChild(resetBtn);
  headerBtns.appendChild(debugBtn);
  headerBtns.appendChild(closeBtn);
  header.appendChild(headerLeft);
  header.appendChild(headerBtns);

  // ── Chat iframe ──
  const chatFrame = document.createElement('iframe');
  chatFrame.className = 'preview-chat-frame';

  // ── Input bar ──
  const inputBar = document.createElement('div');
  inputBar.className = 'preview-input-bar';
  const chatInput = document.createElement('textarea');
  chatInput.className = 'preview-input-textarea';
  chatInput.placeholder = '메시지를 입력하세요...';
  chatInput.rows = 1;
  const sendBtn = document.createElement('button');
  sendBtn.className = 'preview-send-btn';
  sendBtn.textContent = '전송';
  sendBtn.addEventListener('click', handleSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });
  inputBar.appendChild(chatInput);
  inputBar.appendChild(sendBtn);

  // ── Debug drawer (hidden by default) ──
  const debugDrawer = document.createElement('div');
  debugDrawer.className = 'preview-debug-drawer';
  debugDrawer.style.display = 'none';

  const debugTabs = document.createElement('div');
  debugTabs.className = 'preview-debug-tabs';
  const tabDefs = [
    { id: 'variables', label: '변수' },
    { id: 'lorebook', label: '로어북' },
    { id: 'lua', label: 'Lua' },
    { id: 'regex', label: '정규식' },
  ];
  for (const td of tabDefs) {
    const tab = document.createElement('button');
    tab.className = 'preview-debug-tab' + (td.id === activeDebugTab ? ' active' : '');
    tab.textContent = td.label;
    tab.addEventListener('click', () => {
      activeDebugTab = td.id;
      debugTabs.querySelectorAll('.preview-debug-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      updateDebugPanel();
    });
    debugTabs.appendChild(tab);
  }
  // Copy debug button
  const debugCopyBtn = document.createElement('button');
  debugCopyBtn.className = 'preview-debug-copy-btn';
  debugCopyBtn.textContent = '📋 복사';
  debugCopyBtn.title = '디버그 정보 전체 복사';
  debugCopyBtn.addEventListener('click', () => {
    const lines = [];
    lines.push(`=== 프리뷰 디버그 (${new Date().toLocaleTimeString()}) ===`);
    lines.push(`\n[Lua] ${luaInitialized ? '활성' : '비활성'}`);
    const luaOut = PreviewEngine.getLuaOutput();
    if (luaOut.length) lines.push(luaOut.join('\n'));
    const lore = charData.lorebook || [];
    lines.push(`\n[로어북] ${lore.filter(e => e.mode !== 'folder').length}개`);
    const scripts = charData.regex || [];
    lines.push(`[정규식] ${scripts.length}개`);
    lines.push(`\n[메시지] ${previewMessages.length}개`);
    for (const m of previewMessages) lines.push(`  [${m.role}] ${m.content?.substring(0, 100)}`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      debugCopyBtn.textContent = '✅ 복사됨';
      setTimeout(() => { debugCopyBtn.textContent = '📋 복사'; }, 1500);
    });
  });
  debugTabs.appendChild(debugCopyBtn);

  // ── Debug detach/dock button ──
  let debugDetached = false;
  let debugDragOffset = { x: 0, y: 0 };

  const debugDetachBtn = document.createElement('button');
  debugDetachBtn.className = 'preview-debug-copy-btn';
  debugDetachBtn.textContent = '⇱ 분리';
  debugDetachBtn.title = '디버그 패널 분리 (플로팅)';
  debugDetachBtn.addEventListener('click', () => {
    if (debugDetached) dockDebugPanel();
    else detachDebugPanel();
  });
  debugTabs.appendChild(debugDetachBtn);

  function detachDebugPanel() {
    debugDetached = true;
    debugDetachBtn.textContent = '⇲ 도킹';
    debugDetachBtn.title = '디버그 패널 도킹 (복귀)';
    document.body.appendChild(debugDrawer);
    debugDrawer.classList.add('preview-debug-floating');
    debugDrawer.style.display = '';
    debugDrawer.style.left = '50%';
    debugDrawer.style.top = '50%';
    debugDrawer.style.transform = 'translate(-50%, -50%)';

    // Make tabs a drag handle
    debugTabs.style.cursor = 'grab';
    debugTabs.addEventListener('mousedown', onDebugDragStart);
  }

  function dockDebugPanel() {
    debugDetached = false;
    debugDetachBtn.textContent = '⇱ 분리';
    debugDetachBtn.title = '디버그 패널 분리 (플로팅)';
    debugDrawer.classList.remove('preview-debug-floating');
    debugDrawer.style.left = '';
    debugDrawer.style.top = '';
    debugDrawer.style.transform = '';
    panel.appendChild(debugDrawer);
    debugDrawer.style.display = debugOpen ? '' : 'none';
    debugTabs.style.cursor = '';
    debugTabs.removeEventListener('mousedown', onDebugDragStart);
  }

  function onDebugDragStart(e) {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const rect = debugDrawer.getBoundingClientRect();
    debugDragOffset.x = e.clientX - rect.left;
    debugDragOffset.y = e.clientY - rect.top;
    debugDrawer.style.transform = '';
    debugTabs.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onDebugDragMove);
    document.addEventListener('mouseup', onDebugDragEnd);
  }

  function onDebugDragMove(e) {
    debugDrawer.style.left = (e.clientX - debugDragOffset.x) + 'px';
    debugDrawer.style.top = (e.clientY - debugDragOffset.y) + 'px';
  }

  function onDebugDragEnd() {
    debugTabs.style.cursor = 'grab';
    document.removeEventListener('mousemove', onDebugDragMove);
    document.removeEventListener('mouseup', onDebugDragEnd);
  }

  const debugContent = document.createElement('div');
  debugContent.className = 'preview-debug-content';
  debugDrawer.appendChild(debugTabs);
  debugDrawer.appendChild(debugContent);

  function updateDebugPanel() {
    debugContent.innerHTML = '';
    const vars = PreviewEngine.getVariables();
    const lore = charData.lorebook || [];
    const scripts = charData.regex || [];

    if (activeDebugTab === 'variables') {
      const keys = Object.keys(vars);
      if (!keys.length) { debugContent.innerHTML = '<div class="preview-debug-empty">변수 없음</div>'; return; }
      let html = '<table class="preview-debug-table"><tr><th>이름</th><th>값</th></tr>';
      for (const k of keys) html += `<tr><td>${escapeHtmlPreview(k)}</td><td>${escapeHtmlPreview(String(vars[k]))}</td></tr>`;
      html += '</table>';
      if (charData.defaultVariables) html += `<pre class="preview-debug-pre" style="margin-top:6px;">${escapeHtmlPreview(charData.defaultVariables)}</pre>`;
      debugContent.innerHTML = html;
    } else if (activeDebugTab === 'lorebook') {
      if (!lore.length) { debugContent.innerHTML = '<div class="preview-debug-empty">로어북 없음</div>'; return; }
      const matches = previewMessages.length > 0 ? PreviewEngine.matchLorebook(previewMessages, lore) : [];
      const matchSet = new Set(matches.map(m => m.index));
      let html = '<table class="preview-debug-table"><tr><th>#</th><th>이름</th><th>키</th><th>상태</th></tr>';
      for (let i = 0; i < lore.length; i++) {
        const e = lore[i];
        if (e.mode === 'folder') continue;
        const active = matchSet.has(i);
        const match = matches.find(m => m.index === i);
        const cls = active ? ' class="preview-lore-active"' : '';
        html += `<tr${cls}><td>${i}</td><td>${escapeHtmlPreview(e.comment || '')}</td><td>${escapeHtmlPreview(e.key || '')}</td><td>${
          e.alwaysActive ? '🟢 항상' : active ? '🟢 ' + escapeHtmlPreview(match.reason) : e.key ? '⚫' : '⬜'
        }</td></tr>`;
      }
      html += '</table>';
      debugContent.innerHTML = html;
    } else if (activeDebugTab === 'lua') {
      const output = PreviewEngine.getLuaOutput();
      let html = '';
      if (!luaInitialized) {
        html += '<button class="preview-send-btn" id="lua-init-btn" style="margin-bottom:6px;">Lua 초기화</button>';
      } else {
        html += '<div style="color:#4caf50;font-size:11px;margin-bottom:4px;">✅ Lua 활성</div>';
      }
      html += `<pre class="preview-debug-pre" style="min-height:50px;">${output.length ? escapeHtmlPreview(output.join('\n')) : '(출력 없음)'}</pre>`;
      debugContent.innerHTML = html;
      if (!luaInitialized) {
        const btn = debugContent.querySelector('#lua-init-btn');
        if (btn) btn.addEventListener('click', async () => {
          btn.textContent = '초기화 중...'; btn.disabled = true;
          luaInitialized = await PreviewEngine.initLua(charData.lua);
          updateDebugPanel();
        });
      }
    } else if (activeDebugTab === 'regex') {
      if (!scripts.length) { debugContent.innerHTML = '<div class="preview-debug-empty">정규식 없음</div>'; return; }
      const types = ['editinput', 'editoutput', 'editdisplay', 'editrequest'];
      let html = '';
      for (const type of types) {
        const filtered = scripts.filter(s => s.type === type && s.ableFlag !== false);
        if (!filtered.length) continue;
        html += `<div style="font-weight:600;color:#4a90d9;margin:4px 0 2px;font-size:11px;">${type} (${filtered.length})</div>`;
        html += '<table class="preview-debug-table"><tr><th>이름</th><th>찾기</th><th>바꾸기</th></tr>';
        for (const s of filtered) {
          html += `<tr><td>${escapeHtmlPreview(s.comment || '')}</td><td><code>${escapeHtmlPreview(s.find || s.in || '')}</code></td><td><code>${escapeHtmlPreview((s.replace || s.out || '').substring(0, 50))}</code></td></tr>`;
        }
        html += '</table>';
      }
      debugContent.innerHTML = html;
    }
  }

  // ── Debug resizer (between input bar and debug drawer) ──
  const debugResizer = document.createElement('div');
  debugResizer.className = 'preview-debug-resizer';
  debugResizer.style.display = 'none';
  let debugResizing = false;
  debugResizer.addEventListener('mousedown', (e) => {
    if (debugDetached) return;
    e.preventDefault();
    debugResizing = true;
    const startY = e.clientY;
    const startH = debugDrawer.getBoundingClientRect().height;
    const onMove = (ev) => {
      const delta = startY - ev.clientY;
      const newH = Math.max(80, Math.min(startH + delta, panel.getBoundingClientRect().height - 200));
      debugDrawer.style.height = newH + 'px';
    };
    const onUp = () => {
      debugResizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Show/hide resizer when debug opens/closes
  debugBtn.addEventListener('click', () => {
    debugResizer.style.display = debugOpen ? '' : 'none';
  });

  // ── Assemble ──
  panel.appendChild(header);
  panel.appendChild(chatFrame);
  panel.appendChild(inputBar);
  panel.appendChild(debugResizer);
  panel.appendChild(debugDrawer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Initialize iframe after it's in the DOM
  requestAnimationFrame(async () => {
    const doc = chatFrame.contentDocument || chatFrame.contentWindow.document;
    doc.open();
    doc.write(buildChatDoc());
    doc.close();
    // Auto-init Lua
    if (charData.lua) {
      luaInitialized = await PreviewEngine.initLua(charData.lua);
      if (luaInitialized) {
        try { await PreviewEngine.runLuaTrigger('start', null); } catch (e) {
          console.warn('[Preview] Lua onStart error:', e);
        }
        refreshBackground();
      }
    }
    // Render first message
    if (charData.firstMessage) {
      setTimeout(async () => {
        await addMessage('char', charData.firstMessage);
        refreshBackground();
      }, 50);
    }
  });

  // Escape to close
  const onKey = (e) => {
    if (e.key === 'Escape') {
      window.removeEventListener('message', onMessage);
      if (debugDetached) debugDrawer.remove();
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

// ==================== Panel Drag & Drop ====================

function initPanelDragDrop() {
  // Make panel headers draggable
  const draggables = [
    { el: document.querySelector('.sidebar-header'), panel: 'sidebar', label: '항목' },
    { el: document.getElementById('terminal-header'), panel: 'terminal', label: 'TokiTalk' },
  ];

  for (const item of draggables) {
    if (!item.el) continue;
    item.el.style.cursor = 'grab';

    // Add pop-out button to header
    const popoutBtn = document.createElement('button');
    popoutBtn.className = 'panel-collapse-btn';
    popoutBtn.title = '팝아웃 (분리)';
    popoutBtn.textContent = '↗';
    popoutBtn.dataset.popoutPanel = item.panel;
    popoutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPanelPoppedOut(item.panel)) {
        dockPanel(item.panel);
      } else {
        popOutPanel(item.panel);
      }
    });

    // Add close button (✕)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'panel-collapse-btn';
    closeBtn.title = '닫기';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.panel === 'sidebar') toggleSidebar();
      else if (item.panel === 'terminal') toggleTerminal();
    });

    if (item.panel === 'sidebar') {
      // Sidebar header: buttons group [↗ popout] [◀ collapse] [✕ close]
      const btnsGroup = item.el.querySelector('.sidebar-header-btns');
      const collapseBtn = document.getElementById('btn-sidebar-collapse');
      if (btnsGroup && collapseBtn) {
        btnsGroup.insertBefore(popoutBtn, collapseBtn);
        btnsGroup.appendChild(closeBtn);
      }
    } else if (item.panel === 'terminal') {
      // Terminal header: [↗ popout] [━ toggle] [✕ close]
      const headerRight = item.el.querySelector('.momo-header-right');
      const toggleBtn = document.getElementById('btn-terminal-toggle');
      if (headerRight && toggleBtn) {
        headerRight.insertBefore(popoutBtn, toggleBtn);
        toggleBtn.after(closeBtn);
      }
    }

    item.el.addEventListener('mousedown', (e) => {
      // Ignore if clicking a button inside the header
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      // Ignore right-click
      if (e.button !== 0) return;

      e.preventDefault();
      startPanelDrag(e, item.panel, item.label);
    });

    // Right-click for position + pop-out options
    item.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const isPoppedOut_ = isPanelPoppedOut(item.panel);
      const moveFn = item.panel === 'sidebar' ? moveItems : moveTerminal;
      const posItems = [
        { label: '→ 좌측', action: () => moveFn('left') },
        { label: '→ 우측', action: () => moveFn('right') },
        { label: '→ 좌끝', action: () => moveFn('far-left') },
        { label: '→ 우끝', action: () => moveFn('far-right') },
        { label: '→ 상단', action: () => moveFn('top') },
        { label: '→ 하단', action: () => moveFn('bottom') },
        { separator: true },
        isPoppedOut_
          ? { label: '도킹 (복원)', action: () => dockPanel(item.panel) }
          : { label: '팝아웃 (분리)', action: () => popOutPanel(item.panel) },
      ];
      showContextMenu(e.clientX, e.clientY, posItems);
    });
  }
}

function startPanelDrag(e, panelId, label) {
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let dropZones = [];

  const onMove = (ev) => {
    const dx = Math.abs(ev.clientX - startX);
    const dy = Math.abs(ev.clientY - startY);

    // Start drag after 8px movement threshold
    if (!dragging && (dx > 8 || dy > 8)) {
      dragging = true;
      dropZones = createDropZones(panelId);
      document.body.style.cursor = 'grabbing';
    }

    if (dragging) {
      // Highlight the zone under cursor (rects cached at creation time)
      for (const zone of dropZones) {
        const r = zone._rect;
        if (ev.clientX >= r.left && ev.clientX <= r.right &&
            ev.clientY >= r.top && ev.clientY <= r.bottom) {
          zone.el.classList.add('hover');
        } else {
          zone.el.classList.remove('hover');
        }
      }
    }
  };

  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';

    if (!dragging) return;

    // Find which zone was dropped on (use cached rects)
    let dropped = null;
    for (const zone of dropZones) {
      const r = zone._rect;
      if (ev.clientX >= r.left && ev.clientX <= r.right &&
          ev.clientY >= r.top && ev.clientY <= r.bottom) {
        dropped = zone;
      }
      zone.el.remove();
    }

    if (dropped) {
      applyPanelDrop(panelId, dropped.position);
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function createDropZones(panelId) {
  const zones = [];
  const appBody = document.getElementById('app-body');
  const rect = appBody.getBoundingClientRect();
  const e = 0.08; // edge ratio for far zones
  const s = 0.15; // side ratio

  // All panels can go to all 6 positions
  const positions = [
    { position: 'far-left', label: '좌끝', x: rect.left, y: rect.top, w: rect.width * e, h: rect.height },
    { position: 'left', label: '좌측', x: rect.left + rect.width * e, y: rect.top + rect.height * 0.15, w: rect.width * (s - e), h: rect.height * 0.7 },
    { position: 'top', label: '상단', x: rect.left + rect.width * e, y: rect.top, w: rect.width * (1 - 2 * e), h: rect.height * 0.15 },
    { position: 'bottom', label: '하단', x: rect.left + rect.width * e, y: rect.bottom - rect.height * 0.15, w: rect.width * (1 - 2 * e), h: rect.height * 0.15 },
    { position: 'right', label: '우측', x: rect.right - rect.width * s, y: rect.top + rect.height * 0.15, w: rect.width * (s - e), h: rect.height * 0.7 },
    { position: 'far-right', label: '우끝', x: rect.right - rect.width * e, y: rect.top, w: rect.width * e, h: rect.height },
  ];

  for (const pos of positions) {
    const zone = document.createElement('div');
    zone.className = 'panel-drop-zone visible';
    zone.style.left = pos.x + 'px';
    zone.style.top = pos.y + 'px';
    zone.style.width = pos.w + 'px';
    zone.style.height = pos.h + 'px';

    const labelEl = document.createElement('div');
    labelEl.className = 'panel-drop-zone-label';
    labelEl.textContent = pos.label;
    zone.appendChild(labelEl);

    document.body.appendChild(zone);
    zones.push({ el: zone, position: pos.position, _rect: zone.getBoundingClientRect() });
  }

  return zones;
}

function applyPanelDrop(panelId, position) {
  if (panelId === 'sidebar') {
    moveItems(position);
  } else if (panelId === 'terminal') {
    moveTerminal(position);
  }
}

// ==================== Pop-out Mode (External Window) ====================

const poppedOutPanels = new Set(); // tracks which panels are popped out

function isPanelPoppedOut(panelId) {
  return poppedOutPanels.has(panelId);
}

async function popOutPanel(panelId) {
  if (isPanelPoppedOut(panelId)) return;

  const handleTitle = panelId === 'sidebar' ? '항목' : panelId === 'refs' ? '참고자료' : 'TokiTalk';

  // Create external window via IPC
  await window.tokiAPI.popoutPanel(panelId);
  poppedOutPanels.add(panelId);

  // Hide the panel in main window
  if (panelId === 'sidebar') {
    layoutState.itemsVisible = false;
  } else if (panelId === 'terminal') {
    layoutState.terminalVisible = false;
  } else if (panelId === 'refs') {
    layoutState._refsPosBefore = layoutState.refsPos;
    layoutState.refsPos = '_popout';
  }
  rebuildLayout();

  // Update popout button icon
  updatePopoutButtons();
  setStatus(`${handleTitle} 팝아웃됨 (외부 창)`);
}

async function popOutEditorPanel(tabId) {
  if (isPanelPoppedOut('editor')) return;

  const targetId = tabId || activeTabId;
  if (!targetId) return;

  const curTab = openTabs.find(t => t.id === targetId);
  if (!curTab || curTab.language === '_image') return;

  // Switch to target tab first if not active
  if (targetId !== activeTabId) {
    createOrSwitchEditor(curTab);
  }

  // Get current content
  let content = '';
  if (editorInstance) {
    content = editorInstance.getValue();
    if (curTab.setValue) curTab.setValue(content);
  } else {
    content = curTab.getValue();
  }

  // Send tab data to main process for popout to pick up
  await window.tokiAPI.setEditorPopoutData({
    tabId: curTab.id,
    label: curTab.label,
    language: curTab.language,
    content: content,
    readOnly: !curTab.setValue
  });

  // Create popout window
  await window.tokiAPI.popoutPanel('editor');
  poppedOutPanels.add('editor');

  // Show placeholder in editor area
  const container = document.getElementById('editor-container');
  if (editorInstance) { editorInstance.dispose(); editorInstance = null; }
  container.innerHTML = '<div class="empty-state">편집중 (팝아웃 창)</div>';

  updateTabUI();
  setStatus(`에디터 팝아웃됨: ${curTab.label}`);
}

function dockPanel(panelId) {
  if (!isPanelPoppedOut(panelId)) return;

  // Close external window via IPC
  window.tokiAPI.closePopout(panelId);
  poppedOutPanels.delete(panelId);

  // Show the panel back in main window
  if (panelId === 'sidebar') {
    layoutState.itemsVisible = true;
  } else if (panelId === 'terminal') {
    layoutState.terminalVisible = true;
  } else if (panelId === 'editor') {
    // Re-open the active tab in the main editor
    if (activeTabId) {
      const curTab = openTabs.find(t => t.id === activeTabId);
      if (curTab) createOrSwitchEditor(curTab);
    }
  } else if (panelId === 'refs') {
    layoutState.refsPos = layoutState._refsPosBefore || 'sidebar';
    delete layoutState._refsPosBefore;
  }
  rebuildLayout();

  // Refit terminal
  if (panelId === 'terminal' && fitAddon && term) {
    setTimeout(() => fitAddon.fit(), 50);
  }

  updatePopoutButtons();
  updateTabUI();
  const panelName = panelId === 'sidebar' ? '항목' : panelId === 'editor' ? '에디터' : panelId === 'refs' ? '참고자료' : 'TokiTalk';
  setStatus(`${panelName} 도킹됨`);
}

function updatePopoutButtons() {
  // Update popout button icons based on current state
  document.querySelectorAll('[data-popout-panel]').forEach(btn => {
    const panel = btn.dataset.popoutPanel;
    if (poppedOutPanels.has(panel)) {
      btn.textContent = '📌';
      btn.title = '도킹 (복원)';
    } else {
      btn.textContent = '↗';
      btn.title = '팝아웃 (분리)';
    }
  });
}

// Tab open by ID (used for sidebar popout clicks)
function openTabById(tabId) {
  if (!fileData) return;

  const tabMap = {
    lua: { label: 'Lua (통합)', lang: 'lua', get: () => fileData.lua, set: (v) => { fileData.lua = v; luaSections = parseLuaSections(v); } },
    globalNote: { label: '글로벌노트', lang: 'plaintext', get: () => fileData.globalNote, set: (v) => { fileData.globalNote = v; } },
    firstMessage: { label: '첫 메시지', lang: 'html', get: () => fileData.firstMessage, set: (v) => { fileData.firstMessage = v; } },
    css: { label: 'CSS (통합)', lang: 'css', get: () => fileData.css, set: (v) => { fileData.css = v; cssSections = parseCssSections(v); } },
    defaultVariables: { label: '기본변수', lang: 'plaintext', get: () => fileData.defaultVariables, set: (v) => { fileData.defaultVariables = v; } },
    description: { label: '설명', lang: 'plaintext', get: () => fileData.description, set: (v) => { fileData.description = v; } },
  };

  if (tabMap[tabId]) {
    const t = tabMap[tabId];
    if (tabId === 'lua') fileData.lua = combineLuaSections();
    openTab(tabId, t.label, t.lang, t.get, t.set);
    return;
  }

  if (tabId.startsWith('lore_')) {
    const idx = parseInt(tabId.replace('lore_', ''), 10);
    if (fileData.lorebook[idx]) {
      const label = fileData.lorebook[idx].comment || `entry_${idx}`;
      openTab(tabId, label, 'plaintext',
        () => fileData.lorebook[idx].content || '',
        (v) => { fileData.lorebook[idx].content = v; });
    }
  } else if (tabId.startsWith('regex_')) {
    const idx = parseInt(tabId.replace('regex_', ''), 10);
    if (fileData.regex[idx]) {
      const label = fileData.regex[idx].comment || `regex_${idx}`;
      openTab(tabId, label, 'json',
        () => JSON.stringify(fileData.regex[idx], null, 2),
        (v) => { try { fileData.regex[idx] = JSON.parse(v); } catch(e){} });
    }
  } else if (tabId.startsWith('guide_')) {
    // Guide file from refs popout
    const fileName = tabId.replace('guide_', '');
    const existing = openTabs.find(t => t.id === tabId);
    if (existing) {
      activeTabId = tabId;
      createOrSwitchEditor(existing);
      updateTabUI();
      return;
    }
    window.tokiAPI.readGuide(fileName).then(content => {
      if (content == null) { setStatus('가이드 파일 읽기 실패'); return; }
      openTab(tabId, `[가이드] ${fileName}`, 'plaintext',
        () => content,
        (val) => { window.tokiAPI.writeGuide(fileName, val); }
      );
    });
  } else if (tabId.startsWith('ref_')) {
    // Reference file item from refs popout
    openRefTabById(tabId);
  }
}

function openRefTabById(tabId) {
  // Check if tab already open
  const existing = openTabs.find(t => t.id === tabId);
  if (existing) {
    activeTabId = tabId;
    createOrSwitchEditor(existing);
    updateTabUI();
    return;
  }

  // Parse: ref_{ri}_{field} or ref_{ri}_lb_{li} or ref_{ri}_rx_{xi}
  const parts = tabId.split('_');
  if (parts.length < 3) return;
  const ri = parseInt(parts[1], 10);
  if (ri < 0 || ri >= referenceFiles.length) return;
  const ref = referenceFiles[ri];
  const fieldPart = parts[2];

  if (fieldPart === 'lua') {
    openTab(tabId, `[참고] ${ref.fileName} - Lua`, 'lua', () => ref.data.lua, null);
  } else if (fieldPart === 'css') {
    openTab(tabId, `[참고] ${ref.fileName} - CSS`, 'css', () => ref.data.css, null);
  } else if (fieldPart === 'globalNote') {
    openTab(tabId, `[참고] ${ref.fileName} - 글로벌노트`, 'plaintext', () => ref.data.globalNote, null);
  } else if (fieldPart === 'firstMessage') {
    openTab(tabId, `[참고] ${ref.fileName} - 첫 메시지`, 'html', () => ref.data.firstMessage, null);
  } else if (fieldPart === 'description') {
    openTab(tabId, `[참고] ${ref.fileName} - 설명`, 'plaintext', () => ref.data.description, null);
  } else if (fieldPart === 'lb' && parts.length >= 4) {
    const li = parseInt(parts[3], 10);
    if (ref.data.lorebook && ref.data.lorebook[li]) {
      const lbLabel = ref.data.lorebook[li].comment || ref.data.lorebook[li].key || `#${li}`;
      const tab = openTab(tabId, `[참고] ${ref.fileName} - ${lbLabel}`, '_loreform', () => ref.data.lorebook[li], null);
      if (tab) tab._refLorebook = ref.data.lorebook;
    }
  } else if (fieldPart === 'rx' && parts.length >= 4) {
    const xi = parseInt(parts[3], 10);
    if (ref.data.regex && ref.data.regex[xi]) {
      const rxLabel = ref.data.regex[xi].comment || `#${xi}`;
      openTab(tabId, `[참고] ${ref.fileName} - ${rxLabel}`, '_regexform', () => ref.data.regex[xi], null);
    }
  }
}

// ==================== Keyboard Shortcuts ====================
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault(); handleNew();
    } else if (e.ctrlKey && e.key === 'o') {
      e.preventDefault(); handleOpen();
    } else if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault(); handleSaveAs();
    } else if (e.ctrlKey && e.key === 's') {
      e.preventDefault(); handleSave();
    } else if (e.ctrlKey && e.key === 'w') {
      e.preventDefault(); if (activeTabId) closeTab(activeTabId);
    } else if (e.ctrlKey && e.key === 'b') {
      e.preventDefault(); toggleSidebar();
    } else if (e.ctrlKey && e.key === '`') {
      e.preventDefault(); toggleTerminal();
    } else if (e.key === 'F5') {
      e.preventDefault(); showPreviewPanel();
    } else if (e.key === 'Escape') {
      closeAllMenus();
    }
  });
}

// ==================== Init ====================
async function init() {
  initMenuBar();
  initResizers();
  initKeyboard();
  initDragDrop();
  initEditor();
  document.getElementById('btn-terminal-bg').addEventListener('click', handleTerminalBg);
  initRpModeButton();
  initBgm();
  document.getElementById('btn-sidebar-collapse').addEventListener('click', toggleSidebar);
  document.getElementById('btn-avatar-collapse').addEventListener('click', toggleAvatar);
  document.getElementById('sidebar-expand').addEventListener('click', () => {
    layoutState.itemsVisible = true;
    rebuildLayout();
  });
  document.getElementById('toki-help-btn').addEventListener('click', showHelpPopup);
  document.getElementById('btn-settings').addEventListener('click', showSettingsPopup);
  initSidebarSplitResizer();
  initTokiAvatar();
  applyDarkMode(); // Apply saved dark mode preference
  initChatMode();
  initPanelDragDrop();
  // Refs panel dock button
  const refsPanelDockBtn = document.getElementById('btn-refs-panel-dock');
  if (refsPanelDockBtn) refsPanelDockBtn.addEventListener('click', () => moveRefs('sidebar'));
  // Refs panel popout button (in separated refs-panel header)
  const refsPanelPopoutBtn = document.getElementById('btn-refs-panel-popout');
  if (refsPanelPopoutBtn) {
    refsPanelPopoutBtn.addEventListener('click', () => {
      if (isPanelPoppedOut('refs')) dockPanel('refs');
      else popOutPanel('refs');
    });
  }
  // Apply saved layout (restore positions)
  rebuildLayout();
  if (autosaveEnabled) startAutosave();
  buildRefsSidebar(); // Load guides & refs even without a file open

  // Listen for popout window events
  window.tokiAPI.onPopoutClosed((panelType) => {
    poppedOutPanels.delete(panelType);
    // Show the panel back in main window
    if (panelType === 'sidebar') {
      layoutState.itemsVisible = true;
    } else if (panelType === 'terminal') {
      layoutState.terminalVisible = true;
    } else if (panelType === 'editor') {
      // Re-open editor in main window
      if (activeTabId) {
        const curTab = openTabs.find(t => t.id === activeTabId);
        if (curTab) createOrSwitchEditor(curTab);
      }
      updateTabUI();
    } else if (panelType === 'preview') {
      // Re-open inline preview when popout docks
      showPreviewPanel();
    } else if (panelType === 'refs') {
      layoutState.refsPos = layoutState._refsPosBefore || 'sidebar';
      delete layoutState._refsPosBefore;
    }
    rebuildLayout();
    if (panelType === 'terminal' && fitAddon && term) {
      setTimeout(() => fitAddon.fit(), 50);
    }
    updatePopoutButtons();
    const panelName = panelType === 'sidebar' ? '항목' : panelType === 'editor' ? '에디터' : panelType === 'preview' ? '프리뷰' : panelType === 'refs' ? '참고자료' : 'TokiTalk';
    setStatus(`${panelName} 도킹됨`);
  });

  // Listen for editor popout content changes
  window.tokiAPI.onEditorPopoutChange((tabId, content) => {
    const tab = openTabs.find(t => t.id === tabId);
    if (tab && tab.setValue) {
      tab.setValue(content);
      tab._lastValue = content;
      dirtyFields.add(tabId);
      updateTabUI();
    }
  });

  // Listen for editor popout save request
  window.tokiAPI.onEditorPopoutSave(() => {
    handleSave();
  });

  // Listen for sidebar popout clicks → open tab in main editor
  window.tokiAPI.onPopoutSidebarClick((itemId) => {
    openTabById(itemId);
  });

  // Listen for refs popout clicks → open tab in main editor
  window.tokiAPI.onPopoutRefsClick((tabId) => {
    openTabById(tabId);
  });

  // Listen for MCP data updates (Claude modified data via MCP server)
  window.tokiAPI.onDataUpdated((field, value) => {
    if (!fileData) return;
    // (debug log removed)

    if (field === 'lorebook') {
      // Backup each open lorebook tab before overwrite
      for (const tab of openTabs) {
        if (tab.id.startsWith('lore_') && tab.getValue) {
          createBackup(tab.id, tab.getValue());
        }
      }
      fileData.lorebook = value;
      buildSidebar();
      // Refresh open lorebook tabs — if active tab is a lore form, re-render it
      for (const tab of openTabs) {
        if (tab.id.startsWith('lore_') && tab.id === activeTabId) {
          if (tab.language === '_loreform') {
            showLoreEditor(tab);
          } else if (editorInstance) {
            const idx = parseInt(tab.id.replace('lore_', ''), 10);
            if (fileData.lorebook[idx]) {
              const pos = editorInstance.getPosition();
              editorInstance.setValue(fileData.lorebook[idx].content || '');
              if (pos) editorInstance.setPosition(pos);
            }
          }
        }
      }
      setStatus('Claude가 로어북을 수정했습니다');
    } else if (field === 'regex') {
      // Backup each open regex tab before overwrite
      for (const tab of openTabs) {
        if (tab.id.startsWith('regex_') && tab.getValue) {
          createBackup(tab.id, tab.getValue());
        }
      }
      fileData.regex = value;
      buildSidebar();
      for (const tab of openTabs) {
        if (tab.id.startsWith('regex_') && tab.id === activeTabId) {
          if (tab.language === '_regexform') {
            showRegexEditor(tab);
          } else if (editorInstance) {
            const idx = parseInt(tab.id.replace('regex_', ''), 10);
            if (fileData.regex[idx]) {
              const pos = editorInstance.getPosition();
              editorInstance.setValue(JSON.stringify(fileData.regex[idx], null, 2));
              if (pos) editorInstance.setPosition(pos);
            }
          }
        }
      }
      setStatus('Claude가 정규식을 수정했습니다');
    } else {
      // Backup before overwrite (single fields: lua, globalNote, etc.)
      if (field === 'lua') {
        for (const tab of openTabs) {
          if ((tab.id === 'lua' || tab.id.startsWith('lua_s')) && tab.getValue) {
            createBackup(tab.id, tab.getValue());
          }
        }
      } else {
        const tab = openTabs.find(t => t.id === field);
        if (tab && tab.getValue) createBackup(field, tab.getValue());
      }
      fileData[field] = value;
      // Lua: re-parse sections
      if (field === 'lua') {
        luaSections = parseLuaSections(value);
        buildSidebar();
      }
      // CSS: re-parse sections
      if (field === 'css') {
        cssSections = parseCssSections(value);
        buildSidebar();
      }
      // Refresh editor if this field's tab is active
      if (field === activeTabId && editorInstance) {
        const pos = editorInstance.getPosition();
        editorInstance.setValue(value);
        if (pos) editorInstance.setPosition(pos);
      }
      if (field === 'name') {
        const label = document.getElementById('file-label');
        if (label) label.textContent = value || 'Untitled';
      }
      setStatus(`Claude가 ${field} 필드를 수정했습니다`);
    }
    dirtyFields.add(field);
  });

  // (debug log removed)

  // Load Monaco (async)
  try {
    setStatus('Monaco 에디터 로딩 중...');
    await loadMonaco();
    if (darkMode) defineDarkMonacoTheme();
    // (debug log removed)
    setStatus('준비');
  } catch (err) {
    console.error('[init] Monaco load failed:', err);
    setStatus('Monaco 로딩 실패 — 에디터 없이 동작');
  }

  // Load Terminal (async, non-blocking)
  try {
    await initTerminal();
    // (debug log removed)
  } catch (err) {
    console.error('[init] Terminal load failed:', err);
    document.getElementById('terminal-container').innerHTML =
      '<div style="color:#f44;padding:8px;font-size:12px;">터미널 로딩 실패: ' + err.message + '</div>';
  }
}

init();
