# Legacy Retirement Map

## Purpose

This document maps which parts of the old runtime are already replaced by the unified Rust runtime and which parts are still pending retirement.

## `manager/`

### Already replaced

- primary operator runtime overview
- supervised adapter start controls
- train/eval queue creation
- legacy import trigger

### Still pending or partial

- tool marketplace and tool execution surfaces
- knowledge scheduler and showrunner-specific manager features
- some operator UX that still only exists in the old manager pages

## `memory-live2d/`

### Already replaced

- live2d runtime state storage
- subtitle updates
- emotion updates
- model config updates
- overlay event stream

### Still pending or partial

- final replacement of legacy HTML/JS overlay assets
- any browser-side behavior that still assumes the old Node live2d server shape

## `memory-danmaku/`

### Already replaced

- a Rust-owned gateway injection path for danmaku-style ingress
- Rust-owned danmaku source configuration and connection state
- runtime page controls for source save, connect, and disconnect
- Rust-owned session callback state for helper open/error/close events
- Rust-owned reconnect scheduling and retry timing
- Rust-owned semantic normalization for decoded danmaku/gift/superchat/guard events
- runtime event emission from danmaku ingress
- live2d subtitle bridge from danmaku ingress
- supervised protocol adapter launch from the Rust connect path
- Rust-owned native websocket probe against Bilibili upstream
- Rust-owned native one-shot websocket ingest
- Rust-owned native websocket session worker with reconnect scheduling after upstream close

### Still pending or partial

- none in this branch for the former `memory-danmaku/` runtime surface

### Retirement status

- `memory-danmaku/` is retired and deleted from this branch
- remaining danmaku work is now inside the Rust runtime only

## Retirement Rule

No legacy directory should be deleted until the matching Rust-owned path is both:

- functionally exercised from the web/runtime workflow
- covered by repeatable verification commands or tests
