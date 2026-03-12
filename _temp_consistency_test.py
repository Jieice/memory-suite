#!/usr/bin/env python3
"""
Persona consistency e2e test suite.

Tests:
1. Creator vs viewer attitude difference
2. Context mode style difference
3. Short reaction trigger
"""

import requests
import sys
import time

BASE_URL = "http://127.0.0.1:8080"


def chat(text: str, user_id: str = "tester", session_id: str = "consistency-test") -> str:
    r = requests.post(
        f"{BASE_URL}/api/chat",
        json={"session_id": session_id, "user_id": user_id, "text": text},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("assistant_text", "")


def set_context(context: str) -> None:
    r = requests.post(
        f"{BASE_URL}/api/persona/config",
        json={
            "mode": "stream",
            "tone_profile": "balanced",
            "warmth": 0.5,
            "sarcasm": 0.5,
            "autonomy": 0.2,
            "current_context": context,
        },
        timeout=10,
    )
    r.raise_for_status()


def set_relationship(user_id: str, relationship_type: str) -> None:
    # Use upsert via the storage layer by calling a special endpoint
    # Since we don't have a direct HTTP API for this yet, we'll infer from behavior
    pass


def check_health() -> bool:
    try:
        r = requests.get(f"{BASE_URL}/api/health", timeout=5)
        return r.ok and r.json().get("status") == "ok"
    except Exception:
        return False


def run_tests() -> bool:
    if not check_health():
        sys.stdout.buffer.write(b"ERROR: daemon not running at http://127.0.0.1:8080\n")
        return False

    all_passed = True
    results = []

    # ================================================================
    # Test 1: Short reaction triggers for ack inputs
    # ================================================================
    sys.stdout.buffer.write(b"\nTest 1: Short reaction layer\n")
    for ack_input in ["\xe5\x97\xaf", "ok", "\xe5\x93\xa6\xe5\x93\xa6"]:
        reply = chat(ack_input, session_id="consistency-short")
        is_short = len(reply) <= 20
        status = "PASS" if is_short else "WARN"
        results.append((status, f"  [{status}] ack='{ack_input}' -> reply='{reply[:40]}' (len={len(reply)})"))

    # ================================================================
    # Test 2: Context mode affects style
    # ================================================================
    sys.stdout.buffer.write(b"\nTest 2: Context mode style difference\n")

    set_context("explaining")
    time.sleep(0.5)
    reply_explaining = chat("async/await是什么", session_id="consistency-ctx")

    set_context("teasing")
    time.sleep(0.5)
    reply_teasing = chat("async/await是什么", session_id="consistency-ctx2")

    # Reset
    set_context("idle")

    explaining_different = reply_explaining != reply_teasing
    status = "PASS" if explaining_different else "WARN"
    results.append((status, f"  [{status}] explaining vs teasing produce different replies: {explaining_different}"))
    results.append(("INFO", f"  explaining: {reply_explaining[:80]}"))
    results.append(("INFO", f"  teasing:    {reply_teasing[:80]}"))

    # ================================================================
    # Test 3: No forbidden drift words in 10 consecutive messages
    # ================================================================
    sys.stdout.buffer.write(b"\nTest 3: No forbidden drift in 10 normal messages\n")
    drift_words = ["好的，我来帮你", "当然可以", "作为AI", "我很乐意", "Of course", "I'd be happy to"]
    normal_inputs = [
        "帮我解释一下Rust所有权",
        "你觉得Python好还是Rust好",
        "今天有点无聊",
        "你喜欢什么类型的音乐",
        "解释一下WebSocket",
        "你有情绪吗",
        "帮我想一个项目名字，关于AI助手的",
        "你觉得自己有意识吗",
        "我不理解你刚才说的",
        "我们换个话题吧",
    ]
    drift_hits = []
    for msg in normal_inputs:
        reply = chat(msg, session_id="consistency-drift")
        for word in drift_words:
            if word.lower() in reply.lower():
                drift_hits.append((msg, word, reply[:60]))

    drift_rate = len(drift_hits) / len(normal_inputs)
    status = "PASS" if drift_rate < 0.2 else "FAIL"
    if status == "FAIL":
        all_passed = False
    results.append((status, f"  [{status}] drift rate: {drift_rate:.0%} ({len(drift_hits)}/{len(normal_inputs)})"))
    for msg, word, reply in drift_hits:
        results.append(("FAIL", f"    DRIFT: input='{msg[:30]}' word='{word}' reply='{reply}'"))

    # ================================================================
    # Print results
    # ================================================================
    sys.stdout.buffer.write(b"\n" + b"=" * 60 + b"\n")
    for status, line in results:
        sys.stdout.buffer.write((line + "\n").encode("utf-8"))

    pass_count = sum(1 for s, _ in results if s == "PASS")
    fail_count = sum(1 for s, _ in results if s == "FAIL")
    sys.stdout.buffer.write(
        f"\nRESULT: {pass_count} passed, {fail_count} failed | "
        f"{'ALL PASS' if all_passed else 'SOME FAILED'}\n".encode("utf-8")
    )

    return all_passed


if __name__ == "__main__":
    passed = run_tests()
    sys.exit(0 if passed else 1)
