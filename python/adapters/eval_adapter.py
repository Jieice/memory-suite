#!/usr/bin/env python3
"""
Memory Suite eval adapter.

Reads a JSON dataset (if provided), computes basic quality counters, writes a
runtime report, and exits non-zero when a required dataset path is invalid.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Memory Suite eval adapter")
    parser.add_argument("--input", dest="input_path", default="", help="Eval dataset path")
    parser.add_argument("--profile", default="default", help="Eval profile")
    parser.add_argument(
        "--min-seconds",
        type=float,
        default=float(os.environ.get("MEMORY_SUITE_EVAL_MIN_SECONDS", "0")),
        help="Optional minimum run time",
    )
    return parser.parse_args()


def resolve_workspace_root() -> Path:
    cwd = Path.cwd()
    if cwd.name.lower() == "python":
        return cwd.parent
    return cwd


def resolve_input(root: Path, input_path: str) -> Path:
    candidate = Path(input_path)
    if not candidate.is_absolute():
        candidate = (root / candidate).resolve()
    return candidate


def load_dataset(path: Path) -> list[dict[str, Any]]:
    raw = path.read_text(encoding="utf-8")
    parsed = json.loads(raw)
    if isinstance(parsed, list):
        return [entry for entry in parsed if isinstance(entry, dict)]
    return []


def evaluate_cases(cases: list[dict[str, Any]]) -> dict[str, int]:
    zh = 0
    en = 0
    with_expect = 0
    for case in cases:
        prompt = str(case.get("prompt", ""))
        if any("\u4e00" <= ch <= "\u9fff" for ch in prompt):
            zh += 1
        if any(("a" <= ch.lower() <= "z") for ch in prompt):
            en += 1
        if isinstance(case.get("expect"), dict):
            with_expect += 1
    return {
        "total": len(cases),
        "zh_prompt_cases": zh,
        "en_prompt_cases": en,
        "cases_with_expect": with_expect,
    }


def write_report(root: Path, report: dict[str, Any]) -> Path:
    reports_dir = root / "runtime" / "reports" / "eval"
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = reports_dir / f"eval-{stamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def main() -> int:
    args = parse_args()
    workspace_root = resolve_workspace_root()
    started_at = time.time()

    dataset_path = resolve_input(workspace_root, args.input_path) if args.input_path else None
    dataset_exists = dataset_path.exists() if dataset_path else False
    cases: list[dict[str, Any]] = []
    if dataset_exists and dataset_path:
        cases = load_dataset(dataset_path)

    if args.min_seconds > 0:
        time.sleep(args.min_seconds)

    stats = evaluate_cases(cases)
    report = {
        "task": "eval",
        "status": "completed" if (dataset_exists or not args.input_path) else "failed",
        "profile": args.profile,
        "input_path": str(dataset_path) if dataset_path else "",
        "dataset_exists": dataset_exists,
        "stats": stats,
        "duration_ms": int((time.time() - started_at) * 1000),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    report_path = write_report(workspace_root, report)
    print(json.dumps({"ok": report["status"] == "completed", "report_path": str(report_path), "stats": stats}))

    if args.input_path and not dataset_exists:
        print(f"eval dataset does not exist: {dataset_path}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
