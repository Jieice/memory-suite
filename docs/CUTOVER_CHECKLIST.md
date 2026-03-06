# Unified Runtime Cutover Checklist

## 1. Preflight

- Confirm Rust, Node.js, npm, and Python are installed on the Windows host.
- Review `config/app.toml` and verify:
  - `server.host` and `server.port`
  - `storage.database_path` and `storage.data_root`
  - `python.executable` and `python.models_root`
- Stop relying on PM2, batch wrappers, and old port-specific startup commands for operator use.

## 2. Bootstrap Validation

- Run `npm run unified:test`
- Run `npm run unified:types`
- Run `npm run unified:web:build`
- Run `npm run unified:import`
- Run `npm run unified:bootstrap`

Expected:

- Rust tests pass
- shared TS types regenerate cleanly
- web build completes
- legacy import completes without data loss
- bootstrap script prepares the runtime and exits cleanly in bootstrap-only mode

## 3. Operator Switch

- Start the new stack with `start-unified.bat`
- Open `http://127.0.0.1:8080`
- Check the runtime page for:
  - runtime overview
  - adapter list
  - live runtime events
  - legacy import summary
- Check overlays:
  - `http://127.0.0.1:8080/overlay/live2d`
  - `http://127.0.0.1:8080/overlay/danmaku`

## 4. Smoke Verification

- Send a chat request from the dashboard
- Trigger TTS dispatch
- Queue one train job and one eval job
- Verify `GET /api/runtime/adapters` shows supervised runs
- Verify `GET /api/jobs` shows execution metadata
- Verify `/ws/runtime` emits runtime events

## 5. Legacy Retirement Gate

Only retire legacy entrypoints after the following are stable:

- unified daemon starts cleanly from `start-unified.bat`
- runtime page is the primary operator surface
- job and TTS dispatch both work through supervised adapters
- imported legacy memory/config data is present in SQLite
- OBS overlays load from the unified daemon endpoints
