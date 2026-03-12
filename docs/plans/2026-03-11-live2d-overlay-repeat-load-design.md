# Live2D overlay repeated-load glitch design

## Context
After switching the chat default voice to `zh-CN-YunxiNeural`, runtime timing improved materially, but the overlay still shows a playback-finish glitch: the same audio item can trigger a second `loadstart/error` after normal playback end. In the observed trace, playback reaches `audio:ended`, the overlay sends `ack completed`, and then the same `audio_url` is touched again, briefly driving the UI to `speech:error` before returning to idle.

This design focuses on the smallest root-cause-oriented fix. The goal is not only to hide the UI symptom, but to tighten the interaction between the overlay playback state machine and the `/api/live2d/speech/next` + `/api/live2d/speech/{id}/ack` queue semantics so the same finished item is not reprocessed.

## Problem statement
Current behavior suggests a race between three things:

1. The browser audio element reaching `ended`
2. The overlay performing async cleanup and `ack`
3. Polling logic continuing to call `maybePlayNextSpeech()` while the current item is transitioning out of playback

The daemon currently allows `/api/live2d/speech/next` to return the first queue item whose status is `pending` or `playing`. That resumable `playing` behavior is useful, but it means the frontend must be precise about when an item is still actively owned versus when it is already finishing. Today the overlay appears to have a gap where a just-finished item can still participate in follow-up handling, producing a duplicate load/error path.

## Recommended approach
Use a two-layer minimal fix:

1. **Frontend state-machine hardening in `apps/web/overlays/live2d.html`**
   - Add explicit local terminal/finishing protection for the current item.
   - Treat `ended` and `error` as one-shot finalization paths for the active item only.
   - Block poll-driven replay or re-finalization while an item is in its finishing window.

2. **Backend regression protection in `apps/daemon/tests/live2d_speech_api.rs` and, only if needed, a narrow daemon adjustment in `apps/daemon/src/lib.rs`**
   - Keep the existing resumable `playing` contract.
   - Explicitly verify that once an item is acknowledged into a terminal state (`completed` or `failed`), it can no longer be returned by `/api/live2d/speech/next`.
   - Only change daemon logic if tests show a real server-side leak; otherwise leave backend behavior intact and let the overlay fix own the race.

This keeps the blast radius small while still addressing the root cause class, not just the symptom.

## Alternatives considered

### A. Frontend-only duplicate-event guard
Only ignore repeated `ended`/`error` handling for the same audio instance.

- **Pros:** smallest code change
- **Cons:** can mask a queue ownership problem without clarifying the state transition model

### B. Frontend state-machine hardening with no backend changes
Add `finishing`/`finalized` local guards and leave the daemon untouched.

- **Pros:** likely sufficient for the currently observed bug, low blast radius
- **Cons:** still depends on implicit assumptions about `/speech/next` semantics

### C. Frontend hardening plus backend semantic regression coverage (**recommended**)
Harden the overlay, preserve current daemon semantics, and add a backend test that locks in the non-reappearance of terminal items.

- **Pros:** best balance of root-cause confidence and minimal scope
- **Cons:** slightly larger than a pure UI patch

## Detailed design

### 1. Overlay playback state machine
Extend the existing `speechState` with the minimum extra state needed to distinguish:

- no active item
- item actively playing
- item finishing/finalizing
- item already finalized locally

The implementation can use one or two fields such as `finishingId` and `finalizedIds` (or an equivalent single-state representation). The important behavior is:

- `playSpeechItem(item)` only proceeds if no item is active **and** no item is finishing.
- `ended` and `error` handlers must verify that they still belong to the active, non-finalized item.
- The first terminal event claims finalization ownership for that item.
- Any later event for the same audio element or item becomes a no-op.
- `maybePlayNextSpeech()` must not fetch another item until the current item is fully acknowledged and local playback state has been cleared.

This should eliminate the observed pattern where the same item emits a normal `ended`, then later triggers another `loadstart/error` path that corrupts the status badge.

### 2. Overlay sequencing rules
For the `ended` path:

1. mark item as finishing
2. schedule subtitle clear
3. send `ack completed`
4. clear local speech runtime
5. restore idle status
6. allow fetching the next item

For the `error` path:

1. mark item as finishing
2. send `ack failed`
3. clear local speech runtime
4. show `speech:error` only for the genuine active-item failure path
5. allow fetching the next item

Crucially, once step 1 happens, no other event for that item should be allowed to run its terminal branch.

### 3. Backend contract protection
Add or update a daemon test to assert:

- first `/speech/next` returns `speech-1` and marks it `playing`
- second `/speech/next` can still resume `speech-1` while it is truly playing
- after `ack completed` for `speech-1`, the next `/speech/next` must return `speech-2` (or `None` if no later item exists)
- the completed item must never reappear

If this test already passes under existing daemon behavior, no production backend code change is needed. If it fails, make the smallest daemon-side correction necessary to preserve the intended contract.

## Testing plan

### Automated
1. Add/adjust daemon regression coverage in `apps/daemon/tests/live2d_speech_api.rs`.
2. If feasible, add a narrow frontend-facing regression around one-shot finalization behavior; otherwise rely on runtime probe verification.

### Runtime verification
Re-run the existing Playwright overlay timing probe and confirm:

- only one valid playback lifecycle for a speech item
- `audio:ended` is not followed by a second terminal `audio:error` for the same item
- the badge does not flash to `speech:error` after successful playback
- queue advancement to the next item still works

## Non-goals
This change does **not** attempt to:

- redesign subtitle progression timing
- fix the currently observed subtitle truncation-at-end behavior
- replace polling with push-based queue ownership
- redesign resumable playback semantics beyond the minimum necessary test coverage

## Acceptance criteria
- A normal speech item can play to completion without a second load/error attempt for the same `audio_url`.
- The overlay no longer briefly shows `speech:error` after successful playback completion.
- `/api/live2d/speech/next` does not return an item after it has been acknowledged into a terminal state.
- Existing resumable behavior for genuinely in-progress `playing` items remains intact.
