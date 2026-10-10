"""仅消费合成案例、受控输出及显式标注的离线保真报告入口。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REVIEW_DIMENSIONS = (
    "intent", "unsupported_content", "naturalness", "relationship_fit",
    "user_similarity",
)
INPUT_FIELDS = ("current_intent", "available_facts", "unknowns", "allowed_changes")
OPTIONAL_INPUT_FIELDS = ("current_message", "recent_context")


def generation_input(case: dict[str, Any]) -> dict[str, Any]:
    """白名单防止预期答案、评分标签及保留集划分进入模型输入。"""

    return {**{key: case[key] for key in INPUT_FIELDS},
            **{key: case[key] for key in OPTIONAL_INPUT_FIELDS if key in case}}


def _counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    reviewed = sum(row["semantic_review"]["status"] == "reviewed" for row in rows)
    unknown_cost = sum(row["elapsed_ms"] is None or row["call_count"] is None for row in rows)
    known_calls = sum(row["call_count"] for row in rows if row["call_count"] is not None)
    known_elapsed = sum(row["elapsed_ms"] for row in rows if row["elapsed_ms"] is not None)
    dimensions = {}
    for field in REVIEW_DIMENSIONS:
        counts = {value: sum(row["semantic_review"].get(field) == value for row in rows)
                  for value in ("pass", "fail", "unknown")}
        dimensions[field] = {"denominator": len(rows),
                             "evaluated_denominator": counts["pass"] + counts["fail"],
                             **counts, "unreviewed": len(rows) - reviewed}
    return {
        "denominator": len(rows),
        "contract_failed": sum(row["deterministic_contract"]["status"] == "fail" for row in rows),
        "semantic_reviewed": reviewed,
        "fidelity_failed": sum(any(row["semantic_review"].get(field) == "fail"
                                   for field in ("intent", "unsupported_content")) for row in rows),
        "unreviewed": len(rows) - reviewed,
        "known_call_count": known_calls, "known_elapsed_ms": known_elapsed,
        "unknown_cost_count": unknown_cost,
        "total_call_count": None if unknown_cost else known_calls,
        "total_elapsed_ms": None if unknown_cost else known_elapsed,
        "quality_verified": False, "dimensions": dimensions,
    }


def deterministic_contract(output: Any, *, allowed_citations: list[str]) -> dict[str, Any]:
    """只核验结构与已声明引用范围，不推断语义蕴含。"""

    errors: list[str] = []
    if not isinstance(output, dict) or not isinstance(output.get("candidates"), list):
        return {"status": "fail", "errors": ["invalid_structure"]}
    candidates = output["candidates"]
    if not 1 <= len(candidates) <= 3:
        errors.append("invalid_candidate_count")
    for candidate in candidates:
        if not isinstance(candidate, dict):
            errors.append("invalid_candidate")
            continue
        for field in ("text", "basis"):
            if not isinstance(candidate.get(field), str) or not candidate[field].strip():
                errors.append(f"invalid_{field}")
        citations = candidate.get("citation_ids")
        if not isinstance(citations, list) or any(
            not isinstance(citation, str) or citation not in allowed_citations
            for citation in citations
        ):
            errors.append("unauthorized_citation")
    return {"status": "fail" if errors else "pass", "errors": errors}


def _index(entries: list[dict[str, Any]], valid_ids: set[str]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        case_id = entry.get("case_id")
        if case_id not in valid_ids or case_id in result:
            raise ValueError("评测包含未知或重复案例标识。")
        result[case_id] = entry
    return result


def build_report(dataset: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    """保留完整分母及原输出；人工标注与确定性结果分别呈现。"""

    if not isinstance(dataset.get("version"), str) or not dataset["version"].strip() or not isinstance(run.get("config"), dict) or any(
        not isinstance(run["config"].get(key), str) or not run["config"][key].strip()
        for key in ("model", "prompt_version")
    ):
        raise ValueError("评测须记录数据版本与模型/提示配置。")
    cases = dataset["cases"]
    valid_ids = {case["case_id"] for case in cases}
    if len(valid_ids) != len(cases):
        raise ValueError("评测案例标识重复。")
    attempts = _index(run.get("attempts", []), valid_ids)
    reviews = _index(run.get("reviews", []), valid_ids)
    rows: list[dict[str, Any]] = []
    for case in cases:
        if case.get("split") not in ("development", "holdout"):
            raise ValueError("案例必须声明开发/保留划分。")
        model_input = generation_input(case)
        attempt = attempts.get(case["case_id"])
        status = "missing" if attempt is None else attempt["status"]
        if status not in ("ok", "error", "timeout", "missing"):
            raise ValueError("受控响应状态无效。")
        elapsed_ms = None if attempt is None else attempt.get("elapsed_ms")
        calls = None if attempt is None else attempt.get("call_count")
        if attempt is not None and (
            type(elapsed_ms) not in (int, float) or elapsed_ms <= 0
            or type(calls) is not int or calls < 0
            or (status == "timeout" and calls < 1)
        ):
            raise ValueError("已执行响应必须记录真实正耗时和调用次数。")
        output = None if attempt is None else attempt.get("output")
        contract = deterministic_contract(
            output, allowed_citations=case.get("allowed_citations", []),
        ) if status == "ok" else {"status": "fail", "errors": [status]}
        review = reviews.get(case["case_id"])
        semantic: dict[str, Any] = {"status": "unreviewed"}
        if review is not None:
            if not review.get("reviewer") or not review.get("basis") or any(
                review.get(field) not in ("pass", "fail", "unknown")
                for field in REVIEW_DIMENSIONS
            ):
                raise ValueError("语义审阅必须明确标注者、依据及全部维度。")
            semantic = {key: review[key] for key in ("reviewer", "basis", *REVIEW_DIMENSIONS)}
            semantic["status"] = "reviewed"
        rows.append({
            "case_id": case["case_id"], "split": case["split"],
            "tags": case.get("tags", []), "generation_input": model_input,
            "forbidden_additions": case.get("forbidden_additions", []),
            "status": status, "output": output,
            "elapsed_ms": elapsed_ms, "call_count": calls,
            "deterministic_contract": contract, "semantic_review": semantic,
        })
    summary = _counts(rows)
    summary["by_split"] = {split: _counts([row for row in rows if row["split"] == split])
                           for split in ("development", "holdout")}
    return {
        "data_version": dataset["version"], "config": run["config"],
        "protocol": {
            "mode": "offline_controlled_outputs",
            "semantic_method": "explicit_annotations_only",
            "missing_cost": "unknown",
            "holdout_policy": "提示调整使用过的保留案例不得再称未见数据",
            "limitations": "合成输出仅验证报告流程；真实语义、自然度与用户相似度未验证。",
        },
        "summary": summary, "cases": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="合成输出离线保真报告，不调用模型")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        report = build_report(
            json.loads(arguments.dataset.read_text(encoding="utf-8")),
            json.loads(arguments.run.read_text(encoding="utf-8")),
        )
    except (KeyError, TypeError, ValueError):
        parser.error("离线评测资料结构无效。")
    arguments.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
