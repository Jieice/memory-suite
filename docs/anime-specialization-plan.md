# Anime Specialization Plan

## Goal
- Build a live-stream specific anime persona stack with two layers:
1. `LoRA`: style stability (catchphrases, tone, speech rhythm).
2. `Trait NN`: runtime variability (surprise, playfulness, intimacy, directness).

## Why two layers
- `LoRA` is slow-changing and identity-stable.
- `Trait NN` is fast-changing and context-adaptive.
- Together: stable persona + controlled unpredictability.

## Runtime architecture in this repo
1. `brainnn/server.py` emits:
   - `trait_signal`
   - enriched `style_guidance`
   - enriched `reply_constraints`
2. `memory-universe/src/core/SoulOrchestrator.ts` consumes those fields in prompt policy.
3. LLM stays free-form; no hard template output required.

## Live tuning (creator private chat)
- You can tune Trait NN during stream prep via creator channel commands:
  - `/trait status`
  - `/trait list`
  - `/trait <profile>`
  - `/trait variation <0-1>`
  - `/trait novelty <0-1>`
  - `/trait on|off`
  - `/trait reset`
- Current profiles:
  - `moe_balanced`
  - `tsundere_playful`
  - `seiso_gentle`
  - `denpa_chaotic`

## LLM routing tuning (creator private chat)
- Runtime cloud switch without restart:
  - `/llm status`
  - `/llm cloud status`
  - `/llm cloud on`
  - `/llm cloud off`
  - `/llm cloud auto`
- API replies include `llmProvider` (`local` / `deepseek` / `unknown`) for observability.

## LoRA training scope
- Train only for style/persona expression, not factual memory.
- Data sources:
  - creator private chat exports
  - approved danmaku segments
  - scripted roleplay snippets (optional)
- Keep a strict filter:
  - remove unsafe claims
  - remove identity leakage
  - remove low-quality repeats

## LoRA corpus export in repo
- Script: `scripts/build-anime-lora-corpus.mjs`
- Command: `npm run prepare:lora:anime`
- Default output:
  - `data/lora/anime_sft.jsonl`
  - `data/lora/anime_sft.stats.json`

## DPO pair export in repo
- Script: `scripts/build-dpo-pairs.mjs`
- Command: `npm run prepare:dpo:anime`
- Default output:
  - `data/dpo/anime_pairs.jsonl`
  - `data/dpo/anime_pairs.stats.json`

## Trait NN training scope
- Predict per-turn policy heads:
  - novelty target
  - expressiveness
  - intimacy bias
  - tsundere or chaos bias
  - directness (creator channel vs public)
- Inputs:
  - soul state
  - source (`creator` / `danmaku` / `gift`)
  - short context stats
- Outputs are not final text. They are generation control signals.

## Evaluation gates before live
1. `Name safety`: no unsafe ID spoken.
2. `Creator channel correctness`: creator identity always grounded.
3. `Style diversity`: no repeated template lines.
4. `Factual honesty`: uncertainty phrasing appears for unverifiable claims.
5. `Latency`: fast route remains within current SLO budget.

## About GPT-5.2-pro usage
- Not required for runtime serving.
- Recommended for offline tasks:
  - data cleaning
  - style annotation
  - synthetic augmentation draft generation
  - policy rubric design
- Keep online inference on your current local/cloud stack for cost and latency control.
