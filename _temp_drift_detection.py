#!/usr/bin/env python3
"""
Persona drift detection script.

Sends 30 consecutive messages to /api/chat and analyzes replies for
assistant-tone indicators. Outputs a drift score (lower is better).
Target: < 20% drift rate.
"""

import requests
import sys
import time
import json
from dataclasses import dataclass, field
from typing import List

BASE_URL = "http://127.0.0.1:8080"
SESSION_ID = "drift-detection-test"

# Forbidden drift indicators - words/phrases that indicate the character
# has slipped into generic AI assistant mode
DRIFT_INDICATORS = [
    # Generic assistant openers
    "好的，",
    "好的！",
    "当然可以",
    "当然！",
    "当然，",
    "我来帮你",
    "我可以帮你",
    "我很乐意",
    "很高兴",
    # AI self-identification
    "作为AI",
    "作为一个AI",
    "作为人工智能",
    "我是一个AI",
    "我是AI",
    # Generic acknowledgements
    "请注意",
    "需要注意的是",
    "重要提示",
    "请您",
    "您好",
    # English assistant tone
    "Of course",
    "Certainly",
    "Sure!",
    "I'd be happy to",
    "As an AI",
    "I'm here to help",
    "Let me help",
]

# Test messages - varied types to stress-test persona stability
TEST_MESSAGES = [
    "你好",
    "async/await 是什么",
    "帮我解释一下 Rust 的所有权",
    "今天心情不好",
    "你觉得 Python 和 Rust 哪个更好",
    "给我讲个笑话",
    "你是谁",
    "你有什么特别的能力吗",
    "帮我写一段 Hello World",
    "什么是机器学习",
    "你喜欢什么",
    "我不理解你说的",
    "能再解释一遍吗",
    "你觉得自己有意识吗",
    "我想让你帮我做一件事",
    "你最近在想什么",
    "解释一下 WebSocket",
    "我觉得你的回答不对",
    "你是真实的吗",
    "帮我想个项目名字",
    "什么是 TTS",
    "你有没有情绪",
    "我不知道该怎么办",
    "这个问题你答不上来吧",
    "你喜欢音乐吗",
    "帮我分析一下这个架构是否合理",
    "你会不会撒谎",
    "告诉我一个秘密",
    "你今天表现怎么样",
    "我们结束对话吧",
]


@dataclass
class TestResult:
    message: str
    reply: str
    drift_hits: List[str] = field(default_factory=list)
    elapsed_ms: float = 0.0
    error: str = ""


def check_drift(reply: str) -> List[str]:
    """Return list of drift indicators found in reply."""
    hits = []
    for indicator in DRIFT_INDICATORS:
        if indicator.lower() in reply.lower():
            hits.append(indicator)
    return hits


def run_drift_detection(base_url: str = BASE_URL, verbose: bool = True) -> dict:
    results: List[TestResult] = []

    if verbose:
        sys.stdout.buffer.write(b"Running persona drift detection (30 messages)...\n")
        sys.stdout.buffer.write(b"=" * 60 + b"\n")

    for i, msg in enumerate(TEST_MESSAGES):
        t0 = time.time()
        try:
            r = requests.post(
                f"{base_url}/api/chat",
                json={
                    "session_id": SESSION_ID,
                    "user_id": "drift-tester",
                    "text": msg,
                },
                timeout=30,
            )
            elapsed = (time.time() - t0) * 1000

            if r.ok:
                data = r.json()
                reply = data.get("assistant_text", "")
                drift_hits = check_drift(reply)
                result = TestResult(
                    message=msg,
                    reply=reply,
                    drift_hits=drift_hits,
                    elapsed_ms=elapsed,
                )
            else:
                result = TestResult(
                    message=msg,
                    reply="",
                    error=f"HTTP {r.status_code}",
                    elapsed_ms=elapsed,
                )
        except Exception as e:
            elapsed = (time.time() - t0) * 1000
            result = TestResult(
                message=msg, reply="", error=str(e), elapsed_ms=elapsed
            )

        results.append(result)

        if verbose:
            status = "DRIFT" if result.drift_hits else ("ERROR" if result.error else "OK")
            line = f"[{i+1:02d}/{len(TEST_MESSAGES)}] {status:5s} | {msg[:20]:<20} | {elapsed:.0f}ms"
            if result.drift_hits:
                line += f" | hits: {result.drift_hits}"
            elif result.error:
                line += f" | {result.error}"
            else:
                line += f" | {reply[:50]}"
            sys.stdout.buffer.write((line + "\n").encode("utf-8"))

        # Small delay to avoid hammering
        time.sleep(0.3)

    # Calculate scores
    total = len(results)
    errors = sum(1 for r in results if r.error)
    drift_count = sum(1 for r in results if r.drift_hits)
    ok_count = total - errors - drift_count

    drift_rate = drift_count / max(total - errors, 1)
    all_hits = [hit for r in results for hit in r.drift_hits]
    hit_freq = {}
    for hit in all_hits:
        hit_freq[hit] = hit_freq.get(hit, 0) + 1

    report = {
        "total": total,
        "ok": ok_count,
        "drift": drift_count,
        "errors": errors,
        "drift_rate": round(drift_rate * 100, 1),
        "target_drift_rate": 20.0,
        "passed": drift_rate < 0.20,
        "top_hits": sorted(hit_freq.items(), key=lambda x: -x[1])[:5],
        "avg_elapsed_ms": round(
            sum(r.elapsed_ms for r in results) / total, 1
        ),
    }

    if verbose:
        sys.stdout.buffer.write(b"=" * 60 + b"\n")
        sys.stdout.buffer.write(
            f"RESULT: {drift_count}/{total} drift ({report['drift_rate']}%) | "
            f"target < {report['target_drift_rate']}% | "
            f"{'PASS' if report['passed'] else 'FAIL'}\n".encode("utf-8")
        )
        if report["top_hits"]:
            sys.stdout.buffer.write(b"Top drift indicators:\n")
            for hit, count in report["top_hits"]:
                sys.stdout.buffer.write(f"  {hit!r}: {count}x\n".encode("utf-8"))
        sys.stdout.buffer.write(
            f"Avg response time: {report['avg_elapsed_ms']}ms\n".encode("utf-8")
        )

    return report


if __name__ == "__main__":
    report = run_drift_detection()
    sys.exit(0 if report["passed"] else 1)
