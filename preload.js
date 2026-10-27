const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  // data: string or Uint8Array. Resolves to the saved path, or null if cancelled.
  saveFile: (options, data) => ipcRenderer.invoke('save-file', options, data),
  // Resolves to { path, name, data: Uint8Array }, or null if cancelled.
  openFile: (options) => ipcRenderer.invoke('open-file', options),
});
