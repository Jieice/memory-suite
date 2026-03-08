# BrainNN Retirement Inventory

## Direct runtime dependencies
- [x] daemon startup
- [x] chat path
- [x] web client calls
- [x] scripts and eval tools
- [x] config/env references
- [x] tests/docs

## Runtime dependency inventory

### daemon startup
- `brainnn/server.py`
  - BrainNN Flask runtime entrypoint.
  - Owns `/health`, `/process`, `/status`, and coordinates downstream Python services through:
    - `AGENT_CORE_URL`
    - `MEMORY_SYSTEM_V2_URL`
    - `REFLECTION_ENGINE_URL`
    - `NEURO_SYMBOLIC_BRIDGE_URL`
  - Classification: **Delete entirely**.
- `apps/daemon/src/lib.rs`
- `apps/daemon/src/main.rs`
  - No active BrainNN dependency found in the Rust daemon bootstrap path during Task 1 inventory.
  - Current main runtime is already Rust-owned.
  - Classification: **Preserve in Rust**.

### chat path
- `apps/web/src/lib.ts`
  - Web client already calls Rust endpoints such as `/api/health`, `/api/runtime/overview`, `/api/tools/execute`.
  - No direct BrainNN references found.
  - Classification: **Preserve in Rust**.
- `scripts/run-intelligence-eval.mjs`
  - Targets Rust `/api/chat` by default (`http://127.0.0.1:8080/api/chat`) but still sends a legacy request body:
    - `userId`
    - `userName`
    - `content`
  - This is not a BrainNN runtime dependency anymore, but it still assumes the old contract shape.
  - Classification: **Optional tooling only**; align to Rust API contract.

### scripts and eval tools
- `package.json`
  - `train:brain` still points to `python brainnn/scripts/first_lesson.py`.
  - Classification: **Delete entirely** unless explicitly retained as historical/offline-only tooling.
- `scripts/check-services.js`
  - Checks BrainNN health at `http://localhost:4007/health`.
  - Classification: **Delete entirely** or rewrite for retired-architecture documentation only.
- `scripts/clear-logs.ps1`
  - Still clears `brainnn\\logs` as an active maintenance path.
  - Classification: **Delete entirely** after BrainNN removal.
- `scripts/fix-encoding.py`
  - Still hardcodes multiple `brainnn/*` files as maintained targets.
  - Classification: **Delete entirely** or trim BrainNN entries when the runtime is removed.
- `scripts/prediction-example.py`
  - Still instructs operators to start `brainnn/prediction_engine.py`.
  - Classification: **Delete entirely** or rewrite if prediction tooling survives outside BrainNN.
- `scripts/test-fallback-e2e.ts`
  - Still references `BRAINNN_URL` and treats BrainNN as an optional sidecar.
  - Classification: **Optional tooling only** if fallback testing remains useful; otherwise **Delete entirely**.
- `scripts/test-nn-chain.py`
  - Directly targets BrainNN and its subordinate service ports 4009-4012.
  - Classification: **Delete entirely**.
- `scripts/test-prediction-engine.bat`
  - Still instructs users to start BrainNN prediction engine directly.
  - Classification: **Delete entirely** unless prediction tooling is explicitly retained elsewhere.
- `scripts/verify-nn-chain-complete.py`
  - Still verifies optional BrainNN sidecar health.
  - Classification: **Delete entirely** unless deliberately kept as historical validation tooling.

### config/env references
- `brainnn/server.py`
  - Reads `AGENT_CORE_URL`, `MEMORY_SYSTEM_V2_URL`, `REFLECTION_ENGINE_URL`, `NEURO_SYMBOLIC_BRIDGE_URL`.
  - Classification: **Delete entirely**.
- `docs/env.zh-CN.md`
  - Still documents `FAST_PATH_SKIP_BRAINNN=false`.
  - Classification: **Delete entirely** from active runtime docs.
- Repo-wide matches also show BrainNN-specific ports and env assumptions in docs and scripts.
  - Classification: **Delete entirely** from active startup/config surfaces.

### tests/docs
- `docs/FALLBACK_DEPLOYMENT_GUIDE.md`
  - Still lists BrainNN runtime endpoint.
  - Classification: **Delete entirely** from active runtime guidance or mark clearly historical.
- `docs/FALLBACK_MONITORING.md`
  - Still includes BrainNN monitoring metrics.
  - Classification: **Delete entirely** from active monitoring guidance or mark retired.
- `docs/prometheus-rules.yml`
  - Still includes BrainNN alerting rules.
  - Classification: **Delete entirely** from active rules if no runtime BrainNN remains.
- `docs/V9_SOUL_UPGRADE_SPEC.md`
  - Still describes periodic synchronization to BrainNN.
  - Classification: **Delete entirely** from current architecture claims or mark as retired history.
- `docs/anime-specialization-plan.md`
  - Still references `brainnn/server.py` as a live emitting component.
  - Classification: **Delete entirely** from current-state docs or mark historical.
- `docs/AI_INTELLIGENCE_MEMORY_UPGRADE.md`
  - Still references BrainNN memory ownership/components.
  - Classification: **Delete entirely** from active architecture guidance or mark historical.
- `brainnn/README.md`
  - Documents BrainNN as a Python sidecar/tooling surface.
  - Classification: **Delete entirely** once BrainNN code is removed.
- `.gitattributes`
  - Contains `brainnn/** linguist-vendored=true`.
  - Classification: **Delete entirely** after BrainNN removal.

## Coverage summary
- Startup/runtime ownership is already centered in Rust.
- Web client ownership is already centered in Rust APIs.
- Remaining BrainNN dependency edges are concentrated in:
  - legacy Python runtime files
  - package/scripts tooling
  - env and monitoring docs
  - retirement-incomplete architecture documents
- No active browser-to-BrainNN path was found.
- No active Rust daemon bootstrap dependency on BrainNN was found in this inventory pass.

## Classification
- Preserve in Rust:
  - `apps/daemon/src/lib.rs`
  - `apps/daemon/src/main.rs`
  - `apps/web/src/lib.ts`
  - Rust-owned `/api/chat` and runtime endpoints
- Optional tooling only:
  - `scripts/run-intelligence-eval.mjs` after payload alignment
  - `scripts/test-fallback-e2e.ts` only if fallback experiments are intentionally retained
- Delete entirely:
  - `brainnn/server.py`
  - BrainNN subordinate runtime chain and related env keys
  - `package.json` `train:brain`
  - BrainNN verification/check scripts that assume active runtime ownership
  - active docs/monitoring/config guidance that still describe BrainNN as part of the main system

## Docs checklist
- [ ] No document says BrainNN is required for the main runtime
- [ ] Default startup instructions mention Rust daemon + web only
- [ ] Python is described as optional tooling only
