# Bilibili Protocol Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move real Bilibili danmaku ingress under the unified Rust runtime by making Rust own source configuration, connection state, lifecycle actions, and normalized event routing.

**Architecture:** Keep Rust as the authoritative control plane. First migrate danmaku source configuration and connection state into Rust-owned storage and APIs, then introduce a supervised protocol adapter boundary for the old handshake/signature complexity, and finally route normalized upstream events into the existing gateway and runtime bus so the old bridge is no longer an orchestration authority.

**Tech Stack:** Rust (`axum`, `tokio`, `sqlx`, `serde`), TypeScript/React/Vite, supervised Python/Node adapter boundary where needed during transition.

---

### Task 1: Danmaku Source Config And Connection State APIs

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Modify: `crates/gateway/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/danmaku_source_api.rs`

**Step 1: Write the failing test**

Add an integration test that:
- reads `GET /api/danmaku/source`
- updates config through `POST /api/danmaku/source`
- starts and stops the connection lifecycle through `POST /api/danmaku/connect` and `POST /api/danmaku/disconnect`
- reads `GET /api/danmaku/state`
- asserts persisted room id, cookie presence, lifecycle status, and attempt counters

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_source_api`
Expected: FAIL because danmaku source/state endpoints and persistence do not exist.

**Step 3: Write minimal implementation**

- Add `DanmakuSourceConfigRecord`, `DanmakuConnectionStateRecord`, `DanmakuSourceUpdateRequest`, and `DanmakuConnectionActionResponse` to `crates/api-types/src/lib.rs`.
- Add SQLite tables/helpers in `crates/storage/src/lib.rs` for danmaku source config and connection state.
- Extend `crates/gateway/src/lib.rs` with Rust-owned source/state methods:
  - `get_source_config`
  - `update_source_config`
  - `get_connection_state`
  - `connect`
  - `disconnect`
- Expose endpoints from `apps/daemon/src/lib.rs`:
  - `GET /api/danmaku/source`
  - `POST /api/danmaku/source`
  - `GET /api/danmaku/state`
  - `POST /api/danmaku/connect`
  - `POST /api/danmaku/disconnect`

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_source_api`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/storage/src/lib.rs crates/gateway/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/danmaku_source_api.rs
git commit -m "feat: add danmaku source and connection state apis"
```

### Task 2: Runtime And Overlay Visibility For Upstream Danmaku State

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/gateway/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/danmaku_runtime_state_ws.rs`

**Step 1: Write the failing test**

Add a websocket test that subscribes to `/ws/runtime`, performs source update and connect/disconnect actions, and expects runtime events for:
- source config updated
- connection status changed
- connect attempt recorded

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_runtime_state_ws`
Expected: FAIL because no runtime events are emitted for danmaku lifecycle changes.

**Step 3: Write minimal implementation**

- Extend `RuntimeEventKind` with danmaku source/state lifecycle events.
- Publish those events from `GatewayService`.
- Keep event detail payloads compact and operator-readable.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_runtime_state_ws`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/gateway/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/danmaku_runtime_state_ws.rs
git commit -m "feat: emit danmaku lifecycle runtime events"
```

### Task 3: Supervised Protocol Adapter Boundary

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/jobs/src/python_adapter.rs`
- Modify: `crates/gateway/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/danmaku_protocol_adapter.rs`

**Step 1: Write the failing test**

Add a test that starts a danmaku protocol adapter from the Rust connect path and expects:
- connection state moves to `connecting`
- adapter metadata is persisted
- failure transitions the connection state to `failed`

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_protocol_adapter`
Expected: FAIL because connect does not supervise a protocol adapter.

**Step 3: Write minimal implementation**

- Define a temporary adapter launch contract for danmaku protocol ingress.
- Make `GatewayService::connect` request a supervised adapter start when source config is valid.
- Persist adapter id / upstream host / last error into connection state.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_protocol_adapter`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/jobs/src/python_adapter.rs crates/gateway/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/danmaku_protocol_adapter.rs
git commit -m "feat: supervise danmaku protocol adapter lifecycle"
```

### Task 4: Web Runtime Cutover For Real Danmaku Source Control

**Files:**
- Modify: `apps/web/src/lib.ts`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/pages/OverlaysPage.tsx`
- Modify: `apps/web/src/generated/api.ts`

**Step 1: Write the failing test**

Use the production build as the contract by referencing the new danmaku source/state client methods and UI controls before they exist.

**Step 2: Run test to verify it fails**

Run: `npm run build --prefix apps/web`
Expected: FAIL on missing danmaku source/state methods or generated types.

**Step 3: Write minimal implementation**

- Regenerate shared types from Rust.
- Add client methods for source config, connection state, connect, and disconnect.
- Extend the runtime page to show:
  - active room/source details
  - connection posture
  - last heartbeat/error
  - connect/disconnect controls
- Extend overlays/runtime operator surfaces with upstream danmaku visibility where useful.

**Step 4: Run test to verify it passes**

Run: `cargo run -p api-types --bin export_web`
Run: `npm run build --prefix apps/web`
Expected: both PASS

**Step 5: Commit**

```bash
git add apps/web/src apps/web/package.json
git commit -m "feat: add danmaku source controls to runtime console"
```

### Task 5: Protocol Helper Retirement Mapping

**Files:**
- Modify: `docs/LEGACY_RETIREMENT_MAP.md`
- Modify: `docs/CUTOVER_CHECKLIST.md`
- Modify: `docs/UNIFIED_RUST_RUNTIME.md`

**Step 1: Write the failing test**

Use the runtime bootstrap and docs as the contract: identify every remaining Bilibili protocol dependency still owned outside Rust.

**Step 2: Run test to verify it fails**

Run: `cmd /c "set MEMORY_SUITE_SKIP_SERVE=1&& start-unified.bat"`
Expected: docs and bootstrap notes still describe the old protocol path as primary.

**Step 3: Write minimal implementation**

- Update retirement docs to mark the old danmaku bridge as protocol-helper-only.
- Add the remaining deletion criteria for `memory-danmaku`.
- Document the final conditions for removing the temporary adapter boundary.

**Step 4: Run test to verify it passes**

Run: `cargo test -p api-types -p app-config -p storage -p orchestrator -p gateway -p jobs -p media -p daemon`
Run: `cargo run -p api-types --bin export_web`
Run: `npm run build --prefix apps/web`
Run: `cmd /c "set MEMORY_SUITE_SKIP_SERVE=1&& start-unified.bat"`
Expected: all PASS

**Step 5: Commit**

```bash
git add docs/LEGACY_RETIREMENT_MAP.md docs/CUTOVER_CHECKLIST.md docs/UNIFIED_RUST_RUNTIME.md
git commit -m "docs: map bilibili protocol helper retirement"
```
