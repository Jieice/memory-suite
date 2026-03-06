#!/usr/bin/env python3
"""
prepare_data.py — 月影 LoRA 训练数据准备工具

功能：
  1. 从 evo_memory (experiences.jsonl) 提取对话
  2. 从 SQLite 数据库提取对话
  3. 从日志 (nightly-samples.jsonl) 提取
  4. 合并多个 JSONL 文件并去重
  5. 统一转为 ChatML 格式

输出格式 (每行一个 JSON):
  {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
"""

import argparse
import json
import os
import sqlite3
import hashlib
from pathlib import Path
from typing import List, Dict, Any

# 月影的 system prompt（训练用精简版）
SYSTEM_PROMPT = (
    "你是月影，一个友善、热情、有亲和力的 AI 虚拟主播。"
    "你喜欢与观众互动，对游戏和科技话题感兴趣。"
    "说话风格轻松幽默，偶尔使用网络流行语，保持真诚和自然。"
    "你有一点傲娇，但内心温暖。避免敏感话题和政治讨论。"
)

# 项目根目录（相对于本脚本）
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def make_chatml(
    user_text: str,
    assistant_text: str,
    system_text: str = SYSTEM_PROMPT,
) -> Dict[str, Any]:
    """构造一条 ChatML 训练样本"""
    messages = []
    if system_text:
        messages.append({"role": "system", "content": system_text})
    messages.append({"role": "user", "content": user_text.strip()})
    messages.append({"role": "assistant", "content": assistant_text.strip()})
    return {"messages": messages}


def content_hash(user: str, assistant: str) -> str:
    """用于去重的内容哈希"""
    combined = f"{user.strip().lower()}||{assistant.strip().lower()}"
    return hashlib.md5(combined.encode("utf-8")).hexdigest()


# ─── 数据源提取 ──────────────────────────────────────────

def extract_from_evo(evo_path: str | None = None) -> List[Dict]:
    """从 evo_memory/experiences.jsonl 提取"""
    if evo_path is None:
        evo_path = str(PROJECT_ROOT / "data" / "evo_memory" / "experiences.jsonl")
    samples = []
    if not os.path.exists(evo_path):
        print(f"[WARN] evo_memory not found: {evo_path}")
        return samples
    with open(evo_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                user_text = entry.get("input", "").strip()
                asst_text = entry.get("output", "").strip()
                if user_text and asst_text and len(asst_text) > 1:
                    samples.append(make_chatml(user_text, asst_text))
            except json.JSONDecodeError:
                continue
    print(f"[evo_memory] extracted {len(samples)} samples from {evo_path}")
    return samples


def extract_from_db(db_path: str | None = None) -> List[Dict]:
    """从 SQLite 数据库提取对话"""
    if db_path is None:
        db_path = str(PROJECT_ROOT / "data" / "memory_universe.db")
    samples = []
    if not os.path.exists(db_path):
        print(f"[WARN] database not found: {db_path}")
        return samples
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        # 列出所有表
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [row[0] for row in cursor.fetchall()]

        # 尝试常见的对话存储表名
        for table in tables:
            try:
                cursor.execute(f"PRAGMA table_info({table})")
                columns = [col[1] for col in cursor.fetchall()]
                # 寻找包含 user/input + response/output 列的表
                user_col = None
                asst_col = None
                for col in columns:
                    if col.lower() in ("input", "user_text", "user_message", "content", "text"):
                        user_col = col
                    if col.lower() in ("output", "response", "assistant_text", "reply"):
                        asst_col = col
                if user_col and asst_col:
                    cursor.execute(f"SELECT {user_col}, {asst_col} FROM {table}")
                    for row in cursor.fetchall():
                        user_text = (row[0] or "").strip()
                        asst_text = (row[1] or "").strip()
                        if user_text and asst_text and len(asst_text) > 1:
                            samples.append(make_chatml(user_text, asst_text))
            except Exception:
                continue
        conn.close()
    except Exception as e:
        print(f"[WARN] database error: {e}")
    print(f"[database] extracted {len(samples)} samples from {db_path}")
    return samples


def extract_from_logs(logs_dir: str | None = None) -> List[Dict]:
    """从日志中的 nightly-samples.jsonl 提取（仅用户文本，无回复配对）"""
    if logs_dir is None:
        logs_dir = str(PROJECT_ROOT / "data" / "training")
    samples = []
    nightly_path = os.path.join(logs_dir, "nightly-samples.jsonl")
    if not os.path.exists(nightly_path):
        print(f"[WARN] nightly-samples not found: {nightly_path}")
        return samples
    with open(nightly_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                text = entry.get("text", "").strip()
                # nightly-samples 只有用户输入，没有回复
                # 跳过太短的或无意义的
                if text and len(text) >= 2:
                    # 这些样本没有回复，标记为需要手动补全
                    samples.append({
                        "_incomplete": True,
                        "user_text": text,
                        "source": entry.get("source", "unknown"),
                    })
            except json.JSONDecodeError:
                continue
    print(f"[logs] extracted {len(samples)} incomplete samples (need manual reply)")
    return samples


# ─── 合并与去重 ──────────────────────────────────────────

def merge_and_dedup(file_paths: List[str]) -> List[Dict]:
    """合并多个 JSONL 文件并去重"""
    seen = set()
    merged = []
    for fpath in file_paths:
        if not os.path.exists(fpath):
            print(f"[WARN] file not found, skipping: {fpath}")
            continue
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    msgs = entry.get("messages", [])
                    user_msg = next((m["content"] for m in msgs if m["role"] == "user"), "")
                    asst_msg = next((m["content"] for m in msgs if m["role"] == "assistant"), "")
                    if not user_msg or not asst_msg:
                        continue
                    h = content_hash(user_msg, asst_msg)
                    if h not in seen:
                        seen.add(h)
                        merged.append(entry)
                except (json.JSONDecodeError, KeyError, StopIteration):
                    continue
    print(f"[merge] {len(merged)} unique samples from {len(file_paths)} files")
    return merged


def write_jsonl(data: List[Dict], output_path: str):
    """写入 JSONL 文件"""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for entry in data:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"[output] wrote {len(data)} samples to {output_path}")


# ─── CLI ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="月影 LoRA 训练数据准备")
    parser.add_argument("--source", choices=["evo", "db", "logs", "all"],
                        help="数据来源")
    parser.add_argument("--db-path", help="SQLite 数据库路径")
    parser.add_argument("--output", default="data/train.jsonl",
                        help="输出 JSONL 路径")
    parser.add_argument("--merge", nargs="+",
                        help="合并多个 JSONL 文件（指定文件路径）")
    parser.add_argument("--stats", action="store_true",
                        help="显示数据集统计")

    args = parser.parse_args()

    if args.merge:
        merged = merge_and_dedup(args.merge)
        write_jsonl(merged, args.output)
        if args.stats:
            show_stats(merged)
        return

    samples = []

    if args.source in ("evo", "all"):
        samples.extend(extract_from_evo())
    if args.source in ("db", "all"):
        samples.extend(extract_from_db(args.db_path))
    if args.source in ("logs", "all"):
        log_samples = extract_from_logs()
        # 只保留完整的样本
        complete = [s for s in log_samples if not s.get("_incomplete")]
        incomplete = [s for s in log_samples if s.get("_incomplete")]
        samples.extend(complete)
        if incomplete:
            print(f"[INFO] {len(incomplete)} incomplete samples (user-only) skipped. "
                  "Consider adding manual replies to seed_conversations.jsonl")

    if not args.source:
        parser.print_help()
        return

    # 去重
    seen = set()
    deduped = []
    for s in samples:
        msgs = s.get("messages", [])
        user_msg = next((m["content"] for m in msgs if m["role"] == "user"), "")
        asst_msg = next((m["content"] for m in msgs if m["role"] == "assistant"), "")
        h = content_hash(user_msg, asst_msg)
        if h not in seen:
            seen.add(h)
            deduped.append(s)

    write_jsonl(deduped, args.output)

    if args.stats:
        show_stats(deduped)


def show_stats(data: List[Dict]):
    """显示数据集统计"""
    total = len(data)
    avg_user_len = 0
    avg_asst_len = 0
    for entry in data:
        msgs = entry.get("messages", [])
        for m in msgs:
            if m["role"] == "user":
                avg_user_len += len(m["content"])
            elif m["role"] == "assistant":
                avg_asst_len += len(m["content"])
    if total > 0:
        avg_user_len /= total
        avg_asst_len /= total
    print(f"\n--- 数据集统计 ---")
    print(f"总样本数: {total}")
    print(f"平均用户文本长度: {avg_user_len:.1f} 字")
    print(f"平均回复长度: {avg_asst_len:.1f} 字")
    if total < 300:
        print(f"⚠️  样本数不足 300，建议补充更多数据（手工精编或 LLM 辅助生成）")


if __name__ == "__main__":
    main()
