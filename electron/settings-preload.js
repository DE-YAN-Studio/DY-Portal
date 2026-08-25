const { contextBridge, ipcRenderer } = require('electron');

// A separate bridge from preload.js on purpose. That one is attached to the
// portal window, which loads remote content from the server - it gets nothing
// but a fullscreen toggle. Config and the portal password live behind this
// bridge, which is only ever attached to the local settings page.
contextBridge.exposeInMainWorld('portalSettings', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (values) => ipcRenderer.invoke('settings:save', values),
  close: () => ipcRenderer.invoke('settings:close')
});
