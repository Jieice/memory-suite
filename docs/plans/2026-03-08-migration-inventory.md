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

Allowed `Category` values: `keep`, `migrate`, `freeze`, `delete`.

## Scripts and tooling

| Asset | Path | Category | Chain | Owner | Notes |
| --- | --- | --- | --- | --- | --- |

Allowed `Category` values: `keep`, `migrate`, `freeze`, `delete`.

## TODO and placeholder audit

| Item | Path | Severity | Chain | Why it matters | Proposed action |
| --- | --- | --- | --- | --- | --- |

Allowed `Severity` values: `P0`, `P1`, `P2`.

## Classification summary
