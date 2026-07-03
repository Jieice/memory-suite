const { app, BrowserWindow, Menu, globalShortcut, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.env.MEMORY_SUITE_ROOT || path.resolve(__dirname, '..', '..');
const runtimeUrl = (process.env.MEMORY_SUITE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const statePath = path.join(rootDir, 'runtime', 'electron-window-state.json');
const runtimeOrigin = new URL(runtimeUrl).origin;

let mainWindow = null;
let live2dWindow = null;
let saveTimer = null;
let state = loadState();

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {
      main: null,
      live2d: {
        bounds: null,
        visible: true,
        clickThrough: false,
        alwaysOnTop: true,
      },
    };
  }
}

function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }, 180);
}

function rememberBounds(key, win) {
  if (!win || win.isDestroyed()) return;
  state[key] = {
    ...(state[key] || {}),
    bounds: win.getBounds(),
  };
  saveStateSoon();
}

function withSearch(url, values) {
  const nextUrl = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    nextUrl.searchParams.set(key, value);
  }
  return nextUrl.toString();
}

function overlayUrl() {
  const url = new URL('/overlay/live2d', runtimeUrl);
  url.searchParams.set('mode', 'pet');
  url.searchParams.set('electron', '1');
  return url.toString();
}

function externalNavigationGuard(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(runtimeOrigin)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(runtimeOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function defaultMainBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1480, workArea.width);
  const height = Math.min(920, workArea.height);
  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
  };
}

function defaultLive2dBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = Math.min(780, workArea.height - 80);
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 36,
    y: workArea.y + Math.max(24, workArea.height - height - 28),
  };
}

function createMainWindow() {
  const bounds = state.main?.bounds || defaultMainBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    title: '忆境中枢',
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#eef8fb',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  externalNavigationGuard(mainWindow);
  mainWindow.loadURL(withSearch(runtimeUrl, { desktop: '1' }));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', () => rememberBounds('main', mainWindow));
  mainWindow.on('move', () => rememberBounds('main', mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

function setLive2dAlwaysOnTop(enabled) {
  state.live2d = { ...(state.live2d || {}), alwaysOnTop: enabled };
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.setAlwaysOnTop(enabled, enabled ? 'screen-saver' : 'normal');
  }
  saveStateSoon();
  buildMenu();
}

function setLive2dClickThrough(enabled) {
  state.live2d = { ...(state.live2d || {}), clickThrough: enabled };
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.setIgnoreMouseEvents(enabled, { forward: true });
  }
  saveStateSoon();
  buildMenu();
}

function showLive2dWindow() {
  if (process.env.MEMORY_SUITE_NO_LIVE2D === '1') return;
  if (!live2dWindow || live2dWindow.isDestroyed()) {
    createLive2dWindow();
    return;
  }
  live2dWindow.showInactive();
  state.live2d = { ...(state.live2d || {}), visible: true };
  saveStateSoon();
  buildMenu();
}

function hideLive2dWindow() {
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.hide();
  }
  state.live2d = { ...(state.live2d || {}), visible: false };
  saveStateSoon();
  buildMenu();
}

function toggleLive2dWindow() {
  const visible = live2dWindow && !live2dWindow.isDestroyed() && live2dWindow.isVisible();
  if (visible) {
    hideLive2dWindow();
  } else {
    showLive2dWindow();
  }
}

function resetLive2dWindow() {
  state.live2d = {
    ...(state.live2d || {}),
    bounds: defaultLive2dBounds(),
    visible: true,
    clickThrough: false,
    alwaysOnTop: true,
  };
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.setBounds(state.live2d.bounds);
    live2dWindow.showInactive();
  } else {
    createLive2dWindow();
  }
  setLive2dClickThrough(false);
  setLive2dAlwaysOnTop(true);
  saveStateSoon();
  buildMenu();
}

function createLive2dWindow() {
  const live2dState = {
    visible: true,
    clickThrough: false,
    alwaysOnTop: true,
    ...(state.live2d || {}),
  };
  state.live2d = live2dState;
  const bounds = live2dState.bounds || defaultLive2dBounds();

  live2dWindow = new BrowserWindow({
    ...bounds,
    title: '忆境 Live2D 浮窗',
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  externalNavigationGuard(live2dWindow);
  live2dWindow.setAlwaysOnTop(live2dState.alwaysOnTop, live2dState.alwaysOnTop ? 'screen-saver' : 'normal');
  live2dWindow.loadURL(overlayUrl());
  live2dWindow.once('ready-to-show', () => {
    if (state.live2d?.visible !== false) {
      live2dWindow.showInactive();
    }
    setLive2dClickThrough(Boolean(state.live2d?.clickThrough));
  });
  live2dWindow.on('resize', () => rememberBounds('live2d', live2dWindow));
  live2dWindow.on('move', () => rememberBounds('live2d', live2dWindow));
  live2dWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hideLive2dWindow();
    }
  });
  live2dWindow.on('closed', () => {
    live2dWindow = null;
  });
}

function buildMenu() {
  const live2dVisible = live2dWindow && !live2dWindow.isDestroyed() && live2dWindow.isVisible();
  const live2dEnabled = process.env.MEMORY_SUITE_NO_LIVE2D !== '1';
  const template = [
    {
      label: '忆境中枢',
      submenu: [
        {
          label: '重载控制台',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.reload(),
        },
        {
          label: '用浏览器打开后端',
          click: () => shell.openExternal(runtimeUrl),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: 'Live2D',
      submenu: [
        {
          label: '显示透明浮窗',
          type: 'checkbox',
          enabled: live2dEnabled,
          checked: Boolean(live2dVisible),
          accelerator: 'CmdOrCtrl+Alt+L',
          click: () => toggleLive2dWindow(),
        },
        {
          label: '鼠标穿透',
          type: 'checkbox',
          enabled: live2dEnabled,
          checked: Boolean(state.live2d?.clickThrough),
          accelerator: 'CmdOrCtrl+Alt+T',
          click: (item) => setLive2dClickThrough(item.checked),
        },
        {
          label: '窗口置顶',
          type: 'checkbox',
          enabled: live2dEnabled,
          checked: state.live2d?.alwaysOnTop !== false,
          click: (item) => setLive2dAlwaysOnTop(item.checked),
        },
        {
          label: '重置浮窗位置',
          enabled: live2dEnabled,
          click: () => resetLive2dWindow(),
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'toggleDevTools', label: '切换开发者工具' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+L', toggleLive2dWindow);
  globalShortcut.register('CommandOrControl+Alt+T', () => {
    setLive2dClickThrough(!Boolean(state.live2d?.clickThrough));
  });
}

app.whenReady().then(() => {
  createMainWindow();
  if (process.env.MEMORY_SUITE_NO_LIVE2D !== '1') {
    createLive2dWindow();
  }
  buildMenu();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      if (process.env.MEMORY_SUITE_NO_LIVE2D !== '1') {
        createLive2dWindow();
      }
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
});
