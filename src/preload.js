const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gymtrack', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  importJSON: () => ipcRenderer.invoke('dialog:importJSON'),
  exportJSON: (data, name) => ipcRenderer.invoke('dialog:exportJSON', data, name)
});
