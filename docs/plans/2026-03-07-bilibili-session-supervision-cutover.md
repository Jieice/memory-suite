# Bilibili Session Supervision Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Bilibili websocket session supervision, heartbeat response tracking, and scheduled reconnect execution under the Rust runtime so the legacy helper becomes a thin protocol worker instead of a state machine.

**Architecture:** Keep the temporary protocol helper for raw Bilibili websocket traffic, but make Rust own the session lifecycle record, heartbeat acknowledgements, disconnect/error reporting, reconnect scheduling, and reconnect execution. The helper should only report facts upward; it should not decide retry state or backoff.

**Tech Stack:** Rust (`axum`, `tokio`, `serde`, `sqlx`), TypeScript/React/Vite, daemon integration tests with Tokio timers and mock helper callbacks.

---

### Task 1: Rust Session Callback APIs

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Modify: `crates/gateway/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/danmaku_session_callbacks_api.rs`

**Step 1: Write the failing test**

Add an integration test that:
- calls `POST /api/danmaku/session/open`
- calls `POST /api/danmaku/session/error`
- calls `POST /api/danmaku/session/close`
- expects Rust to persist session state, upstream host, session id, close reason, and emit the correct connection posture

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_session_callbacks_api`
Expected: FAIL because Rust does not expose session callback APIs.

**Step 3: Write minimal implementation**

- Add session callback request types and session state fields to `crates/api-types/src/lib.rs`.
- Extend danmaku connection/session persistence in `crates/storage/src/lib.rs`.
- Add Rust session callback handlers in `crates/gateway/src/lib.rs`.
- Expose:
  - `POST /api/danmaku/session/open`
  - `POST /api/danmaku/session/error`
  - `POST /api/danmaku/session/close`

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_session_callbacks_api`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/storage/src/lib.rs crates/gateway/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/danmaku_session_callbacks_api.rs
git commit -m "feat: add danmaku session callback apis"
```

### Task 2: Rust-Owned Reconnect Executor

**Files:**
- Modify: `crates/gateway/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/danmaku_reconnect_worker.rs`

**Step 1: Write the failing test**

Add a test that:
- reports a disconnect
- waits past `next_retry_at`
- expects Rust to trigger a reconnect attempt automatically and update connection state

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_reconnect_worker`
Expected: FAIL because no reconnect worker consumes `next_retry_at`.

**Step 3: Write minimal implementation**

- Add a lightweight reconnect worker under Rust supervision.
- Poll or schedule against persisted `next_retry_at`.
- Reuse existing `connect` path so retry behavior stays centralized.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_reconnect_worker`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/gateway/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/danmaku_reconnect_worker.rs
git commit -m "feat: execute danmaku reconnects from rust"
```

### Task 3: Runtime Console And Retirement Map For Session Supervision

**Files:**
- Modify: `apps/web/src/lib.ts`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `docs/LEGACY_RETIREMENT_MAP.md`
- Modify: `docs/UNIFIED_RUST_RUNTIME.md`
- Modify: `docs/CUTOVER_CHECKLIST.md`

**Step 1: Write the failing test**

Use the production build as the contract by referencing session callback/reconnect visibility in the runtime console before the client methods exist.

**Step 2: Run test to verify it fails**

Run: `npm run build --prefix apps/web`
Expected: FAIL on missing session supervision client methods or types.

**Step 3: Write minimal implementation**

- Regenerate shared types.
- Show session id, upstream host, close reason, retry deadline, and retry state in the runtime page.
- Update retirement docs so the old helper is explicitly “raw websocket worker only”.

**Step 4: Run test to verify it passes**

Run: `cargo run -p api-types --bin export_web`
Run: `npm run build --prefix apps/web`
Expected: both PASS

**Step 5: Commit**

```bash
git add apps/web/src docs/LEGACY_RETIREMENT_MAP.md docs/UNIFIED_RUST_RUNTIME.md docs/CUTOVER_CHECKLIST.md
git commit -m "feat: expose danmaku session supervision state"
```
