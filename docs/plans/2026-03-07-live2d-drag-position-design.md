# Live2D Drag Position Design

## Goal

Allow the user to drag the Live2D model directly inside `/overlay/live2d` and persist the resulting `x/y` values so the position survives refreshes, OBS reloads, and daemon restarts.

## Scope

- Add direct drag interaction to the Live2D model in `apps/web/overlays/live2d.html`.
- Keep the existing `scale/x/y` backend contract unchanged.
- Persist new `x/y` values via `POST /api/live2d/config`.
- Continue to use the Runtime page as the secondary fine-tuning surface.

## Recommended Approach

Implement drag on the Live2D model itself inside the overlay page.

### Why this approach

- It matches the OBS workflow: move what you see.
- It does not require new backend schema or new routes.
- It preserves the existing config model, so the Runtime page and overlay stay in sync.

## Interaction Design

- Pointer down on the model starts dragging.
- Pointer move updates the model position locally for immediate feedback.
- Pointer up persists normalized `x/y` back to the backend.
- Save failures show a visible overlay error instead of failing silently.
- `scale` remains controlled by the Runtime page for now.

## Data Flow

1. Overlay loads `/api/live2d/state`.
2. Overlay renders the model using the current `scale/x/y`.
3. User drags the model.
4. Overlay converts current stage coordinates to normalized `x/y` using viewport width and height.
5. Overlay calls `POST /api/live2d/config` with existing `scale` and new `x/y`.
6. Overlay refreshes local state from the API response.

## Constraints

- Dragging must not move the subtitle card.
- Position values must remain normalized `0..1`-style fractions so they stay resolution-independent.
- The overlay must still work in OBS browser source, so interaction code must stay dependency-light.

## Error Handling

- If persistence fails, keep the visual position where the user dropped it, but show an error badge/card.
- If the model is unavailable, existing runtime error behavior remains unchanged.

## Testing Strategy

- Add a server-side page test that asserts the overlay includes drag-save hooks.
- Run targeted daemon tests for overlay page serving.
- Run a real browser verification that drags the model and confirms `/api/live2d/state` reflects the new `x/y`.
