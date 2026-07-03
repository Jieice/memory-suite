# Unified Runtime Cutover Checklist

## 1. Preflight

- Confirm Rust, Node.js, npm, and Python are installed on the Windows host.
- Review `config/app.toml`:
  - `server.host`
  - `server.port`
  - `storage.database_path`
  - `storage.data_root`
- `python.executable`
  - `python.models_root`
- Treat `start-electron.bat` as the only supported startup path.

## 2. Verification Before Operator Switch

- Run `npm run unified:test`
- Run `npm run unified:types`
- Run `npm run unified:web:build`
- Run `npm run unified:bootstrap`

Expected:

- Rust crates pass their test suite
- shared TS types regenerate cleanly
- web build completes cleanly
- bootstrap completes without needing legacy manager startup

## 3. Operator Surface Checks

- Start the stack with `start-electron.bat`
- Open `http://127.0.0.1:8080`
- Check:
  - runtime page
  - adapters list
  - runtime event feed
  - danmaku source save/connect/disconnect controls
  - native danmaku probe / one-shot connect / session start controls
  - danmaku source and connection state readback
  - live2d state controls
  - danmaku injection controls

## 4. Overlay Checks

- Open `http://127.0.0.1:8080/overlay/live2d`
- Open `http://127.0.0.1:8080/overlay/danmaku`
- Verify `/ws/overlay` emits subtitle/emotion/config and danmaku events after runtime updates

## 5. Runtime Flow Checks

- Send a chat message from the dashboard
- Trigger TTS dispatch
- Queue a train job and an eval job
- Push a subtitle and emotion update from the runtime page
- Inject a danmaku message through the runtime page
- Save danmaku source config and trigger connect/disconnect from the runtime page
- Trigger native probe, native one-shot connect, and native session start from the runtime page
- Verify:
  - `/api/runtime/adapters` reflects supervised adapters
  - `/api/jobs` reflects execution metadata
  - `/api/danmaku/source` reflects the latest operator-controlled source config
  - `/api/danmaku/state` reflects connect attempts and failures
  - `/api/danmaku/state` reflects session id, close reason, and retry deadline
  - `/api/live2d/state` reflects the latest overlay state
  - `/ws/runtime` emits runtime events

## 6. Retirement Gate

The cutover is complete only when:

- unified daemon starts cleanly from `start-electron.bat`
- runtime page is sufficient for daily operator control
- OBS uses `/overlay/live2d` and `/overlay/danmaku`
- required memory/config data is present in SQLite
- `manager/`, `memory-universe/`, `memory-live2d/`, and `memory-danmaku/` are absent from the active runtime tree

---

## 7. 正式开播 Readiness 门禁（新增）

> 在开始正式开播前，必须按以下顺序通过所有 blocking 门禁，warning 门禁建议处理但不阻塞。

### 执行顺序

```
构建校验 → 启动校验 → 运行面校验 → Overlay/TTS 校验 → 完整彩排 → go/no-go
```

### 7.1 构建校验（自动）

```
npm run unified:types        # 重新生成共享 API 类型
npm run unified:web:build    # 确认 web 构建干净
npm run readiness:test       # 运行 readiness 单元测试（4 个用例）
npm run smoke                # 运行 smoke 检查
```

所有命令零错误退出 → 通过。

### 7.2 启动校验（手动）

- 用 `start-electron.bat` 冷启动（先彻底关闭旧进程）
- 确认终端无 FATAL / panic 输出
- 确认 `http://127.0.0.1:8080/api/health` 返回 `{ "status": "ok", "runtime_mode": "rust_single_process" }`
- 确认 `/api/runtime/overview` 返回 `db_ready: true`

### 7.3 运行面校验（手动 + 自动）

打开 RuntimePage（`http://127.0.0.1:8080`），确认顶部 **开播 Readiness** 卡片显示：

| 门禁 | 判定条件 | 级别 |
|------|----------|------|
| DB ready | `overview.db_ready === true` | **blocking** |
| Speech adapter running | adapters 中存在 `adapter_id=edge_tts` 或 `adapter_id=sovits`，且 `status=running` | **blocking** |
| Runtime event feed 有数据 | 已收到至少 1 条 runtime event | **blocking** |
| Danmaku 已连接 | `danmakuState.status === 'connected'` | warning |
| 聊天延迟正常 | `avg_total_ms < 5000` 且 `avg_finalize_ms < 2500` | warning |
| Fallback 不频繁 | `remote_timeouts < 2` 且 `builtin_fallbacks < 2` | warning |

所有 blocking 门禁绿灯 → 可继续。

### 7.4 Overlay / TTS 校验（手动）

- 打开 `http://127.0.0.1:8080/overlay/live2d`，确认 Live2D 模型加载
- 打开 `http://127.0.0.1:8080/overlay/danmaku`，确认弹幕遮罩加载
- 在浏览器/OBS 中完成一次 autoplay 解锁（点击页面或交互）
- 从 RuntimePage 推送一条字幕，确认 overlay 显示完整文字
- 触发一次真实聊天回复，确认：
  - 字幕全文显示（不截断）
  - TTS 播放完整（不只播开头）
  - speech_completed 事件出现在 event feed

### 7.5 完整彩排（手动，至少做一次）

按顺序操作：

1. **冷启动**：关闭所有进程 → 运行 `start-electron.bat` → 等待 daemon 就绪
2. **运行面观察**：刷新 RuntimePage，确认 Readiness 卡片无 blocking
3. **Overlay 加载**：在 OBS 中重载 live2d 和 danmaku overlay
4. **Autoplay 解锁**：在浏览器中点击 overlay 页面解锁音频
5. **整句 TTS 验证**：发送一条中文消息，听完整回复
6. **Overlay 重载恢复**：在 OBS 中刷新 live2d overlay，再发一条消息，确认字幕/TTS 继续工作
7. **Danmaku 全链路**：连接 → 等待收到真实弹幕事件 → 断开 → 重连
8. **连续消息压力**：连发 3～5 条消息，确认队列不积压、不崩溃
9. **故障诊断入口验证**：运行 `scripts/diagnose-services.bat`，确认输出正常

### 7.6 Go / No-Go 判断

| 条件 | 判定 |
|------|------|
| 7.1 + 7.2 全部通过 | ✅ 构建与启动健康 |
| 7.3 无 blocking | ✅ 运行面健康 |
| 7.4 TTS 完整播放 + overlay 正常 | ✅ 播放链路健康 |
| 7.5 彩排全部通过 | ✅ 整体就绪 |
| 以上全部满足 | → **正式开播(推荐)** |
| 存在任何 blocking 未清零 | → **不可开播，先修复** |
| 仅存在 warning | → **可灰度开播，持续观察** |
