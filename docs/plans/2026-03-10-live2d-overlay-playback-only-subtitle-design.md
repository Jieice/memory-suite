# Live2D Overlay Subtitle Playback-Only Design

Date: 2026-03-10

## Context
Users are seeing subtitle duplication: once immediately after LLM response (state subtitle), then again as a streaming subtitle during TTS playback. This creates a “double subtitle” effect and causes early clearing or desynchronization. The target behavior is: **show subtitles only during actual TTS playback**, as a streaming reveal aligned with audio start, and clear them when playback ends.

Current flow (relevant pieces):
- Backend writes `live2d_state.subtitle` as soon as the LLM response is finalized.
- Overlay `renderState()` writes this state subtitle to the DOM.
- Overlay `playSpeechItem()` separately starts a streaming subtitle loop.

This results in two competing subtitle writers.

## Goal
- Do not display subtitles before audio playback begins.
- Only render subtitle text from the playback flow (streaming text).
- Clear subtitle at playback end.
- Keep changes minimal and localized to the Live2D overlay frontend.

## Non-Goals
- Changing backend subtitle/state writes.
- Changing TTS pipeline timing or speech queue semantics.
- Changing behavior in other UI pages.

## Proposed Approach (Selected)
**Frontend-only change in `apps/web/overlays/live2d.html`:**
- Remove state subtitle rendering from `renderState()`.
- Keep `renderState()` for emotion/config updates only.
- Keep streaming subtitle logic in `playSpeechItem()` → `startSubtitleLoop()` as the sole writer to `subtitleEl`.
- Clear subtitles at playback end using the existing loop completion behavior.

## Alternatives Considered
1. **Ignore state subtitle only when playback active** (partial suppression).
   - Still allows idle-state subtitles, but can leak duplicates when playback starts.
2. **Backend removal of `set_subtitle` in finalize**.
   - Larger behavior change across the system; not required for this fix.

## Data Flow (After)
- LLM response → state subtitle still written (backend), **but overlay ignores it**.
- TTS item becomes ready → overlay starts playback → streaming subtitle begins.
- Playback ends → subtitle cleared.

## Edge Cases
- TTS playback fails: no subtitle shown (consistent with “playback-only” rule).
- Overlay refreshes while playback is active: no subtitle overwrite from state.
- Overlay refreshes while idle: subtitle remains empty/placeholder.

## Testing
Add/adjust overlay page tests to assert:
- `renderState()` does not write subtitle content (no direct `subtitleEl.textContent = state.subtitle` in idle flow).
- Streaming subtitle loop remains present.
- Playback gating remains (`speechState.currentId` guard).

## Rollout
- Update overlay HTML and tests.
- Run targeted daemon overlay tests.

## Success Criteria
- No subtitle appears until audio playback starts.
- Only one subtitle instance is displayed (streaming).
- Subtitle clears after playback ends.
