# Memory Suite Long-Term Agent Upgrade Spec

This is the **long-term, incremental** engineering spec to evolve Memory Suite from a reactive chatbot into a **world-aware, proactive, continuously improving agent**.

## 0. Scope & Principles

### 0.1 Non-goals (for now)
- No heavy vision model on the main box (RTX 2070S 8GB). Vision is optional and postponed.
- No high-risk "always-training" during streaming.

### 0.2 Hard principles
- **Stability first**: streaming path must stay reliable.
- **Small steps**: each milestone must have measurable acceptance criteria.
- **No personality drift without gate**: training/evolution must have eval gate + rollback.
- **Separation of concerns**:
  - "Public reply" != "internal thinking".
  - "Short-term traces" != "long-term memory".

## 1. Hardware Constraints
Target machine: **R5 5500 + RTX 2070 Super 8GB + RAM 16GB**
- **Inference**: 4B GGUF Q4_K_M is OK.
- **Training**: must be **QLoRA/LoRA small-step**, low seq length, low batch, scheduled off-stream.

## 2. Milestones Overview

- **M1: CoT Hard Contract**
  - LLM outputs strict JSON schema.
  - System parses it, shows only `response`.
  - `thinking` written to trace JSONL (not to memory).

- **M2: Real WorldState Signals**
  - Replace placeholder metrics with real danmaku-derived stats and manager metadata.

- **M3: Continual Learning v1 (No training)**
  - Use traces + preference pairs to update policies / memory structures without weights update.

- **M4: Continual Learning v2 (QLoRA small-step)**
  - Offline adapter training + eval gate + auto rollback.

- **M5: Production Safety & Observability**
  - Resource guard, scheduling, versioning, dashboards, incident modes.

## 3. M1: CoT Hard Contract (Recommended First)

### 3.1 Contract Schema
LLM MUST output JSON only:

```json
{
  "thinking": {
    "observation": "string",
    "intent_analysis": "string",
    "social_strategy": "string",
    "confidence": 0.0
  },
  "response": "string",
  "meta": {
    "language": "zh|en|mixed",
    "safety": {
      "risk": "low|med|high",
      "notes": "string"
    }
  }
}
```

Notes:
- `thinking` is **internal only**.
- `response` is the only user-visible text.
- `confidence` is used for gating memory writes.

### 3.2 Storage (方案 A)
- Write every CoT result to JSONL trace file.
- **Do not** store raw `thinking` to long-term memory.

Recommended path:
- `memory-suite/data/traces/cot_traces.jsonl`

Each line includes:
- `timestamp`, `requestId`, `userId` (hashed/optional)
- `world_state_snapshot`
- `input_text`, `source`
- `thinking`, `response`
- `provider`, `latency_ms`
- `parse_ok`, `parse_error`

Implementation notes (current):
- Controlled by env flag: `COT_JSON_HARD_CONTRACT_ENABLED=true`.
- Trace path envs (optional overrides):
  - `COT_TRACE_PATH` (default: `../data/traces/cot_traces.jsonl` from `memory-universe` cwd).
  - `COT_BAD_TRACE_PATH` (default: `../data/traces/bad_cot_samples.jsonl`).

### 3.3 Parsing & Failure Behavior
- If parse fails:
  - Use existing fallback/rescue reply.
  - Write `bad_cot_samples.jsonl`.

System prompt sketch (for slow route):
- Strongly instruct LLM to output **only** the JSON object above (no markdown, no explanations).
- `thinking` in Chinese, concise but honest; `response` is live-friendly Simplified Chinese, within word budget.

### 3.4 Acceptance Criteria
- >= 95% CoT outputs parse successfully under stress test.
- Parse failure does not crash the request.
- Trace file grows with correct schema.

### 3.5 Basic Evaluation Tooling
- A simple CLI script (`scripts/analyze-cot-traces.mjs`) reads the latest `cot_traces.jsonl` and reports:
  - Global `parse_ok` ratio.
  - Breakdown by `route` (fast/slow) and `llmProvider` (local/deepseek).
- Use it to check M1 acceptance target (>= 95% parse success under load).

## 4. M2: Real WorldState Signals

### 4.1 WorldState v1 Schema
- `activity`: string
- `atmosphere`: float 0..1
- `danmaku_density_10s`: float
- `hot_topics_300s`: string[]
- `audience_pulse`: float 0..1
- `room_heat`: float 0..1
- `system_load`: { cpu, gpu, ram }

### 4.2 Data Sources
- Danmaku stream:
  - count per 10s, rolling 5-min word frequency.
  - sentiment classifier (lightweight lexicon first).
- Manager metadata:
  - current scene/game/activity name (manual override supported).

Implementation sketch:
- `memory-danmaku` (or equivalent danmaku service) maintains rolling windows:
  - every 10s: count of danmaku messages → `danmaku_density_10s`.
  - every 300s: word frequency map → top-K terms → `hot_topics_300s`.
  - simple lexicon-based sentiment on each danmaku → average over last 60–120s → `audience_pulse`.
- `manager` (or stream controller) exposes:
  - current `activity` (game / chatting / special segment), via REST or in-memory bridge.
- A small aggregator (can live in Manager):
  - every 10s, POST to `BrainNN /world/update`:
    - `activity`
    - `atmosphere` (normalized from chat density & sentiment, 0..1)
    - `danmaku_density`
    - `hot_topics`
    - optional: `audience_pulse`

### 4.3 Acceptance Criteria
- `hot_topics_300s` derived from real danmaku frequency.
- `atmosphere` correlates with real chat density.

## 5. M3: Continual Learning v1 (No training)

### 5.1 Goal
Improve behavior without weight updates:
- policy memory
- taboo rules
- audience-specific preferences

### 5.2 Inputs
- CoT traces JSONL
- online DPO pair logs

### 5.3 Outputs
- `policy_memory.json`
- `taboo_rules.json`
- optional: compact system prompt snippets

Suggested pipeline (offline, daily):
- Step 1: Sample from `cot_traces.jsonl` where:
  - `parse_ok=true`
  - `thinking.confidence` above a threshold (e.g. >= 0.6)
  - User feedback / DPO pairs indicate high quality behavior when available.
- Step 2: Distill *re-usable rules* instead of raw traces:
  - Persona rules: what fits the VTuber persona and what should be avoided.
  - Taboo rules: sensitive topics/phrases and how to defuse them.
  - Viewer preferences: per-viewer or per-cohort stable likes/dislikes.
  - Topic transitions: how to naturally move from topic A to B when fatigue is high.
- Step 3: Persist:
  - `policy_memory.json`: compact, human-auditable policies (short text).
  - `taboo_rules.json`: safety/avoidance rules.
  - Optionally: a few **very short** prompt snippets to inject into system prompt.

### 5.4 Acceptance Criteria
- Reduced repetition.
- Fewer unsafe outputs.

## 6. M4: Continual Learning v2 (QLoRA small-step)

### 6.1 Training Mode
- Off-stream only.
- Adapter training only (do not replace base weights).

### 6.2 Eval Gate
- Must run `eval:intelligence`.
- Must run safety checks.
- If fail: rollback to previous adapter.

### 6.3 Acceptance Criteria
- New adapter only promoted when eval improves.
- Automatic rollback works.

## 7. M5: Production Safety & Observability

### 7.1 Safety
- Resource guard: forbid training if GPU usage/temp high.
- Circuit breaker for unstable LLM.

### 7.2 Observability
- Metrics: p50/p95 latency, parse success, fallback rate.
- Daily report.

## 8. Open Questions (To Decide)
- Where to hash/strip `userId` in traces.
- Whether `thinking.confidence` gates memory writes.
- How to schedule training (Windows Task Scheduler vs pm2 cron-like).
