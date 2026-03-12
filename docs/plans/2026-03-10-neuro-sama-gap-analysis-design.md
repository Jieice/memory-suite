# Memory Suite Neuro-sama Gap Analysis Design

**Goal:** Produce a structured product-gap assessment for Memory Suite using Neuro-sama as a public reference point, then turn that assessment into a prioritized product/runtime/UI roadmap.

## Scope

This phase is a research and product-planning phase, not an implementation phase. It will compare Memory Suite's current capabilities against publicly observable AI VTuber patterns, with Neuro-sama as the main reference. The analysis will focus on:

1. realtime responsiveness
2. persona continuity and conversational memory
3. stream autonomy and reaction loops
4. Live2D / TTS / subtitle presentation quality
5. operator tooling and runtime observability
6. OBS-facing overlay quality and visual polish

## Inputs

### External inputs
- Publicly available descriptions, interviews, writeups, videos, and summaries about Neuro-sama and similar AI VTuber systems.
- Public descriptions of audience-facing behavior only; no attempt to infer private implementation details as fact.

### Internal inputs
- Current Memory Suite runtime architecture (`apps/daemon`, `crates/media`, `crates/orchestrator`, `crates/storage`)
- Current web operator surfaces (`apps/web/src/pages/*.tsx`)
- Current OBS overlays (`apps/web/overlays/*.html`)
- Existing plans and docs around unified runtime and Live2D playback behavior

## Method

For each evaluation dimension, the analysis will answer:
1. What publicly observable capability does the reference product exhibit?
2. What current Memory Suite capability already exists?
3. What is the actual gap: missing system, weak quality, or immature UI/polish?
4. What is the expected impact of closing that gap?
5. What priority should that work receive?

## Output structure

### Output A: Gap report
A narrative assessment of where Memory Suite is already aligned, where it is clearly behind, and where the difference is mostly polish rather than architecture.

### Output B: Prioritized backlog
A grouped backlog by subsystem:
- runtime / orchestration
- memory / persona
- danmaku interaction
- TTS / Live2D presentation
- admin web UI
- OBS overlays / stream presentation

Each backlog item should include:
- why it matters
- current state
- target state
- dependency notes
- suggested priority (P0/P1/P2/P3)

### Output C: Near-term roadmap
A phased roadmap oriented around stream impact:
- first: make the stream feel fast and coherent
- second: make the character feel persistent and reactive
- third: make the operator and overlay surfaces feel like a polished product

## Evaluation rubric

### P0
Missing capability or quality issue that blocks the core “AI streamer” feeling.

### P1
High-visibility improvement that significantly upgrades stream quality, autonomy, or operator control.

### P2
Meaningful improvement that increases immersion, consistency, or production value after P0/P1 are stable.

### P3
Nice-to-have polish or experimental enhancements.

## Constraints

- Do not overclaim private Neuro-sama internals that are not public.
- Treat public behavior as reference signals, not authoritative system diagrams.
- Ground Memory Suite assessment in actual repository evidence.
- Prefer practical backlog outcomes over abstract comparison.

## Deliverables from this phase

1. concise executive summary
2. dimension-by-dimension comparison table
3. prioritized backlog
4. 2–6 week roadmap proposal
5. admin UI / OBS polish direction
