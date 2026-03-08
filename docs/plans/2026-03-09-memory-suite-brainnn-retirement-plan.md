# Memory Suite BrainNN Retirement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove BrainNN from the online runtime path and consolidate `memory-suite` into a Rust + React main architecture with Python reduced to optional tooling only.

**Architecture:** Keep the existing Rust daemon as the single online control plane and React as the only web surface. Migrate any still-required online behavior into Rust, demote Python to optional worker/tool use, then cut and delete BrainNN in staged, test-driven slices so the system stays stable.

**Tech Stack:** Rust, Axum, Tokio, SQLite/sqlx, React/TypeScript, optional Python worker scripts, existing daemon integration tests.

---

### Task 1: Inventory BrainNN runtime dependencies

**Files:**
- Modify: `docs/plans/2026-03-09-memory-suite-refactor-design.md`
- Create: `docs/plans/2026-03-09-memory-suite-brainnn-retirement-inventory.md`
- Check: `brainnn/server.py`
- Check: `apps/daemon/src/lib.rs`
- Check: `apps/daemon/src/main.rs`
- Check: `apps/web/src/lib.ts`
- Check: `scripts/run-intelligence-eval.mjs`

**Step 1: Write the inventory document stub**

```md
# BrainNN Retirement Inventory

## Direct runtime dependencies
- [ ] daemon startup
- [ ] chat path
- [ ] web client calls
- [ ] scripts and eval tools
- [ ] config/env references
- [ ] tests/docs

## Classification
- Preserve in Rust:
- Optional tooling only:
- Delete:
```

**Step 2: Search for BrainNN references and online dependency assumptions**

Run: `rg -n "brainnn|AGENT_CORE_URL|MEMORY_SYSTEM_V2_URL|REFLECTION_ENGINE_URL|NEURO_SYMBOLIC_BRIDGE_URL|http://127.0.0.1:4009|process_input" "/d/AI/memory-suite"`
Expected: matches across `brainnn/`, scripts, docs, configs, or tests that reveal remaining dependency edges.

**Step 3: Record each dependency in the inventory doc**

Document exact file paths and classify each item as:
- must move into Rust
- optional tool only
- delete entirely

**Step 4: Verify the inventory covers startup, runtime, scripts, config, and docs**

Run: `rg -n "brainnn|4009|4010|4011|4012" "/d/AI/memory-suite/docs" "/d/AI/memory-suite/apps" "/d/AI/memory-suite/scripts"`
Expected: either no additional categories are found, or the inventory doc is updated.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-09-memory-suite-brainnn-retirement-inventory.md docs/plans/2026-03-09-memory-suite-refactor-design.md
git commit -m "docs: inventory BrainNN retirement dependencies"
```

### Task 2: Lock chat and runtime tests around the Rust-only main path

**Files:**
- Modify: `apps/daemon/tests/http_api.rs:10-33`
- Modify: `apps/daemon/tests/job_execution.rs:12-88`
- Modify: `apps/daemon/tests/tts_pipeline.rs:15-220`
- Create: `apps/daemon/tests/brainnn_absence_runtime.rs`

**Step 1: Write a failing integration test proving BrainNN is not required for the core runtime**

```rust
#[tokio::test]
async fn core_runtime_works_without_brainnn() -> anyhow::Result<()> {
    let state = daemon::bootstrap_state().await?;
    let app = daemon::build_router(state);

    let health = app
        .clone()
        .oneshot(axum::http::Request::builder().uri("/api/health").body(axum::body::Body::empty())?)
        .await?;
    assert_eq!(health.status(), axum::http::StatusCode::OK);
    Ok(())
}
```

**Step 2: Run the targeted test to confirm current behavior**

Run: `cargo test -p daemon core_runtime_works_without_brainnn -- --nocapture`
Expected: PASS if BrainNN is already not required, or FAIL with a concrete dependency that must be removed.

**Step 3: Add focused assertions to existing HTTP/job/TTS tests**

Add checks that:
- `/api/chat` responds through the Rust entrypoint
- jobs run through supervised adapters owned by Rust
- TTS tests do not require any BrainNN process or configuration

**Step 4: Run the daemon integration tests that defend the Rust-only path**

Run: `cargo test -p daemon --test http_api --test job_execution --test tts_pipeline --test brainnn_absence_runtime`
Expected: PASS with no BrainNN-related startup assumptions.

**Step 5: Commit**

```bash
git add apps/daemon/tests/http_api.rs apps/daemon/tests/job_execution.rs apps/daemon/tests/tts_pipeline.rs apps/daemon/tests/brainnn_absence_runtime.rs
git commit -m "test: lock runtime behavior to Rust-only main path"
```

### Task 3: Remove BrainNN assumptions from model and chat orchestration boundaries

**Files:**
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `apps/daemon/src/lib.rs`
- Modify: `crates/app-config/src/lib.rs`
- Test: `apps/daemon/tests/http_api.rs`

**Step 1: Write a failing test for the intended Rust-owned chat contract if one is missing**

```rust
#[tokio::test]
async fn chat_request_is_handled_without_external_brainnn_contract() -> anyhow::Result<()> {
    // bootstrap state and POST /api/chat with the current Rust payload shape
    // assert OK and confirm response body contains assistant text
}
```

**Step 2: Run the targeted chat test to observe the current boundary**

Run: `cargo test -p daemon chat_request_is_handled_without_external_brainnn_contract -- --nocapture`
Expected: PASS if the Rust contract is already self-contained, or FAIL with the exact dependency to remove.

**Step 3: Simplify orchestration/config code so BrainNN is not part of runtime assumptions**

Keep only:
- Rust-owned request intake
- history/context assembly
- model call boundary
- persistence and event publication

Do not add any new compatibility layer for BrainNN concepts.

**Step 4: Run the relevant daemon tests**

Run: `cargo test -p daemon --test http_api`
Expected: PASS with chat still working through Rust only.

**Step 5: Commit**

```bash
git add crates/orchestrator/src/lib.rs apps/daemon/src/lib.rs crates/app-config/src/lib.rs apps/daemon/tests/http_api.rs
git commit -m "refactor: remove BrainNN assumptions from chat orchestration"
```

### Task 4: Make unsupported adapters fail clearly instead of pretending to run

**Files:**
- Modify: `crates/jobs/src/python_adapter.rs`
- Test: `crates/jobs/src/lib.rs:144-238`
- Create: `apps/daemon/tests/unsupported_adapter_api.rs`

**Step 1: Write a failing test for unsupported adapter startup**

```rust
#[tokio::test]
async fn unsupported_adapter_returns_error_instead_of_placeholder_process() {
    // attempt to start an unknown adapter id
    // assert error mentions unsupported adapter
}
```

**Step 2: Run the targeted test to verify current placeholder behavior**

Run: `cargo test -p jobs unsupported_adapter_returns_error_instead_of_placeholder_process -- --nocapture`
Expected: FAIL because unknown adapters currently fall back to a sleep-based placeholder.

**Step 3: Implement the minimal change in `python_adapter.rs`**

Replace the unknown-adapter fallback path with an explicit unsupported-adapter error. Keep only clearly supported adapters wired to real scripts or intentionally configured worker args.

**Step 4: Run focused jobs and daemon tests**

Run: `cargo test -p jobs && cargo test -p daemon --test job_execution --test adapter_api`
Expected: PASS with supported adapters unchanged and unsupported ones failing clearly.

**Step 5: Commit**

```bash
git add crates/jobs/src/python_adapter.rs crates/jobs/src/lib.rs apps/daemon/tests/unsupported_adapter_api.rs
git commit -m "refactor: reject unsupported adapters explicitly"
```

### Task 5: Demote Python to optional tooling in config and runtime bootstrapping

**Files:**
- Modify: `apps/daemon/src/lib.rs`
- Modify: `crates/app-config/src/lib.rs`
- Modify: `docs/UNIFIED_RUST_RUNTIME.md`
- Test: `apps/daemon/tests/http_api.rs`
- Test: `apps/daemon/tests/job_execution.rs`

**Step 1: Write a failing test proving the daemon boots without optional Python worker usage**

```rust
#[tokio::test]
async fn daemon_boots_when_optional_python_capabilities_are_unused() -> anyhow::Result<()> {
    // use a config that does not rely on worker startup for the tested flow
    // assert health endpoint works
}
```

**Step 2: Run the targeted daemon boot test**

Run: `cargo test -p daemon daemon_boots_when_optional_python_capabilities_are_unused -- --nocapture`
Expected: FAIL only if bootstrap still assumes Python as a permanent runtime pillar.

**Step 3: Implement the minimum config/bootstrap changes**

Ensure Python-backed capabilities are optional. The daemon should start and serve core endpoints even when no Python worker is being used.

**Step 4: Run daemon tests for boot, chat, and jobs**

Run: `cargo test -p daemon --test http_api --test job_execution`
Expected: PASS with the daemon still serving core runtime flows.

**Step 5: Commit**

```bash
git add apps/daemon/src/lib.rs crates/app-config/src/lib.rs docs/UNIFIED_RUST_RUNTIME.md apps/daemon/tests/http_api.rs apps/daemon/tests/job_execution.rs
git commit -m "refactor: make Python runtime capabilities optional"
```

### Task 6: Align Node-side evaluation and tooling with the Rust-owned API contract

**Files:**
- Modify: `scripts/run-intelligence-eval.mjs`
- Modify: `package.json`
- Check: `apps/web/src/lib.ts`
- Test: `apps/daemon/tests/http_api.rs`

**Step 1: Write a failing smoke check for the evaluation payload builder**

```js
import assert from 'node:assert/strict';

assert.deepEqual(buildChatPayload({ sessionId: 's', userId: 'u', prompt: 'p' }), {
  session_id: 's',
  user_id: 'u',
  text: 'p'
});
```

**Step 2: Run the Node script test or smoke command**

Run: `node scripts/run-intelligence-eval.mjs --help`
Expected: Existing CLI still works; payload handling differences are visible in code and then fixed.

**Step 3: Implement the minimum contract alignment**

Make the evaluation script target the Rust API contract directly. Do not add compatibility wrappers for the old BrainNN payload shape.

**Step 4: Run a quick script smoke check and daemon HTTP test**

Run: `node scripts/run-intelligence-eval.mjs --help && cargo test -p daemon --test http_api`
Expected: PASS with the script still usable and the API contract consistent with Rust.

**Step 5: Commit**

```bash
git add scripts/run-intelligence-eval.mjs package.json
git commit -m "refactor: align eval tooling with Rust API contract"
```

### Task 7: Remove BrainNN from active startup, docs, and config surfaces

**Files:**
- Modify: `docs/README_V9.md`
- Modify: `docs/UNIFIED_RUST_RUNTIME.md`
- Modify: `docs/LEGACY_RETIREMENT_MAP.md`
- Modify: any startup/config docs discovered in Task 1

**Step 1: Write a failing docs checklist in the inventory file**

```md
- [ ] No document says BrainNN is required for the main runtime
- [ ] Default startup instructions mention Rust daemon + web only
- [ ] Python is described as optional tooling only
```

**Step 2: Run a repo search for BrainNN runtime claims**

Run: `rg -n "BrainNN|brainnn|Flask|4009|AGENT_CORE_URL" "/d/AI/memory-suite/docs"`
Expected: matches identify documentation that must be updated.

**Step 3: Update the docs and startup guidance**

Remove BrainNN from the default runtime story. Document Rust + React as the primary architecture and Python as optional tooling only.

**Step 4: Re-run the doc search**

Run: `rg -n "BrainNN|brainnn|Flask|4009|AGENT_CORE_URL" "/d/AI/memory-suite/docs"`
Expected: only historical or explicitly retired references remain.

**Step 5: Commit**

```bash
git add docs/README_V9.md docs/UNIFIED_RUST_RUNTIME.md docs/LEGACY_RETIREMENT_MAP.md docs/plans/2026-03-09-memory-suite-brainnn-retirement-inventory.md
git commit -m "docs: retire BrainNN from runtime guidance"
```

### Task 8: Prove the system runs without BrainNN and then delete it

**Files:**
- Delete: `brainnn/server.py`
- Delete: `brainnn/agent_core.py`
- Delete: `brainnn/memory_system_v2.py`
- Delete: `brainnn/reflection_engine.py`
- Delete: `brainnn/neuro_symbolic_bridge.py`
- Delete: `brainnn/nested_learning_upgrade.py`
- Delete: additional `brainnn/*` runtime files still present
- Test: `apps/daemon/tests/brainnn_absence_runtime.rs`
- Test: `apps/daemon/tests/http_api.rs`
- Test: `apps/daemon/tests/job_execution.rs`
- Test: `apps/daemon/tests/tts_pipeline.rs`

**Step 1: Run the full targeted verification suite before deletion**

Run: `cargo test -p daemon --test brainnn_absence_runtime --test http_api --test job_execution --test tts_pipeline`
Expected: PASS while BrainNN is already inactive.

**Step 2: Delete the BrainNN runtime files and remove any last references**

Do not leave dead config keys, imports, or launch paths behind.

**Step 3: Run the same targeted verification suite after deletion**

Run: `cargo test -p daemon --test brainnn_absence_runtime --test http_api --test job_execution --test tts_pipeline`
Expected: PASS with no BrainNN files present.

**Step 4: Run a repo-wide search for accidental leftovers**

Run: `rg -n "brainnn|AGENT_CORE_URL|MEMORY_SYSTEM_V2_URL|REFLECTION_ENGINE_URL|NEURO_SYMBOLIC_BRIDGE_URL" "/d/AI/memory-suite"`
Expected: either no matches or only historical notes explicitly kept on purpose.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove retired BrainNN runtime"
```

### Task 9: Harden the unified Rust + React system after deletion

**Files:**
- Modify: `apps/web/src/pages/JobsPage.tsx`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/pages/CreatorChatPage.tsx`
- Modify: `docs/UNIFIED_RUST_RUNTIME.md`
- Test: `apps/daemon/tests/http_api.rs`
- Test: `apps/daemon/tests/runtime_bus.rs`

**Step 1: Write a failing assertion or UI copy test for migration-era wording if practical**

```ts
expect(screen.queryByText(/new Rust-owned job lane/i)).toBeNull();
```

**Step 2: Run the targeted UI or grep check**

Run: `rg -n "new Rust-owned|migration|cutover|legacy lane" "/d/AI/memory-suite/apps/web/src"`
Expected: existing migration-era copy is found and then cleaned up.

**Step 3: Implement the minimum cleanup**

Remove migration-era wording and reflect the new reality: Rust + React is the system, not the transition target.

**Step 4: Run final verification**

Run: `cargo test -p daemon --test http_api --test runtime_bus`
Expected: PASS and docs/UI copy align with the new architecture.

**Step 5: Commit**

```bash
git add apps/web/src/pages/JobsPage.tsx apps/web/src/pages/RuntimePage.tsx apps/web/src/pages/CreatorChatPage.tsx docs/UNIFIED_RUST_RUNTIME.md
git commit -m "chore: harden unified runtime after BrainNN removal"
```
