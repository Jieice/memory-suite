# Live2D OBS Runtime Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `/overlay/live2d` render the real Hiyori model in OBS instead of failing with `Live2DModel export unavailable`.

**Architecture:** Keep the current Rust daemon and static asset routing unchanged where possible. Fix the overlay by loading the correct local Live2D runtime bundle and, if needed, explicitly bridging its global exports into the page bootstrap so OBS/CEF can construct `Live2DModel`.

**Tech Stack:** Rust, Axum, static HTML/JS overlay, PixiJS 6, `pixi-live2d-display`, Playwright-style runtime verification.

---

### Task 1: Capture the failing runtime assumption

**Files:**
- Modify: `D:\AI\memory-suite\apps\daemon\tests\overlay_pages.rs`
- Inspect: `D:\AI\memory-suite\apps\web\overlays\live2d.html`

**Step 1: Write the failing test**

Add an assertion that the Live2D overlay references the runtime bundle we actually intend to support in OBS.

**Step 2: Run test to verify it fails**

Run: `cargo test -p daemon --test overlay_pages -- --nocapture`

Expected: the live2d overlay test fails because the page still points to the old runtime script path.

**Step 3: Write minimal implementation**

Update the overlay page and any required static route assumptions to use the intended local runtime bundle/bootstrap path.

**Step 4: Run test to verify it passes**

Run: `cargo test -p daemon --test overlay_pages -- --nocapture`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/tests/overlay_pages.rs apps/web/overlays/live2d.html
git commit -m "fix: switch live2d overlay to the supported local runtime bundle"
```

### Task 2: Bridge the runtime export for OBS

**Files:**
- Modify: `D:\AI\memory-suite\apps\web\overlays\live2d.html`
- Inspect: `D:\AI\memory-suite\apps\web\node_modules\pixi-live2d-display\dist\index.min.js`
- Inspect: `D:\AI\memory-suite\apps\web\node_modules\pixi-live2d-display\dist\cubism4.min.js`

**Step 1: Write the failing check**

Add a minimal runtime check in the overlay bootstrap that fails loudly if the expected global export is missing.

**Step 2: Run runtime verification to observe the failure**

Run the daemon, open `/overlay/live2d`, and confirm the page still reports the missing export before the fix.

**Step 3: Write minimal implementation**

Load the correct local bundle and normalize whichever global export it provides into the overlay bootstrap (`window.PIXI.live2d.Live2DModel` or equivalent) before model loading begins.

**Step 4: Run runtime verification to confirm the model loads**

Use browser automation or direct page inspection to confirm:
- no `Live2DModel export unavailable`
- model asset request succeeds
- stage contains a canvas and the model loader does not throw

**Step 5: Commit**

```bash
git add apps/web/overlays/live2d.html
git commit -m "fix: bridge live2d runtime exports for obs overlay"
```

### Task 3: Fresh verification against the unified runtime

**Files:**
- Verify only

**Step 1: Run focused tests**

Run:
- `cargo test -p daemon --test overlay_pages -- --nocapture`
- `npm run unified:web:build`

Expected: both commands pass.

**Step 2: Run unified verification**

Run:
- `npm run unified:test`

Expected: PASS.

**Step 3: Run live runtime verification**

Run the daemon and verify:
- `GET /overlay/live2d` returns `200`
- `GET /live2d-assets/hiyori_pro_t11.model3.json` returns `200`
- `/overlay/live2d` no longer reports the missing runtime export

**Step 4: Commit**

```bash
git add Cargo.lock
git commit -m "test: verify live2d obs runtime cutover"
```
