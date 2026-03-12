# Live2D Overlay Repeat-Load Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the Live2D overlay bug where a speech item can trigger a second load/error path after normal playback completion, without breaking resumable queue behavior.

**Architecture:** Keep the current polling + `/api/live2d/speech/next` queue model. First lock in the daemon contract with a regression test showing terminal items never reappear after `ack`. Then harden the overlay playback state machine so only the active, non-finalized item may run a terminal path, and only after local finalization fully completes may polling fetch the next item.

**Tech Stack:** Rust (`axum`, daemon integration tests), browser JavaScript in `apps/web/overlays/live2d.html`, Playwright-based runtime probe, existing local runtime scripts.

---

### Task 1: Lock in daemon terminal-item queue semantics

**Files:**
- Modify: `apps/daemon/tests/live2d_speech_api.rs`
- Inspect only if test fails: `apps/daemon/src/lib.rs:784-857`

**Step 1: Write the failing test**

Add or tighten a test in `apps/daemon/tests/live2d_speech_api.rs` that exercises this exact sequence:

```rust
#[tokio::test]
async fn completed_speech_items_do_not_reappear_in_next_queue_results() -> Result<()> {
    let state = sample_app_state().await?;
    {
        let mut queue = state.live2d_speech_queue.write().await;
        queue.push_back(sample_speech_record("speech-1", "session-a"));
        queue.push_back(sample_speech_record("speech-2", "session-a"));
    }
    let app = app_router(state);

    let next1 = app.clone().oneshot(
        Request::builder().uri("/api/live2d/speech/next").body(Body::empty())?
    ).await?;
    let payload1: Live2dSpeechNextResponse = parse_json(next1).await?;
    let first = payload1.item.expect("first queued item missing");
    assert_eq!(first.id, "speech-1");
    assert_eq!(first.status, "playing");

    let next2 = app.clone().oneshot(
        Request::builder().uri("/api/live2d/speech/next").body(Body::empty())?
    ).await?;
    let payload2: Live2dSpeechNextResponse = parse_json(next2).await?;
    let resumed = payload2.item.expect("playing item should be resumable");
    assert_eq!(resumed.id, "speech-1");

    let ack1 = app.clone().oneshot(
        Request::builder()
            .method("POST")
            .uri("/api/live2d/speech/speech-1/ack")
            .header("content-type", "application/json")
            .body(Body::from(json!({"status":"completed","error":null}).to_string()))?
    ).await?;
    assert_eq!(ack1.status(), StatusCode::OK);

    let next3 = app.clone().oneshot(
        Request::builder().uri("/api/live2d/speech/next").body(Body::empty())?
    ).await?;
    let payload3: Live2dSpeechNextResponse = parse_json(next3).await?;
    let second = payload3.item.expect("second queued item missing");
    assert_eq!(second.id, "speech-2");
    assert_eq!(second.status, "playing");

    Ok(())
}
```

If a nearly identical test already exists, narrow it so it explicitly describes the terminal-item contract and would fail if `speech-1` reappears after completion.

**Step 2: Run test to verify current behavior**

Run:
```bash
cargo test -p daemon completed_speech_items_do_not_reappear_in_next_queue_results -- --exact
```

Expected:
- Preferably `PASS` immediately, proving daemon semantics are already correct.
- If `FAIL`, the failure should show `speech-1` incorrectly reappearing after terminal ack.

**Step 3: Make the smallest backend change only if needed**

If the new test fails, inspect `apps/daemon/src/lib.rs:784-857` and make the narrowest change necessary so `/api/live2d/speech/next` never returns `completed` or `failed` items and never keeps a terminal item eligible through an unintended path.

Do **not** redesign queue ownership or resumable `playing` behavior.

**Step 4: Re-run the targeted test**

Run:
```bash
cargo test -p daemon completed_speech_items_do_not_reappear_in_next_queue_results -- --exact
```

Expected: `PASS`

**Step 5: Run related daemon queue coverage**

Run:
```bash
cargo test -p daemon live2d_speech -- --nocapture
```

Expected:
- Existing queue/resume tests remain green.
- No regressions in `next` / `ack` flow.

**Step 6: Commit**

```bash
git add apps/daemon/tests/live2d_speech_api.rs apps/daemon/src/lib.rs
git commit -m "test: lock live2d speech terminal queue semantics"
```

---

### Task 2: Add one-shot finalization guards to the overlay state machine

**Files:**
- Modify: `apps/web/overlays/live2d.html:172-178`
- Modify: `apps/web/overlays/live2d.html:390-497`

**Step 1: Write the failing behavior description as an inline target before editing**

Before touching logic, identify the exact behavior to enforce in the overlay code:

- `playSpeechItem(item)` must not start if another item is active or finishing.
- `ended` and `error` handlers must only finalize the currently active item once.
- After the first terminal event claims an item, all later terminal events for that same item become no-ops.
- `maybePlayNextSpeech()` must not fetch another item until finalization has finished.

Use the smallest new state needed, for example:

```js
let speechState = {
  currentId: null,
  finishingId: null,
  finalizedIds: new Set(),
  // existing fields...
};
```

You do not need to use this exact representation if a smaller equivalent is clearer.

**Step 2: Implement minimal state additions**

In `speechState`, add only the fields required to distinguish:
- active item
- finishing item
- already-finalized current item

Keep all existing subtitle, mouth-loop, and polling structures unless directly needed for the fix.

**Step 3: Implement a tiny helper for terminal ownership**

Add a very small helper near `playSpeechItem()` such as:

```js
function claimSpeechFinalization(itemId) {
  if (!itemId) return false;
  if (speechState.currentId !== itemId) return false;
  if (speechState.finishingId === itemId) return false;
  speechState.finishingId = itemId;
  return true;
}
```

And a matching cleanup helper such as:

```js
function releaseSpeechFinalization(itemId) {
  if (speechState.finishingId === itemId) {
    speechState.finishingId = null;
  }
}
```

Keep helpers tiny. No abstraction layer beyond this.

**Step 4: Guard `playSpeechItem(item)`**

Adjust `playSpeechItem(item)` so it returns early when:
- `speechState.currentId` is already set
- or `speechState.finishingId` is set
- or the item has already been finalized locally in the current playback cycle

The early return must be a pure no-op, not an `ack failed` path.

**Step 5: Make `ended` one-shot**

Change the `ended` event handler so it:

```js
if (!claimSpeechFinalization(item.id)) return;
scheduleSubtitleClear(item.assistant_text, 2000);
await ackSpeech(item.id, 'completed');
clearSpeechRuntime();
releaseSpeechFinalization(item.id);
setSpeechStatus('idle');
void maybePlayNextSpeech();
```

Important details:
- The handler must only run for the still-active item.
- `releaseSpeechFinalization()` should happen after local cleanup, not before.
- If `clearSpeechRuntime()` resets your new fields, keep the order consistent so the next poll does not reopen the race.

**Step 6: Make `error` one-shot**

Apply the same one-shot ownership idea to the `error` event path:

```js
if (!claimSpeechFinalization(item.id)) return;
await ackSpeech(item.id, 'failed', 'audio playback error');
clearSpeechRuntime();
releaseSpeechFinalization(item.id);
setSpeechStatus('error');
void maybePlayNextSpeech();
```

This must prevent the second `loadstart/error` after a normal `ended` from re-finalizing the same item.

**Step 7: Ensure cleanup clears new state**

Update `clearSpeechRuntime()` so it resets any new local finalization markers needed for the next item. Be careful not to clear them so early that the current terminal branch can be re-entered.

**Step 8: Review polling gate**

Update `maybePlayNextSpeech()` and/or `ensureSpeechPolling()` so polling will not fetch a next item while `finishingId` is still set.

Minimal target:

```js
if (dragState.active || speechState.currentId || speechState.finishingId) return;
```

**Step 9: Save with no unrelated cleanup**

Do not rename unrelated variables, refactor animation code, or touch subtitle timing beyond what the finalization fix requires.

**Step 10: Commit**

```bash
git add apps/web/overlays/live2d.html
git commit -m "fix: prevent live2d overlay speech re-finalization"
```

---

### Task 3: Verify the overlay fix with runtime probes

**Files:**
- Run only: `D:/AI/memory-suite/_temp_trace_chat_to_ready.py`
- Run only: `D:/AI/memory-suite/_temp_overlay_timing.py`
- If `networkidle` flakes again, run the existing fallback Playwright probe variant used in-session

**Step 1: Re-run queue timing probe**

Run:
```bash
python "D:/AI/memory-suite/_temp_trace_chat_to_ready.py"
```

Expected:
- `speech_ready` and `chat:response` remain nearly simultaneous.
- No queue regression from backend test or overlay changes.

**Step 2: Re-run overlay probe**

Run:
```bash
python "D:/AI/memory-suite/_temp_overlay_timing.py"
```

If it times out on `networkidle`, use the fallback Playwright probe that loads the page with `domcontentloaded` and `load` before triggering chat.

**Step 3: Verify the exact success conditions**

Inspect probe output and confirm all of the following:

- one playback lifecycle for the speech item
- `audio:ended` is **not** followed by a second terminal `audio:error` for the same `audio_url`
- the status badge does **not** flash to `speech:error` after a successful completion
- queue advancement still works after completion

**Step 4: If probe still shows duplicate terminal events, stop and debug before changing more code**

Do not stack more speculative fixes. Re-check whether:
- the duplicate path is coming from a second local event handler
- `clearSpeechRuntime()` is resetting state too early
- or the backend is still surfacing a finished item unexpectedly

**Step 5: Run focused daemon tests one more time**

Run:
```bash
cargo test -p daemon live2d_speech -- --nocapture
```

Expected: `PASS`

**Step 6: Commit verification-safe final state**

```bash
git add apps/web/overlays/live2d.html apps/daemon/tests/live2d_speech_api.rs apps/daemon/src/lib.rs
git commit -m "fix: remove live2d overlay repeat-load glitch"
```

Only include files actually changed.

---

### Task 4: Optional follow-up note if subtitle truncation remains

**Files:**
- No code required
- Optionally note in session handoff or follow-up issue

**Step 1: Check whether subtitle truncation still happens**

From the probe output, note whether subtitles still stop on a partial phrase after audio completion.

**Step 2: Do not fix it in this task**

If present, record it as a separate follow-up. This plan intentionally does not change subtitle progression behavior.

**Step 3: No commit for this task unless a note file is explicitly requested**

---

## Verification checklist

Before calling this work done, verify all boxes:

- [ ] Terminal speech items do not reappear in daemon `next` results.
- [ ] Overlay only finalizes each speech item once.
- [ ] Successful playback no longer flashes `speech:error`.
- [ ] No duplicate load/error path appears for the same finished audio URL.
- [ ] Existing resumable `playing` queue behavior still works.
- [ ] No unrelated subtitle or animation regressions were introduced.
