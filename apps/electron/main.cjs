const { app, BrowserWindow, Menu, globalShortcut, ipcMain, shell, screen, session, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const rootDir = process.env.MEMORY_SUITE_ROOT || path.resolve(__dirname, '..', '..');
const runtimeUrl = (process.env.MEMORY_SUITE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const daemonExePath = path.join(rootDir, 'target', 'debug', 'daemon.exe');
const statePath = path.join(rootDir, 'runtime', 'electron-window-state.json');
const runtimeOrigin = new URL(runtimeUrl).origin;
const runtimePort = Number(new URL(runtimeUrl).port || 8080);
const bootPagePath = path.join(__dirname, 'boot.html');
const preloadPath = path.join(__dirname, 'preload.cjs');
const serviceJanitorPath = path.join(rootDir, 'scripts', 'service-janitor.ps1');
const OBS_HIDDEN_VISIBLE_EDGE = 6;
const FALLBACK_PRIMARY_WORKAREA = Object.freeze({
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
});
const STATIC_SHORTCUTS = Object.freeze({
  toggleLive2d: 'CommandOrControl+Alt+L',
  toggleClickThrough: 'CommandOrControl+Alt+T',
});

let mainWindow = null;
let live2dWindow = null;
let saveTimer = null;
let state = null;
let runtimeBootstrapAttempted = false;
let runtimeBootstrapPromise = null;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function loadState() {
  try {
    return normalizePersistedState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return normalizePersistedState(null);
  }
}

function normalizePersistedState(input) {
  return {
    main: input?.main || null,
    live2d: normalizeLive2dState(input?.live2d),
    // renderer 设置过的屏幕采集偏好源类型（stream→window 优先 / desktop→screen 优先）。
    // 值是 ['screen'|'window'] 的最多两项数组；只有白名单内值才能被保持。
    screenCapture: normalizeScreenCaptureState(input?.screenCapture),
  };
}

function normalizeScreenCaptureState(input) {
  if (!input || typeof input !== 'object') return null;
  const preferred = Array.isArray(input.preferredSourceTypes)
    ? input.preferredSourceTypes
        .filter((t) => t === 'screen' || t === 'window')
        .slice(0, 2)
    : [];
  return preferred.length > 0 ? { preferredSourceTypes: preferred } : null;
}

function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushStateNow();
  }, 180);
}

function flushStateNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function rememberBounds(key, win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  if (key === 'live2d') {
    const live2dState = normalizeLive2dState(state.live2d);
    state.live2d = {
      ...live2dState,
      bounds,
      visibleBounds:
        live2dState.localVisibilityMode === 'visible'
          ? bounds
          : live2dState.visibleBounds,
    };
  } else {
    state[key] = {
      ...(state[key] || {}),
      bounds,
    };
  }
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

function getPrimaryWorkAreaSafe() {
  if (!app.isReady()) {
    return FALLBACK_PRIMARY_WORKAREA;
  }
  return screen.getPrimaryDisplay().workArea;
}

function getDisplayWorkAreaForBoundsSafe(bounds) {
  if (!app.isReady()) {
    return FALLBACK_PRIMARY_WORKAREA;
  }
  return screen.getDisplayMatching(bounds).workArea;
}

function getDisplayWorkAreaForPointSafe(point) {
  if (!app.isReady()) {
    return FALLBACK_PRIMARY_WORKAREA;
  }
  return screen.getDisplayNearestPoint(point).workArea;
}

function defaultMainBounds() {
  const workArea = getPrimaryWorkAreaSafe();
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
  const workArea = getPrimaryWorkAreaSafe();
  const width = 420;
  const height = Math.min(780, workArea.height - 80);
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 36,
    y: workArea.y + Math.max(24, workArea.height - height - 28),
  };
}

function normalizeLive2dState(input) {
  const fallbackBounds = defaultLive2dBounds();
  const nextState = {
    bounds: null,
    visibleBounds: null,
    visible: true,
    clickThrough: false,
    alwaysOnTop: true,
    localVisibilityMode: 'visible',
    ...(input || {}),
  };

  const visibleBounds = nextState.visibleBounds || nextState.bounds || fallbackBounds;
  const localVisibilityMode =
    nextState.localVisibilityMode === 'obs_hidden' ? 'obs_hidden' : 'visible';

  return {
    ...nextState,
    visibleBounds,
    localVisibilityMode,
    bounds:
      localVisibilityMode === 'obs_hidden'
        ? createObsHiddenBounds(visibleBounds)
        : nextState.bounds || visibleBounds,
  };
}

function createObsHiddenBounds(visibleBounds) {
  const workArea = getDisplayWorkAreaForBoundsSafe(visibleBounds);
  const clamped = clampWindowBoundsToDisplay(
    visibleBounds.x,
    visibleBounds.y,
    visibleBounds.width,
    visibleBounds.height,
  );
  return {
    width: visibleBounds.width,
    height: visibleBounds.height,
    x: workArea.x + workArea.width - OBS_HIDDEN_VISIBLE_EDGE,
    y: clamped.y,
  };
}

function resolveLive2dBounds(live2dState) {
  const normalized = normalizeLive2dState(live2dState);
  return normalized.localVisibilityMode === 'obs_hidden'
    ? createObsHiddenBounds(normalized.visibleBounds)
    : normalized.visibleBounds;
}

function syncLive2dMouseEvents() {
  if (!live2dWindow || live2dWindow.isDestroyed()) return;
  const live2dState = normalizeLive2dState(state.live2d);
  live2dWindow.setIgnoreMouseEvents(
    live2dState.localVisibilityMode === 'obs_hidden' || Boolean(live2dState.clickThrough),
    { forward: true },
  );
}

function getLive2dShellState() {
  if (process.env.MEMORY_SUITE_NO_LIVE2D === '1') {
    return {
      available: false,
      visible: false,
      clickThrough: false,
      alwaysOnTop: false,
      localVisibilityMode: 'visible',
    };
  }
  const live2dState = normalizeLive2dState(state.live2d);
  state.live2d = live2dState;
  return {
    available: true,
    visible:
      live2dWindow && !live2dWindow.isDestroyed()
        ? live2dWindow.isVisible()
        : live2dState.visible !== false,
    clickThrough: Boolean(live2dState.clickThrough),
    alwaysOnTop: live2dState.alwaysOnTop !== false,
    localVisibilityMode: live2dState.localVisibilityMode,
  };
}

function clampWindowBoundsToDisplay(x, y, width, height) {
  const probePoint = {
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  };
  const workArea = getDisplayWorkAreaForPointSafe(probePoint);
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  return {
    x: Math.round(Math.min(Math.max(x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(y, workArea.y), maxY)),
  };
}

function createMainWindow() {
  const bounds = state.main?.bounds || defaultMainBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    title: '忆境中枢',
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#020617',
    autoHideMenuBar: true,
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  externalNavigationGuard(mainWindow);
  mainWindow.loadFile(bootPagePath);
  waitForRuntimeAndLoadMain(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('app-command', (event, command) => {
    if (command === 'browser-backward' || command === 'browser-forward') {
      event.preventDefault();
    }
  });
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      void shutdownRuntimeAndQuit();
    }
  });
  mainWindow.on('resize', () => rememberBounds('main', mainWindow));
  mainWindow.on('move', () => rememberBounds('main', mainWindow));
  mainWindow.on('maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:maximize-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:maximize-changed', false);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function requestRuntimeShutdown() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    await fetch(`${runtimeUrl}/api/runtime/shutdown`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (_) {
    // Best-effort shutdown. The shell should still be allowed to exit.
  } finally {
    clearTimeout(timer);
  }
}

function runServiceJanitor(mode) {
  if (!fs.existsSync(serviceJanitorPath)) {
    return;
  }

  const shellPath = 'powershell.exe';
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    serviceJanitorPath,
    '-Mode',
    mode,
  ];

  try {
    if (mode === 'shutdown') {
      const child = spawn(shellPath, args, {
        cwd: rootDir,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }

    const result = spawnSync(shellPath, args, {
      cwd: rootDir,
      windowsHide: true,
      timeout: 12000,
      encoding: 'utf8',
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr || `service janitor exited with code ${result.status}`);
    }

    if (result.stdout?.trim()) {
      console.log(result.stdout.trim());
    }
  } catch (error) {
    console.warn('[janitor] cleanup failed:', error.message || error);
  }
}

async function shutdownRuntimeAndQuit() {
  if (app.isQuitting) {
    return;
  }
  app.isQuitting = true;
  flushStateNow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.hide();
  }
  await requestRuntimeShutdown();
  runServiceJanitor('shutdown');
  setImmediate(() => {
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
  syncLive2dMouseEvents();
  saveStateSoon();
  buildMenu();
}

function setLive2dLocalVisibilityMode(mode) {
  const nextMode = mode === 'obs_hidden' ? 'obs_hidden' : 'visible';
  const live2dState = normalizeLive2dState(state.live2d);
  const visibleBounds =
    live2dState.localVisibilityMode === 'visible' && live2dWindow && !live2dWindow.isDestroyed()
      ? live2dWindow.getBounds()
      : live2dState.visibleBounds;

  const nextState = normalizeLive2dState({
    ...live2dState,
    visibleBounds,
    localVisibilityMode: nextMode,
  });

  state.live2d = nextState;

  if (live2dWindow && !live2dWindow.isDestroyed()) {
    const targetBounds = resolveLive2dBounds(nextState);
    live2dWindow.setBounds(targetBounds);
    if (nextState.visible !== false) {
      live2dWindow.showInactive();
    }
    syncLive2dMouseEvents();
  }

  saveStateSoon();
  buildMenu();
  return getLive2dShellState();
}

function showLive2dWindow() {
  if (process.env.MEMORY_SUITE_NO_LIVE2D === '1') return;
  if (!live2dWindow || live2dWindow.isDestroyed()) {
    createLive2dWindow();
    return;
  }
  const previousMode = state.live2d?.localVisibilityMode === 'obs_hidden' ? 'obs_hidden' : 'visible';
  // obs_hidden 模式下窗口停在屏幕右缘只露 6px，先切回 visible 再显示，否则用户看不到反应。
  let live2dState = normalizeLive2dState({
    ...(state.live2d || {}),
    visible: true,
    localVisibilityMode: 'visible',
  });
  if (previousMode === 'obs_hidden') {
    live2dState = normalizeLive2dState({
      ...live2dState,
      localVisibilityMode: 'visible',
    });
  }
  state.live2d = live2dState;
  live2dWindow.setBounds(resolveLive2dBounds(live2dState));
  live2dWindow.showInactive();
  syncLive2dMouseEvents();
  saveStateSoon();
  buildMenu();
}

function hideLive2dWindow() {
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.hide();
  }
  state.live2d = normalizeLive2dState({
    ...(state.live2d || {}),
    visible: false,
  });
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
  const bounds = defaultLive2dBounds();
  state.live2d = {
    ...(state.live2d || {}),
    bounds,
    visibleBounds: bounds,
    visible: true,
    clickThrough: false,
    alwaysOnTop: true,
    localVisibilityMode: 'visible',
  };
  if (live2dWindow && !live2dWindow.isDestroyed()) {
    live2dWindow.setBounds(bounds);
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
  const live2dState = normalizeLive2dState(state.live2d);
  state.live2d = live2dState;
  let bounds = resolveLive2dBounds(live2dState);

  // 首启或持久化越界时把可见模式窗口拉回屏幕内，避免在小于 1080p 的屏上开到屏外。
  if (live2dState.localVisibilityMode === 'visible') {
    const clamped = clampWindowBoundsToDisplay(bounds.x, bounds.y, bounds.width, bounds.height);
    bounds = { ...bounds, ...clamped };
    state.live2d = { ...live2dState, visibleBounds: bounds, bounds };
  }

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
      preload: preloadPath,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  externalNavigationGuard(live2dWindow);
  live2dWindow.setAlwaysOnTop(live2dState.alwaysOnTop, live2dState.alwaysOnTop ? 'screen-saver' : 'normal');
  live2dWindow.loadURL(overlayUrl());
  live2dWindow.once('ready-to-show', () => {
    // 本地桌宠窗硬静音：直播由 OBS browser source 出声，避免本地和直播间两份重叠人声。
    // 这是窗口级静音，不依赖页面代码，即使页面缓存了旧 html 也不会外放。
    live2dWindow.webContents.setAudioMuted(true);
    if (state.live2d?.visible !== false) {
      live2dWindow.showInactive();
    }
    syncLive2dMouseEvents();
  });
  // 页面每次加载完成后重申静音，防止 reload/导航后失效。
  live2dWindow.webContents.on('did-finish-load', () => {
    live2dWindow?.webContents.setAudioMuted(true);
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
  const live2dObsHidden = state.live2d?.localVisibilityMode === 'obs_hidden';
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
        {
          label: '完全退出（含后台）',
          click: () => {
            void shutdownRuntimeAndQuit();
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            void shutdownRuntimeAndQuit();
          },
        },
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
          accelerator: STATIC_SHORTCUTS.toggleLive2d,
          click: () => toggleLive2dWindow(),
        },
        {
          label: live2dObsHidden ? '鼠标穿透（隐身模式下强制穿透）' : '鼠标穿透',
          type: 'checkbox',
          enabled: live2dEnabled && !live2dObsHidden,
          checked: Boolean(state.live2d?.clickThrough) || live2dObsHidden,
          accelerator: STATIC_SHORTCUTS.toggleClickThrough,
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

function registerStaticShortcuts() {
  globalShortcut.unregisterAll();
  globalShortcut.register(STATIC_SHORTCUTS.toggleLive2d, toggleLive2dWindow);
  globalShortcut.register(STATIC_SHORTCUTS.toggleClickThrough, () => {
    setLive2dClickThrough(!Boolean(state.live2d?.clickThrough));
  });
}

function registerWindowControls() {
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle('window:is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win && !win.isDestroyed() && win.isMaximized());
  });
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('live2d-window:get-bounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== live2dWindow) return null;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    return {
      ...bounds,
      workArea: display.workArea,
    };
  });
  ipcMain.handle('live2d-shell:get-state', () => getLive2dShellState());
  ipcMain.handle('live2d-shell:set-local-visibility-mode', (_event, mode) =>
    setLive2dLocalVisibilityMode(mode),
  );
  ipcMain.on('live2d-window:set-position', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== live2dWindow || !payload) return;
    const nextX = Number(payload.x);
    const nextY = Number(payload.y);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;
    const bounds = win.getBounds();
    const clamped = clampWindowBoundsToDisplay(nextX, nextY, bounds.width, bounds.height);
    win.setPosition(clamped.x, clamped.y);
  });

  // 屏幕识别采集前，renderer 会让主进程记住「偏好源类型」（stream→window 优先，
  // desktop/monitor→screen 优先）。getDisplayMedia 的 handler 会据此决定列举 screen 还是
  // window、并优先选哪个；不注册的话 renderer 那次的 ipcRenderer.invoke 会 reject，连带
  // start() 直接失败、采集起不来。
  ipcMain.handle('screen-capture:set-preferred-source-types', (_event, types) => {
    if (!Array.isArray(types)) return false;
    const preferred = types
      .filter((t) => t === 'screen' || t === 'window')
      .slice(0, 2);
    if (preferred.length === 0) return false;
    state.screenCapture = { ...(state.screenCapture || {}), preferredSourceTypes: preferred };
    saveStateSoon();
    return true;
  });
}

async function isRuntimeHealthy() {
  try {
    const response = await fetch(`${runtimeUrl}/api/health`);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return payload?.status === 'ok';
  } catch {
    return false;
  }
}

async function ensureRuntimeStarted() {
  if (await isRuntimeHealthy()) {
    return true;
  }

  if (runtimeBootstrapPromise) {
    return runtimeBootstrapPromise;
  }

  runtimeBootstrapPromise = (async () => {
    if (await isRuntimeHealthy()) {
      return true;
    }

    if (!fs.existsSync(daemonExePath)) {
      console.warn('[runtime] daemon executable missing:', daemonExePath);
      return false;
    }

    runServiceJanitor('startup');

    try {
      const child = spawn(daemonExePath, [], {
        cwd: rootDir,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          MEMORY_SUITE_PORT: String(runtimePort),
        },
      });
      child.unref();
    } catch (error) {
      console.warn('[runtime] failed to spawn daemon:', error.message || error);
      return false;
    }

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await isRuntimeHealthy()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.warn('[runtime] daemon spawn timed out:', runtimeUrl);
    return false;
  })().finally(() => {
    runtimeBootstrapPromise = null;
  });

  return runtimeBootstrapPromise;
}

function waitForRuntimeAndLoadMain(win) {
  const targetUrl = withSearch(runtimeUrl, { desktop: '1' });
  const startedAt = Date.now();

  const tick = async () => {
    if (!win || win.isDestroyed()) {
      return;
    }
    if (win.webContents.getURL() === targetUrl) {
      return;
    }
    if (await isRuntimeHealthy()) {
      win.loadURL(targetUrl);
      return;
    }
    if (!runtimeBootstrapAttempted) {
      runtimeBootstrapAttempted = true;
      if (await ensureRuntimeStarted()) {
        win.loadURL(targetUrl);
        return;
      }
    }
    if (Date.now() - startedAt < 90000) {
      setTimeout(() => {
        void tick();
      }, 500);
    }
  };

  void tick();
}

// 屏幕识别：renderer 调 getDisplayMedia 时，Electron 在桌面端不会自动弹选源框，
// 必须在主进程挂 setDisplayMediaRequestHandler。我们用 desktopCapturer 主动列举源、
// 按 renderer 提交的偏好（stream→window 优先 / desktop·monitor→screen 优先）挑一个
// 再回传给 callback。
//
// 为什么不用 `useSystemPicker: true`：Electron 43 在 Windows 上用系统选源框时，
// callback({}) 会以 "Video was requested, but no video stream was provided" TypeError
// reject（实测见 runtime/launcher.log），renderer 端拿到 Invalid capture constraints。
// 系统选源框这条路在 43.0.0 上不可靠，改回手动列举源的写法 —— 跨版本都稳。
function registerScreenCaptureHandler() {
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler((request, callback) => {
    // renderer 通过 screen-capture:set-preferred-source-types 设置过偏好：
    // stream 模式优先 window，desktop/monitor 模式优先 screen。没设过就两者都列举。
    const preferred = state?.screenCapture?.preferredSourceTypes;
    const types = preferred && preferred.length > 0 ? preferred : ['screen', 'window'];
    desktopCapturer
      .getSources({ types, fetchWindowIcons: false })
      .then((sources) => {
        if (!sources || sources.length === 0) {
          // 拿不到源也得给 callback 一个答复，否则 getDisplayMedia 会一直挂起。
          callback({});
          return;
        }
        // [screen/window] 偏好顺序已在 getSources 的 types 里体现，这里在返回结果里
        // 倾向选第一个有 display_id 的屏幕源（多屏时取主屏）；否则取第一个窗口源。
        const screenSource =
          sources.find((s) => s.display_id) || sources[0];
        // 只回传 video，不带 audio——'loopback' 在 43 上会让约束校验不稳，且视觉识别不需要音频。
        callback({ video: screenSource });
      })
      .catch(() => {
        callback({});
      });
  });
}

// 单实例锁：桌面快捷方式双击两次不该开出两个应用。第二个实例直接退出，
// 并把已有主窗口拉到前台。
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // 延迟到 app ready 后加载状态，避免 visibleBounds 在屏幕信息可用前用兜底 1920×1080 计算。
  if (state === null) {
    state = loadState();
  }
  registerWindowControls();
  createMainWindow();
  if (process.env.MEMORY_SUITE_NO_LIVE2D !== '1') {
    createLive2dWindow();
  }
  buildMenu();
  registerStaticShortcuts();
  registerScreenCaptureHandler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      if (process.env.MEMORY_SUITE_NO_LIVE2D !== '1') {
        createLive2dWindow();
      }
      buildMenu();
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
});
