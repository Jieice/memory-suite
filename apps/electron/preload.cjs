const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memorySuiteWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
});

contextBridge.exposeInMainWorld('memorySuiteLive2dWindow', {
  getBounds: () => ipcRenderer.invoke('live2d-window:get-bounds'),
  setPosition: (x, y) => ipcRenderer.send('live2d-window:set-position', { x, y }),
  getShellState: () => ipcRenderer.invoke('live2d-shell:get-state'),
  setLocalVisibilityMode: (mode) =>
    ipcRenderer.invoke('live2d-shell:set-local-visibility-mode', mode),
});
