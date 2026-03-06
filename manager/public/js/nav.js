/**
 * Memory Suite V8 — 动态导航栏注入
 * 在页面中引入此脚本即可自动生成导航栏
 * 用法: <script src="js/nav.js"></script>
 */
(function() {
  const pages = [
    { href: 'index.html',        label: '🎛 控制台' },
    { href: 'creator-chat.html', label: '💬 私聊' },
    { href: 'tools.html',        label: '🔧 工具' },
    { href: 'knowledge.html',    label: '🧠 记忆空间' },
    { href: 'training.html',     label: '⚡ LoRA训练' },
  ];

  const currentPage = location.pathname.split('/').pop() || 'index.html';

  const nav = document.createElement('nav');
  nav.className = 'ms-nav';
  nav.id = 'ms-global-nav';

  pages.forEach(function(page) {
    const a = document.createElement('a');
    a.href = page.href;
    a.textContent = page.label;
    if (currentPage === page.href) {
      a.className = 'active';
    }
    nav.appendChild(a);
  });

  // 插入到 body 的最前面，或者替换已有的 nav
  var existing = document.getElementById('ms-global-nav');
  if (existing) {
    existing.replaceWith(nav);
  } else {
    document.body.insertBefore(nav, document.body.firstChild);
  }
})();
