const { contextBridge, ipcRenderer } = require('electron');

// The window is frameless and comes up fullscreen, so the page has no chrome of
// its own left to hide - the portal's fullscreen button has to reach the real
// window instead of the Fullscreen API. That toggle is the only thing the
// renderer is handed; everything else stays in the main process.
contextBridge.exposeInMainWorld('portal', {
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen')
});
