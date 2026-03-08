# Memory Suite Refactor Design

Date: 2026-03-09

## Summary

This design defines the target architecture for refactoring `memory-suite` into a simpler, more stable system centered on Rust and React. Python is no longer treated as a first-class runtime pillar. Instead, it is reduced to optional tooling or worker use only when strictly necessary. The current BrainNN online chain is designated for removal.

The primary goals are:
- keep the host machine responsive
- preserve second-level AI interaction where possible
- reduce architectural sprawl
- eliminate online multi-center ownership across Rust, Python, and Node
- make Rust the single online control plane and state owner

## Target Architecture

### Core system
- **Rust daemon** is the single online backend and control plane.
- **React web** is the single operator-facing web surface.

### Optional edge capabilities
These may exist, but they are not part of the core architecture:
- TTS worker
- model inference bridge, if required by the local model setup
- LoRA training scripts
- evaluation scripts

These capabilities must remain stateless from the product perspective. They cannot own session state, runtime state, or orchestration.

### Removed from future architecture
- BrainNN online runtime and Flask chain
- Python-owned online orchestration and memory ownership
- Node-owned online service responsibilities
- placeholder worker paths that simulate support without real implementation

## Architectural Judgment From Audit

### Real backbone to keep
The repository already contains a substantial Rust runtime backbone:
- `apps/daemon` owns the HTTP and WebSocket surface
- `crates/storage` owns persistent state
- `crates/orchestrator` owns chat orchestration entry behavior
- `crates/gateway` owns danmaku and reconnect/session supervision
- `crates/jobs` owns job creation and state transitions
- `crates/media` owns TTS and Live2D-related orchestration
- `apps/web` is a live React console wired to real Rust APIs

### Transitional or thin areas to tighten
- `crates/jobs/src/python_adapter.rs` currently includes placeholder behavior for unknown adapters
- `crates/media/src/lib.rs` keeps TTS policy simplified to one active backend
- parts of Rust chat intelligence are still thinner than the rest of the control plane
- some UI surfaces still reflect migration-era wording and assumptions

### Legacy or removal targets
- `brainnn/*` is a real but now undesirable online runtime layer
- Node evaluation and script surfaces should be downgraded to tooling only

## Design Principles

1. **Rust owns online truth**
   - session ownership
   - runtime state ownership
   - storage ownership
   - orchestration ownership
   - runtime event ownership

2. **React only talks to Rust**
   - no direct browser-to-Python runtime behavior
   - no online dependency on BrainNN

3. **Heavy work stays off the main path**
   - training, long evaluation, and similar jobs must run asynchronously
   - optional workers are invoked by Rust but do not control Rust

4. **Delete, do not replatform BrainNN**
   - do not port BrainNN concepts 1:1 into Rust
   - only preserve narrowly useful behavior that is still required

5. **Prefer explicit unsupported behavior over fake support**
   - unsupported adapters should fail clearly
   - placeholder sleep-based worker simulation should be removed from the target state

## Component Boundary Design

### Rust daemon responsibilities
- API and WebSocket endpoints
- session and message persistence
- memory and runtime context assembly
- job orchestration and status tracking
- tool execution coordination
- danmaku, overlay, and Live2D control
- event publication to runtime clients
- optional worker invocation through narrow interfaces

### React responsibilities
- dashboard and runtime visibility
- operator controls
- jobs and tools views
- creator/chat surfaces
- overlay and runtime subscriptions

### Optional worker responsibilities
- TTS generation
- model inference adaptation only when necessary
- LoRA training
- evaluation and batch processing

Workers may produce outputs or results, but must not own product state.

## Core Runtime Flows

### Online flow
`React -> Rust daemon -> storage/orchestrator/runtime services -> response`

This is the default path for:
- chat
- runtime inspection
- tool execution
- jobs inspection
- danmaku and Live2D control
- knowledge search

### Chat flow
`React -> /api/chat -> Rust loads history/context -> Rust assembles model input -> Rust calls model endpoint/bridge if needed -> Rust stores reply -> Rust emits runtime event -> React renders`

The important change is that BrainNN no longer sits in the middle as an online orchestration system.

### Long-running jobs
`React/API request -> Rust JobService -> job record -> optional worker -> result/state written back -> Rust updates job state -> UI polls or receives events`

### Event flow
`Rust service updates state -> RuntimeEvent published -> WS subscribers receive updates -> React pages/overlays update`

## What Must Be Preserved From BrainNN

Only preserve behavior that is still product-relevant, such as:
- prompt or context assembly rules that materially affect response quality
- model input/output normalization if genuinely needed
- lightweight policy logic that belongs in orchestration

Do not preserve:
- soul-state systems as an online requirement
- nested learning chains as default runtime behavior
- multi-service Python cognition pipelines
- Python-owned memory or session truth

## Risk Control Strategy

Use a staged deletion strategy:
1. break BrainNN out of the main path
2. remove remaining dependencies and config assumptions
3. physically delete BrainNN and related code
4. harden the Rust + React main system after deletion

This avoids unstable big-bang removal.

## Testing Strategy

### Required smoke coverage
- daemon starts successfully
- web connects to daemon
- `/api/health` works
- `/api/chat` works
- `/api/runtime/overview` works
- `/ws/runtime` and `/ws/overlay` work
- tools, jobs, and core runtime pages still function

### Required chat contract coverage
- request shape stability
- response shape stability
- history persistence
- assistant reply persistence
- timeout and failure behavior

### Required worker isolation coverage
- system starts without optional workers
- TTS or training failures degrade only those features
- optional worker failures do not break the main online system

### Required deletion validation
- project builds and runs without BrainNN present
- core user flows remain available after BrainNN removal

## Implementation Roadmap

### Phase 0: Freeze direction
- Rust + React become the official main architecture
- BrainNN is declared a deletion target
- Python becomes optional tooling only

### Phase 1: Inventory BrainNN dependencies
- identify runtime, config, script, test, and documentation dependencies
- classify each dependency as preserve, migrate, or delete
- record the file-by-file inventory in `docs/plans/2026-03-09-memory-suite-brainnn-retirement-inventory.md`

### Phase 2: Move required online duties into Rust
- ensure chat and orchestration paths no longer depend on BrainNN
- define model-calling boundaries clearly
- ensure frontend talks only to Rust

### Phase 3: Demote Python
- keep only optional tooling/workers where truly necessary
- remove fake adapter support semantics
- stop treating Python as a permanent runtime pillar

### Phase 4: Shrink Node responsibility
- keep build/tooling/eval only
- align scripts with the Rust API contract
- remove any remaining online role assumptions

### Phase 5: Cut BrainNN out of the main path
- disable it in runtime validation
- remove active dependency hooks
- ensure system still functions normally

### Phase 6: Physically delete BrainNN
- remove code, docs, config, scripts, and dependency references
- verify no dangling imports or hidden assumptions remain

### Phase 7: Harden the unified system
- tighten job semantics
- improve model interface reliability
- remove migration-era UI wording
- ensure docs, code, and runtime behavior match

## Final Design Decision

The future system should be understood as:
- **Main architecture:** Rust + React
- **Optional tooling:** Python only when strictly needed
- **Retired architecture:** BrainNN and any Python online orchestration chain

This design intentionally favors clarity, control-plane simplicity, and runtime stability over preserving every historical abstraction.
