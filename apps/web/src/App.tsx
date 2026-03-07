import { NavLink, Route, Routes } from 'react-router-dom';
import { CreatorChatPage } from './pages/CreatorChatPage';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { OverlaysPage } from './pages/OverlaysPage';
import { RuntimePage } from './pages/RuntimePage';
import { TrainingPage } from './pages/TrainingPage';
import { ToolsPage } from './pages/ToolsPage';

const navItems = [
  { to: '/', label: 'Control' },
  { to: '/runtime', label: 'Runtime' },
  { to: '/training', label: 'Training' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/tools', label: 'Tools' },
  { to: '/knowledge', label: 'Knowledge' },
  { to: '/creator-chat', label: 'Creator Chat' },
  { to: '/overlays', label: 'Overlays' },
];

export default function App() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">MS</span>
          <div>
            <p className="eyebrow">Rust Unified Runtime</p>
            <h1>Memory Suite</h1>
          </div>
        </div>
        <nav className="nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/runtime" element={<RuntimePage />} />
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
