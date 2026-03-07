# Legacy Surface Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the remaining live manager, danmaku, and live2d control plane with Rust-owned runtime APIs, state, and event streams.

**Architecture:** Keep the unified Rust daemon as the only long-lived operator backend. Migrate live2d runtime state and danmaku ingress into Rust-owned modules first, then expose operator controls and status through the web console so the old manager becomes reference-only.

**Tech Stack:** Rust (`axum`, `tokio`, `sqlx`, `serde`), TypeScript/React/Vite, supervised adapter boundaries for temporary legacy ingress where needed.

---

### Task 1: Live2D Runtime State Service

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Modify: `crates/media/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/live2d_state_api.rs`

**Step 1: Write the failing test**

Add a test that posts subtitle, emotion, and model config updates to new Rust endpoints, then reads them back and expects persisted live2d state without touching the old Node server.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test live2d_state_api`
Expected: FAIL because live2d state APIs do not exist.

**Step 3: Write minimal implementation**

- Add `Live2dStateRecord`, `Live2dConfigRecord`, and request payloads to `crates/api-types/src/lib.rs`.
- Add SQLite tables/helpers for live2d state and config in `crates/storage/src/lib.rs`.
- Extend `crates/media/src/lib.rs` with a live2d state service.
- Expose endpoints from `apps/daemon/src/lib.rs`:
  - `GET /api/live2d/state`
  - `POST /api/live2d/subtitle`
  - `POST /api/live2d/emotion`
  - `POST /api/live2d/config`

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test live2d_state_api`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/storage/src/lib.rs crates/media/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/live2d_state_api.rs
git commit -m "feat: add rust-owned live2d runtime state"
```

### Task 2: Overlay Runtime Stream

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/orchestrator/src/runtime_bus.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/overlay_ws.rs`

**Step 1: Write the failing test**

Add a websocket test that subscribes to a new overlay/runtime stream, triggers subtitle and emotion updates, and expects those events to arrive in order.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test overlay_ws`
Expected: FAIL because the overlay runtime websocket does not exist.

**Step 3: Write minimal implementation**

- Add overlay event types to `crates/api-types/src/lib.rs`.
- Publish subtitle/emotion/config updates into the runtime bus.
- Expose `GET /ws/overlay` from `apps/daemon/src/lib.rs`.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test overlay_ws`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/orchestrator/src/runtime_bus.rs apps/daemon/src/lib.rs apps/daemon/tests/overlay_ws.rs
git commit -m "feat: add overlay runtime stream"
```

### Task 3: Danmaku Gateway Skeleton

**Files:**
- Create: `crates/gateway/Cargo.toml`
- Create: `crates/gateway/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/danmaku_gateway.rs`

**Step 1: Write the failing test**

Add a test that injects a danmaku message through a Rust gateway API and expects:
- runtime event emission
- message persistence into the target session
- live2d subtitle update trigger

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_gateway`
Expected: FAIL because the gateway module and injection API do not exist.

**Step 3: Write minimal implementation**

- Add a new `crates/gateway` crate for danmaku/runtime ingress.
- Add a mock-safe injection endpoint such as `POST /api/gateway/danmaku`.
- Route the injected message into orchestrator + live2d subtitle update + runtime event feed.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_gateway`
Expected: PASS

**Step 5: Commit**

```bash
git add Cargo.toml crates/gateway apps/daemon/src/lib.rs apps/daemon/tests/danmaku_gateway.rs
git commit -m "feat: add rust danmaku gateway skeleton"
```

### Task 4: Web Operator Cutover

**Files:**
- Modify: `apps/web/src/lib.ts`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/pages/OverlaysPage.tsx`
- Test: `apps/web/src/generated/api.ts` regeneration + production build

**Step 1: Write the failing test**

Use the build as the contract: reference new live2d and gateway client methods before implementing them.

**Step 2: Run test to verify it fails**

Run: `npm run build --prefix apps/web`
Expected: FAIL on missing live2d/gateway client methods or types.

**Step 3: Write minimal implementation**

- Regenerate shared types from Rust.
- Add client methods for live2d state, overlay websocket, and danmaku injection.
- Extend the runtime page to show:
  - live2d state
  - subtitle/emotion controls
  - danmaku injection/test controls
- Make overlays page reflect the new Rust-owned overlay state flow.

**Step 4: Run test to verify it passes**

Run: `cargo run -p api-types --bin export_web`
Run: `npm run build --prefix apps/web`
Expected: both PASS

**Step 5: Commit**

```bash
git add apps/web/src apps/web/package.json apps/web/tsconfig*.json
git commit -m "feat: cut over web operator controls to rust runtime"
```

### Task 5: Legacy Manager Retirement Prep

**Files:**
- Modify: `docs/UNIFIED_RUST_RUNTIME.md`
- Modify: `docs/CUTOVER_CHECKLIST.md`
- Create: `docs/LEGACY_RETIREMENT_MAP.md`
- Modify: `start-unified.bat`

**Step 1: Write the failing test**

Treat validation as the contract: update the retirement map first, then run the bootstrap path and identify any remaining dependency on manager/live2d/danmaku startup.

**Step 2: Run test to verify it fails**

Run: `cmd /c "set MEMORY_SUITE_SKIP_SERVE=1&& start-unified.bat"`
Expected: one or more missing references around live2d/gateway/runtime operator assumptions.

**Step 3: Write minimal implementation**

- Document which old endpoints are now replaced and which are still pending.
- Update bootstrap docs and scripts so operators are pointed at the Rust runtime first.
- Add a retirement map describing what remains in `manager`, `memory-danmaku`, and `memory-live2d`.

**Step 4: Run test to verify it passes**

Run: `cargo test -p api-types -p app-config -p storage -p orchestrator -p jobs -p media -p daemon`
Run: `cargo run -p api-types --bin export_web`
Run: `npm run build --prefix apps/web`
Run: `cmd /c "set MEMORY_SUITE_SKIP_SERVE=1&& start-unified.bat"`
Expected: all PASS

**Step 5: Commit**

```bash
git add docs/UNIFIED_RUST_RUNTIME.md docs/CUTOVER_CHECKLIST.md docs/LEGACY_RETIREMENT_MAP.md start-unified.bat
git commit -m "docs: map remaining legacy retirement work"
```
