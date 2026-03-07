# BrainNN

BrainNN remains in this repository as a Python sidecar and model/tooling surface. It is no longer the primary runtime entrypoint.

## Current Role

- Optional Python sidecar used by the unified runtime
- Source of model logic, training helpers, and experimental cognition components
- Not a standalone operator surface

## Current Runtime Topology

- Primary runtime: `start-unified.bat`
- Operator UI: `http://127.0.0.1:8080`
- Unified daemon: Rust
- Web UI: React + TypeScript
- Python sidecars:
  - BrainNN: default `http://127.0.0.1:4007`
  - TTS adapter: default `http://127.0.0.1:3000`

## When To Start BrainNN Directly

Only start BrainNN directly if you are:

- developing BrainNN internals
- debugging sidecar integration
- running Python-only experiments or training flows

For normal operator use, start the unified runtime instead.

## Recommended Start Paths

### Operator Flow

```bat
start-unified.bat
```

### Sidecar / Local Debug Flow

```bash
cd brainnn
python server.py
```

## Integration Expectations

- The unified Rust daemon owns the control plane
- BrainNN is consumed as an adapter/sidecar, not as the top-level orchestrator
- Old references to `Memory Universe` as the active runtime should be treated as historical

## Verification

```bash
curl http://localhost:4007/health
curl http://localhost:8080/api/runtime/overview
```
