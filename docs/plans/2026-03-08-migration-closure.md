# Migration Closure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the migration middle-state by classifying legacy assets, hardening the four core runtime chains, and freezing old JS/Python expansion so the Rust + React runtime becomes the clear system of record.

**Architecture:** Treat this as a closure program, not a rewrite. First establish inventory and governance artifacts, then harden the four core chains in priority order (`job/adapter`, `speech/live2d`, `chat/session/memory`, `danmaku`), and finally clean up confirmed redundant assets. Keep Python only as supervised edge executors and keep React as a pure control surface over Rust-owned state.

**Tech Stack:** Rust workspace (`apps/daemon`, `crates/*`), React + TypeScript (`apps/web`), Python adapters (`python/`), SQLite, Axum, Tokio, shared API types via `ts-rs`.

---

### Task 1: Create the migration inventory document

**Files:**
- Create: `docs/plans/2026-03-08-migration-inventory.md`
- Reference: `docs/plans/2026-03-08-migration-closure-design.md`
- Reference: `README.md`

**Step 1: Create the inventory document skeleton**

Write a new markdown file with these top-level sections:

```md
# Migration Inventory

## Core runtime chains
## Python assets
## JavaScript assets
## Scripts and tooling
## TODO and placeholder audit
## Classification summary
```

**Step 2: Add the four core chains**

Under `## Core runtime chains`, list exactly these chains:

```md
- chat/session/memory
- speech/live2d
- danmaku
- job/adapter
```

**Step 3: Add classification tables**

Add markdown tables for Python, JavaScript, and scripts with these columns:

```md
| Asset | Path | Category | Chain | Owner | Notes |
```

Allowed `Category` values:
- `keep`
- `migrate`
- `freeze`
- `delete`

**Step 4: Add TODO/placeholder severity table**

Add a final table with these columns:

```md
| Item | Path | Severity | Chain | Why it matters | Proposed action |
```

Allowed `Severity` values:
- `P0`
- `P1`
- `P2`

**Step 5: Commit**

```bash
git add docs/plans/2026-03-08-migration-inventory.md
git commit -m "docs: add migration inventory scaffold"
```

---

### Task 2: Classify Python assets and mark runtime bundles

**Files:**
- Modify: `docs/plans/2026-03-08-migration-inventory.md`
- Inspect: `python/**/*`
- Inspect: `crates/jobs/src/python_adapter.rs`
- Inspect: `crates/media/src/lib.rs`

**Step 1: Audit Python entrypoints actually used by the runtime**

Populate the Python table with at least these rows:

```md
| Asset | Path | Category | Chain | Owner | Notes |
| edge_tts adapter | python/tts/edge_tts_server.py | keep | speech/live2d | python-edge | supervised by Rust |
| sovits adapter | python/tts/genie_api_server.py | keep or freeze | speech/live2d | python-sovits | decide based on active policy |
| train adapter | python/adapters/train_adapter.py | keep | job/adapter | python-train | edge executor |
| eval adapter | python/adapters/eval_adapter.py | keep | job/adapter | python-eval | edge executor |
```

**Step 2: Mark bundled runtimes and old model directories**

Add rows for bundled or historical directories such as `_OLD` and packaged runtimes. Mark them `freeze` or `delete`, never `migrate`.

**Step 3: Add one-sentence classification reasons**

For every Python row, write one sentence in `Notes` explaining why it is `keep`, `freeze`, or `delete`.

**Step 4: Add a summary note**

At the bottom of the Python section, add:

```md
Python remains only for model-bound or training-bound edge execution. Runtime state, lifecycle, and user-facing system truth stay in Rust.
```

**Step 5: Commit**

```bash
git add docs/plans/2026-03-08-migration-inventory.md
git commit -m "docs: classify python migration assets"
```

---

### Task 3: Classify JavaScript and script assets

**Files:**
- Modify: `docs/plans/2026-03-08-migration-inventory.md`
- Inspect: `scripts/**/*.{js,mjs,cjs,ts,py,bat,ps1}`
- Inspect: root `package.json`

**Step 1: Add JavaScript asset rows**

List each meaningful JS or MJS entrypoint still in use. For each one, decide:
- `migrate` if it belongs in Rust or TypeScript
- `freeze` if it is temporary migration support
- `delete` if it no longer serves a real path

**Step 2: Add scripts/tooling rows**

For each meaningful script family, add a row in the scripts table. Group by purpose instead of listing every one-off file separately when possible, for example:

```md
| Runtime health scripts | scripts/runtime/*.ts | freeze | speech/live2d | platform | migration support only |
| Legacy import helpers | scripts/import/*.js | migrate | chat/session/memory | runtime | fold into Rust import surface |
```

**Step 3: Add a freeze rule section**

Below the scripts table, add this exact text:

```md
## Freeze Rules

- Do not add new JavaScript control-plane entrypoints.
- Do not add new Python components that own runtime lifecycle.
- Prefer Rust for stateful orchestration.
- Prefer TypeScript for UI-facing tooling.
```

**Step 4: Add a deletion candidate subsection**

Create `## Deletion Candidates` with bullet points for clearly obsolete directories or entrypoints.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-08-migration-inventory.md
git commit -m "docs: classify javascript and script migration assets"
```

---

### Task 4: Add TODO and placeholder severity audit

**Files:**
- Modify: `docs/plans/2026-03-08-migration-inventory.md`
- Inspect: `crates/orchestrator/src/lib.rs`
- Inspect: `crates/media/src/lib.rs`
- Inspect: `crates/jobs/src/lib.rs`
- Inspect: `crates/jobs/src/python_adapter.rs`
- Inspect: `crates/gateway/src/lib.rs`
- Inspect: `apps/web/src/pages/*.tsx`

**Step 1: Record known P0 items**

Add rows for issues that can block a core chain, such as:
- state not written back correctly
- adapter completion ambiguity
- UI status diverging from backend truth
- reconnect or worker readiness failures that leave chains stuck

**Step 2: Record known P1 items**

Add rows for migration middle-state issues, such as:
- hardcoded session IDs in UI pages
- forced single-backend TTS policy exposed through broader interfaces
- placeholder adapter behavior
- weak readiness checks

**Step 3: Record known P2 items**

Add rows for non-core cleanup and deferred polish.

**Step 4: Add a triage summary**

Append a short summary:

```md
P0 items must be cleared before expanding features on a chain. P1 items must have an owner and a destination. P2 items stay visible but do not block closure.
```

**Step 5: Commit**

```bash
git add docs/plans/2026-03-08-migration-inventory.md
git commit -m "docs: add migration todo and placeholder audit"
```

---

### Task 5: Harden the job and adapter lifecycle contract

**Files:**
- Modify: `crates/jobs/src/lib.rs`
- Modify: `crates/jobs/src/python_adapter.rs`
- Modify: `crates/api-types/src/lib.rs`
- Modify: `apps/web/src/generated/api.ts` (via existing type generation workflow)
- Test: `crates/jobs/tests/*` or nearest existing crate test module

**Step 1: Write the failing lifecycle tests**

Add tests that cover:

```rust
#[tokio::test]
async fn job_enters_terminal_state_when_adapter_stops() {
    // create queued job, simulate adapter stop, assert completed or failed is persisted
}

#[tokio::test]
async fn duplicate_running_adapter_is_rejected_or_reused_consistently() {
    // start once, attempt second start, assert deterministic outcome
}
```

**Step 2: Run the targeted tests to verify current failure**

Run: `cargo test -p jobs -- --test-threads=1`
Expected: at least one lifecycle assertion fails or is missing.

**Step 3: Define explicit lifecycle states in API types**

Add or tighten enums/records so the job and adapter lifecycle is not represented by loose string combinations.

**Step 4: Implement minimal lifecycle hardening**

Update `crates/jobs/src/lib.rs` and `crates/jobs/src/python_adapter.rs` so:
- adapter start outcome is explicit
- duplicate-run policy is explicit
- terminal state writeback is deterministic
- error paths are recorded once in a stable shape

**Step 5: Re-run tests**

Run: `cargo test -p jobs -- --test-threads=1`
Expected: PASS.

**Step 6: Regenerate shared types if required**

Run the existing repo command that refreshes frontend API types.
Expected: `apps/web/src/generated/api.ts` matches new Rust types.

**Step 7: Commit**

```bash
git add crates/jobs/src/lib.rs crates/jobs/src/python_adapter.rs crates/api-types/src/lib.rs apps/web/src/generated/api.ts
git commit -m "fix: harden job and adapter lifecycle states"
```

---

### Task 6: Harden the speech and Live2D chain

**Files:**
- Modify: `crates/media/src/lib.rs`
- Modify: `crates/api-types/src/lib.rs`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/pages/CreatorChatPage.tsx`
- Test: nearest existing media tests or add crate-local tests

**Step 1: Write the failing tests**

Add tests covering:

```rust
#[tokio::test]
async fn tts_request_records_failure_when_worker_never_becomes_ready() {
    // enqueue request, simulate readiness timeout, assert failed state is persisted
}

#[tokio::test]
async fn live2d_updates_follow_speech_state_transitions() {
    // enqueue, simulate ready/start/complete, assert runtime events and stored state align
}
```

**Step 2: Run the targeted tests**

Run: `cargo test -p media -- --test-threads=1`
Expected: failing or missing lifecycle expectations.

**Step 3: Narrow the active TTS policy**

Make the active backend policy explicit in code and type surface. If only `edge_tts` is supported now, represent that clearly instead of implying broad backend flexibility.

**Step 4: Move hardcoded request values behind config or explicit runtime policy**

Remove inline demo assumptions from dispatch where possible and centralize the policy in one place.

**Step 5: Update UI status rendering**

Ensure the Runtime and Creator Chat pages display the hardened speech states instead of inferring them loosely.

**Step 6: Re-run tests**

Run: `cargo test -p media -- --test-threads=1`
Expected: PASS.

**Step 7: Commit**

```bash
git add crates/media/src/lib.rs crates/api-types/src/lib.rs apps/web/src/pages/RuntimePage.tsx apps/web/src/pages/CreatorChatPage.tsx
git commit -m "fix: harden speech and live2d runtime flow"
```

---

### Task 7: Harden chat, session, and memory behavior

**Files:**
- Modify: `crates/orchestrator/src/lib.rs`
- Modify: `crates/storage/src/lib.rs`
- Modify: `crates/api-types/src/lib.rs`
- Modify: `apps/web/src/pages/DashboardPage.tsx`
- Modify: `apps/web/src/pages/CreatorChatPage.tsx`
- Test: nearest existing orchestrator tests or add crate-local tests

**Step 1: Write the failing tests**

Add tests covering:

```rust
#[tokio::test]
async fn chat_without_session_id_creates_one_and_persists_both_messages() {
    // send request, assert session id returned and user/assistant messages stored
}

#[tokio::test]
async fn fallback_response_is_marked_as_fallback_behavior() {
    // force remote model unavailable, assert response metadata shows fallback path
}
```

**Step 2: Run the targeted tests**

Run: `cargo test -p orchestrator -- --test-threads=1`
Expected: current metadata or persistence behavior is incomplete.

**Step 3: Tighten chat response semantics**

Make sure the response shape distinguishes clearly between:
- real assistant output
- fallback output
- speech not requested
- animation not planned

**Step 4: Remove or centralize hardcoded session behavior in the UI**

Stop scattering fixed demo session IDs through pages. Move demo/default session behavior into one explicit UI helper or config path.

**Step 5: Re-run tests**

Run: `cargo test -p orchestrator -- --test-threads=1`
Expected: PASS.

**Step 6: Commit**

```bash
git add crates/orchestrator/src/lib.rs crates/storage/src/lib.rs crates/api-types/src/lib.rs apps/web/src/pages/DashboardPage.tsx apps/web/src/pages/CreatorChatPage.tsx
git commit -m "fix: tighten chat and session runtime semantics"
```

---

### Task 8: Harden danmaku connection state

**Files:**
- Modify: `crates/gateway/src/lib.rs`
- Modify: `crates/gateway/src/protocol_client.rs`
- Modify: `crates/api-types/src/lib.rs`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Test: nearest existing gateway tests or add crate-local tests

**Step 1: Write the failing tests**

Add tests covering:

```rust
#[tokio::test]
async fn reconnect_state_sets_next_retry_and_error_fields_consistently() {
    // simulate connect failure, assert reconnect metadata is coherent
}

#[tokio::test]
async fn disconnect_clears_active_session_fields() {
    // simulate disconnect, assert session_id and upstream host are cleared or finalized consistently
}
```

**Step 2: Run the targeted tests**

Run: `cargo test -p gateway -- --test-threads=1`
Expected: at least one state transition is under-specified.

**Step 3: Tighten connection state transitions**

Replace loose state combinations with an explicit transition policy for connect, connected, reconnecting, disconnected, and failed-like outcomes.

**Step 4: Align frontend rendering**

Update the Runtime page so it renders state based on the hardened backend model rather than inferred combinations.

**Step 5: Re-run tests**

Run: `cargo test -p gateway -- --test-threads=1`
Expected: PASS.

**Step 6: Commit**

```bash
git add crates/gateway/src/lib.rs crates/gateway/src/protocol_client.rs crates/api-types/src/lib.rs apps/web/src/pages/RuntimePage.tsx
git commit -m "fix: harden danmaku connection state transitions"
```

---

### Task 9: Reduce migration noise in the frontend control surface

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/RuntimePage.tsx`
- Modify: `apps/web/src/pages/DashboardPage.tsx`
- Modify: `apps/web/src/pages/CreatorChatPage.tsx`
- Create: `apps/web/src/lib/session.ts` (only if needed)
- Test: nearest existing frontend test file, or add targeted tests if the repo already has a frontend test setup

**Step 1: Write the failing UI tests**

Cover at least:
- session defaulting is centralized
- runtime status panels render explicit backend states
- pages do not duplicate demo-only session constants

**Step 2: Run the frontend tests**

Run the repo's existing frontend test command.
Expected: targeted UI behavior is missing or inconsistent.

**Step 3: Extract only the minimal shared helper**

If multiple pages still hardcode demo sessions, add one shared helper file for session defaults. Do not create broader abstractions.

**Step 4: Update pages to consume the helper and explicit backend states**

Keep the UI simple. Remove duplication without redesigning the whole frontend.

**Step 5: Re-run the frontend tests**

Run the same frontend test command.
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/RuntimePage.tsx apps/web/src/pages/DashboardPage.tsx apps/web/src/pages/CreatorChatPage.tsx apps/web/src/lib/session.ts
git commit -m "refactor: reduce migration noise in control pages"
```

---

### Task 10: Remove or isolate confirmed redundant assets

**Files:**
- Modify or delete only assets marked `delete` in `docs/plans/2026-03-08-migration-inventory.md`
- Modify: `.gitignore` or docs only if necessary to isolate bundled runtime artifacts
- Modify: `README.md` only if operational guidance changes

**Step 1: Pick only confirmed deletion candidates**

Start with directories or files already marked `delete` in the inventory document. Do not guess.

**Step 2: Delete or isolate one candidate at a time**

For each candidate:
- remove the asset if fully obsolete, or
- move it behind a documented boundary if it must temporarily remain but should stop polluting the main source tree

**Step 3: Run the relevant verification after each removal**

Use the smallest verification that proves the chain still works, for example:
- `cargo test -p jobs -- --test-threads=1`
- `cargo test -p media -- --test-threads=1`
- `cargo test -p orchestrator -- --test-threads=1`
- `cargo test -p gateway -- --test-threads=1`
- the existing frontend build or test command

Expected: PASS after each deletion batch.

**Step 4: Update the inventory document**

Mark each deleted asset as completed, with the commit hash or date.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-08-migration-inventory.md README.md .gitignore
git commit -m "chore: remove confirmed migration leftovers"
```

---

### Task 11: Run full focused verification

**Files:**
- No code changes required
- Verify all files touched in Tasks 5-10

**Step 1: Run Rust crate tests in closure order**

Run:

```bash
cargo test -p jobs -- --test-threads=1
cargo test -p media -- --test-threads=1
cargo test -p orchestrator -- --test-threads=1
cargo test -p gateway -- --test-threads=1
```

Expected: PASS.

**Step 2: Run the shared repo verification command**

Run the existing repo-level command already used for unified testing.
Expected: PASS or only known pre-existing failures documented separately.

**Step 3: Run frontend verification**

Run the existing frontend test or build command.
Expected: PASS.

**Step 4: Update the design and inventory docs if verification changed scope**

Only update docs if the implementation outcome materially changed the plan.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-08-migration-closure-design.md docs/plans/2026-03-08-migration-inventory.md
git commit -m "test: verify migration closure changes"
```

---

### Task 12: Prepare handoff summary

**Files:**
- Modify: `docs/plans/2026-03-08-migration-inventory.md`
- Modify: `docs/plans/2026-03-08-migration-closure-design.md`
- Create: `docs/plans/2026-03-08-migration-closure-handoff.md`

**Step 1: Create the handoff document**

Add these sections:

```md
# Migration Closure Handoff

## Completed
## Deferred
## Kept Python assets
## Frozen JavaScript/scripts
## Deleted assets
## Remaining P1/P2 items
```

**Step 2: Summarize final outcomes**

Use short bullets tied back to the four chains and the asset categories.

**Step 3: Record what was intentionally not done**

Include explicit bullets for deferred items so future work does not re-open already-made decisions.

**Step 4: Commit**

```bash
git add docs/plans/2026-03-08-migration-closure-handoff.md docs/plans/2026-03-08-migration-inventory.md docs/plans/2026-03-08-migration-closure-design.md
git commit -m "docs: add migration closure handoff summary"
```
