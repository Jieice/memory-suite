# DeepSeek And TTS Rate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Switch the local runtime LLM to DeepSeek and add configurable edge-tts speech-rate support so chat playback can speak faster at rate 1.4 without regressing existing subtitle / speech behavior.

**Architecture:** Keep the existing Rust config and chat orchestration flow, but change the active local runtime configuration to use DeepSeek's OpenAI-compatible endpoint and model. Extend the existing `TtsConfig` and edge-tts request path with one small optional speech-rate field that defaults to current behavior when absent, then set the active local runtime to `1.4`.

**Tech Stack:** Rust, Tokio, reqwest, TOML config loading, FastAPI Python adapter, Playwright/manual runtime verification.

---

### Task 1: Add failing config tests for TTS speech rate

**Files:**
- Modify: `crates/app-config/tests/config_loading.rs`
- Modify: `crates/app-config/src/lib.rs`
- Test: `crates/app-config/tests/config_loading.rs`

**Step 1: Write the failing test**

Add assertions to `loads_from_toml_and_applies_environment_overrides()` proving the config layer can read an explicit TTS speech-rate override.

Add a second focused test proving `MEMORY_SUITE_TTS_RATE` overrides TOML.

Example test shape:

```rust
#[test]
fn tts_rate_can_be_loaded_from_toml_and_env() {
    // write app.toml with [tts] speech_rate = "1.2"
    // set MEMORY_SUITE_TTS_RATE=1.4
    // load config
    // assert_eq!(config.tts.speech_rate.as_deref(), Some("1.4"));
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p app-config tts_rate_can_be_loaded_from_toml_and_env -- --exact --test-threads=1
```

Expected: FAIL because `TtsConfig` does not yet have a speech-rate field.

**Step 3: Write minimal implementation**

In `crates/app-config/src/lib.rs`:
- add `speech_rate: Option<String>` to `TtsConfig`
- load `MEMORY_SUITE_TTS_RATE`
- preserve current behavior when the field is missing

**Step 4: Run test to verify it passes**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p app-config tts_rate_can_be_loaded_from_toml_and_env -- --exact --test-threads=1
```

Expected: PASS.

**Step 5: Run nearby config coverage**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p app-config config_loading -- --test-threads=1
```

Expected: PASS with no regressions in existing config loading.

**Step 6: Commit**

```bash
git add crates/app-config/src/lib.rs crates/app-config/tests/config_loading.rs
git commit -m "test: add tts speech rate config coverage"
```

---

### Task 2: Add failing media / edge-tts dispatch test for speech rate propagation

**Files:**
- Modify: `crates/media/src/lib.rs`
- Modify: `apps/daemon/tests/live2d_speech_api.rs` or add media unit test in `crates/media/src/lib.rs`
- Test: same file as added test

**Step 1: Write the failing test**

Prefer a focused unit or integration test that proves edge-tts dispatch includes the configured speech rate in the POST payload.

Recommended shape:
- start a tiny HTTP test server
- configure `TtsConfig` with `speech_rate = Some("1.4".into())`
- call the dispatch path
- assert the server received JSON containing `"rate":"1.4"`

If a narrower helper extraction is needed, first write the failing test around the extracted payload builder.

**Step 2: Run test to verify it fails**

Run the exact targeted test you added, for example:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p media edge_tts_dispatch_includes_configured_speech_rate -- --exact --test-threads=1
```

Expected: FAIL because the current JSON body only sends `character_name`, `text`, and `voice`.

**Step 3: Write minimal implementation**

In `crates/media/src/lib.rs`:
- thread `speech_rate` through `TtsConfig`
- include it in the `/tts` JSON request only when present and non-empty
- do not change sovits behavior beyond harmlessly ignoring an absent field

Keep the current `enqueue()` / `dispatch_to_python_worker()` architecture intact.

**Step 4: Run test to verify it passes**

Run the exact test from Step 2 again.

Expected: PASS.

**Step 5: Run nearby media tests**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p media --lib -- --test-threads=1
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crates/media/src/lib.rs
git commit -m "feat: send configurable tts speech rate"
```

---

### Task 3: Add failing Python adapter test or minimal verification hook for `rate`

**Files:**
- Modify: `python/tts/edge_tts_server.py`
- Create or modify: `python/tts/tests/test_edge_tts_server.py` if a Python test location exists; otherwise add a minimal daemon/media-level verification path only if no Python tests exist
- Test: corresponding Python test file

**Step 1: Write the failing test**

Preferred behavior:
- request model accepts optional `rate`
- `synthesize_with_edge_tts()` passes that rate to `edge_tts.Communicate(...)`

Example shape:

```python
def test_synthesize_with_edge_tts_passes_rate(monkeypatch):
    captured = {}
    class FakeCommunicate:
        def __init__(self, text, voice, rate=None):
            captured['rate'] = rate
        async def stream(self):
            yield {'type': 'audio', 'data': b'abc'}
```

Assert `captured['rate'] == '1.4'`.

If there is no existing Python test harness, create the smallest targeted test file necessary.

**Step 2: Run test to verify it fails**

Run the exact Python test command appropriate to the repository, for example:

```bash
pytest D:/AI/memory-suite/python/tts/tests/test_edge_tts_server.py -q
```

Expected: FAIL because `rate` is not yet modeled or passed through.

**Step 3: Write minimal implementation**

In `python/tts/edge_tts_server.py`:
- add optional `rate: str | None = None` to `TTSRequest`
- update `synthesize_with_edge_tts(text, voice_name, rate=None)`
- call `edge_tts.Communicate(text, voice_name, rate=rate)` only when rate is provided, or pass it directly if the library supports `None`
- do not change fallback Windows SAPI behavior

**Step 4: Run test to verify it passes**

Re-run the exact Python test from Step 2.

Expected: PASS.

**Step 5: Run any nearby Python adapter checks**

Run the smallest relevant command available, or note clearly if no broader Python test suite exists.

**Step 6: Commit**

```bash
git add python/tts/edge_tts_server.py python/tts/tests/test_edge_tts_server.py
git commit -m "feat: support configurable edge tts rate"
```

---

### Task 4: Switch the active local runtime config to DeepSeek and TTS rate 1.4

**Files:**
- Modify: `config/app.toml`
- Optional reference only: `config/app.toml.example`

**Step 1: Write the failing config expectation**

Because this is an active local runtime configuration change, use a verification-first workflow instead of a committed automated secret test:
- record the current values from `config/app.toml`
- define the target values

Target runtime config:

```toml
[tts]
provider = "edge_tts"
endpoint = "http://127.0.0.1:9881"
health_path = "/voices"
chat_voice = "edge-tts-zh"
speech_rate = "1.4"

[llm]
endpoint = "https://api.deepseek.com/v1/chat/completions"
model = "deepseek-chat"
api_key = "<local secret>"
system_prompt = "你是 Memory Suite 直播运行时助手。默认使用简体中文直接回复，保持自然、简洁、可执行，避免模板腔和自我介绍。"
```

**Step 2: Apply the minimal config change**

Edit only `config/app.toml`.

Do not update `config/app.toml.example` with the real key.
If you want documentation parity, leave example key blank.

**Step 3: Restart runtime**

Run:

```bash
D:/AI/memory-suite/start-unified.bat
```

Expected: unified daemon starts successfully.

**Step 4: Verify health**

Run:

```bash
python -X utf8 -c "import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=5); print(r.status); print(r.read().decode('utf-8'))"
```

Expected: `200` and healthy JSON.

**Step 5: Verify DeepSeek-backed chat and ready speech**

Run a short prompt and confirm:
- HTTP 200
- `speech.status == ready`
- assistant text is natural Chinese

**Step 6: Commit (config-only if desired locally, but do not commit secrets)**

If a commit is made, never include the real key. Prefer skipping commit for secret-bearing config.

---

### Task 5: Run full regression and browser verification

**Files:**
- Modify only if verification reveals a real bug
- Test: existing Rust tests and temporary local browser script if needed

**Step 1: Run targeted Rust regressions**

Run:

```bash
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p media --lib -- --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon live2d_overlay_uses_subtitle_duration_to_auto_clear_text -- --exact --test-threads=1
cargo test --manifest-path "D:/AI/memory-suite/Cargo.toml" -p daemon live2d_speech_next_and_ack_preserve_order_and_resume_playing_item -- --exact --test-threads=1
```

Expected: PASS.

**Step 2: Verify runtime timing**

Measure:
- `/api/chat` latency for a short prompt
- time from `/api/chat` completion to `/api/live2d/speech/next`

Expected:
- chat still returns `speech.status=ready`
- queue handoff remains near-immediate after chat response

**Step 3: Verify browser behavior**

Use Playwright against:

```text
http://127.0.0.1:8080/overlay/live2d
```

Check:
- short reply starts quickly
- long reply subtitle streams progressively
- subtitle clears about 2 seconds after playback ends
- no duplicate playback after full text is shown
- subjective speech rate is faster than before

**Step 4: If verification fails, stop and debug systematically**

Use `superpowers:systematic-debugging` before any further fixes.

**Step 5: Final non-secret diff review**

Inspect the working tree and ensure no real API key is accidentally staged.

---

Plan complete and saved to `docs/plans/2026-03-10-deepseek-and-tts-rate.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
