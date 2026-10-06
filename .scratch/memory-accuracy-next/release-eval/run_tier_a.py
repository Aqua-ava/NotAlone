"""档 A 维度放行评测 runner（subject ＋ paraphrase，上限 80 次调用）。

用法（凭据只从环境读取，本脚本不读也不打印 .env）：:

    python .scratch/memory-accuracy-next/release-eval/run_tier_a.py \
        --output-dir ~/.notalone/audits/memory-dimension-release-20261006

设计要点：

- 只跑仓库内合成用例（`memory_extraction.cases` 与 `semantic_evaluation_cases`），
  不读真实聊天、不连数据库、不写业务记忆。
- 用记账包装器套住模型：每次出站调用 +1，超过 ``--budget`` 立即停止并如实记录，
  不补跑。按提案口径每条用例上限 2 次（1 次提取 ＋ 至多 1 次来源核验）。
- 原始逐条结果写仓库外私有目录（0700／0600），仓库内只保留聚合指标。
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import uuid
from dataclasses import asdict
from datetime import datetime, timezone

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "src"))

from notalone.memory_extraction.adapters import LangChainExtractionRuntime  # noqa: E402
from notalone.memory_extraction.evaluation import (  # noqa: E402
    build_window,
    evaluate_case,
    summarize,
)
from notalone.memory_extraction.evaluation_cases import CASES, EvaluationCase  # noqa: E402
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES  # noqa: E402
from notalone.memory_extraction.verification_adapters import (  # noqa: E402
    LangChainSourceVerificationRuntime,
)
from notalone.reply.adapters.deepseek_provider import build_deepseek_model  # noqa: E402

API_KEY_ENV = "NOTALONE_EVALUATION_API_KEY"
DEFAULT_DIMENSIONS = ("subject", "paraphrase")
BUDGET = 80
# 提案口径：每条用例 1 次提取 ＋ 至多 1 次来源核验。
MAX_CALLS_PER_CASE = 2


class BudgetExceeded(RuntimeError):
    """超出批准预算；整个运行立即停止，不补跑。"""


class CountingModel:
    """包装 LangChain 模型：转发调用并记账，超预算抛错。"""

    def __init__(self, model, budget: int) -> None:
        self._model = model
        self._budget = budget
        self.calls = 0
        self.failures = 0

    @property
    def model_name(self):
        return getattr(self._model, "model_name", "unreported")

    def bind_tools(self, tools, **kwargs):
        bound = self._model.bind_tools(tools, **kwargs)
        return _CountingBound(bound, self)

    def __getattr__(self, item):
        return getattr(self._model, item)


class _CountingBound:
    def __init__(self, bound, owner: CountingModel) -> None:
        self._bound = bound
        self._owner = owner

    def invoke(self, *args, **kwargs):
        if self._owner.calls >= self._owner._budget:
            raise BudgetExceeded(
                f"已达批准上限 {self._owner._budget} 次调用，停止且不补跑。"
            )
        self._owner.calls += 1
        try:
            return self._bound.invoke(*args, **kwargs)
        except BaseException:
            self._owner.failures += 1
            raise

    def __getattr__(self, item):
        return getattr(self._bound, item)


def select_cases(dimensions: tuple[str, ...]) -> list[EvaluationCase]:
    cases = [case for case in (*CASES, *SEMANTIC_CASES) if case.dimension in dimensions]
    order = {name: index for index, name in enumerate(
        case.name for case in (*CASES, *SEMANTIC_CASES))}
    return sorted(cases, key=lambda case: order[case.name])


def prepare_output(output_dir: pathlib.Path) -> pathlib.Path:
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = output_dir / f"tier-a-{stamp}"
    run_dir.mkdir(mode=0o700)
    return run_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True,
                        help="仓库外私有目录；逐条原始结果写在这里。")
    parser.add_argument("--budget", type=int, default=BUDGET,
                        help=f"调用上限，默认 {BUDGET}。")
    parser.add_argument("--dimension", action="append", default=[],
                        help="可重复；默认 subject 与 paraphrase。")
    parser.add_argument("--dry-run", action="store_true",
                        help="只列出用例与预算，不读凭据、不联网。")
    args = parser.parse_args(argv)

    dimensions = tuple(args.dimension) or DEFAULT_DIMENSIONS
    selected = select_cases(dimensions)

    if args.dry_run:
        print(json.dumps({
            "dimensions": list(dimensions), "cases": len(selected),
            "budget": args.budget, "upper_bound_calls": len(selected) * MAX_CALLS_PER_CASE,
            "names": [case.name for case in selected],
        }, ensure_ascii=False, indent=2))
        return 0

    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        print(f"[skip] 未显式提供 {API_KEY_ENV}；未读 .env、未联网。")
        return 2

    run_dir = prepare_output(pathlib.Path(args.output_dir).expanduser())
    raw_path = run_dir / "tier-a-results.jsonl"
    meta_path = run_dir / "tier-a-meta.json"

    model = build_deepseek_model(api_key=api_key)
    counting = CountingModel(model, args.budget)
    runtime = LangChainExtractionRuntime(model=counting)
    verifier = LangChainSourceVerificationRuntime(model=counting)

    meta = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "run_id": str(uuid.uuid4()),
        "dimensions": list(dimensions),
        "cases": len(selected),
        "budget": args.budget,
        "model": counting.model_name,
        "base_url_host": (os.environ.get("NOTALONE_DEEPSEEK_BASE_URL", "")
                          .split("//")[-1].split("/")[0]),
        "synthetic_only": True,
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    os.chmod(meta_path, 0o600)
    print(json.dumps(meta, ensure_ascii=False), flush=True)

    results = []
    stopped = None
    with raw_path.open("w", encoding="utf-8") as raw:
        os.chmod(raw_path, 0o600)
        for index, case in enumerate(selected, 1):
            before = counting.calls
            try:
                result = evaluate_case(
                    case, build_window(case), runtime, verification_runtime=verifier,
                )
            except BudgetExceeded as error:
                stopped = str(error)
                raw.write(json.dumps({
                    "case": case.name, "dimension": case.dimension,
                    "budget_stopped": stopped, "calls_before": before,
                }, ensure_ascii=False) + "\n")
                break
            except Exception as error:  # 失败计入分母，不补跑
                stopped = f"{type(error).__name__}: {error}"
                raw.write(json.dumps({
                    "case": case.name, "dimension": case.dimension,
                    "failure": stopped, "calls_before": before,
                    "calls_used": counting.calls - before,
                }, ensure_ascii=False) + "\n")
                continue
            results.append(result)
            payload = asdict(result)
            payload["calls_used"] = counting.calls - before
            raw.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
            raw.flush()
            print(json.dumps({
                "progress": f"{index}/{len(selected)}", "case": case.name,
                "dimension": case.dimension, "passed": result.passed,
                "error_kind": result.error_kind, "calls": counting.calls,
            }, ensure_ascii=False), flush=True)

    summaries = summarize(results)
    agg = {
        "meta": meta,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "calls_used": counting.calls,
        "call_failures": counting.failures,
        "budget": args.budget,
        "budget_stopped": stopped,
        "evaluated": len(results),
        "planned": len(selected),
        "dimensions": [asdict(item) for item in summaries],
    }
    (run_dir / "tier-a-summary.json").write_text(
        json.dumps(agg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(run_dir / "tier-a-summary.json", 0o600)
    print(json.dumps(agg, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
