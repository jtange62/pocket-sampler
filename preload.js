const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  // data: string or Uint8Array. Resolves to the saved path, or null if cancelled.
  saveFile: (options, data) => ipcRenderer.invoke('save-file', options, data),
  // Resolves to { path, name, data: Uint8Array }, or null if cancelled.
  openFile: (options) => ipcRenderer.invoke('open-file', options),
  library: {
    roots: () => ipcRenderer.invoke('library-roots'),
    add: () => ipcRenderer.invoke('library-add'), // shows a folder picker
    remove: (dir) => ipcRenderer.invoke('library-remove', dir),
    list: (dir) => ipcRenderer.invoke('library-list', dir),
    search: (query) => ipcRenderer.invoke('library-search', query),
    read: (file) => ipcRenderer.invoke('library-read', file), // Uint8Array
    refresh: () => ipcRenderer.invoke('library-refresh'),
  },
});
