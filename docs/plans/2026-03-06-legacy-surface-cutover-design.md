# Legacy Surface Cutover Design

**Date:** 2026-03-06  
**Branch:** `codex/rust-unified-foundation`

## Context

The current Rust runtime now owns unified HTTP APIs, runtime supervision, shared types, SQLite persistence, a runtime event bus, TTS dispatch, train/eval job dispatch, and the new web console.

The largest remaining legacy surface is still concentrated in three places:

- `manager/server.js`
- `memory-danmaku/bridge.js`
- `memory-live2d/server.js`

These files still carry the real operational flow for:

- service orchestration and operator control
- danmaku ingress and live message shaping
- subtitle, emotion, audio, and overlay runtime state

If these are not cut over, the repository still has two control planes:

- the new Rust daemon as the intended runtime spine
- the old Node services as the real live path

That is the main architectural debt left in the system.

## Approaches Considered

### 1. Keep legacy manager and only proxy it through Rust

Pros:

- lowest short-term change risk
- fast to expose old behavior through the new daemon

Cons:

- preserves the worst architecture
- keeps multi-process orchestration alive
- does not actually reduce language or runtime surface

This is not acceptable for the stated end goal.

### 2. Migrate danmaku and live2d first, leave manager as a shell

Pros:

- removes the most visible real-time path
- lowers coupling between stream input and presentation

Cons:

- still leaves the old manager as the operator authority
- cutover remains split across two systems

This is better, but still incomplete.

### 3. Move manager orchestration, danmaku ingress, and live2d runtime state behind the Rust daemon together

Pros:

- collapses the remaining legacy control plane in one slice
- gives the Rust daemon real ownership of live operation
- makes old services demotable to migration/reference-only status

Cons:

- larger migration slice
- requires careful event and state modeling

This is the recommended path.

## Recommended Design

The next slice should turn the Rust daemon into the single live operations backend for:

- runtime service status and operator actions
- danmaku ingress/session event processing
- live2d state, subtitle, audio, and emotion control

The implementation should not attempt to reproduce every legacy behavior in one pass. It should pull over the stable runtime spine and leave advanced heuristics as follow-up work once the control plane is fully unified.

## Architecture

### 1. Gateway ownership moves into Rust

Add a dedicated Rust gateway layer that owns:

- danmaku input ingestion
- outbound session event emission
- operator-facing runtime status

For the first cut, danmaku ingress should be modeled as a gateway adapter with two modes:

- mock/local feed mode for tests and operator verification
- legacy Bilibili source mode behind a supervised adapter boundary

This keeps Rust in control even where a protocol-specific bridge still needs Python or Node help temporarily.

### 2. Live2D runtime state becomes a Rust-owned store

The Node `memory-live2d/server.js` currently acts as a state holder for:

- subtitle text
- subtitle duration
- current emotion
- current audio payload
- model configuration

This should move into a Rust `media` or `gateway` submodule with explicit state records and read/write APIs. The web overlay should read from this Rust-owned state, not from the old Node process.

### 3. Manager orchestration becomes runtime commands

The old manager mixes:

- service lifecycle actions
- tool status
- showrunner/topic state
- eval/training triggers
- operational probes

The next slice should only migrate what the new daemon must own to become the primary operator backend:

- service/adaptor status
- start/stop/restart actions for supervised adapters
- health and preflight summary
- live operations summary for danmaku/live2d/chat/TTS/jobs

Knowledge schedulers, tool marketplace logic, and other non-critical manager features should not be dragged into this slice unless they block cutover.

### 4. Web becomes the only operator surface

The existing new web app should absorb:

- service control cards
- live danmaku event monitor
- live2d state inspection and mutation
- preflight/cutover checks

This removes the need to keep `manager/public` and scattered HTML admin pages as the primary console.

## Data Flow

The target live path should be:

`danmaku ingress -> Rust gateway -> orchestrator/chat path -> TTS dispatch -> live2d state update -> overlay/websocket consumers`

The target operator path should be:

`web console -> unified daemon runtime APIs -> adapter supervision / state mutation / preflight checks`

## Error Handling

The next slice should standardize failures as structured runtime events and persisted state, rather than console-only logs:

- adapter start failures
- danmaku source disconnects
- live2d state update failures
- overlay/client websocket disconnects

These need to appear in:

- `/api/runtime/overview`
- runtime event feed
- adapter/service status lists

## Testing Strategy

The slice should be validated with:

- Rust integration tests for runtime control APIs
- websocket tests for runtime and overlay state streams
- gateway tests using mock danmaku events
- web production build after API/type regeneration
- bootstrap and import verification

## Success Criteria

This slice is complete when:

- the Rust daemon can expose live2d runtime state without the old Node live2d server
- danmaku input can be injected and observed through Rust-owned runtime APIs/events
- the new web console can act as the main operator surface for these flows
- the old manager is no longer required for day-to-day runtime control
