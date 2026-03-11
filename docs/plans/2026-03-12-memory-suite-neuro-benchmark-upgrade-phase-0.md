# Memory Suite Neuro Benchmark Upgrade Phase 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first production slice that turns Memory Suite from a generic livestream runtime assistant into a directed live character runtime with a single persona canon, saner fallback behavior, and creator-facing persona controls.

**Architecture:** Keep the current `apps/daemon -> crates/orchestrator -> crates/media -> apps/web` spine intact. Add a repo-owned persona canon source, load it into orchestrator prompt assembly, expose lightweight persona runtime config through daemon APIs, and wire the creator/runtime web surfaces to that config. Do not redesign overlays or add vision/game autonomy in this phase.

**Tech Stack:** Rust, Tokio, Axum, sqlx/sqlite, serde, ts-rs, React, TypeScript, SQLite, existing DeepSeek-compatible chat API.

---

## Existing code and constraints to understand before touching anything

- `crates/orchestrator/src/lib.rs` currently builds a prompt around a `runtime assistant` identity and uses a very short remote fallback timeout path.
- `config/app.toml` already injects a Chinese runtime prompt, but that prompt still frames the system as an assistant instead of a role.
- `crates/media/src/lib.rs` already finalizes chat replies into subtitle, emotion, TTS, viseme, and motion plans. Reuse that path.
- `apps/web/src/pages/CreatorChatPage.tsx` is the correct place to become a lightweight director lane. Do not create a new page for persona control.
- `apps/web/src/pages/RuntimePage.tsx` is already the operational surface and should show persona/fallback state once the backend exposes it.
- `data/memories/global/PERSONALITY.md` exists, but the current runtime does not show a stable consumption path for it. This phase should create an explicit canonical source instead of relying on implicit folklore.
- Keep this phase deterministic. No speculative autonomous multi-agent planner.

---

### Task 1: Create a canonical persona source file and parser contract

**Files:**
- Create: `data/memories/global/PERSONA_CANON.md`
- Create: `crates/orchestrator/src/persona.rs`
- Test: `crates/orchestrator/src/persona.rs`

**Step 1: Write the failing test**

Add a focused Rust unit test proving the persona module can parse a markdown canon file with the required sections:

- `## Core Identity`
- `## Voice`
- `## Attitude`
- `## Relationship Rules`
- `## Short Reactions`
- `## Idle Presence`
- `## Forbidden Drift`

Example test:

```rust
#[test]
fn parses_persona_canon_sections() {
    let parsed = PersonaCanon::parse(r#"
# Persona Canon

## Core Identity
- sharp

## Voice
- concise

## Attitude
- teasing

## Relationship Rules
- creator > trusted

## Short Reactions
- "hmm"

## Idle Presence
- "still here"

## Forbidden Drift
- no generic assistant tone
"#).unwrap();

    assert!(parsed.core_identity.contains("sharp"));
    assert!(parsed.forbidden_drift.contains("generic assistant"));
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p orchestrator parses_persona_canon_sections -- --exact --test-threads=1
```

Expected: FAIL because the persona parser does not exist yet.

**Step 3: Write minimal implementation**

- Create `data/memories/global/PERSONA_CANON.md` with the required headings and first-pass Chinese content.
- Add `PersonaCanon` and a small parser in `crates/orchestrator/src/persona.rs`.
- Keep the parser strict enough to fail on missing required sections.

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add data/memories/global/PERSONA_CANON.md crates/orchestrator/src/persona.rs
git commit -m "feat: add persona canon source and parser"
```

---

### Task 2: Add shared API types for persona runtime config and fallback stats

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Test: `crates/api-types/src/lib.rs`

**Step 1: Write the failing test**

Add a unit test proving the new shared records serialize in the shape the web UI needs:

- `PersonaRuntimeConfigRecord`
- `PersonaRuntimeConfigUpdateRequest`
- `PersonaRuntimeStateRecord`
- `FallbackStatsRecord`

Example test:

```rust
#[test]
fn persona_runtime_state_serializes_for_web() {
    let payload = PersonaRuntimeStateRecord {
        mode: "stream".into(),
        tone_profile: "sharp-playful".into(),
        warmth: 0.45,
        sarcasm: 0.65,
        autonomy: 0.20,
        fallback: FallbackStatsRecord {
            remote_successes: 10,
            remote_timeouts: 3,
            builtin_fallbacks: 5,
            last_path: "remote".into(),
        },
    };

    let value = serde_json::to_value(payload).unwrap();
    assert_eq!(value["tone_profile"], "sharp-playful");
    assert_eq!(value["fallback"]["last_path"], "remote");
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p api-types persona_runtime_state_serializes_for_web -- --exact --test-threads=1
```

Expected: FAIL because the shared API types do not exist yet.

**Step 3: Write minimal implementation**

- Add the four records above to `crates/api-types/src/lib.rs`.
- Keep the shape flat and web-safe.
- Regenerate TypeScript types after the Rust test passes.

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Run nearby API type verification**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p api-types --lib -- --test-threads=1
cargo run --manifest-path "D:/ai/memory-suite/Cargo.toml" -p api-types --bin export_web
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/api-types/src/lib.rs apps/web/src/generated/api.ts
git commit -m "feat: add persona runtime api types"
```

---

### Task 3: Persist persona runtime config and fallback counters in storage

**Files:**
- Modify: `crates/storage/src/lib.rs`
- Test: `crates/storage/src/lib.rs`

**Step 1: Write the failing test**

Add a storage test proving the runtime can persist:

- one active persona config row
- one fallback stats row

Example test:

```rust
#[tokio::test]
async fn stores_and_reads_persona_runtime_state() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("runtime.db")).await.unwrap();

    storage.upsert_persona_runtime_config(/* stream, sharp-playful */).await.unwrap();
    storage.bump_fallback_stat("builtin").await.unwrap();

    let state = storage.get_persona_runtime_state().await.unwrap();
    assert_eq!(state.tone_profile, "sharp-playful");
    assert_eq!(state.fallback.builtin_fallbacks, 1);
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p storage stores_and_reads_persona_runtime_state -- --exact --test-threads=1
```

Expected: FAIL because the storage tables and methods do not exist yet.

**Step 3: Write minimal implementation**

- Add tables for persona runtime config and fallback stats.
- Add `upsert_persona_runtime_config`, `get_persona_runtime_state`, and `bump_fallback_stat`.
- Keep one-row semantics simple.

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Run nearby storage verification**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p storage --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/storage/src/lib.rs
git commit -m "feat: persist persona runtime state"
```

---

### Task 4: Refactor orchestrator prompt assembly to consume persona canon

**Files:**
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `crates/orchestrator/src/persona.rs`
- Test: `crates/orchestrator/src/lib.rs`

**Step 1: Write the failing test**

Add a test proving the rendered system prompt now includes:

- persona canon identity
- relationship rules
- forbidden drift constraints
- current tone profile

Example test:

```rust
#[tokio::test]
async fn render_system_prompt_includes_persona_canon() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("orch.db")).await.unwrap();
    storage.upsert_persona_runtime_config(/* mode=stream tone=sharp-playful */).await.unwrap();

    let orchestrator = Orchestrator::new(storage, RuntimeBus::new());
    let prompt = orchestrator.debug_render_prompt("creator", "hello").await.unwrap();

    assert!(prompt.contains("Persona core"));
    assert!(prompt.contains("Forbidden drift"));
    assert!(prompt.contains("sharp-playful"));
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p orchestrator render_system_prompt_includes_persona_canon -- --exact --test-threads=1
```

Expected: FAIL because the current prompt builder does not load persona canon or runtime config.

**Step 3: Write minimal implementation**

- Load and cache `PERSONA_CANON.md`.
- Add a debug prompt rendering helper for tests.
- Replace the current assistant-centric prompt assembly with persona-centric sections while keeping concise output rules.
- Preserve existing message history and memory snippet injection.

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Run nearby orchestrator verification**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p orchestrator --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/orchestrator/src/lib.rs crates/orchestrator/src/persona.rs
git commit -m "feat: build orchestrator prompt from persona canon"
```

---

### Task 5: Replace the hardcoded remote fallback behavior with configurable budgets and stats

**Files:**
- Modify: `crates/app-config/src/lib.rs`
- Modify: `crates/app-config/tests/config_loading.rs`
- Modify: `config/app.toml`
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Test: `crates/orchestrator/src/lib.rs`

**Step 1: Write the failing test**

Add an orchestrator test proving:

- a configured fallback timeout is honored
- timeout increments fallback stats
- last path becomes `builtin_timeout`

Example test:

```rust
#[tokio::test]
async fn remote_timeout_updates_builtin_fallback_stats() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("orch.db")).await.unwrap();
    let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());

    // configure a tiny remote timeout and point to a delayed test server
    let _ = orchestrator.handle_chat(ChatRequest {
        session_id: Some("s".into()),
        user_id: Some("creator".into()),
        text: "hello".into(),
    }).await.unwrap();

    let state = storage.get_persona_runtime_state().await.unwrap();
    assert_eq!(state.fallback.last_path, "builtin_timeout");
}
```

**Step 2: Run test to verify it fails**

Run the exact test you added, for example:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p orchestrator remote_timeout_updates_builtin_fallback_stats -- --exact --test-threads=1
```

Expected: FAIL because fallback stats and configurable budget handling do not exist yet.

**Step 3: Write minimal implementation**

- Add explicit app config fields for chat fallback budgets.
- Thread them into orchestrator initialization.
- Count `remote_success`, `remote_error`, `remote_timeout`, and `builtin_fallback`.
- Persist the last path and counters in storage.
- Keep the initial set small and deterministic.

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Run nearby verification**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p app-config --lib -- --test-threads=1
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p orchestrator --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/app-config/src/lib.rs crates/app-config/tests/config_loading.rs config/app.toml crates/orchestrator/src/lib.rs crates/storage/src/lib.rs
git commit -m "feat: add configurable fallback budgets and stats"
```

---

### Task 6: Expose persona runtime APIs from the daemon

**Files:**
- Modify: `apps/daemon/src/lib.rs`
- Test: `apps/daemon/src/lib.rs` or `apps/daemon/tests/...`

**Step 1: Write the failing test**

Add daemon tests for:

- `GET /api/persona/state`
- `POST /api/persona/config`

Example test:

```rust
#[tokio::test]
async fn persona_config_round_trips_through_http_api() -> Result<()> {
    let state = test_app_state().await?;
    let app = build_router(state);

    let response = app.oneshot(post_json(
        "/api/persona/config",
        serde_json::json!({
            "mode": "stream",
            "tone_profile": "sharp-playful",
            "warmth": 0.45,
            "sarcasm": 0.65,
            "autonomy": 0.20
        }),
    )?).await?;

    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}
```

**Step 2: Run test to verify it fails**

Run the exact test you added.

Expected: FAIL because the routes do not exist yet.

**Step 3: Write minimal implementation**

- Add the two routes to `build_router`.
- Fetch and update persona runtime state through storage.
- Return the shared API records from `crates/api-types`.

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Run nearby daemon verification**

Run:

```bash
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p daemon -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/daemon/src/lib.rs
git commit -m "feat: expose persona runtime apis"
```

---

### Task 7: Add runtime and creator web controls for persona state

**Files:**
- Modify: `apps/web/src/lib.ts`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/pages/CreatorChatPage.tsx`
- Test: `apps/web`

**Step 1: Write the failing UI expectation**

Use build-first failure:

- import the new persona state/config types
- reference new client helpers before implementing them
- add a persona card on `RuntimePage.tsx`
- add quick persona mode chips on `CreatorChatPage.tsx`

**Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix "D:/ai/memory-suite/apps/web" run build
```

Expected: FAIL because the web client helpers and generated types are not wired yet.

**Step 3: Write minimal implementation**

- Add `fetchPersonaState` and `updatePersonaConfig` helpers in `apps/web/src/lib.ts`.
- On `RuntimePage.tsx`, render:
  - mode
  - tone profile
  - warmth
  - sarcasm
  - autonomy
  - fallback counters
- On `CreatorChatPage.tsx`, add mode/tone quick actions and show the returned persona state in a JSON block.
- Reuse existing card styles.

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Run web verification**

Run:

```bash
cargo run --manifest-path "D:/ai/memory-suite/Cargo.toml" -p api-types --bin export_web
npm --prefix "D:/ai/memory-suite/apps/web" run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/lib.ts apps/web/src/pages/RuntimePage.tsx apps/web/src/pages/CreatorChatPage.tsx apps/web/src/generated/api.ts
git commit -m "feat: add persona controls to web surfaces"
```

---

### Task 8: Final verification for the Phase 0 slice

**Files:**
- No new files

**Step 1: Run Rust verification**

Run:

```bash
cargo run --manifest-path "D:/ai/memory-suite/Cargo.toml" -p api-types --bin export_web
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p api-types --lib -- --test-threads=1
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p app-config --lib -- --test-threads=1
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p storage --lib -- --test-threads=1
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p orchestrator --lib -- --test-threads=1
cargo test --manifest-path "D:/ai/memory-suite/Cargo.toml" -p daemon -- --test-threads=1
```

Expected: PASS.

**Step 2: Run web verification**

Run:

```bash
npm --prefix "D:/ai/memory-suite/apps/web" run build
```

Expected: PASS.

**Step 3: Run manual runtime verification**

1. Start the runtime with `start-unified.bat`.
2. Open `http://127.0.0.1:8080/runtime`.
3. Confirm the persona state card renders.
4. Open `http://127.0.0.1:8080/creator-chat`.
5. Switch between at least two persona modes.
6. Send one backstage line and one normal chat line.
7. Confirm fallback counters change only when the remote path fails or times out.

**Step 4: Commit**

```bash
git add .
git commit -m "chore: verify phase 0 persona runtime slice"
```

Note: if unrelated worktree changes are present, replace `git add .` with explicit file paths for only the files changed in this phase.

---

## Notes for the implementing engineer

- Do not add short reactions or idle chatter in this phase. That belongs to Phase 1.
- Do not redesign the overlay yet.
- Do not overbuild a general config system; a single canonical persona source is the goal.
- Keep persona config numeric fields bounded and human-editable.
- Keep stats simple and observable before trying to optimize them.
