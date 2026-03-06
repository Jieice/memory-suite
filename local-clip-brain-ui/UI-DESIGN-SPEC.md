# Local-Clip-Brain UI 设计规范文档

> **版本**: v1.0  
> **设计风格**: 暗黑科技风 (Dark Tech)  
> **目标用户**: 视频创作者、剪辑师

---

## 📋 目录

1. [设计理念](#1-设计理念)
2. [色彩系统](#2-色彩系统)
3. [字体系统](#3-字体系统)
4. [组件规范](#4-组件规范)
5. [交互设计](#5-交互设计)
6. [页面布局](#6-页面布局)
7. [动效规范](#7-动效规范)

---

## 1. 设计理念

### 核心原则

**"简洁高效，专业可靠"**

- 🎯 **语义优先**：搜索框是核心，占据视觉焦点
- ⚡ **即时反馈**：流式结果展示，零等待体验
- 🎨 **氛围营造**：暗黑科技风，专业视频编辑工具感
- 📱 **响应式设计**：适配桌面端 (主要) 和移动端 (次要)

### 视觉风格

```
暗黑科技风 = 深色背景 + 霓虹高亮 + 玻璃质感 + 微妙光效
```

---

## 2. 色彩系统

### 主色调

```css
/* 背景色系 */
--bg-primary: #0a0a0f;      /* 主背景 - 深邃黑 */
--bg-secondary: #12121a;    /* 次级背景 - 侧边栏/卡片 */
--bg-tertiary: #1a1a24;     /* 三级背景 - 输入框/按钮 */
--bg-card: #1e1e28;         /* 卡片背景 */
--bg-hover: #252530;        /* 悬停背景 */

/* 强调色系 */
--accent-primary: #6366f1;   /* 主强调色 - 靛蓝 */
--accent-secondary: #8b5cf6; /* 次强调色 - 紫罗兰 */
--accent-tertiary: #a855f7;  /* 三级强调 - 亮紫 */

/* 文字色系 */
--text-primary: #f8fafc;     /* 主文字 - 亮白 */
--text-secondary: #94a3b8;   /* 次级文字 - 灰蓝 */
--text-tertiary: #64748b;    /* 三级文字 - 暗灰 */

/* 功能色 */
--success: #10b981;  /* 成功 - 绿 */
--warning: #f59e0b;  /* 警告 - 橙 */
--error: #ef4444;    /* 错误 - 红 */
```

### 来源标识色

```css
.source-local { background: #10b981; }     /* 本地 - 绿 */
.source-pexels { background: #05a081; }    /* Pexels - 青绿 */
.source-pixabay { background: #00ab6c; }   /* Pixabay - 翠绿 */
.source-openverse { background: #3b82f6; } /* Openverse - 蓝 */
```

### 渐变

```css
/* 主渐变 - 用于按钮/Logo */
--gradient-primary: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);

/* 卡片渐变 - 用于素材卡片背景 */
--gradient-card: linear-gradient(145deg, #1e1e28 0%, #1a1a24 100%);
```

---

## 3. 字体系统

### 字体家族

```css
/* 主字体 - 中文优先 */
font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, sans-serif;

/* 等宽字体 - 用于时长/分辨率等技术信息 */
font-family: 'JetBrains Mono', 'Fira Code', monospace;
```

### 字体大小

```css
/* 标题 */
--font-size-h1: 24px;   /* 页面标题 */
--font-size-h2: 20px;   /* 区块标题 */
--font-size-h3: 18px;   /* 卡片标题 */

/* 正文 */
--font-size-body: 14px; /* 主要正文 */
--font-size-small: 13px; /* 次要信息 */
--font-size-xs: 12px;   /* 标签/提示 */
--font-size-tiny: 11px; /* 极小文字 */

/* 字重 */
--font-weight-light: 300;
--font-weight-normal: 400;
--font-weight-medium: 500;
--font-weight-semibold: 600;
--font-weight-bold: 700;
```

---

## 4. 组件规范

### 4.1 搜索框

**设计要点**：
- 大尺寸，圆角，居中布局
- 聚焦时发光效果
- 支持回车搜索

```html
<div class="search-input-wrapper">
    <div class="search-icon">🔍</div>
    <input type="text" class="search-input" placeholder="输入语义描述...">
    <button class="search-button">搜索 ↵</button>
</div>
```

**样式**：
```css
.search-input-wrapper {
    background: var(--bg-tertiary);
    border: 2px solid var(--border-color);
    border-radius: 24px; /* 大圆角 */
    padding: 4px;
}

.search-input-wrapper:focus-within {
    border-color: var(--accent-primary);
    box-shadow: 0 0 40px rgba(99, 102, 241, 0.3); /* 发光效果 */
}
```

### 4.2 素材卡片

**设计要点**：
- 16:9 缩略图
- 悬停时上浮 + 发光
- 显示来源、时长、分辨率
- 支持多选

```html
<div class="asset-card">
    <div class="asset-thumbnail">
        <img src="..." alt="...">
        <div class="asset-duration">00:15</div>
        <div class="asset-source pexels">Pexels</div>
        <div class="asset-checkbox">✓</div>
    </div>
    <div class="asset-info">
        <div class="asset-title">雨夜城市街道</div>
        <div class="asset-meta">
            <div class="asset-author">👤 作者</div>
            <div class="asset-resolution">1920×1080</div>
        </div>
        <div class="asset-tags">
            <div class="asset-tag">雨夜</div>
            <div class="asset-tag">城市</div>
        </div>
    </div>
</div>
```

**样式**：
```css
.asset-card {
    background: var(--gradient-card);
    border: 1px solid var(--border-color);
    border-radius: 16px;
    transition: all 0.3s ease;
}

.asset-card:hover {
    transform: translateY(-4px); /* 上浮 */
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    border-color: var(--accent-primary);
}

.asset-card.selected {
    border-color: var(--accent-primary);
    box-shadow: 0 0 40px rgba(99, 102, 241, 0.3);
}
```

### 4.3 筛选器

**设计要点**：
- 胶囊形状
- 点击切换激活状态
- 分组显示

```html
<div class="filter-group">
    <div class="filter-label">来源：</div>
    <div class="filter-chips">
        <div class="filter-chip active">全部</div>
        <div class="filter-chip">本地</div>
        <div class="filter-chip">Pexels</div>
    </div>
</div>
```

**样式**：
```css
.filter-chip {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 6px 12px;
}

.filter-chip.active {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-primary);
}
```

### 4.4 下载面板

**设计要点**：
- 固定在底部
- 选择素材后滑入
- 显示选中数量

```html
<div class="download-panel visible">
    <div class="download-info">
        <div class="download-count">已选择 <strong>3</strong> 个素材</div>
    </div>
    <div class="download-actions">
        <button class="btn btn-secondary">清空选择</button>
        <button class="btn btn-primary">⬇️ 批量下载</button>
    </div>
</div>
```

**样式**：
```css
.download-panel {
    position: fixed;
    bottom: 0;
    left: 280px; /* 侧边栏宽度 */
    right: 0;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    transform: translateY(100%); /* 默认隐藏 */
    transition: transform 0.3s ease;
}

.download-panel.visible {
    transform: translateY(0); /* 滑入 */
}
```

### 4.5 详情模态框

**设计要点**：
- 居中显示
- 背景模糊遮罩
- 视频预览 + 元数据 + 授权信息

```html
<div class="modal-overlay visible">
    <div class="modal">
        <div class="modal-header">
            <div class="modal-title">素材详情</div>
            <button class="modal-close">✕</button>
        </div>
        <div class="modal-body">
            <div class="detail-preview">
                <video controls></video>
            </div>
            <div class="detail-info">
                <!-- 基本信息 -->
                <!-- 授权信息 -->
            </div>
            <div class="attribution-box">
                <!-- 署名信息 -->
            </div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-primary">⬇️ 下载素材</button>
        </div>
    </div>
</div>
```

---

## 5. 交互设计

### 5.1 搜索流程

```
1. 用户输入查询词
   ↓
2. 按回车或点击搜索按钮
   ↓
3. 立即显示本地结果 (<100ms)
   ↓
4. SSE 流式加载外部结果
   - 每个来源返回后立即显示
   - 显示加载动画
   ↓
5. 后台自动入库新素材
```

### 5.2 选择流程

```
1. 单击素材卡片 → 切换选中状态
   ↓
2. 选中后：
   - 卡片边框变亮
   - 显示勾选图标
   - 底部面板滑入
   ↓
3. 双击素材卡片 → 打开详情模态框
```

### 5.3 下载流程

```
1. 选择多个素材
   ↓
2. 点击"批量下载"
   ↓
3. 显示下载进度
   ↓
4. 下载完成提示
   - 显示保存路径
   - 提供"打开文件夹"按钮
```

### 5.4 筛选流程

```
1. 点击筛选器标签
   ↓
2. 立即过滤结果
   - 平滑过渡动画
   - 更新结果计数
```

---

## 6. 页面布局

### 6.1 整体布局

```
┌─────────────────────────────────────────────┐
│ 侧边栏 (280px) │      主内容区 (flex: 1)      │
│                │                             │
│ ┌────────────┐ │ ┌─────────────────────────┐ │
│ │ Logo       │ │ │      搜索栏 (固定)       │ │
│ └────────────┘ │ └─────────────────────────┘ │
│                │                             │
│ ┌────────────┐ │ ┌─────────────────────────┐ │
│ │ 导航菜单   │ │ │      筛选栏 (固定)       │ │
│ │            │ │ └─────────────────────────┘ │
│ │ - 发现     │ │                             │
│ │ - 素材库   │ │ ┌─────────────────────────┐ │
│ │ - 外部源   │ │ │      结果区域 (滚动)     │ │
│ │ - 设置     │ │ │                         │ │
│ │            │ │ │  ┌───┬───┬───┬───┐      │ │
│ └────────────┘ │ │  │   │   │   │   │      │ │
│                │ │  └───┴───┴───┴───┘      │ │
│                │ │  ┌───┬───┬───┬───┐      │ │
│                │ │  │   │   │   │   │      │ │
│                │ │  └───┴───┴───┴───┘      │ │
│                │ └─────────────────────────┘ │
│                │                             │
│                │ ┌─────────────────────────┐ │
│                │ │   下载面板 (固定底部)    │ │
│                │ └─────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 6.2 响应式断点

```css
/* 桌面端 (>1024px) */
.sidebar { width: 280px; }
.assets-grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }

/* 平板端 (768px - 1024px) */
.sidebar { width: 240px; }
.assets-grid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }

/* 移动端 (<768px) */
.sidebar { display: none; }
.assets-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
```

---

## 7. 动效规范

### 7.1 过渡动画

```css
/* 通用过渡 */
transition: all 0.3s ease;

/* 快速交互 (按钮/标签) */
transition: all 0.2s ease;

/* 慢速展示 (模态框/面板) */
transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
```

### 7.2 关键动画

#### 卡片悬停上浮
```css
.asset-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
```

#### 发光效果
```css
.search-input-wrapper:focus-within {
    box-shadow: 0 0 40px rgba(99, 102, 241, 0.3);
}
```

#### 滑入动画
```css
.download-panel.visible {
    transform: translateY(0);
}
```

#### 缩放动画
```css
.modal-overlay.visible .modal {
    transform: scale(1);
}
```

### 7.3 加载动画

```css
/* 骨架屏 */
.loading-skeleton {
    background: linear-gradient(90deg, 
        var(--bg-tertiary) 25%, 
        var(--bg-hover) 50%, 
        var(--bg-tertiary) 75%
    );
    background-size: 200% 100%;
    animation: loading 1.5s infinite;
}

@keyframes loading {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}
```

---

## 8. 图标规范

### 8.1 图标来源

使用 **Emoji** 作为图标，优点：
- ✅ 无需额外加载
- ✅ 跨平台一致
- ✅ 彩色生动

### 8.2 常用图标

```
🔍 搜索
🎬 视频
📁 文件夹
⭐ 收藏
🕐 历史
🌐 外部源
⚙️ 设置
📊 统计
⬇️ 下载
✓ 选中
✕ 关闭
👤 用户
🌧️ 天气标签
🌃 场景标签
```

---

## 9. 可访问性

### 9.1 颜色对比度

- 文字与背景对比度 ≥ 4.5:1 (WCAG AA)
- 大标题对比度 ≥ 3:1

### 9.2 键盘导航

- Tab 键切换焦点
- Enter 键确认操作
- Esc 键关闭模态框

### 9.3 屏幕阅读器

```html
<img alt="雨夜城市街道视频缩略图" ...>
<button aria-label="搜索素材">🔍</button>
```

---

## 10. 设计资源

### 10.1 设计工具

- **Figma**: UI 设计稿
- **Coolors**: 配色方案
- **Google Fonts**: 字体选择

### 10.2 参考设计

- **剪映 Web 版**: 素材库交互
- **Pexels**: 卡片布局
- **Notion**: 侧边栏设计
- **Vercel**: 暗黑主题

---

## 11. 开发指南

### 11.1 技术栈

```yaml
前端框架: Vue 3 / React
UI 库: 自定义 CSS (无框架)
状态管理: Pinia / Redux
HTTP 客户端: Axios
流式处理: EventSource API
```

### 11.2 组件拆分

```
components/
├── SearchBar.vue          # 搜索栏
├── FilterBar.vue          # 筛选栏
├── AssetGrid.vue          # 素材网格
├── AssetCard.vue          # 素材卡片
├── DownloadPanel.vue      # 下载面板
├── AssetDetailModal.vue   # 详情模态框
├── Sidebar.vue            # 侧边栏
└── LoadingSkeleton.vue    # 加载骨架屏
```

### 11.3 状态管理

```typescript
// store/assets.ts
export const useAssetsStore = defineStore('assets', {
  state: () => ({
    searchQuery: '',
    assets: [],
    selectedAssets: new Set(),
    filters: {
      source: 'all',
      type: 'video',
      resolution: '1080p'
    }
  }),
  
  actions: {
    async searchAssets(query: string) {
      // SSE 流式搜索
    },
    
    toggleAssetSelection(assetId: string) {
      // 切换选中状态
    },
    
    async downloadSelected() {
      // 批量下载
    }
  }
})
```

---

## 📚 附录

### A. 设计稿文件

- Figma 链接: [待补充]
- 设计源文件: `local-clip-brain-ui.fig`

### B. 组件库文档

- Storybook: [待补充]
- 组件 API 文档: [待补充]

### C. 设计更新日志

| 日期 | 版本 | 更新内容 |
|------|------|----------|
| 2025-02-28 | v1.0 | 初始版本，完成核心 UI 设计 |

---

**设计团队**: Claude AI  
**最后更新**: 2025-02-28
