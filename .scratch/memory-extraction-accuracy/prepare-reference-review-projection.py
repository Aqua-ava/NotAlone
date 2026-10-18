"""任务07只读核验／显式生成机械投影；不含供应商、凭据或数据库入口。"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
from dataclasses import replace
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
os.environ["NOTALONE_DISABLE_DOTENV"] = "1"
sys.path.insert(0, str(ROOT / "backend/src"))
from notalone.memory_extraction.cases.reference import CASES
from notalone.memory_extraction.cases.types import EvaluationCase, ExpectedDestination
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.evaluation_records import canonical_sha256, _json_value
from notalone.memory_extraction.evaluation_reference import public_window_projection
from notalone.memory_extraction.evaluation_review import validate_reference_structure

SOURCES = {
    ".scratch/unfinished-work/memory-gold-reference-v2-20261016.json":
        "6ec7ee70a47b94d0cdf667be6478b8fe7cbe33e91bc3d4ec5e49ee340914f738",
    ".scratch/memory-extraction-accuracy/reference-agent-contrast-gold-20261018.json":
        "7d7ff70e5d906255d7b26a1682433bb73867e264e1f3bb1e6846c3f8f9cd0786",
}
ANNOTATION = OUT / "reference-review-projection-20261018.md"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def materials() -> dict[str, dict]:
    for name, digest in SOURCES.items():
        if sha(ROOT / name) != digest:
            raise ValueError("原Gold已变化，禁止静默重生成")
    original, diagnostic = [json.loads((ROOT / name).read_text()) for name in SOURCES]
    main = copy.deepcopy(original)
    main.update(status="agent_reviewed_reference",
                annotation_path=str(ANNOTATION.relative_to(ROOT)), annotation_sha256=sha(ANNOTATION))
    main["windows"] = main["windows"][:16]
    main["provenance"] = {"synthetic_only": True, "quality_certified": False,
        "blind_annotation": False, "source_file_sha256": SOURCES,
        "source_provenance": original["provenance"], "projection_group": "main16",
        "scope": "仅原A01–A16；common_rules逐字保留，原其他5窗不进入本集合。",
        "projection_review": {"reviewer_kind": "agent", "semantic_equivalence": "passed",
            "standards": "passed", "execution_authorized_by_projection": False}}
    derived = {"format_version": 1, "status": "mechanical_projection_incomplete",
        "annotation_path": str(ANNOTATION.relative_to(ROOT)), "annotation_sha256": sha(ANNOTATION),
        "provenance": {"synthetic_only": True, "quality_certified": False,
            "blind_annotation": False, "source_file_sha256": SOURCES,
            "source_provenance": diagnostic["provenance"], "projection_group": "diagnostic8",
            "original_gold_by_case": {c["case_id"]: c["gold"] for c in diagnostic["cases"]},
            "unresolved_projection_fields": ["reason_rule"],
            "projection_review": {"reviewer_kind": "agent", "mechanical_equivalence": "passed",
                "standards": "passed", "formal_reference_complete": False}},
        "e_fields": original["e_fields"], "v_fields": original["v_fields"],
        "common_rules": {"boundaries": diagnostic["boundaries"], "pairs": diagnostic["pairs"],
            "scope": "D01–D08独立诊断，仅7个必需命题；不补主16分数。"}, "windows": []}
    snapshots = []
    for index, case in enumerate(CASES):
        window = build_window(case)
        assert main["windows"][index]["input_sha256"] == canonical_sha256(public_window_projection(window))
        snapshots.append({"case_id": f"A{index+1:02d}", "group": "main16",
            "window": _json_value(window), "full_window_sha256": canonical_sha256(window),
            "gold_input_sha256": main["windows"][index]["input_sha256"]})
    for index, item in enumerate(diagnostic["cases"]):
        cid, g = item["case_id"], item["gold"]
        if canonical_sha256({"messages": item["messages"],
                             "target_indices": item["target_indices"]}) != item["input_sha256"]:
            raise ValueError("D8原输入摘要不匹配")
        case = EvaluationCase(name="独立诊断：" + cid, dimension="reference",
            messages=tuple((m["sender"], m["text"]) for m in item["messages"]),
            targets=tuple(item["target_indices"]), expect=ExpectedDestination(g["ideal_destination"]))
        window = build_window(case)
        window = replace(window, messages=tuple(replace(m,
            occurred_at=datetime.fromisoformat(item["messages"][i]["occurred_at"]))
            for i, m in enumerate(window.messages)))
        gold_hash = canonical_sha256(public_window_projection(window))
        snapshots.append({"case_id": cid, "group": "diagnostic8", "window": _json_value(window),
            "full_window_sha256": canonical_sha256(window), "gold_input_sha256": gold_hash,
            "original_input_sha256": item["input_sha256"]})
        claims = []
        if g["required_claim_count"]:
            start, end = None, None
            if cid in {"D01", "D02"}:
                start = item["messages"][0]["occurred_at"]
            if cid == "D04":
                start, end = "2026-11-01T00:00:00+08:00", "2027-02-01T00:00:00+08:00"
            variant = {"id": cid + "-P1-v1", "body_requirements": g["necessary_propositions"],
                "subject": g["subject"], "category": g["category"], "allowed_topics": [g["topic"]],
                "source_choices": [{"indices": g["source_indices"], "when": "沿原source_indices，不增加来源组合。"}],
                "speech_act": g["speech_act"], "assertion_status": g["assertion_status"],
                "figurative_type": g["figurative_type"], "valid_at": start, "invalid_at": end,
                "time_rule": g["time_note"], "ideal_destination": g["ideal_destination"],
                "risk_rule": g["risk_rule"], "alternatives_rule": g["alternatives_requirement"],
                "reason_rule": None}
            claims = [{"id": cid + "-P1", "required": True,
                "meaning_requirements": g["necessary_propositions"], "variants": [variant]}]
        derived["windows"].append({"id": cid, "position": index, "case_name": case.name,
            "input_sha256": gold_hash, "target_indices": item["target_indices"],
            "inclusion": g["inclusion"], "claims": claims, "forbidden_meanings": g["forbidden_inferences"]})
    assert main["windows"] == original["windows"][:16]
    assert [sum(c["required"] for w in r["windows"] for c in w["claims"]) for r in (main, derived)] == [18, 7]
    for reference in (main, derived):
        for window in reference["windows"]:
            validate_reference_structure(reference, window["id"])
    return {"reference-main16-review-projection-20261018.json": main,
        "reference-diagnostic8-review-projection-20261018.json": derived,
        "reference24-input-snapshot-20261018.json": {"format_version": 1,
            "status": "offline_input_snapshot", "source_file_sha256": SOURCES,
            "groups": {"main16": 16, "diagnostic8": 8}, "cases": snapshots}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--previous-freeze", type=Path)
    args = parser.parse_args()
    values = materials()
    for name, value in values.items():
        encoded = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        if args.write:
            (OUT / name).write_text(encoded)
        elif (OUT / name).read_text() != encoded:
            raise ValueError("投影与原Gold不等价：" + name)
    if args.previous_freeze:
        previous = json.loads(args.previous_freeze.read_text())
        current = values["reference24-input-snapshot-20261018.json"]["cases"]
        assert [c["window"] for c in current] == previous["windows"]
    print("24窗原输入；主16/18必需＋诊断8/7必需；结构与机械投影一致。D8理由判据缺口保留，未授予执行资格。")
