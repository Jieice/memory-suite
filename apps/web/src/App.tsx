import { NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { CreatorChatPage } from './pages/CreatorChatPage';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { OverlaysPage } from './pages/OverlaysPage';
import { RuntimePage } from './pages/RuntimePage';
import { SettingsPage } from './pages/SettingsPage';
import { TrainingPage } from './pages/TrainingPage';
import { ToolsPage } from './pages/ToolsPage';
import { loadUiPreferences, subscribeUiPreferences } from './preferences';

const navItems = [
  { to: '/', label: '总控台' },
  { to: '/runtime', label: '运行时' },
  { to: '/settings', label: '配置中心' },
  { to: '/knowledge', label: '知识库' },
  { to: '/creator-chat', label: '创作者聊天' },
  { to: '/overlays', label: '浮窗' },
  { to: '/training', label: '训练', devOnly: true },
  { to: '/jobs', label: '任务', devOnly: true },
  { to: '/tools', label: '工具', devOnly: true },
];

export default function App() {
  const [preferences, setPreferences] = useState(loadUiPreferences);
  const visibleNavItems = useMemo(
    () =>
      navItems.filter(
        (item) => !item.devOnly || preferences.developerMode || !preferences.compactNavigation,
      ),
    [preferences.compactNavigation, preferences.developerMode],
  );

  useEffect(() => subscribeUiPreferences(setPreferences), []);

  return (
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
          <Route path="/runtime" element={<RuntimePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/training" element={<TrainingPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/creator-chat" element={<CreatorChatPage />} />
          <Route path="/overlays" element={<OverlaysPage />} />
        </Routes>
      </main>
    </div>
  );
}
