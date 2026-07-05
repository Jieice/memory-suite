# Voice STT Chat Redesign Plan

## Goal

Implement the approved Mic -> STT -> LLM -> TTS/Live2D redesign from `.agent/work/2026-07-05-voice-stt-chat-redesign/SPEC.md`.

## Architecture Approach

Use a daemon-visible but browser-owned voice session:

- Capture and VAD live in `apps/web` because microphone access is browser/Electron UI state.
- STT remains daemon-mediated through `/api/stt/transcribe`; the first implementation uses client-side VAD plus batch final transcription, with optional partial preview calls for long utterances. Partial text never triggers the model.
- Final transcript is the only input forwarded to `/api/chat`.
- Speech detection interrupts the active turn immediately by calling the existing session interrupt and Live2D speech cancel APIs before final transcript is ready.
- Runtime observability is added through new voice runtime events, published by the daemon so `/ws/runtime` and `/ws/overlay` can show the same chain.
- The main user control remains the existing `Mic 聊天` preference. No global hotkey or press-to-talk configuration returns to the main flow.

## Execution Routing and Topology

Default: direct, serial, continuation after verification.

Overrides:
- Slice 2: subagent recommended if execution context is tight, because it touches shared API types, daemon routing, and media tests.
- Slice 6: subagent recommended if execution context is tight, because it crosses overlay playback, daemon cancel events, and browser timing behavior.

Parallel-safe groups: none. The slices share contracts and should run in order.

Checkpoints: none. Continue through all slices after each slice verifies.

## Ordered Slice Sequence

### Slice 1: Lock the Voice Chain Contract in Code Comments and Tests

**Objective:** Add a small, testable voice-chain model in the web layer that names the state machine and transition rules before wiring microphone hardware.

**Acceptance criteria:**
- A new web voice module defines the states `idle`, `arming`, `listening`, `speech_detected`, `finalizing_asr`, `thinking`, `speaking`, `interrupted`, `failed`, and `cooldown`.
- Transition helpers reject invalid jumps that would hide failures, such as `listening -> thinking` without a final transcript.
- Unit tests cover normal turn flow, silence timeout flow, STT failure flow, and interrupt flow.

**Touches:** `apps/web/src/voice/*`, `apps/web/src/**/*.test.ts`

**Produces:** A reusable voice session state model with focused Jest coverage.

**Verification:** `npm run readiness:test` passes and includes the new voice state tests.

**Status:** complete

**Evidence:** Added `apps/web/src/voice/sessionState.ts` and `apps/web/src/voice/sessionState.test.ts`; `npm run readiness:test` passed with 2 test suites and 10 tests, including normal turn, silence timeout, STT failure, interrupt, and invalid transition coverage.

**Risks / next:** none.

### Slice 2: Add Daemon Voice Runtime Events

**Objective:** Extend runtime events so the voice chain can publish capture, VAD, STT, LLM, and interruption milestones through the existing runtime bus.

**Acceptance criteria:**
- `RuntimeEventKind` includes voice milestones from the SPEC: `capture_started`, `capture_stopped`, `vad_open`, `vad_close`, `stt_partial`, `stt_final`, `stt_failed`, `llm_started`, `llm_completed`, `llm_failed`, `tts_interrupted`.
- TypeScript bindings regenerate with the new event kinds.
- A daemon route accepts trusted local voice event posts from the web UI and republishes them through `RuntimeBus`.
- Existing runtime websocket subscribers continue receiving old event kinds.

**Touches:** `crates/api-types/src/lib.rs`, `apps/daemon/src/routes/*`, `apps/daemon/src/lib.rs`, `apps/web/src/generated/api.ts`, `apps/web/src/lib.ts`

**Produces:** A daemon-visible voice event contract and web client helper.

**Verification:** `npm run unified:types` passes, then `cargo test -p api-types -p daemon -- --test-threads=1` passes.

**Execution:** subagent recommended

**Depends on:** Slice 1

### Slice 3: Restore Browser Mic Capture with Client VAD

**Objective:** Implement a browser/Electron microphone controller that auto-arms when `Mic 聊天` is enabled and closes utterances with VAD silence detection.

**Acceptance criteria:**
- The controller uses `navigator.mediaDevices.getUserMedia`, `AudioContext`/analyser energy, and `MediaRecorder` without global hotkeys.
- Enabling `Mic 聊天` requests/uses microphone permission and moves through `arming -> listening`.
- Voice energy opens VAD, emits `vad_open`, records audio chunks, and emits `vad_close` after a silence tail.
- Disabling `Mic 聊天` stops tracks, timers, recorder, and audio context.
- Permission denial and unsupported browser APIs land in `failed` with a visible status.

**Touches:** `apps/web/src/voice/*`, `apps/web/src/App.tsx`, `apps/web/src/preferences.ts`, `apps/web/src/styles.css`

**Produces:** A running mic capture loop with no Dashboard press-to-talk entry.

**Verification:** `npm --prefix apps/web run build` passes; `npm run readiness:test` passes.

**Depends on:** Slice 2

### Slice 4: Wire Final Transcript to Chat

**Objective:** Send closed utterances to STT, normalize the final transcript, and forward only non-empty final text to `/api/chat`.

**Acceptance criteria:**
- On `vad_open`, the client interrupts the active session and cancels active Live2D speech before STT finishes.
- On utterance close, the recorded audio is sent to `/api/stt/transcribe`.
- Empty, whitespace-only, or failed STT results do not call `/api/chat`; they publish `stt_failed` or return to `listening`.
- Final text publishes `stt_final`, then calls `/api/chat`, then maps chat completion/failure to `llm_completed` or `llm_failed`.
- The response still enters existing TTS/Live2D finalization through the current `/api/chat` route.

**Touches:** `apps/web/src/voice/*`, `apps/web/src/lib.ts`, `apps/web/src/App.tsx`

**Produces:** A full Mic final-transcript-to-chat path using existing STT and chat APIs.

**Verification:** `npm --prefix apps/web run build` passes; `npm run readiness:test` passes.

**Depends on:** Slice 3

### Slice 5: Add Partial STT Preview for Long Utterances

**Objective:** Add optional partial transcription for long speech segments without letting interim text trigger the model.

**Acceptance criteria:**
- During a long open VAD segment, the controller may submit bounded audio windows to `/api/stt/transcribe` for `stt_partial`.
- Partial transcript is displayed as provisional UI/status only.
- Partial calls are throttled and cancelled when the utterance closes.
- The final full utterance remains the only transcript forwarded to `/api/chat`.

**Touches:** `apps/web/src/voice/*`, `apps/web/src/styles.css`

**Produces:** Low-latency transcript feedback without duplicate model replies.

**Verification:** `npm --prefix apps/web run build` passes; `npm run readiness:test` covers that partial transcripts do not call chat.

**Depends on:** Slice 4

### Slice 6: Harden End-to-End Interruption

**Objective:** Make user speech reliably stop active TTS and Live2D playback across daemon queue state and overlay audio state.

**Acceptance criteria:**
- New voice turn start calls both `/api/sessions/{session_id}/interrupt` and `/api/live2d/speech/cancel`.
- Speech cancellation publishes `tts_interrupted` or an equivalent explicit runtime event in addition to the existing failed speech status.
- The overlay immediately pauses audio and clears mouth/subtitle loops when it receives the interruption event for the active speech id.
- A stale cancelled speech item cannot resume after the next polling tick.
- Tests cover queue cancellation and generation invalidation.

**Touches:** `apps/web/src/voice/*`, `crates/media/src/lib.rs`, `apps/daemon/src/routes/chat.rs`, `apps/web/overlays/live2d.html`, `apps/daemon/tests/*`

**Produces:** A provable interruption path from microphone speech start to stopped OBS/Live2D audio.

**Verification:** `cargo test -p media -p daemon -- --test-threads=1` passes; `npm --prefix apps/web run build` passes.

**Execution:** subagent recommended

**Depends on:** Slice 4

### Slice 7: Add Operator-Visible Voice Status

**Objective:** Surface the voice chain state in the unified window without reintroducing press-to-talk or hotkey configuration.

**Acceptance criteria:**
- The unified UI shows compact Mic status, current transcript/provisional transcript, and last failure in a persistent non-Dashboard-specific location.
- Settings still expose only the simple `Mic 聊天` enable switch plus provider/STT configuration.
- The UI has no press-and-hold button, global hotkey editor, or Dashboard mic trigger.
- The status view can distinguish listening, speech detected, transcribing, thinking, speaking, interrupted, and failed.

**Touches:** `apps/web/src/App.tsx`, `apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/styles.css`, `apps/web/src/voice/*`

**Produces:** A compact operator-facing voice state surface.

**Verification:** `npm --prefix apps/web run build` passes; `rg -n "按住说话|快捷键|全局麦克风|onMicHotkey" apps/web/src apps/electron` returns no active UI path.

**Depends on:** Slice 6

### Slice 8: Full Chain Regression

**Objective:** Verify that the redesigned chain builds and preserves existing text chat, TTS, runtime config, and overlay behavior.

**Acceptance criteria:**
- Rust API/types/tests pass for touched crates.
- Web build and readiness tests pass.
- Existing text probe still sends chat and queues TTS.
- STT config test path still supports local `faster-whisper` and OpenAI-compatible endpoint configuration.
- No global hotkey/PTT configuration reappears.

**Touches:** verification only

**Produces:** Final verification evidence for the redesigned voice chain.

**Verification:** `npm test` passes; `npm run smoke:quick` passes if the local runtime can be started in the current environment.

**Depends on:** Slice 7

## Aggregate Verification Commands

| Slice | Command |
|-------|---------|
| 1 | `npm run readiness:test` |
| 2 | `npm run unified:types`; `cargo test -p api-types -p daemon -- --test-threads=1` |
| 3 | `npm --prefix apps/web run build`; `npm run readiness:test` |
| 4 | `npm --prefix apps/web run build`; `npm run readiness:test` |
| 5 | `npm --prefix apps/web run build`; `npm run readiness:test` |
| 6 | `cargo test -p media -p daemon -- --test-threads=1`; `npm --prefix apps/web run build` |
| 7 | `npm --prefix apps/web run build`; `rg -n "按住说话|快捷键|全局麦克风|onMicHotkey" apps/web/src apps/electron` |
| 8 | `npm test`; `npm run smoke:quick` |
