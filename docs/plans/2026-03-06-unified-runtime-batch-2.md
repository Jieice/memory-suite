# Unified Runtime Batch 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current Rust runtime stubs with real supervised adapters, observable runtime state, and the first cut of a usable replacement for the legacy manager flow.

**Architecture:** Keep the single Rust daemon as the only long-lived service. Add supervised Python-backed adapters for TTS/train/eval, promote WebSocket eventing from a chat-only stream into a runtime bus, and make the web shell read and drive the new runtime instead of relying on legacy pages.

**Tech Stack:** Rust (`axum`, `tokio`, `sqlx`, `serde`), TypeScript/React/Vite, Python subprocess adapters for model and training tooling.

---

### Task 1: Python Adapter Supervisor

**Files:**
- Create: `crates/jobs/src/python_adapter.rs`
- Modify: `crates/jobs/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/adapter_api.rs`

**Step 1: Write the failing test**

Add a test that boots `AppState`, calls a new `POST /api/runtime/adapters/tts/start`, then `GET /api/runtime/adapters`, and expects a persisted adapter entry with `status = "running"` and the configured Python executable path.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test adapter_api`
Expected: FAIL with 404 or unresolved adapter state types.

**Step 3: Write minimal implementation**

- Add `AdapterRecord`, `AdapterStatus`, and `AdapterStartRequest` to `crates/api-types/src/lib.rs`.
- Add `adapter_runs` table and CRUD helpers to `crates/storage/src/lib.rs`.
- Implement a `PythonAdapterSupervisor` in `crates/jobs/src/python_adapter.rs` that starts subprocesses with `tokio::process::Command`, captures PID/start time, and persists state.
- Expose `GET /api/runtime/adapters` and `POST /api/runtime/adapters/{adapter_id}/start` from `apps/daemon/src/lib.rs`.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test adapter_api`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/jobs/src/python_adapter.rs crates/jobs/src/lib.rs crates/storage/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/adapter_api.rs
git commit -m "feat: add supervised python adapters"
```

### Task 2: Runtime Event Bus

**Files:**
- Create: `crates/orchestrator/src/runtime_bus.rs`
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/runtime_bus.rs`

**Step 1: Write the failing test**

Add a test that triggers chat creation, adapter start, and job creation, then subscribes to `GET /ws/runtime` and expects three event kinds: `message_created`, `adapter_started`, `job_queued`.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test runtime_bus`
Expected: FAIL because `/ws/runtime` and runtime events do not exist.

**Step 3: Write minimal implementation**

- Add `RuntimeEvent` and `RuntimeEventKind` to `crates/api-types/src/lib.rs`.
- Add a broadcast-based runtime bus in `crates/orchestrator/src/runtime_bus.rs`.
- Publish runtime events from chat, job, and adapter paths.
- Add `GET /ws/runtime` to `apps/daemon/src/lib.rs`.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test runtime_bus`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/api-types/src/lib.rs crates/orchestrator/src/runtime_bus.rs crates/orchestrator/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/runtime_bus.rs
git commit -m "feat: add runtime event bus"
```

### Task 3: Real TTS Job Path

**Files:**
- Modify: `crates/media/src/lib.rs`
- Modify: `crates/jobs/src/python_adapter.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/tts_pipeline.rs`

**Step 1: Write the failing test**

Add a test that posts to `POST /api/tts/speak`, expects a queued TTS request, and then verifies the runtime state marks it as `dispatching` to the configured Python TTS adapter.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test tts_pipeline`
Expected: FAIL because TTS currently only writes a queued record.

**Step 3: Write minimal implementation**

- Connect `crates/media/src/lib.rs` to the adapter supervisor instead of only writing `tts_requests`.
- Add adapter selection rules for `edge_tts` and `sovits`.
- Persist adapter dispatch metadata in SQLite.
- Keep mock mode as fallback when Python tooling is unavailable.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test tts_pipeline`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/media/src/lib.rs crates/jobs/src/python_adapter.rs apps/daemon/src/lib.rs apps/daemon/tests/tts_pipeline.rs
git commit -m "feat: route tts through supervised adapters"
```

### Task 4: Web Runtime Console

**Files:**
- Modify: `apps/web/src/pages/DashboardPage.tsx`
- Modify: `apps/web/src/pages/JobsPage.tsx`
- Modify: `apps/web/src/pages/ToolsPage.tsx`
- Create: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/lib.ts`
- Test: `apps/web/src/generated/api.ts` regeneration + production build

**Step 1: Write the failing test**

Use the build as the contract: add imports and UI calls for runtime adapters/events before implementing the API client updates.

**Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL on missing runtime adapter/event types or unresolved client methods.

**Step 3: Write minimal implementation**

- Regenerate shared types from Rust.
- Add API client methods for runtime adapters and runtime WebSocket.
- Add a runtime page showing:
  - adapter list
  - latest runtime events
  - import summary
  - quick start buttons for TTS/train/eval adapters
- Make dashboard and jobs pages refresh from runtime APIs instead of local placeholder flows.

**Step 4: Run test to verify it passes**

Run: `cargo run -p api-types --bin export_web`
Run: `npm run build`
Expected: both PASS

**Step 5: Commit**

```bash
git add apps/web/src apps/web/package.json apps/web/tsconfig*.json
git commit -m "feat: add unified runtime console"
```

### Task 5: Training and Eval Job Execution

**Files:**
- Modify: `crates/jobs/src/lib.rs`
- Modify: `crates/jobs/src/python_adapter.rs`
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/tests/job_execution.rs`

**Step 1: Write the failing test**

Add a test that posts to `POST /api/jobs/train` and `POST /api/jobs/eval`, then verifies both move from `queued` to `running` with adapter metadata attached.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test job_execution`
Expected: FAIL because jobs currently persist but do not execute.

**Step 3: Write minimal implementation**

- Extend job records with execution fields: adapter id, started_at, finished_at, last_error.
- Dispatch train/eval jobs through the supervisor.
- Persist terminal states `completed` and `failed`.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test job_execution`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/jobs/src/lib.rs crates/jobs/src/python_adapter.rs crates/storage/src/lib.rs apps/daemon/src/lib.rs apps/daemon/tests/job_execution.rs
git commit -m "feat: execute training and eval jobs through adapters"
```

### Task 6: Cutover Prep

**Files:**
- Modify: `start-unified.bat`
- Modify: `package.json`
- Modify: `docs/UNIFIED_RUST_RUNTIME.md`
- Create: `docs/CUTOVER_CHECKLIST.md`

**Step 1: Write the failing test**

Treat verification as the contract: document the cutover checklist first, then run the end-to-end commands and record any missing steps.

**Step 2: Run test to verify it fails**

Run: `start-unified.bat`
Expected: one or more gaps around adapter startup, runtime config, or web availability.

**Step 3: Write minimal implementation**

- Update `start-unified.bat` to generate types, build web, ensure runtime directories exist, and launch the daemon with the default config.
- Add cutover checklist for replacing legacy manager usage with the unified runtime.
- Update root scripts and docs to point operators at the new path first.

**Step 4: Run test to verify it passes**

Run: `cargo test -p api-types -p app-config -p storage -p orchestrator -p daemon`
Run: `cargo run -p api-types --bin export_web`
Run: `npm run build --prefix apps/web`
Run: `cargo run -p daemon -- import-legacy --root .`
Expected: all PASS

**Step 5: Commit**

```bash
git add start-unified.bat package.json docs/UNIFIED_RUST_RUNTIME.md docs/CUTOVER_CHECKLIST.md
git commit -m "docs: prepare unified runtime cutover"
```
