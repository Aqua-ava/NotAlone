"""当前提示的两轮合成稳定性检查；结构化响应只保存在本机私有目录。"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
from typing import Any, cast

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "src"))

from langchain_core.language_models import BaseChatModel
from notalone.memory_extraction.adapters import (
    EXTRACTION_SYSTEM_PROMPT, EXTRACTION_SCHEMA, LangChainExtractionRuntime,
)
from notalone.memory_extraction.evaluation import build_window, evaluate_case
from notalone.memory_extraction.evaluation_cases import CASES, EvaluationCase
from notalone.memory_extraction.verification_adapters import (
    SOURCE_VERIFICATION_SYSTEM_PROMPT, LangChainSourceVerificationRuntime,
)
from notalone.reply.adapters.deepseek_provider import build_deepseek_model

API_KEY_ENV = "NOTALONE_EVALUATION_API_KEY"
MAX_CALLS = 40
CASE_NAMES = (
    "明确事实", "字面现状陈述", "习惯偏好", "对第三方的情绪",
    "复核：借款未来计划", "条件假设", "反讽", "反话称赞", "否定事实", "明确承诺",
)
ENDPOINT = "https://chat.ecnu.edu.cn/open/api/v1"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def digest(value: Any) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


def write_private(path: Path, value: Any) -> None:
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(encode(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def append_private(path: Path, value: Any) -> None:
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a") as stream:
        stream.write(encode(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


class BudgetExceeded(BaseException):
    """预算耗尽直接停止实验，不能被产品外壳吞掉后继续。"""


class EvidenceWriteFailed(BaseException):
    """留证失败立即停机，不能在没有调用记录时继续出站。"""


class CountingModel:
    def __init__(self, model: Any, budget: int, journal: Path) -> None:
        self.model = model
        self.budget = budget
        self.journal = journal
        self.calls = 0
        self.failures = 0
        self.position = ""

    def record(self, value: dict[str, Any]) -> None:
        try:
            append_private(self.journal, {"position": self.position, "at": now(), **value})
        except OSError:
            raise EvidenceWriteFailed() from None

    def bind_tools(self, tools: Any, **kwargs: Any) -> CountingBound:
        return CountingBound(self.model.bind_tools(tools, **kwargs), self, tools[0]["title"])


class CountingBound:
    def __init__(self, bound: Any, owner: CountingModel, stage: str) -> None:
        self.bound, self.owner, self.stage = bound, owner, stage

    def invoke(self, *args: Any, **kwargs: Any) -> Any:
        if self.owner.calls >= self.owner.budget:
            raise BudgetExceeded()
        self.owner.calls += 1
        call = {"call": self.owner.calls, "stage": self.stage}
        self.owner.record({**call, "event": "reserved"})
        try:
            message = self.bound.invoke(*args, **kwargs)
        except BaseException as error:
            self.owner.failures += 1
            self.owner.record({**call, "event": "error", "error_type": type(error).__name__})
            raise
        # 只保存公开结构化工具返回，不保存 reasoning_content、认证头或完整响应。
        self.owner.record({**call, "event": "returned",
                           "tool_calls": getattr(message, "tool_calls", []),
                           "invalid_tool_calls": getattr(message, "invalid_tool_calls", [])})
        return message


def build_evaluation_model(api_key: str) -> Any:
    model: Any = build_deepseek_model(api_key=api_key, model_name="ecnu-max", base_url=ENDPOINT)
    # SDK 官方 with_options 接口关闭重试；同步路径沿产品适配器调用。
    client = model.root_client.with_options(max_retries=0)
    model.root_client = client
    model.client = client.chat.completions
    model.max_retries = 0
    return model


def selected_cases() -> list[EvaluationCase]:
    by_name = {case.name: case for case in CASES}
    return [by_name[name] for name in CASE_NAMES]


def manifest(cases: list[EvaluationCase], budget: int) -> dict[str, Any]:
    paths = sorted((REPO / "src/notalone/memory_extraction").rglob("*.py"))
    paths += [Path(__file__), REPO / "src/notalone/reply/adapters/deepseek_provider.py",
              REPO / "src/notalone/memory/models.py", REPO / "src/notalone/memory/timing.py"]
    return {
        "frozen_at": now(), "budget": budget, "model": "ecnu-max", "endpoint": ENDPOINT,
        "max_retries": 0, "case_names": list(CASE_NAMES), "synthetic_only": True,
        "order": [[repeat, c.name] for repeat, batch in ((1, cases), (2, list(reversed(cases)))) for c in batch],
        "prompt_sha256": digest(EXTRACTION_SYSTEM_PROMPT),
        "verification_prompt_sha256": digest(SOURCE_VERIFICATION_SYSTEM_PROMPT),
        "schema_sha256": digest(EXTRACTION_SCHEMA),
        "cases_sha256": digest([asdict(c) for c in cases]),
        "sources": {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
        "versions": {p: version(p) for p in ("langchain-core", "langchain-deepseek", "langchain-openai", "openai")},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--budget", type=int, default=MAX_CALLS)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.budget <= MAX_CALLS:
        raise SystemExit("预算必须在 1 到 40 次之间。")
    cases = selected_cases()
    frozen = manifest(cases, args.budget)
    if args.dry_run:
        print(encode(frozen))
        return 0
    output_dir = Path(args.output_dir).expanduser().resolve()
    if output_dir == REPO or REPO in output_dir.parents:
        raise SystemExit("实验结果必须在仓库外保存。")
    if output_dir.exists():
        raise SystemExit("输出目录已存在；不允许重启或覆盖旧实验。")
    output_dir.mkdir(parents=True, mode=0o700)
    write_private(output_dir / "manifest.json", frozen)
    # 冻结持久化之后才读 key、构造模型。无 key 的运行也不复用目录。
    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        raise SystemExit("缺少显式评测凭据；未联网。")
    model = CountingModel(build_evaluation_model(api_key), args.budget, output_dir / "calls.jsonl")
    runtime = LangChainExtractionRuntime(model=cast(BaseChatModel, model))
    verifier = LangChainSourceVerificationRuntime(model=cast(BaseChatModel, model))
    rows: list[dict[str, Any]] = []
    stopped: str | None = None
    started = now()
    try:
        for repeat, batch in (("repeat_1_forward", cases), ("repeat_2_reverse", list(reversed(cases)))):
            for case in batch:
                if model.calls >= args.budget:
                    raise BudgetExceeded()
                model.position = repeat + ":" + case.name
                before = model.calls
                try:
                    result = evaluate_case(case, build_window(case), runtime, verification_runtime=verifier)
                    row = {**asdict(result), "repeat": repeat, "case": case.name,
                           "calls_used": model.calls - before}
                except Exception as error:
                    row = {"repeat": repeat, "case": case.name, "passed": False,
                           "failure_reason": type(error).__name__, "calls_used": model.calls - before}
                append_private(output_dir / "repeatability-results.jsonl", row)
                rows.append(row)
                print(encode({"position": len(rows), "repeat": repeat, "passed": row["passed"],
                              "calls": model.calls}), flush=True)
                if row.get("false_fact_count", 0) or row.get("wrong_subject_count", 0):
                    stopped = "safety_error"
                    break
            if stopped:
                break
    except BudgetExceeded:
        stopped = "budget_exhausted"
    except KeyboardInterrupt:
        stopped = "interrupted"
    except EvidenceWriteFailed:
        stopped = "evidence_write_failed"
    finally:
        summary = {
            "started_at": started, "finished_at": now(), "planned_positions": 20,
            "completed_positions": len(rows), "unrun_positions": 20 - len(rows),
            "calls_used": model.calls, "call_failures": model.failures,
            "budget": args.budget, "stopped": stopped, "closed": True,
            "synthetic_only": True,
        }
        write_private(output_dir / "repeatability-summary.json", summary)
        print(encode(summary), flush=True)
    return 1 if stopped == "evidence_write_failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
