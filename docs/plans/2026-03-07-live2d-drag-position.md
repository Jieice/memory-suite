# Live2D Drag Position Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add drag-to-save Live2D positioning directly inside `/overlay/live2d`.

**Architecture:** Keep the backend contract unchanged and implement drag in the overlay page. The overlay updates local model coordinates during drag, persists normalized `x/y` via `/api/live2d/config` on pointer release, then refreshes state from the API response.

**Tech Stack:** Rust (Axum tests), HTML/CSS/JS overlay, Playwright-based browser verification

---

### Task 1: Lock the drag-save contract into the overlay page test

**Files:**
- Modify: `D:\AI\memory-suite\apps\daemon\tests\overlay_pages.rs`

**Step 1: Write the failing test**

Assert that `/overlay/live2d` includes:
- a drag hint token
- a pointer-down hook
- a save call to `/api/live2d/config`

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test overlay_pages -- --nocapture`
Expected: FAIL because the overlay page does not yet expose the drag-save hooks.

**Step 3: Write minimal implementation**

No production code in this task.

**Step 4: Run test to verify it still fails for the expected reason**

Run the same command and verify the failure text maps to missing drag-save markup/scripts.

**Step 5: Commit**

Skip commit until the implementation is green.

### Task 2: Implement drag-to-save behavior in the overlay page

**Files:**
- Modify: `D:\AI\memory-suite\apps\web\overlays\live2d.html`

**Step 1: Write the minimal implementation**

- Add a small drag hint badge.
- Register pointer handlers on the model.
- During drag, update local `x/y`.
- On pointer release, call `/api/live2d/config` with the current scale and new `x/y`.
- Surface a visible save error if persistence fails.

**Step 2: Run targeted test**

Run: `cargo test -p daemon --test overlay_pages -- --nocapture`
Expected: PASS

**Step 3: Refactor**

Keep drag helpers isolated and avoid mixing drag state with fetch/bootstrap logic.

**Step 4: Re-run test**

Run the same command and keep it green.

**Step 5: Commit**

Skip commit until browser verification also passes.

### Task 3: Verify drag persistence in a real browser

**Files:**
- Reuse or create temporary verification helper under `D:\AI\memory-suite\runtime\`

**Step 1: Write verification helper**

Create a browser script that:
- opens `/overlay/live2d`
- waits for the model canvas
- drags the canvas/model area
- fetches `/api/live2d/state`
- asserts `x/y` changed

**Step 2: Run verification**

Run a local daemon and the verification script.
Expected: PASS with new normalized coordinates returned by `/api/live2d/state`.

**Step 3: Clean up**

Keep only reusable verification artifacts.

**Step 4: Final regression**

Run:
- `cargo test -p daemon --test overlay_pages -- --nocapture`
- `npm run unified:web:build`

Expected: both commands pass.

**Step 5: Commit**

```bash
git add D:\AI\memory-suite\apps\daemon\tests\overlay_pages.rs D:\AI\memory-suite\apps\web\overlays\live2d.html D:\AI\memory-suite\docs\plans\2026-03-07-live2d-drag-position-design.md D:\AI\memory-suite\docs\plans\2026-03-07-live2d-drag-position.md
git commit -m "feat: add drag-save live2d positioning"
```
