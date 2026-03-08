# Migration Inventory

## Core runtime chains
- chat/session/memory
- speech/live2d
- danmaku
- job/adapter

## Python assets

| Asset | Path | Category | Chain | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| edge_tts adapter | python/tts/edge_tts_server.py | keep | speech/live2d | python-edge | Rust starts and supervises this adapter as the active speech backend today. |
| sovits adapter | python/tts/genie_api_server.py | freeze | speech/live2d | python-sovits | Runtime policy currently forces `edge_tts`, so this remains a retained but non-primary adapter. |
| train adapter | python/adapters/train_adapter.py | keep | job/adapter | python-train | This is a model-bound executor and fits the long-term edge-executor role. |
| eval adapter | python/adapters/eval_adapter.py | keep | job/adapter | python-eval | This is a supervised evaluation executor and does not need to own runtime lifecycle. |
| packaged SoVITS runtime | python/tts/sovits/GPT-SoVITS-v2pro-20250604/runtime/** | freeze | speech/live2d | python-sovits | This bundled runtime is large and noisy but may still be required for legacy SoVITS execution. |
| old SoVITS runtime bundle | python/tts/sovits/GPT-SoVITS-v2pro-20250604_OLD/** | delete | speech/live2d | platform | The `_OLD` tree is historical baggage and should not remain in the active source surface. |

Allowed `Category` values: `keep`, `migrate`, `freeze`, `delete`.

Python remains only for model-bound or training-bound edge execution. Runtime state, lifecycle, and user-facing system truth stay in Rust.

## JavaScript assets

| Asset | Path | Category | Chain | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| runtime smoke entrypoint | scripts/smoke-test.ts | freeze | chat/session/memory | platform | This verifies the unified daemon surface but remains a migration-era Node harness outside the Rust runtime. |
| intelligence eval runner | scripts/run-intelligence-eval.mjs | freeze | chat/session/memory | runtime | This drives offline evaluation against `/api/chat` and should stay an external harness instead of becoming control-plane logic. |
| tts readiness preflight | scripts/check-tts-readiness.mjs | freeze | speech/live2d | platform | This is an operational preflight wrapper over the Rust API and should not grow into a second control entrypoint. |
| legacy dashboard server | scripts/dashboard-server.mjs | delete | chat/session/memory | platform | This standalone Node dashboard duplicates observability that should live in Rust APIs and the React console. |
| knowledge maintenance scripts | scripts/clean-knowledge.js; scripts/list-knowledge.js; scripts/clean-knowledge.ts | migrate | chat/session/memory | memory | These direct SQLite maintenance entrypoints should move behind a typed Rust admin/import surface or be retired. |
| retired rollback helper | scripts/migration-rollback.ts | delete | chat/session/memory | platform | This file now only prints retirement guidance and should not remain as an active migration control surface. |
| one-click weights rollback | scripts/rollback-one-click.ts | freeze | job/adapter | platform | This is a narrow data recovery helper for model weights and should remain isolated from runtime orchestration. |

Allowed `Category` values: `keep`, `migrate`, `freeze`, `delete`.

## Scripts and tooling

| Asset | Path | Category | Chain | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| Unified runtime verification scripts | scripts/smoke-test.ts; scripts/test-fallback-e2e.ts; scripts/functional-equivalence*.ts; scripts/validate-fallback-deployment.ts | freeze | chat/session/memory | platform | These are migration verification harnesses around the Rust runtime and should stay external-only. |
| Speech and readiness scripts | scripts/check-tts-readiness.mjs; scripts/test-tts.js; scripts/generate-training-audio.* | freeze | speech/live2d | media | These scripts support speech validation and dataset preparation but should not own runtime lifecycle. |
| Intelligence and report scripts | scripts/run-intelligence-eval.mjs; scripts/generate-daily-report.mjs; scripts/analyze-cot-traces.mjs; scripts/verify-m1-cot.mjs | freeze | chat/session/memory | runtime | These produce evaluation and reporting artifacts and are acceptable as temporary tooling rather than product surfaces. |
| Knowledge import and cleanup scripts | scripts/clean-knowledge.*; scripts/list-knowledge.js; scripts/clean-canonical-facts.mjs; scripts/extract-policy-memory.mjs | migrate | chat/session/memory | memory | These manipulate persistent memory data directly and should be folded into Rust-owned admin/import flows. |
| Legacy dashboard and health utilities | scripts/dashboard-server.mjs; scripts/check-services.js; scripts/diagnose-llm-latency.js | delete | chat/session/memory | platform | These duplicate runtime observability that should come from the unified backend and web console. |
| Training and dataset scripts | scripts/*brain*.py; scripts/*brain*.ts; scripts/*brain*.js; scripts/train-lccc-batched.py; scripts/download-lccc-dataset.py; scripts/merge-batches.py | freeze | job/adapter | ml | These are offline data and training helpers that can remain outside the control plane while Python stays the model-bound executor. |
| Stress and manual test launchers | scripts/run-stress-test.bat; scripts/stress-test-live.ts; scripts/test-*.bat; scripts/test-chat-api.ps1; scripts/diagnose-services.bat | freeze | danmaku | platform | These manual operator scripts are useful during closure but should not expand into the long-term orchestration layer. |
| Legacy rollback helpers | scripts/migration-rollback.ts; scripts/rollback-one-click.ts | freeze | job/adapter | platform | These are recovery-only helpers and should stay isolated with explicit retirement boundaries. |

Allowed `Category` values: `keep`, `migrate`, `freeze`, `delete`.

## Freeze Rules

- Do not add new JavaScript control-plane entrypoints.
- Do not add new Python components that own runtime lifecycle.
- Prefer Rust for stateful orchestration.
- Prefer TypeScript for UI-facing tooling.

## Deletion Candidates

- `scripts/dashboard-server.mjs` duplicates monitoring that should come from Rust APIs plus `apps/web`.
- `scripts/migration-rollback.ts` is already retired and should be removed once no callers remain.
- `python/tts/sovits/GPT-SoVITS-v2pro-20250604_OLD/**` is historical baggage and should be removed in an isolated cleanup step.

## TODO and placeholder audit

| Item | Path | Severity | Chain | Why it matters | Proposed action |
| --- | --- | --- | --- | --- | --- |
| Job terminal state is inferred only by polling for `Stopped` adapters | crates/jobs/src/lib.rs | P0 | job/adapter | If an adapter exits abnormally or never reaches the exact observed state, the job can remain stuck in `running` and the control surface loses trustworthy completion semantics. | Replace loose polling-only completion with explicit terminal outcome handling and lifecycle tests for stop, failure, and duplicate-run paths. |
| TTS worker readiness timeout does not persist an explicit failed speech state | crates/media/src/lib.rs | P0 | speech/live2d | A readiness timeout currently aborts dispatch before a stable failure record is written back, leaving speech/live2d flow without deterministic backend truth for the request. | Persist a terminal failed TTS state on readiness timeout and cover the path with crate-local lifecycle tests. |
| Chat fallback path is not surfaced in response semantics | crates/orchestrator/src/lib.rs | P0 | chat/session/memory | The runtime can fall back from remote generation to local generation, but the response still looks like ordinary assistant output, so operators and UI cannot distinguish degraded behavior from normal behavior. | Add explicit response metadata for fallback origin and verify persistence plus response shape in orchestrator tests. |
| Danmaku reconnect and disconnect transitions are still under-specified | crates/gateway/src/lib.rs | P0 | danmaku | Reconnect polling updates some fields opportunistically, which risks stale session or upstream host data surviving across disconnect/failure transitions and leaving runtime state inconsistent. | Define explicit connect/reconnect/disconnect transition rules and add tests for retry metadata plus field cleanup on disconnect. |
| Dashboard page hardcodes a demo session id | apps/web/src/pages/DashboardPage.tsx | P1 | chat/session/memory | Fixed demo sessions keep UI behavior tied to migration-era assumptions and make session truth diverge from the backend-created session model. | Move default session behavior behind one explicit helper or config path and stop scattering per-page constants. |
| Creator chat page hardcodes a backstage session id | apps/web/src/pages/CreatorChatPage.tsx | P1 | chat/session/memory | This page bypasses the same session semantics as the rest of the runtime and keeps demo wiring alive in a user-facing control surface. | Reuse the same centralized session-default helper and remove page-local demo session constants. |
| Active TTS policy is forced to `edge_tts` behind a broader voice interface | crates/media/src/lib.rs | P1 | speech/live2d | The code advertises a more flexible voice/backend surface than the runtime actually supports today, which makes future UI and adapter behavior misleading. | Narrow the public/runtime type surface so the single active backend policy is explicit until multi-backend support really exists. |
| Unknown adapters still fall back to a placeholder Python sleep command | crates/jobs/src/python_adapter.rs | P1 | job/adapter | Placeholder adapter launches can make unsupported adapter IDs look superficially valid, which hides migration gaps and weakens lifecycle guarantees. | Replace the placeholder path with an explicit unsupported-adapter error or a tightly scoped test-only path. |
| Runtime page still carries demo-like default connection and helper values | apps/web/src/pages/RuntimePage.tsx | P2 | danmaku | Seeded room, uid, buvid, cookie, and helper session defaults add migration noise to the control surface even when they are not the source of backend truth bugs. | Reduce demo defaults to the minimum needed for local operation and move any remaining defaults into clearly labeled config or helpers. |
| Speech dispatch still posts hardcoded request identity such as `character_name = feibi` | crates/media/src/lib.rs | P2 | speech/live2d | Inline demo request assumptions make the speech path harder to reason about and keep policy spread across dispatch code instead of one explicit runtime configuration point. | Centralize request policy/configuration and remove inline demo-specific values from dispatch code. |

Allowed `Severity` values: `P0`, `P1`, `P2`.

P0 items must be cleared before expanding features on a chain. P1 items must have an owner and a destination. P2 items stay visible but do not block closure.

## Classification summary
