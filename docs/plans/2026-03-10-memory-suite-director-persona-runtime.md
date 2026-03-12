# Memory Suite Director Persona Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a functionality-first event-driven director layer so Memory Suite can normalize chat and danmaku inputs, apply response policy, maintain lightweight persona/session/viewer state, and expose minimal operator controls for autonomous livestream behavior.

**Architecture:** Keep the existing `apps/daemon -> crates/orchestrator -> crates/media -> Live2D/TTS` spine intact. Add a thin decision layer inside `crates/orchestrator` that converts transport-specific inputs into normalized runtime events, evaluates them with explicit policy rules, builds richer prompt context from persona/session/viewer state, and only then reuses the existing chat generation and response finalization path. Persist the minimum state necessary in `crates/storage`, surface the new controls through `apps/daemon` HTTP routes, and expose them in the existing runtime and creator web pages before any visual redesign.

**Tech Stack:** Rust, Tokio, Axum, sqlx/sqlite, serde, ts-rs generated API bindings, React, TypeScript.

---

## Existing code and constraints to understand before touching anything

- `crates/orchestrator/src/lib.rs` currently only exposes `handle_chat(ChatRequest)` and directly appends user/assistant messages before calling the chat engine.
- `apps/daemon/src/lib.rs` already has the unified router, `AppState`, `/api/chat`, `/api/gateway/danmaku`, `/ws/runtime`, and the `ChatResponseFinalizer` bridge into TTS/Live2D.
- `apps/web/src/pages/RuntimePage.tsx` is already the operator console for adapters, runtime events, danmaku control, and Live2D state.
- `apps/web/src/pages/CreatorChatPage.tsx` is already the backstage lane and should become the director command surface rather than introducing a new page.
- `crates/storage/src/lib.rs` already persists messages, memory entries, profiles, danmaku state, and runtime records, but it does not yet store director/persona/session/viewer runtime state.
- `crates/api-types/src/lib.rs` exports the shared Rust/TypeScript API contract, so any new runtime or director APIs must be defined there first.
- Reuse the existing response finalization path; do not replace `ChatResponseFinalizer` or the Live2D speech queue architecture.
- Use TDD for every behavior change: failing test first, verify the failure, implement minimal code, verify pass, then run nearby coverage.

---

### Task 1: Add shared API types for director events, policy, and runtime state

**Files:**
- Modify: `crates/api-types/src/lib.rs`
- Modify: `crates/api-types/src/bin/export_web.rs` (only if type export coverage needs updating)
- Test: `crates/api-types/src/lib.rs`

**Step 1: Write the failing test**

Add a focused Rust unit test proving the new shared structs/enums serialize in the shape the daemon and web UI need.

Minimum types to add in this task:
- `DirectorMode` (`manual`, `assist`, `autonomous`)
- `DirectorAction` (`ignore`, `reply`, `defer`)
- `RuntimeInputSource` (`chat`, `danmaku`, `operator`, `timer`, `system`)
- `RuntimeInputEvent`
- `DirectorDecisionRecord`
- `DirectorStateRecord`
- `PersonaCoreRecord`
- `SessionStateRecord`
- `ViewerStateRecord`
- `DirectorConfigRecord`
- `DirectorConfigUpdateRequest`
- `DirectorCommandRequest`
- `DirectorCommandResponse`

Example test shape:

```rust
#[test]
fn director_state_record_serializes_with_snake_case_values() {
    let payload = DirectorStateRecord {
        mode: DirectorMode::Assist,
        speaking: false,
        cooldown_until: None,
        last_decision: Some(DirectorDecisionRecord {
            action: DirectorAction::Reply,
            reason: "high_priority_operator".into(),
            source: RuntimeInputSource::Operator,
            summary: "creator asked for follow-up".into(),
            created_at: Utc::now(),
        }),
        last_autonomous_at: None,
    };

    let value = serde_json::to_value(payload).unwrap();
    assert_eq!(value["mode"], "assist");
    assert_eq!(value["last_decision"]["action"], "reply");
    assert_eq!(value["last_decision"]["source"], "operator");
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p api-types director_state_record_serializes_with_snake_case_values -- --exact --test-threads=1
```

Expected: FAIL because the director shared types do not exist yet.

**Step 3: Write minimal implementation**

In `crates/api-types/src/lib.rs`:
- add the new enums and records with `Serialize`, `Deserialize`, `TS`, and snake_case serde settings where appropriate
- keep fields minimal and aligned to the current roadmap; do not add speculative tool-planning structures yet
- ensure all new types are export-safe for TypeScript generation

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run nearby API type coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p api-types --lib -- --test-threads=1
cargo run --manifest-path "D:/AI/memory-suite/Cargo.toml" -p api-types --bin export_web
```

Expected: all Rust tests PASS and web type export completes successfully.

**Step 6: Commit**

```bash
git add crates/api-types/src/lib.rs crates/api-types/src/bin/export_web.rs apps/web/src/generated/api.ts
git commit -m "feat: add shared director runtime api types"
```

---

### Task 2: Persist director config and lightweight runtime state in storage

**Files:**
- Modify: `crates/storage/src/lib.rs`
- Test: `crates/storage/src/lib.rs`

**Step 1: Write the failing test**

Add storage tests proving the repo can persist and read back:
- one current director config row
- one current session state row by `session_id`
- one current viewer state row by `user_id`
- a bounded list of recent director decisions

Example test shape:

```rust
#[tokio::test]
async fn stores_and_reads_director_runtime_state() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("runtime.db")).await.unwrap();

    storage
        .upsert_director_config(NewDirectorConfigRecord {
            mode: "assist".into(),
            auto_reply_enabled: true,
            min_reply_interval_ms: 1200,
            idle_prompt_interval_ms: 15000,
            interrupt_priority_enabled: false,
        })
        .await
        .unwrap();

    let config = storage.get_director_config().await.unwrap();
    assert_eq!(config.mode, "assist");
    assert_eq!(config.min_reply_interval_ms, 1200);
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p storage stores_and_reads_director_runtime_state -- --exact --test-threads=1
```

Expected: FAIL because the director storage tables and methods do not exist yet.

**Step 3: Write minimal implementation**

In `crates/storage/src/lib.rs`:
- add new record structs for insert/update operations
- extend schema initialization with tables for:
  - `director_config`
  - `director_decisions`
  - `session_runtime_state`
  - `viewer_runtime_state`
- add CRUD methods required by the new tests only
- keep one-row config semantics simple (single active row)
- keep decision history bounded by read methods instead of over-designing retention policy now

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run nearby storage coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p storage --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/storage/src/lib.rs
git commit -m "feat: persist director runtime state"
```

---

### Task 3: Normalize runtime input events inside orchestrator

**Files:**
- Create: `crates/orchestrator/src/events.rs`
- Modify: `crates/orchestrator/src/lib.rs`
- Test: `crates/orchestrator/src/lib.rs`

**Step 1: Write the failing test**

Add an orchestrator test proving a normalized runtime input event can be accepted without going through raw `ChatRequest` directly.

Target behavior for this task:
- a `RuntimeInputEvent` with source `operator` or `chat` can be converted into a session/user-scoped generation request
- message persistence still happens in session order
- existing session broadcast still emits a message-created event

Example test shape:

```rust
#[tokio::test]
async fn runtime_input_event_persists_messages_through_orchestrator() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("orch.db")).await.unwrap();
    let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());

    let response = orchestrator
        .handle_runtime_input(RuntimeInputEvent {
            session_id: Some("director-room".into()),
            user_id: Some("creator".into()),
            source: RuntimeInputSource::Operator,
            text: "status check".into(),
            priority: 90,
            trigger_id: None,
        })
        .await
        .unwrap();

    let stored = storage.list_messages("director-room").await.unwrap();
    assert_eq!(stored.len(), 2);
    assert_eq!(response.session_id, "director-room");
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator runtime_input_event_persists_messages_through_orchestrator -- --exact --test-threads=1
```

Expected: FAIL because `RuntimeInputEvent` handling does not exist yet.

**Step 3: Write minimal implementation**

In `crates/orchestrator/src/events.rs`:
- add helpers to normalize `ChatRequest` into `RuntimeInputEvent`
- keep the event model transport-agnostic and small

In `crates/orchestrator/src/lib.rs`:
- `pub mod events;`
- add `handle_runtime_input(...)`
- refactor the current `handle_chat(...)` to call the new normalized path instead of duplicating logic
- keep response generation and session event broadcasting behavior unchanged for direct chat traffic

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run nearby orchestrator coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator persists_messages_and_broadcasts_session_events -- --exact --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator runtime_input_event_persists_messages_through_orchestrator -- --exact --test-threads=1
```

Expected: both PASS.

**Step 6: Commit**

```bash
git add crates/orchestrator/src/lib.rs crates/orchestrator/src/events.rs
git commit -m "refactor: normalize orchestrator runtime input events"
```

---

### Task 4: Add explicit response policy and decision logging

**Files:**
- Create: `crates/orchestrator/src/policy.rs`
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Test: `crates/orchestrator/src/lib.rs`

**Step 1: Write the failing test**

Add an orchestrator test proving the director policy can ignore low-priority inputs during cooldown and logs the decision.

Example test shape:

```rust
#[tokio::test]
async fn policy_ignores_low_priority_event_during_cooldown() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("orch.db")).await.unwrap();
    storage
        .upsert_director_config(NewDirectorConfigRecord {
            mode: "assist".into(),
            auto_reply_enabled: true,
            min_reply_interval_ms: 60_000,
            idle_prompt_interval_ms: 15_000,
            interrupt_priority_enabled: false,
        })
        .await
        .unwrap();

    let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());
    orchestrator.handle_runtime_input(test_operator_event("first")).await.unwrap();

    let decision = orchestrator
        .evaluate_runtime_input(test_danmaku_event("spam"))
        .await
        .unwrap();

    assert_eq!(decision.action, DirectorAction::Ignore);
    assert!(decision.reason.contains("cooldown"));
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator policy_ignores_low_priority_event_during_cooldown -- --exact --test-threads=1
```

Expected: FAIL because policy evaluation and decision logging do not exist yet.

**Step 3: Write minimal implementation**

In `crates/orchestrator/src/policy.rs`:
- add a small pure rule evaluator
- first-pass rules only:
  - manual mode ignores non-operator traffic
  - `auto_reply_enabled = false` ignores danmaku/timer events
  - reply cooldown ignores low-priority events
  - operator events can bypass cooldown

In `crates/orchestrator/src/lib.rs`:
- add `evaluate_runtime_input(...)`
- before generating text, evaluate policy and either ignore/defer or continue to generation
- persist `DirectorDecisionRecord` through storage
- publish a runtime event for decisions only if it is needed by the UI and easy to keep stable now

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run nearby orchestrator/storage coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator --lib -- --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p storage --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/orchestrator/src/lib.rs crates/orchestrator/src/policy.rs crates/storage/src/lib.rs
git commit -m "feat: add director response policy and decision logging"
```

---

### Task 5: Build persona, session, viewer, and performance context assembly

**Files:**
- Create: `crates/orchestrator/src/context.rs`
- Create: `crates/orchestrator/src/persona.rs`
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Test: `crates/orchestrator/src/lib.rs`

**Step 1: Write the failing test**

Add a focused test proving prompt context now includes persona core plus session/viewer runtime state, not just memory snippets.

Example test shape:

```rust
#[tokio::test]
async fn render_system_prompt_includes_persona_and_session_runtime_context() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("orch.db")).await.unwrap();

    storage.upsert_session_runtime_state(/* current topic = boss rush */).await.unwrap();
    storage.upsert_viewer_runtime_state(/* user creator, familiarity = regular */).await.unwrap();

    let orchestrator = Orchestrator::new(storage, RuntimeBus::new());
    let prompt = orchestrator
        .debug_render_prompt(test_operator_event("keep talking about the boss rush"))
        .await
        .unwrap();

    assert!(prompt.contains("Persona core"));
    assert!(prompt.contains("boss rush"));
    assert!(prompt.contains("regular"));
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator render_system_prompt_includes_persona_and_session_runtime_context -- --exact --test-threads=1
```

Expected: FAIL because the context builder and debug prompt rendering path do not exist yet.

**Step 3: Write minimal implementation**

In `crates/orchestrator/src/persona.rs`:
- define the default persona core builder using the current runtime assistant identity
- keep this as explicit structured text, not a giant prompt template system

In `crates/orchestrator/src/context.rs`:
- load session state, viewer state, recent assistant turn, and memory snippets
- expose a small context struct used by prompt rendering

In `crates/orchestrator/src/lib.rs`:
- refactor `render_system_prompt(...)` to use the richer context builder
- keep the existing concise output rules
- add a tiny debug-only/helper method for tests if needed rather than exposing prompt internals to production APIs

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run nearby orchestrator coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/orchestrator/src/lib.rs crates/orchestrator/src/context.rs crates/orchestrator/src/persona.rs crates/storage/src/lib.rs
git commit -m "feat: assemble persona and runtime prompt context"
```

---

### Task 6: Add a minimal director service for chat, danmaku, and timer inputs

**Files:**
- Create: `crates/orchestrator/src/director.rs`
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `crates/api-types/src/lib.rs`
- Test: `crates/orchestrator/src/lib.rs`

**Step 1: Write the failing test**

Add a test proving the director can accept a timer event and either return `None` when idle behavior is suppressed or produce a reply when the idle interval threshold is met.

Example test shape:

```rust
#[tokio::test]
async fn director_tick_generates_idle_followup_after_interval() {
    let dir = tempdir().unwrap();
    let storage = Storage::connect(&dir.path().join("orch.db")).await.unwrap();
    storage.upsert_director_config(/* assist mode, idle interval 1 ms */).await.unwrap();

    let orchestrator = Orchestrator::new(storage.clone(), RuntimeBus::new());
    let response = orchestrator.tick_director("runtime-room").await.unwrap();

    assert!(response.is_some());
    assert!(!response.unwrap().assistant_text.trim().is_empty());
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator director_tick_generates_idle_followup_after_interval -- --exact --test-threads=1
```

Expected: FAIL because there is no director loop or tick API yet.

**Step 3: Write minimal implementation**

In `crates/orchestrator/src/director.rs`:
- add a small director facade that:
  - receives normalized runtime events
  - asks policy for a decision
  - triggers generation when action is `reply`
  - exposes `tick_director(session_id)` for timer-driven idle prompts
- keep the idle behavior simple: one short generated line when the idle interval is exceeded and mode allows it

In `crates/orchestrator/src/lib.rs`:
- wire the new director facade into the orchestrator instead of scattering logic
- keep `handle_chat(...)` and future danmaku paths delegating into the same director entrypoint

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run nearby orchestrator coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/orchestrator/src/lib.rs crates/orchestrator/src/director.rs crates/api-types/src/lib.rs apps/web/src/generated/api.ts
git commit -m "feat: add minimal orchestrator director loop"
```

---

### Task 7: Route danmaku ingress through the new director path in the daemon

**Files:**
- Modify: `apps/daemon/src/lib.rs`
- Modify: `apps/daemon/tests/live2d_speech_api.rs`
- Modify: `apps/daemon/tests/overlay_pages.rs` only if runtime route coverage needs updates
- Test: `apps/daemon/tests/live2d_speech_api.rs`

**Step 1: Write the failing test**

Add a daemon integration test proving danmaku injection now goes through the unified runtime input path and still produces a finalized chat response ready for the media pipeline.

Example test shape:

```rust
#[tokio::test]
async fn gateway_danmaku_uses_director_pipeline_and_returns_chat_response() -> Result<()> {
    let state = test_app_state().await?;
    let app = build_router(state.clone());

    let response = app
        .oneshot(post_json(
            "/api/gateway/danmaku",
            serde_json::json!({
                "session_id": "runtime-room",
                "user_id": "viewer-1",
                "text": "hello streamer"
            }),
        )?)
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let payload: ChatResponse = read_json(response).await?;
    assert_eq!(payload.session_id, "runtime-room");
    assert!(!payload.assistant_text.trim().is_empty());
    Ok(())
}
```

**Step 2: Run test to verify it fails**

Run the exact targeted daemon test you added, for example:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon gateway_danmaku_uses_director_pipeline_and_returns_chat_response -- --exact --test-threads=1
```

Expected: FAIL because the gateway path is not yet wired to the new normalized director path.

**Step 3: Write minimal implementation**

In `apps/daemon/src/lib.rs`:
- keep `/api/chat` behavior unchanged externally
- update the danmaku/gateway path to construct `RuntimeInputEvent` and delegate to the orchestrator director path
- continue running `ChatResponseFinalizer` on generated replies
- if the director returns ignore/defer, return a stable API result that does not break callers; keep the behavior minimal and explicit

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run nearby daemon coverage**

Run the relevant nearby daemon tests, for example:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon gateway_danmaku_uses_director_pipeline_and_returns_chat_response -- --exact --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon live2d_speech_next_and_ack_preserve_order_and_resume_playing_item -- --exact --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/daemon/src/lib.rs apps/daemon/tests/live2d_speech_api.rs
git commit -m "feat: route danmaku ingress through director pipeline"
```

---

### Task 8: Expose director runtime APIs from the daemon

**Files:**
- Modify: `apps/daemon/src/lib.rs`
- Modify: `crates/api-types/src/lib.rs`
- Test: `apps/daemon/src/lib.rs` or `apps/daemon/tests/...` using the existing daemon test style

**Step 1: Write the failing test**

Add daemon tests for the minimum operator APIs:
- `GET /api/director/state`
- `POST /api/director/config`
- `POST /api/director/command`
- optional `GET /api/director/decisions` if decision history is easy to expose now

Example test shape:

```rust
#[tokio::test]
async fn director_config_round_trips_through_http_api() -> Result<()> {
    let state = test_app_state().await?;
    let app = build_router(state.clone());

    let update = serde_json::json!({
        "mode": "assist",
        "auto_reply_enabled": true,
        "min_reply_interval_ms": 1200,
        "idle_prompt_interval_ms": 15000,
        "interrupt_priority_enabled": false
    });

    let response = app.oneshot(post_json("/api/director/config", update)?).await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(())
}
```

**Step 2: Run test to verify it fails**

Run the exact targeted test you added.

Expected: FAIL because the routes and handlers do not exist yet.

**Step 3: Write minimal implementation**

In `apps/daemon/src/lib.rs`:
- add the new routes to `build_router`
- add handlers that use storage/orchestrator to:
  - fetch current state
  - update config
  - execute creator/director commands through the same orchestration path
- keep transport logic in the daemon and business logic in orchestrator/storage

**Step 4: Run test to verify it passes**

Re-run the exact test from Step 2.

Expected: PASS.

**Step 5: Run nearby daemon coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/daemon/src/lib.rs crates/api-types/src/lib.rs apps/web/src/generated/api.ts
git commit -m "feat: expose director runtime http apis"
```

---

### Task 9: Add minimal runtime console controls for director state and decision history

**Files:**
- Modify: `apps/web/src/lib.ts`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Test: existing web build/typecheck path (`apps/web`)

**Step 1: Write the failing UI expectation**

Because this page does not currently have frontend unit tests, use a type/build-first failing expectation:
- add imports and component state for the new director APIs and records
- wire rendering against fields that do not exist yet so TypeScript fails until the API client changes are added

Minimum new UI sections for this task:
- Director state card
- Response policy card
- Recent decision log card
- Persona/session snapshot card (read-only JSON is acceptable)

**Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix "D:/AI/memory-suite/apps/web" run build
```

Expected: FAIL because the new director client functions and generated types are not wired yet.

**Step 3: Write minimal implementation**

In `apps/web/src/lib.ts`:
- add minimal fetch helpers for the new director endpoints

In `apps/web/src/pages/RuntimePage.tsx`:
- fetch director state alongside runtime overview
- add a simple config form for mode, auto reply toggle, reply interval, and idle interval
- render the last few decision records
- render persona/session/viewer snapshot in a simple `pre` block or compact fields
- keep styling minimal and reuse existing card layout

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run web export/build verification**

Run:

```bash
cargo run --manifest-path "D:/AI/memory-suite/Cargo.toml" -p api-types --bin export_web
npm --prefix "D:/AI/memory-suite/apps/web" run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/lib.ts apps/web/src/pages/RuntimePage.tsx apps/web/src/generated/api.ts
git commit -m "feat: add director controls to runtime console"
```

---

### Task 10: Turn Creator Chat into a backstage director command surface

**Files:**
- Modify: `apps/web/src/lib.ts`
- Modify: `apps/web/src/pages/CreatorChatPage.tsx`
- Test: existing web build/typecheck path (`apps/web`)

**Step 1: Write the failing UI expectation**

Add TypeScript usage for explicit backstage commands that do not yet exist in the page.

Minimum commands to support now:
- `/mode manual`
- `/mode assist`
- `/mode autonomous`
- `/topic <text>`
- `/mood <text>`
- `/note viewer <text>`
- `/followup`
- `/selfcheck`
- `/speak <text>`

The first failing change can simply be wiring a `runDirectorCommand(...)` client function and command shortcut buttons that do not compile yet.

**Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix "D:/AI/memory-suite/apps/web" run build
```

Expected: FAIL because the page references missing command helpers and/or types.

**Step 3: Write minimal implementation**

In `apps/web/src/lib.ts`:
- add the director command client helper if not already added in Task 9

In `apps/web/src/pages/CreatorChatPage.tsx`:
- keep normal backstage chat working
- add quick command chips for the new backstage director commands
- submit slash commands through the new command endpoint when they are recognized
- leave unknown text flowing through `sendChat(...)`
- update the last-response block to show whether the action became a direct command or a normal reply

**Step 4: Run test to verify it passes**

Run the exact command from Step 2 again.

Expected: PASS.

**Step 5: Run web verification**

Run:

```bash
npm --prefix "D:/AI/memory-suite/apps/web" run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/lib.ts apps/web/src/pages/CreatorChatPage.tsx
git commit -m "feat: add backstage director commands"
```

---

### Task 11: Add a daemon-side autonomous tick loop and verify end-to-end behavior

**Files:**
- Modify: `apps/daemon/src/lib.rs`
- Modify: `apps/daemon/src/main.rs` if bootstrap wiring needs to surface shutdown-safe background tasks
- Modify: `apps/daemon/tests/live2d_speech_api.rs` or create a targeted daemon integration test file if needed
- Test: targeted daemon integration test plus existing web/runtime verification commands

**Step 1: Write the failing test**

Add an integration test proving that when the director mode allows autonomous behavior and the idle interval is exceeded, a daemon-triggered tick causes a reply to be generated and finalized into the Live2D speech queue.

Example test shape:

```rust
#[tokio::test]
async fn autonomous_tick_queues_speech_after_idle_interval() -> Result<()> {
    let state = test_app_state().await?;
    state.storage.upsert_director_config(/* autonomous, very short idle interval */).await?;

    state.orchestrator.tick_director("runtime-room").await?;

    let next = state.live2d_speech_queue.read().await.front().cloned();
    assert!(next.is_some());
    Ok(())
}
```

If the finalization path cannot be hit directly from the orchestrator test, add a daemon-level helper that performs one autonomous tick and finalizes the response.

**Step 2: Run test to verify it fails**

Run the exact targeted daemon test you added.

Expected: FAIL because the daemon is not yet running a periodic director tick or finalizing the autonomous response.

**Step 3: Write minimal implementation**

In `apps/daemon/src/lib.rs` and/or `apps/daemon/src/main.rs`:
- spawn a lightweight Tokio interval task after state bootstrap
- on each interval, call the orchestrator director tick for the primary runtime session
- when the tick returns a response, run it through `ChatResponseFinalizer`
- keep interval conservative and configurable later; do not build a full scheduler now

**Step 4: Run test to verify it passes**

Re-run the exact command from Step 2.

Expected: PASS.

**Step 5: Run focused regression coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon -- --test-threads=1
npm --prefix "D:/AI/memory-suite/apps/web" run build
```

Expected: daemon tests PASS and web build still PASS.

**Step 6: Commit**

```bash
git add apps/daemon/src/lib.rs apps/daemon/src/main.rs apps/daemon/tests/live2d_speech_api.rs
git commit -m "feat: add autonomous director tick loop"
```

---

## Final verification checklist after all tasks

Run all of these fresh before claiming the implementation is complete:

```bash
cargo run --manifest-path "D:/AI/memory-suite/Cargo.toml" -p api-types --bin export_web
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p api-types --lib -- --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p storage --lib -- --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p orchestrator --lib -- --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon -- --test-threads=1
npm --prefix "D:/AI/memory-suite/apps/web" run build
```

Then do a short manual runtime verification:

1. Start the unified runtime.
2. Open `http://127.0.0.1:8080/runtime` and verify director state/config sections render.
3. Open `http://127.0.0.1:8080/creator-chat` and verify backstage command chips work.
4. Send a normal `/api/chat` message and confirm standard behavior still works.
5. Inject danmaku and confirm it appears in the decision log and can produce a reply.
6. Put director into `autonomous` mode with a short idle interval and verify one autonomous follow-up can enter the TTS/Live2D pipeline.

## Notes for the implementing engineer

- Do not redesign overlays yet.
- Do not build speculative planner/tool autonomy yet.
- Keep the first director policy deterministic and debuggable.
- Prefer read-only JSON blocks in the UI over premature custom widgets.
- Reuse existing runtime/session/message flows wherever possible.
- If a task reveals the need for a new shared type, add it in `crates/api-types` first and regenerate web bindings immediately.
