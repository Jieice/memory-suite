# Memory Suite v9.0 "The Soul Upgrade" Implementation Roadmap

This document outlines the architectural shift from a reactive chatbot to a proactive, world-aware AI agent (Neuro-sama level).

## 1. Architectural Overview
The v9.0 upgrade introduces a **Triple-Loop Architecture**:
1.  **Perception Loop**: Real-time synchronization of stream environment into `WorldState`.
2.  **Cognition Loop**: Mandatory CoT (Chain-of-Thought) reasoning for "True Understanding".
3.  **Evolution Loop**: Asynchronous daily LoRA fine-tuning based on high-quality interaction pairs.

## 2. Completed Components (Phase 1)
- [x] **WorldModel Schema**: Defined `WorldState` (activity, atmosphere, topics) in `BrainNN`.
- [x] **Soul Expansion**: Added `expression_desire` and `WorldState` integration to `SoulState`.
- [x] **Thinking Protocol**: Implemented mandatory CoT instructions in `generate_mood_instruction`.
- [x] **Proactive Engine**: Implemented `/tick` endpoint to trigger speech based on boredom and desire levels.

## 3. Immediate Next Steps (Phase 2)

### 3.1 WorldState Integration (Memory Universe)
Update `SoulOrchestrator.ts` to actively push world data to `BrainNN`.
- **Target**: `memory-universe/src/core/SoulOrchestrator.ts`
- **Action**: Add a background interval that scrapes `activity` (from Manager) and `atmosphere` (from Danmaku density) and posts to `BrainNN /world/update`.

### 3.2 Self-Evolution Pipeline
Deploy and test the `scripts/self_evolution_loop.py`.
- **Pre-requisites**: Install `unsloth`, `torch`, `peft`.
- **Workflow**: 
    1. Collect `online_pairs.jsonl`.
    2. Filter by `score > 0.8`.
    3. Run nocturnal LoRA training.
    4. Auto-update `.env` with the new model path.

### 3.3 Enhanced Prompt Engineering
Refine the `System Prompt` to handle the new JSON CoT output.
- **Goal**: Ensure the LLM understands it must analyze the "Social Strategy" before replying.

## 4. Hardware Guidelines
- **Inference**: Qwen3-4B-Instruct (GGUF Q4_K_M) requires ~4GB VRAM.
- **Evolution**: Unsloth LoRA training requires ~12GB VRAM (RTX 3060 12G+).
- **Vision (Optional)**: If upgrading to Vision, Moondream2 requires an additional 2GB VRAM.

## 5. Vision for v10.0
- **Knowledge Graph Integration**: Moving from flat RAG to structured "Opinions & Values".
- **Cross-Platform Awareness**: Real-time awareness of other streamers/events.
