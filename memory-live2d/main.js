const { app, BrowserWindow, screen, globalShortcut, Tray, Menu, ipcMain, dialog, nativeImage } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const LIVE2D_LOCAL_PORT = process.env.LIVE2D_SERVICE_PORT || process.env.LIVE2D_PORT || '4002';
const LIVE2D_LOCAL_URL = `http://127.0.0.1:${LIVE2D_LOCAL_PORT}`;
const SERVER_READY_TIMEOUT_MS = 12000;
const SERVER_CHECK_INTERVAL_MS = 400;
const ENV_PATH = path.resolve(__dirname, '../.env');

const DEFAULT_CONFIG = {
    scale: 0.25,
    x: 0.3,
    y: 0.5,
    mouthSpeed: 20,
    fontSize: 36,
    minFontSize: 30
};

let mainWindow = null;
let configWindow = null;
let tray = null;
let serverProcess = null;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isServerAvailable() {
    return new Promise((resolve) => {
        const req = http.get(`${LIVE2D_LOCAL_URL}/api/status`, (res) => {
            const ok = res.statusCode === 200;
            res.resume();
            resolve(ok);
        });

        req.setTimeout(1500, () => {
            req.destroy();
            resolve(false);
        });

        req.on('error', () => resolve(false));
    });
}

async function waitForServerReady(timeoutMs) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        if (await isServerAvailable()) {
            return;
        }

        if (!serverProcess) {
            break;
        }

        await delay(SERVER_CHECK_INTERVAL_MS);
    }

    throw new Error(`Live2D server is not ready after ${timeoutMs}ms`);
}

async function startServer() {
    if (await isServerAvailable()) {
        console.log('[live2d-main] server already running');
        return;
    }

    const isWindows = process.platform === 'win32';
    serverProcess = spawn('node', ['server.js'], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        shell: isWindows
    });

    serverProcess.stdout.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
            console.log(`[live2d-server] ${line}`);
        }
    });

    serverProcess.stderr.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
            console.error(`[live2d-server:error] ${line}`);
        }
    });

    serverProcess.on('error', (error) => {
        console.error('[live2d-main] failed to start server process:', error);
    });

    serverProcess.on('exit', (code, signal) => {
        console.log(`[live2d-main] server process exited code=${code} signal=${signal || 'none'}`);
        serverProcess = null;
    });

    await waitForServerReady(SERVER_READY_TIMEOUT_MS);
    console.log('[live2d-main] server ready');
}

function killServerProcess() {
    if (!serverProcess) {
        return;
    }

    try {
        const pid = serverProcess.pid;
        const isWindows = process.platform === 'win32';

        if (isWindows) {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
                stdio: 'ignore',
                shell: true
            });
        } else {
            serverProcess.kill('SIGKILL');
        }
    } catch (error) {
        console.error('[live2d-main] failed to kill server process:', error.message);
    } finally {
        serverProcess = null;
    }
}

function createMainWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    mainWindow = new BrowserWindow({
        width,
        height,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        focusable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        resizable: false,
        movable: false,
        skipTaskbar: true,
        maximizable: false,
        show: false
    });

    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.setMenu(null);
    mainWindow.setPosition(0, 0);

    mainWindow.on('blur', () => {
        if (mainWindow && !mainWindow.isAlwaysOnTop()) {
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
        }
    });

    mainWindow.on('close', () => {
        if (configWindow && !configWindow.isDestroyed()) {
            configWindow.close();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function chooseTrayIcon() {
    const candidates = [
        path.join(__dirname, 'icon', '1.png'),
        path.join(__dirname, 'icon', 'Icon.png'),
        path.join(__dirname, '..', '..', 'Icon', '1.png')
    ];

    for (const iconPath of candidates) {
        if (fs.existsSync(iconPath)) {
            return iconPath;
        }
    }

    return nativeImage.createEmpty();
}

function applyPreset(scale, x, y) {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
        return;
    }

    const script = `
(() => {
    const controller = window.live2dController;
    if (!controller || !controller.model) {
        return { ok: false, reason: 'controller_not_ready' };
    }

    const model = controller.model;
    model.scale.set(${scale}, ${scale});
    model.x = window.innerWidth * ${x};
    model.y = window.innerHeight * ${y};
    model.visible = true;
    model.alpha = 1;

    return { ok: true, x: model.x, y: model.y };
})();`;

    mainWindow.webContents.executeJavaScript(script)
        .then((result) => {
            if (result && result.ok) {
                updateServerConfig({ scale, x, y });
            }
        })
        .catch((error) => {
            console.error('[live2d-main] applyPreset failed:', error.message);
        });
}

function updateTrayMenu() {
    if (!tray) {
        return;
    }

    const menu = Menu.buildFromTemplate([
        {
            label: 'Open Config',
            click: () => openConfigWindow()
        },
        { type: 'separator' },
        {
            label: 'Position Presets',
            submenu: [
                { label: 'Bottom Left', click: () => applyPreset(0.25, 0.15, 0.75) },
                { label: 'Bottom Right', click: () => applyPreset(0.25, 0.85, 0.75) },
                { label: 'Center', click: () => applyPreset(0.3, 0.5, 0.5) },
                { label: 'Left Center', click: () => applyPreset(0.25, 0.2, 0.5) },
                { label: 'Right Center', click: () => applyPreset(0.25, 0.8, 0.5) },
                { label: 'Small Test', click: () => applyPreset(0.15, 0.3, 0.5) }
            ]
        },
        { type: 'separator' },
        {
            label: 'Reload Scene',
            click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.reload();
                }
            }
        },
        {
            label: 'Show / Hide',
            click: () => {
                if (!mainWindow || mainWindow.isDestroyed()) {
                    return;
                }

                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.show();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => app.quit()
        }
    ]);

    tray.setContextMenu(menu);
}

function createTray() {
    if (tray) {
        return;
    }

    try {
        tray = new Tray(chooseTrayIcon());
        tray.setToolTip('Live2D Overlay');
        tray.on('double-click', () => openConfigWindow());
        updateTrayMenu();
    } catch (error) {
        console.error('[live2d-main] tray creation failed:', error.message);
    }
}

function openConfigWindow() {
    if (configWindow && !configWindow.isDestroyed()) {
        configWindow.focus();
        return;
    }

    configWindow = new BrowserWindow({
        width: 420,
        height: 640,
        title: 'Live2D Config',
        resizable: false,
        alwaysOnTop: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#101322',
        autoHideMenuBar: true,
        skipTaskbar: true,
        parent: mainWindow || undefined
    });

    configWindow.loadFile('config-overlay.html').catch((error) => {
        console.error('[live2d-main] failed to load config window:', error.message);
    });

    configWindow.on('closed', () => {
        configWindow = null;
    });
}

function updateServerConfig(config) {
    const payload = JSON.stringify(config);
    const port = parseInt(LIVE2D_LOCAL_PORT, 10);

    const options = {
        hostname: '127.0.0.1',
        port,
        path: '/api/config/update',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = http.request(options, (res) => {
        res.resume();
    });

    req.on('error', (error) => {
        console.warn('[live2d-main] updateServerConfig failed:', error.message);
    });

    req.write(payload);
    req.end();
}

function parseEnvFile(content) {
    const result = {};

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const eqIndex = line.indexOf('=');
        if (eqIndex <= 0) {
            continue;
        }

        const key = line.slice(0, eqIndex).trim();
        let value = line.slice(eqIndex + 1).trim();

        const commentIndex = value.indexOf('#');
        if (commentIndex >= 0) {
            value = value.slice(0, commentIndex).trim();
        }

        result[key] = value;
    }

    return result;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertEnvValue(content, key, value) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');

    if (pattern.test(content)) {
        return content.replace(pattern, line);
    }

    const trimmed = content.trimEnd();
    return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}

function readConfigFromEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        return { ...DEFAULT_CONFIG };
    }

    const envMap = parseEnvFile(fs.readFileSync(ENV_PATH, 'utf8'));

    const toNumber = (raw, fallback, parser) => {
        const value = parser(raw);
        return Number.isFinite(value) ? value : fallback;
    };

    return {
        scale: toNumber(envMap.LIVE2D_MODEL_SCALE, DEFAULT_CONFIG.scale, parseFloat),
        x: toNumber(envMap.LIVE2D_MODEL_X, DEFAULT_CONFIG.x, parseFloat),
        y: toNumber(envMap.LIVE2D_MODEL_Y, DEFAULT_CONFIG.y, parseFloat),
        mouthSpeed: toNumber(envMap.LIVE2D_MOUTH_SPEED, DEFAULT_CONFIG.mouthSpeed, (v) => parseInt(v, 10)),
        fontSize: toNumber(envMap.LIVE2D_SUBTITLE_FONT_SIZE, DEFAULT_CONFIG.fontSize, (v) => parseInt(v, 10)),
        minFontSize: toNumber(envMap.LIVE2D_SUBTITLE_MIN_FONT_SIZE, DEFAULT_CONFIG.minFontSize, (v) => parseInt(v, 10))
    };
}

function saveConfigToEnv(config) {
    let envContent = '';

    if (fs.existsSync(ENV_PATH)) {
        envContent = fs.readFileSync(ENV_PATH, 'utf8');
    }

    envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_SCALE', config.scale);
    envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_X', config.x);
    envContent = upsertEnvValue(envContent, 'LIVE2D_MODEL_Y', config.y);
    envContent = upsertEnvValue(envContent, 'LIVE2D_MOUTH_SPEED', config.mouthSpeed);
    envContent = upsertEnvValue(envContent, 'LIVE2D_SUBTITLE_FONT_SIZE', config.fontSize);
    envContent = upsertEnvValue(envContent, 'LIVE2D_SUBTITLE_MIN_FONT_SIZE', config.minFontSize);

    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
}

ipcMain.on('apply-config', (event, config) => {
    const scale = Number(config.scale);
    const x = Number(config.x);
    const y = Number(config.y);

    if ([scale, x, y].some((n) => !Number.isFinite(n))) {
        return;
    }

    applyPreset(scale, x, y);
});

ipcMain.on('save-config', (event, config) => {
    try {
        const normalized = {
            scale: Number.isFinite(Number(config.scale)) ? Number(config.scale) : DEFAULT_CONFIG.scale,
            x: Number.isFinite(Number(config.x)) ? Number(config.x) : DEFAULT_CONFIG.x,
            y: Number.isFinite(Number(config.y)) ? Number(config.y) : DEFAULT_CONFIG.y,
            mouthSpeed: Number.isFinite(Number(config.mouthSpeed)) ? Number(config.mouthSpeed) : DEFAULT_CONFIG.mouthSpeed,
            fontSize: Number.isFinite(Number(config.fontSize)) ? Number(config.fontSize) : DEFAULT_CONFIG.fontSize,
            minFontSize: Number.isFinite(Number(config.minFontSize)) ? Number(config.minFontSize) : DEFAULT_CONFIG.minFontSize
        };

        saveConfigToEnv(normalized);
        updateServerConfig(normalized);
        event.reply('config-saved', { success: true });
    } catch (error) {
        event.reply('config-saved', { success: false, error: error.message });
    }
});

ipcMain.on('load-config', (event) => {
    try {
        event.reply('config-loaded', readConfigFromEnv());
    } catch (error) {
        event.reply('config-loaded', { ...DEFAULT_CONFIG });
    }
});

function registerShortcuts() {
    globalShortcut.register('CommandOrControl+Q', () => {
        app.quit();
    });

    globalShortcut.register('CommandOrControl+Shift+Q', () => {
        killServerProcess();
        app.exit(0);
    });
}

async function boot() {
    createMainWindow();
    createTray();

    try {
        await startServer();
    } catch (error) {
        dialog.showErrorBox(
            'Live2D Service Startup Failed',
            `Unable to start Live2D service at ${LIVE2D_LOCAL_URL}.\n\n${error.message}`
        );
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            await mainWindow.loadURL(LIVE2D_LOCAL_URL);
        } catch (error) {
            console.error('[live2d-main] loadURL failed:', error.message);
        }

        // 只在非无头模式下显示窗口（OBS 仍然可以捕获）
        const headless = process.env.LIVE2D_HEADLESS === '1' || process.env.LIVE2D_HEADLESS === 'true';
        if (!headless) {
            mainWindow.show();
        }
    }
}

app.whenReady().then(async () => {
    registerShortcuts();
    await boot();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            boot().catch((error) => {
                console.error('[live2d-main] re-boot failed:', error.message);
            });
        }
    });
});

app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    killServerProcess();
    app.quit();
});

app.on('before-quit', () => {
    killServerProcess();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    killServerProcess();
});

process.on('exit', () => {
    killServerProcess();
});

process.on('SIGINT', () => {
    killServerProcess();
    process.exit(0);
});

process.on('SIGTERM', () => {
    killServerProcess();
    process.exit(0);
});
