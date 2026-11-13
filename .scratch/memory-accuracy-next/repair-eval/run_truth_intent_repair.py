"""`truth_intent` 失败形态的私有 A/B 对照 runner。

只使用仓库内合成用例；生产提示常量只在本进程内临时替换，默认产品路径不变。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "src"))

from notalone.memory_extraction import adapters as extraction_adapters  # noqa: E402
from notalone.memory_extraction.adapters import LangChainExtractionRuntime  # noqa: E402
from notalone.memory_extraction.evaluation import (  # noqa: E402
    build_window,
    evaluate_case,
)
from notalone.memory_extraction.evaluation_cases import CASES  # noqa: E402
from notalone.memory_extraction.semantic_evaluation_cases import (  # noqa: E402
    SEMANTIC_CASES,
)
from notalone.memory_extraction.verification_adapters import (  # noqa: E402
    LangChainSourceVerificationRuntime,
)
from notalone.reply.adapters.deepseek_provider import build_deepseek_model  # noqa: E402


API_KEY_ENV = "NOTALONE_EVALUATION_API_KEY"
MAX_CALLS = 40
CASE_NAMES = (
    "明确事实",
    "字面现状陈述",
    "习惯偏好",
    "对第三方的情绪",
    "复核：借款未来计划",
    "条件假设",
    "反讽",
    "反话称赞",
    "否定事实",
    "明确承诺",
)

REPAIR_LEAF = """
【失败形态修复对照叶】
先检查 target 消息是否直接表达了当前事实或稳定习惯。若字段、主体、来源和语用状态
已经可以确定，必须返回一条完整候选并填写全部必填字段；不能因为担心误记而静默丢弃。
只有问题、玩笑、反讽、纯情绪或确实没有值得记忆内容时才返回空数组。不得为了通过率
强行生成候选，也不得改变计划、条件、转述、否定和主体规则。
""".strip()


class CountingModel:
    def __init__(self, model, budget: int) -> None:
        self._model = model
        self._budget = budget
        self.calls = 0

    def bind_tools(self, tools, **kwargs):
        return CountingBound(self._model.bind_tools(tools, **kwargs), self)

    def __getattr__(self, name):
        return getattr(self._model, name)


class CountingBound:
    def __init__(self, bound, owner: CountingModel) -> None:
        self._bound = bound
        self._owner = owner

    def invoke(self, *args, **kwargs):
        if self._owner.calls >= self._owner._budget:
            raise RuntimeError("已达修复对照批准上限，停止且不补跑。")
        self._owner.calls += 1
        return self._bound.invoke(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._bound, name)


def selected_cases():
    by_name = {case.name: case for case in (*CASES, *SEMANTIC_CASES)}
    return [by_name[name] for name in CASE_NAMES]


def _load_current_prompt() -> str:
    return extraction_adapters.EXTRACTION_SYSTEM_PROMPT


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--budget", type=int, default=MAX_CALLS)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    cases = selected_cases()
    if args.budget > MAX_CALLS:
        raise SystemExit(f"预算不能超过 {MAX_CALLS} 次。")
    if args.dry_run:
        print(json.dumps({
            "arms": ["A_current", "B_repair_leaf"],
            "cases": len(cases),
            "upper_bound_calls": args.budget,
            "case_names": [case.name for case in cases],
        }, ensure_ascii=False, indent=2))
        return 0

    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        print(f"[skip] 未显式提供 {API_KEY_ENV}；未联网。")
        return 2
    output_dir = Path(args.output_dir).expanduser()
    if output_dir.exists():
        raise SystemExit("输出目录已存在；本轮不覆盖既有实验。")
    output_dir.mkdir(parents=True, mode=0o700)

    base_prompt = _load_current_prompt()
    model = CountingModel(build_deepseek_model(api_key=api_key), args.budget)
    verifier = LangChainSourceVerificationRuntime(model=model)
    results: list[dict] = []
    stopped: str | None = None
    original_prompt = extraction_adapters.EXTRACTION_SYSTEM_PROMPT
    try:
        for arm, prompt in (
            ("A_current", base_prompt),
            ("B_repair_leaf", base_prompt + "\n\n" + REPAIR_LEAF),
        ):
            extraction_adapters.EXTRACTION_SYSTEM_PROMPT = prompt
            runtime = LangChainExtractionRuntime(model=model)
            for case in cases:
                result = evaluate_case(
                    case,
                    build_window(case),
                    runtime,
                    verification_runtime=verifier,
                )
                results.append({
                    "arm": arm,
                    "case": case.name,
                    "dimension": case.dimension,
                    "passed": result.passed,
                    "error_kind": result.error_kind,
                    "false_fact_count": result.false_fact_count,
                    "wrong_subject_count": result.wrong_subject_count,
                    "rejected_count": result.rejected_count,
                    "calls_used_total": model.calls,
                })
                if result.false_fact_count or result.wrong_subject_count:
                    stopped = (
                        "检测到 false_fact 或 wrong_subject，按修复对照规则停止。"
                    )
                    break
            if stopped is not None:
                break
    finally:
        extraction_adapters.EXTRACTION_SYSTEM_PROMPT = original_prompt

    (output_dir / "repair-results.jsonl").write_text(
        "\n".join(json.dumps(item, ensure_ascii=False) for item in results) + "\n",
        encoding="utf-8",
    )
    os.chmod(output_dir / "repair-results.jsonl", 0o600)
    summary = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "arms": ["A_current", "B_repair_leaf"],
        "planned_cases_per_arm": len(cases),
        "completed_positions": len(results),
        "calls_used": model.calls,
        "budget": args.budget,
        "stopped": stopped,
        "synthetic_only": True,
    }
    (output_dir / "repair-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    os.chmod(output_dir / "repair-summary.json", 0o600)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
