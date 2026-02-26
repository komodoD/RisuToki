'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popoutAPI', {
  // Panel type from URL query
  getType: () => new URLSearchParams(window.location.search).get('type') || 'terminal',

  // Dock (return to main window)
  dock: () => ipcRenderer.invoke('popout-dock'),

  // Terminal (reuse same channels as main window)
  terminalIsRunning: () => ipcRenderer.invoke('terminal-is-running'),
  terminalStart: (cols, rows) => ipcRenderer.invoke('terminal-start', cols, rows),
  terminalInput: (data) => ipcRenderer.send('terminal-input', data),
  terminalResize: (cols, rows) => ipcRenderer.send('terminal-resize', cols, rows),
  onTerminalData: (cb) => { ipcRenderer.on('terminal-data', (_, data) => cb(data)); },
  onTerminalExit: (cb) => { ipcRenderer.on('terminal-exit', () => cb()); },

  // Sidebar
  getSidebarData: () => ipcRenderer.invoke('popout-sidebar-data'),
  sidebarClick: (itemId) => ipcRenderer.send('popout-sidebar-click', itemId),

  // Editor popout
  getEditorData: () => ipcRenderer.invoke('get-editor-popout-data'),
  editorChange: (tabId, content) => ipcRenderer.send('editor-popout-change', tabId, content),
  editorSave: () => ipcRenderer.send('editor-popout-save'),

  // Preview popout
  getPreviewData: () => ipcRenderer.invoke('get-preview-popout-data'),

  // Refs popout
  getRefsData: () => ipcRenderer.invoke('popout-refs-data'),
  refsItemClick: (tabId) => ipcRenderer.send('popout-refs-click', tabId),
});
