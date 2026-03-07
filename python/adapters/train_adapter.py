#!/usr/bin/env python3
"""
Memory Suite train adapter.

This script is intentionally lightweight so the Rust supervisor can launch a
real task instead of a sleep placeholder. It inspects input data, records a
summary report, and exits with non-zero on invalid input.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Memory Suite training adapter")
    parser.add_argument("--input", dest="input_path", default="", help="Dataset path")
    parser.add_argument("--profile", default="default", help="Training profile")
    parser.add_argument(
        "--min-seconds",
        type=float,
        default=float(os.environ.get("MEMORY_SUITE_TRAIN_MIN_SECONDS", "0")),
        help="Optional minimum run time to simulate long training jobs",
    )
    return parser.parse_args()


def resolve_workspace_root() -> Path:
    # cwd is expected to be ./python because the supervisor sets models_root
    cwd = Path.cwd()
    if cwd.name.lower() == "python":
        return cwd.parent
    return cwd


def inspect_input(root: Path, input_path: str) -> dict:
    if not input_path:
        return {
            "exists": False,
            "kind": "missing",
            "files": 0,
            "bytes": 0,
            "resolved_path": "",
        }

    candidate = Path(input_path)
    if not candidate.is_absolute():
        candidate = (root / candidate).resolve()

    if not candidate.exists():
        return {
            "exists": False,
            "kind": "missing",
            "files": 0,
            "bytes": 0,
            "resolved_path": str(candidate),
        }

    if candidate.is_file():
        return {
            "exists": True,
            "kind": "file",
            "files": 1,
            "bytes": candidate.stat().st_size,
            "resolved_path": str(candidate),
        }

    files = [p for p in candidate.rglob("*") if p.is_file()]
    total_bytes = sum(p.stat().st_size for p in files)
    return {
        "exists": True,
        "kind": "directory",
        "files": len(files),
        "bytes": total_bytes,
        "resolved_path": str(candidate),
    }


def write_report(root: Path, report: dict) -> Path:
    reports_dir = root / "runtime" / "reports" / "train"
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = reports_dir / f"train-{stamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def main() -> int:
    args = parse_args()
    workspace_root = resolve_workspace_root()

    started_at = time.time()
    input_summary = inspect_input(workspace_root, args.input_path)
    if args.min_seconds > 0:
        time.sleep(args.min_seconds)

    completed_at = time.time()
    report = {
        "task": "train",
        "status": "completed" if input_summary["exists"] or not args.input_path else "failed",
        "profile": args.profile,
        "input": input_summary,
        "duration_ms": int((completed_at - started_at) * 1000),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    report_path = write_report(workspace_root, report)
    print(json.dumps({"ok": report["status"] == "completed", "report_path": str(report_path)}))

    if args.input_path and not input_summary["exists"]:
        print(f"training input does not exist: {input_summary['resolved_path']}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
