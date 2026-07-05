import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { ToolsPage } from './pages/ToolsPage';
import { loadUiPreferences, subscribeUiPreferences } from './preferences';

const navItems = [
  { to: '/', label: '总控台' },
  { to: '/settings', label: '配置中心' },
  { to: '/tools', label: '工具', devOnly: true },
];

export default function App() {
  const [preferences, setPreferences] = useState(loadUiPreferences);
  const [booting, setBooting] = useState(true);
  const visibleNavItems = useMemo(
    () => navItems.filter((item) => !item.devOnly || preferences.developerMode),
    [preferences.developerMode],
  );

  useEffect(() => subscribeUiPreferences(setPreferences), []);
  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 1100);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const theme =
      preferences.themeMode === '跟随系统'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : preferences.themeMode === '夜间'
          ? 'dark'
          : 'light';
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
  }, [preferences.themeMode]);

  return (
    <>
      <div className={`app-startup${booting ? '' : ' ready'}`} aria-hidden={!booting}>
        <div className="app-startup-card" role="status" aria-live="polite">
          <span className="brand-mark app-startup-mark">MS</span>
          <div>
            <p className="app-startup-kicker">Memory Suite Unified</p>
            <h2>统一窗口启动中</h2>
            <p>正在连接 Rust 后端、加载控制台资源和 Live2D 浮窗入口…</p>
            <div className="app-startup-bar" aria-hidden="true">
              <span />
            </div>
          </div>
        </div>
      </div>
      <header className="window-titlebar">
        <div className="window-titlebar-center">
          <div className="window-titlebar-brand">
            <span className="window-titlebar-orb" aria-hidden="true" />
            <div className="window-titlebar-copy">
              <strong>忆境中枢</strong>
              <span>Memory Suite Unified</span>
            </div>
          </div>
          <span className="window-titlebar-badge">Rust Unified Runtime</span>
        </div>
        <span className="window-titlebar-status">Live2D / Chat / Runtime Control</span>
        <div className="window-titlebar-controls">
          <button
            type="button"
            className="window-control minimize"
            aria-label="最小化窗口"
            onClick={() => window.memorySuiteWindow?.minimize()}
          >
            <span aria-hidden="true">－</span>
          </button>
          <button
            type="button"
            className="window-control maximize"
            aria-label="最大化窗口"
            onClick={() => window.memorySuiteWindow?.toggleMaximize()}
          >
            <span aria-hidden="true">□</span>
          </button>
          <button
            type="button"
            className="window-control close"
            aria-label="完全退出"
            onClick={() => window.memorySuiteWindow?.close()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">MS</span>
            <div>
              <p className="eyebrow">Rust 统一运行时</p>
              <h1>忆境中枢</h1>
            </div>
          </div>
          <nav className="nav">
            {visibleNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <span>{item.label}</span>
                {item.devOnly ? <small>开发</small> : null}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/runtime" element={<Navigate to="/" replace />} />
            <Route path="/knowledge" element={<Navigate to="/settings" replace />} />
            <Route path="/creator-chat" element={<Navigate to="/settings" replace />} />
            <Route path="/overlays" element={<Navigate to="/settings" replace />} />
          </Routes>
        </main>
      </div>
    </>
  );
}
