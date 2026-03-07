# Bilibili Bootstrap Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Bilibili room bootstrap and upstream danmaku target resolution into the Rust runtime so the old helper no longer owns room init and `getDanmuInfo` orchestration.

**Architecture:** Keep the websocket protocol helper temporary, but make Rust fetch room init, resolve the real room id, query danmaku bootstrap metadata, persist the resolved upstream targets, and expose the result through APIs and the runtime console. Connect/disconnect should then consume that Rust-owned bootstrap state instead of treating upstream details as opaque.

**Tech Stack:** Rust (`axum`, `tokio`, `serde`, `reqwest`, `sqlx`), TypeScript/React/Vite, axum integration tests with local mock HTTP servers.

---

### Task 1: Rust Room Bootstrap Resolver API

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Modify: `crates/gateway/Cargo.toml`
- Modify: `crates/gateway/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/danmaku_bootstrap_api.rs`

**Step 1: Write the failing test**

Add an integration test that:
- stores danmaku source config through Rust
- mocks `room_init` and `getDanmuInfo`
- calls `POST /api/danmaku/bootstrap`
- expects:
  - resolved room id
  - live status
  - token readiness
  - upstream hosts
  - persisted `current_upstream_host`

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_bootstrap_api`
Expected: FAIL because Rust bootstrap resolution does not exist.

**Step 3: Write minimal implementation**

- Add bootstrap record types to `crates/api-types/src/lib.rs`.
- Add SQLite persistence for the latest bootstrap snapshot.
- Add a small Rust HTTP client in `crates/gateway/src/lib.rs` for:
  - `room_init`
  - `getDanmuInfo`
- Add `POST /api/danmaku/bootstrap` and persist the resolved upstream host into connection state.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_bootstrap_api`
Expected: PASS

**Step 5: Commit**

```bash
git add Cargo.toml crates/api-types/src/lib.rs crates/storage/src/lib.rs crates/gateway/Cargo.toml crates/gateway/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/danmaku_bootstrap_api.rs
git commit -m "feat: add rust bilibili bootstrap resolver"
```

### Task 2: Connect Path Consumes Rust Bootstrap State

**Files:**
- Modify: `crates/gateway/src/lib.rs`
- Modify: `apps/daemon/tests/danmaku_protocol_adapter.rs`

**Step 1: Write the failing test**

Extend the protocol adapter test so `connect` first uses a Rust bootstrap snapshot and writes the selected upstream host into connection state detail.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test danmaku_protocol_adapter`
Expected: FAIL because connect does not consult Rust bootstrap state.

**Step 3: Write minimal implementation**

- Make `connect` use the latest bootstrap snapshot, triggering bootstrap on demand if missing.
- Persist chosen upstream host in connection state.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test danmaku_protocol_adapter`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/gateway/src/lib.rs apps/daemon/tests/danmaku_protocol_adapter.rs
git commit -m "feat: route danmaku connect through rust bootstrap state"
```

### Task 3: Web Runtime Bootstrap Visibility

**Files:**
- Modify: `apps/web/src/lib.ts`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/generated/api.ts`

**Step 1: Write the failing test**

Use the production build as the contract by referencing the new bootstrap client method and state rendering.

**Step 2: Run test to verify it fails**

Run: `npm run build --prefix apps/web`
Expected: FAIL on missing bootstrap methods or generated types.

**Step 3: Write minimal implementation**

- Regenerate shared types.
- Add bootstrap trigger/readback to the runtime page.
- Show resolved room id, live status, token readiness, and selected upstream host.

**Step 4: Run test to verify it passes**

Run: `cargo run -p api-types --bin export_web`
Run: `npm run build --prefix apps/web`
Expected: both PASS

**Step 5: Commit**

```bash
git add apps/web/src apps/web/package.json
git commit -m "feat: expose bilibili bootstrap state in runtime console"
```
