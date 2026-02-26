'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokiAPI', {
  // File
  newFile: () => ipcRenderer.invoke('new-file'),
  openFile: () => ipcRenderer.invoke('open-file'),
  openReference: () => ipcRenderer.invoke('open-reference'),
  openReferencePath: (filePath) => ipcRenderer.invoke('open-reference-path', filePath),
  removeReference: (fileName) => ipcRenderer.invoke('remove-reference', fileName),
  removeAllReferences: () => ipcRenderer.invoke('remove-all-references'),
  saveFile: (updatedFields) => ipcRenderer.invoke('save-file', updatedFields),
  saveFileAs: (updatedFields) => ipcRenderer.invoke('save-file-as', updatedFields),
  getFilePath: () => ipcRenderer.invoke('get-file-path'),
  getCwd: () => ipcRenderer.invoke('get-cwd'),

  // Terminal
  terminalStart: (cols, rows) => ipcRenderer.invoke('terminal-start', cols, rows),
  terminalInput: (data) => ipcRenderer.send('terminal-input', data),
  terminalResize: (cols, rows) => ipcRenderer.send('terminal-resize', cols, rows),
  terminalStop: () => ipcRenderer.invoke('terminal-stop'),
  onTerminalData: (cb) => { ipcRenderer.on('terminal-data', (_, data) => cb(data)); },
  onTerminalExit: (cb) => { ipcRenderer.on('terminal-exit', () => cb()); },

  // Claude
  getClaudePrompt: () => ipcRenderer.invoke('get-claude-prompt'),

  // MCP
  getMcpInfo: () => ipcRenderer.invoke('get-mcp-info'),
  writeMcpConfig: () => ipcRenderer.invoke('write-mcp-config'),
  onDataUpdated: (cb) => { ipcRenderer.on('data-updated', (_, field, value) => cb(field, value)); },

  // MCP Confirm (MomoTalk style popup)
  onMcpConfirmRequest: (cb) => { ipcRenderer.on('mcp-confirm-request', (_, id, title, message) => cb(id, title, message)); },
  sendMcpConfirmResponse: (id, allowed) => ipcRenderer.send('mcp-confirm-response', id, allowed),

  // Close Confirm (MomoTalk style popup, 3-button)
  onCloseConfirmRequest: (cb) => { ipcRenderer.on('close-confirm-request', (_, id) => cb(id)); },
  sendCloseConfirmResponse: (id, choice) => ipcRenderer.send('close-confirm-response', id, choice),

  // Assets
  getAssetList: () => ipcRenderer.invoke('get-asset-list'),
  getAssetData: (assetPath) => ipcRenderer.invoke('get-asset-data', assetPath),
  getAllAssetsMap: () => ipcRenderer.invoke('get-all-assets-map'),
  addAsset: (targetFolder) => ipcRenderer.invoke('add-asset', targetFolder),
  addAssetBuffer: (fileName, base64, targetFolder) => ipcRenderer.invoke('add-asset-buffer', fileName, base64, targetFolder),
  deleteAsset: (assetPath) => ipcRenderer.invoke('delete-asset', assetPath),
  renameAsset: (oldPath, newName) => ipcRenderer.invoke('rename-asset', oldPath, newName),

  // Import JSON (lorebook/regex)
  importJson: () => ipcRenderer.invoke('import-json'),

  // Autosave
  autosaveFile: (updatedFields) => ipcRenderer.invoke('autosave-file', updatedFields),
  cleanupAutosave: (customDir) => ipcRenderer.invoke('cleanup-autosave', customDir),

  // System Prompt (temp file)
  writeSystemPrompt: (content) => ipcRenderer.invoke('write-system-prompt', content),

  // Persona
  readPersona: (name) => ipcRenderer.invoke('read-persona', name),
  writePersona: (name, content) => ipcRenderer.invoke('write-persona', name, content),
  listPersonas: () => ipcRenderer.invoke('list-personas'),

  // Guides
  listGuides: () => ipcRenderer.invoke('list-guides'),
  readGuide: (filename) => ipcRenderer.invoke('read-guide', filename),
  writeGuide: (filename, content) => ipcRenderer.invoke('write-guide', filename, content),
  importGuide: () => ipcRenderer.invoke('import-guide'),

  // UI
  pickBgImage: () => ipcRenderer.invoke('pick-bg-image'),
  pickBgm: () => ipcRenderer.invoke('pick-bgm'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  getAutosaveInfo: (customDir) => ipcRenderer.invoke('get-autosave-info', customDir),
  pickAutosaveDir: () => ipcRenderer.invoke('pick-autosave-dir'),

  // Sync (RisuAI live sync)
  startSync: (port) => ipcRenderer.invoke('start-sync', port),
  stopSync: () => ipcRenderer.invoke('stop-sync'),
  onSyncStatus: (cb) => { ipcRenderer.on('sync-status', (_, active, port) => cb(active, port)); },

  // DevTools
  toggleDevTools: () => ipcRenderer.invoke('toggle-devtools'),

  // Popout panels
  popoutPanel: (type) => ipcRenderer.invoke('popout-create', type),
  closePopout: (type) => ipcRenderer.invoke('popout-close', type),
  onPopoutClosed: (cb) => { ipcRenderer.on('popout-closed', (_, type) => cb(type)); },
  onPopoutSidebarClick: (cb) => { ipcRenderer.on('popout-sidebar-click', (_, itemId) => cb(itemId)); },
  onPopoutRefsClick: (cb) => { ipcRenderer.on('popout-refs-click', (_, tabId) => cb(tabId)); },

  // Editor popout
  setEditorPopoutData: (data) => ipcRenderer.invoke('set-editor-popout-data', data),
  onEditorPopoutChange: (cb) => { ipcRenderer.on('editor-popout-change', (_, tabId, content) => cb(tabId, content)); },
  onEditorPopoutSave: (cb) => { ipcRenderer.on('editor-popout-save', () => cb()); },

  // Preview popout
  setPreviewPopoutData: (data) => ipcRenderer.invoke('set-preview-popout-data', data),

  // Guides
  getGuidesPath: () => ipcRenderer.invoke('get-guides-path')
});
