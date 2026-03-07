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
- Treat `start-unified.bat` as the primary startup path.
- Treat `start-manager.bat` as a compatibility alias only, not a separate stack entry.

## 2. Verification Before Operator Switch

- Run `npm run unified:test`
- Run `npm run unified:types`
- Run `npm run unified:web:build`
- Run `npm run unified:import`
- Run `npm run unified:bootstrap`

Expected:

- Rust crates pass their test suite
- shared TS types regenerate cleanly
- web build completes cleanly
- legacy import succeeds
- bootstrap completes without needing legacy manager startup

## 3. Operator Surface Checks

- Start the stack with `start-unified.bat`
- Open `http://127.0.0.1:8080`
- Check:
  - runtime page
  - adapters list
  - runtime event feed
  - danmaku source save/connect/disconnect controls
  - native danmaku probe / one-shot connect / session start controls
  - danmaku session open/error/close controls
  - danmaku source and connection state readback
  - live2d state controls
  - danmaku injection controls

## 4. Overlay Checks

- Open `http://127.0.0.1:8080/overlay/live2d`
- Open `http://127.0.0.1:8080/overlay/danmaku`
- Verify `/ws/overlay` emits subtitle/emotion/config events after live2d updates

## 5. Runtime Flow Checks

- Send a chat message from the dashboard
- Trigger TTS dispatch
- Queue a train job and an eval job
- Push a subtitle and emotion update from the runtime page
- Inject a danmaku message through the runtime page
- Save danmaku source config and trigger connect/disconnect from the runtime page
- Trigger native probe, native one-shot connect, and native session start from the runtime page
- Simulate helper session open/error/close from the runtime page
- Verify:
  - `/api/runtime/adapters` reflects supervised adapters
  - `/api/jobs` reflects execution metadata
  - `/api/danmaku/source` reflects the latest operator-controlled source config
  - `/api/danmaku/state` reflects connect attempts and failures
  - `/api/danmaku/state` reflects session id, close reason, and retry deadline
  - `/api/live2d/state` reflects the latest overlay state
  - `/ws/runtime` emits runtime events

## 6. Legacy Retirement Gate

Only retire legacy operator usage after all of the following are true:

- unified daemon starts cleanly from `start-unified.bat`
- runtime page is sufficient for daily operator control
- live2d state no longer requires the old Node live2d server
- danmaku ingress and source control can be exercised through the Rust-owned path
- native danmaku session control no longer requires the old `memory-danmaku/` helper
- imported legacy memory/config data is present in SQLite
- the `memory-danmaku/` directory is absent from the active runtime branch
