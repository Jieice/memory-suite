#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unified runtime chain verifier.

This replaces the old multi-service NN chain checker with a validation pass for
the Rust daemon plus optional Python sidecars.
"""

from __future__ import annotations

import os
import sys
from typing import Dict, Tuple

import requests

SERVICES = {
    "unified_runtime": os.environ.get("MEMORY_SUITE_URL", "http://localhost:8080"),
    "brainnn": os.environ.get("BRAINNN_URL", "http://localhost:4007"),
    "tts_sidecar": os.environ.get("TTS_SERVICE_URL", "http://localhost:3000"),
}


class Colors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    RESET = "\033[0m"


def print_header(text: str) -> None:
    print(f"\n{Colors.BLUE}{'=' * 60}")
    print(f"  {text}")
    print(f"{'=' * 60}{Colors.RESET}\n")


def print_success(text: str) -> None:
    print(f"{Colors.GREEN}PASS {text}{Colors.RESET}")


def print_error(text: str) -> None:
    print(f"{Colors.RED}FAIL {text}{Colors.RESET}")


def print_warning(text: str) -> None:
    print(f"{Colors.YELLOW}WARN {text}{Colors.RESET}")


def print_info(text: str) -> None:
    print(f"{Colors.BLUE}INFO {text}{Colors.RESET}")


def check_endpoint(name: str, url: str, timeout: int = 5) -> Tuple[bool, str]:
    try:
        response = requests.get(url, timeout=timeout)
        if response.status_code == 200:
            return True, f"{name} healthy"
        return False, f"{name} returned {response.status_code}"
    except requests.exceptions.ConnectionError:
        return False, f"{name} unavailable"
    except requests.exceptions.Timeout:
        return False, f"{name} timed out"
    except Exception as exc:
        return False, f"{name} failed: {exc}"


def test_chat() -> bool:
    try:
        response = requests.post(
            f"{SERVICES['unified_runtime']}/api/chat",
            json={
                "session_id": "verify-nn-chain",
                "user_id": "test_user",
                "text": "你好"
            },
            timeout=15,
        )
        if response.status_code != 200:
            print_error(f"Unified chat returned {response.status_code}")
            return False
        data = response.json()
        if not any(key in data for key in ("response_text", "response", "text")):
            print_error("Unified chat payload does not contain response text")
            return False
        print_success("Unified chat endpoint works")
        return True
    except Exception as exc:
        print_error(f"Unified chat failed: {exc}")
        return False


def test_runtime_overview() -> bool:
    try:
        response = requests.get(f"{SERVICES['unified_runtime']}/api/runtime/overview", timeout=5)
        if response.status_code != 200:
            print_error(f"Runtime overview returned {response.status_code}")
            return False
        print_success("Runtime overview endpoint works")
        return True
    except Exception as exc:
        print_error(f"Runtime overview failed: {exc}")
        return False


def test_live2d_state() -> bool:
    try:
        response = requests.get(f"{SERVICES['unified_runtime']}/api/live2d/state", timeout=5)
        if response.status_code != 200:
            print_error(f"Live2D state returned {response.status_code}")
            return False
        print_success("Live2D state endpoint works")
        return True
    except Exception as exc:
        print_error(f"Live2D state failed: {exc}")
        return False


def test_danmaku_state() -> bool:
    try:
        response = requests.get(f"{SERVICES['unified_runtime']}/api/danmaku/state", timeout=5)
        if response.status_code != 200:
            print_error(f"Danmaku state returned {response.status_code}")
            return False
        print_success("Danmaku state endpoint works")
        return True
    except Exception as exc:
        print_error(f"Danmaku state failed: {exc}")
        return False


def main() -> int:
    print_header("Unified runtime chain verification")

    print_info("Step 1: health checks")
    health_targets: Dict[str, str] = {
        "unified_runtime": f"{SERVICES['unified_runtime']}/api/health",
        "brainnn": f"{SERVICES['brainnn']}/health",
        "tts_sidecar": f"{SERVICES['tts_sidecar']}/health",
    }
    health_results: Dict[str, bool] = {}
    for name, url in health_targets.items():
        healthy, message = check_endpoint(name, url)
        health_results[name] = healthy
        if healthy:
            print_success(message)
        else:
            if name == "unified_runtime":
                print_error(message)
            else:
                print_warning(f"{message} (optional sidecar)")

    print_info("\nStep 2: unified runtime endpoint checks")
    endpoint_results = {
        "runtime_overview": test_runtime_overview(),
        "chat": test_chat(),
        "live2d_state": test_live2d_state(),
        "danmaku_state": test_danmaku_state(),
    }

    print_header("Verification summary")
    required_ok = health_results.get("unified_runtime", False)
    endpoint_ok = all(endpoint_results.values())

    print(f"Unified runtime healthy: {required_ok}")
    print(f"Unified endpoints ok: {sum(endpoint_results.values())}/{len(endpoint_results)}")
    print(f"Optional BrainNN sidecar: {health_results.get('brainnn', False)}")
    print(f"Optional TTS sidecar: {health_results.get('tts_sidecar', False)}")

    if required_ok and endpoint_ok:
        print_success("Unified runtime chain is operational")
        return 0

    print_error("Unified runtime chain verification failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
