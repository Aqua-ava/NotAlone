"""实际合成捕获的薄适配器，只调用唯一E01报告，不执行语义判断。"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from notalone.reply.fidelity_evaluation import (
    BOUNDARY_DIMENSIONS, annotated_content_status, build_report,
)


def capture_report(capture: dict, case_spec: dict) -> dict:
    """评价来自独立审阅表；模型输入只读取已经发生的实际捕获。"""

    if capture.get("data_kind") != "synthetic" or case_spec.get("data_kind") != "synthetic":
        raise ValueError("只接收合成捕获及审阅表。")
    entry = capture.get("entry_point", "unknown")
    elapsed_scope = {"http": "直接 HTTP 请求发起至响应完成", "page": "页面操作至 HTTP 完成",
                     "unknown": "捕获未声明计时入口，起止范围未知"}
    if entry not in elapsed_scope:
        raise ValueError("捕获计时入口无效。")
    rows = capture["rows"]
    indexed = {row["case_id"]: row for row in rows}
    specifications = case_spec["cases"]
    spec_ids = [case["case_id"] for case in specifications]
    if len(indexed) != len(rows) or len(set(spec_ids)) != len(spec_ids) or set(indexed) != set(spec_ids):
        raise ValueError("捕获与审阅案例不完整或重复。")
    cases, attempts = [], []
    for specification in specifications:
        row = indexed[specification["case_id"]]
        payload = row["payload"]
        expectation = specification.get("expectation", {})
        evidence = payload["evidence"]
        cases.append({
            "case_id": row["case_id"], "split": specification["split"],
            "tags": specification.get("labels", []),
            "pair_id": specification.get("pair_id"),
            "current_intent": payload["fidelity_contract"]["current_intent"]["text"],
            "current_message": payload.get("draft_text", payload.get("current_text")),
            "available_facts": [{key: item[key] for key in ("kind", "text", "status", "factual_role") if key in item}
                                for item in evidence if item["kind"] not in
                                ("user_draft", "user_purpose", "continued_candidate", "pending_candidate", "style_sample")],
            "unknowns": expectation.get("unknowns", []),
            "allowed_changes": [payload["fidelity_contract"]["instruction_scope"]],
            "forbidden_additions": expectation.get("forbidden_additions", []),
            "expected_intent": expectation.get("intent"),
            "allowed_citations": [item["evidence_id"] for item in evidence],
            "actual_capture": {"owner_id": row["owner_id"], "contact_id": row["contact_id"],
                               "payload": payload, "system_prompt": row["system_prompt"]},
        })
        attempts.append({"case_id": row["case_id"], "status": "ok", "output": row["output"],
                         "elapsed_ms": row["latency_ms"], "call_count": row["call_count"]})
    reviews = []
    for annotation in case_spec.get("reviews", []):
        details = annotation["dimensions"]
        hard = {key: copy.deepcopy(details[key]) for key in BOUNDARY_DIMENSIONS}
        review = {"case_id": annotation["case_id"], "reviewer_kind": annotation["reviewer_kind"],
                  "reviewer": annotation["reviewer"], "details": hard,
                  "basis": "；".join(value["basis"] for value in hard.values()),
                  "intent": hard["intent"]["status"],
                  "unsupported_content": annotated_content_status(hard)}
        for key in ("naturalness", "relationship_fit", "user_similarity"):
            review[key] = details.get(key, {"status": "unknown"})["status"]
        reviews.append(review)
    report = build_report({"version": capture["data_version"], "cases": cases}, {
        "config": case_spec["config"], "attempts": attempts, "reviews": reviews,
    })
    report["protocol"].update({
        "capture_entry_point": entry, "capture_elapsed_scope": elapsed_scope[entry],
        "token_count": "unknown",
        "actual_input": "actual_capture保留实际模型输入；generation_input为供审阅整理的字段，不由报告发给模型。",
    })
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--case-spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = capture_report(json.loads(args.capture.read_text()), json.loads(args.case_spec.read_text()))
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
