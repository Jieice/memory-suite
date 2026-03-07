# Bilibili Protocol Cutover Design

**Date:** 2026-03-06  
**Branch:** `codex/rust-unified-foundation`

## Context

The unified Rust runtime already owns:

- runtime persistence
- runtime and overlay websocket streams
- live2d runtime state
- a mock-safe danmaku gateway injection path

What still remains outside the Rust control plane is the real external danmaku protocol path:

- room bootstrap and real room resolution
- signed Bilibili danmaku info fetch
- websocket session lifecycle and reconnection
- raw event ingestion

Those protocol details still live in the old `memory-danmaku` Node implementation.

## Recommended Migration Shape

Do not port the entire old bridge in one jump.

Instead migrate it in three layers:

1. **Source config and connection state** owned by Rust
2. **Protocol adapter boundary** supervised by Rust
3. **Event normalization and routing** owned by Rust

That means Rust stays authoritative even if a temporary protocol-specific helper still exists during the transition.

## Architecture

### 1. Rust-owned danmaku source configuration

Rust should own:

- room id
- user uid
- buvid
- cookie presence state
- signature mode
- connection mode

This becomes the operator-visible source of truth and replaces ad-hoc `config.json` assumptions for runtime control.

### 2. Rust-owned connection state

Rust should persist and expose:

- disconnected / connecting / connected / failed
- last connect attempt
- last heartbeat
- last error
- current upstream host

This gives the runtime page real observability of the external danmaku path.

### 3. Temporary protocol adapter boundary

The first real protocol slice does not need a full Rust websocket implementation immediately.

A safe migration path is:

- keep protocol-specific handshake/signature complexity behind a supervised boundary
- make Rust own the lifecycle, state, and event normalization
- pull the protocol implementation into Rust later once the boundary is stable

This prevents the old Node bridge from remaining the orchestration authority.

## Success Criteria

This slice is complete when:

- Rust stores and serves danmaku source configuration
- Rust exposes danmaku connection state and lifecycle actions
- the runtime page can show real external danmaku connection posture
- the old bridge is demoted from control plane to protocol helper at most
