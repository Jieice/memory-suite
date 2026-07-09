const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memorySuiteWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizeChange: (callback) => {
    const listener = (_event, maximized) => {
      try {
        callback(maximized);
      } catch (_) {
        // 渲染进程回调异常忽略，避免阻塞主进程事件分发。
      }
    };
    ipcRenderer.on('window:maximize-changed', listener);
    return () => {
      ipcRenderer.removeListener('window:maximize-changed', listener);
    };
  },
});

contextBridge.exposeInMainWorld('memorySuiteLive2dWindow', {
  getBounds: () => ipcRenderer.invoke('live2d-window:get-bounds'),
  setPosition: (x, y) => ipcRenderer.send('live2d-window:set-position', { x, y }),
  getShellState: () => ipcRenderer.invoke('live2d-shell:get-state'),
  setLocalVisibilityMode: (mode) =>
    ipcRenderer.invoke('live2d-shell:set-local-visibility-mode', mode),
});

contextBridge.exposeInMainWorld('memorySuiteScreenCapture', {
  setPreferredSourceTypes: (types) =>
    ipcRenderer.invoke('screen-capture:set-preferred-source-types', types),
});
