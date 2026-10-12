"""公开参考的加载绑定；不认证中文语义，也不访问文件或供应商。"""

from __future__ import annotations

import hashlib
import json
import re


_ANNOTATION_PATH = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"


def _sha(reference: dict) -> str:
    return hashlib.sha256(json.dumps(
        reference, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")).hexdigest()


def validate_public_reference(
    reference: dict, *, expected_reference_sha256: str, annotation_sha256: str,
) -> dict:
    """期望摘要由调用方沿实际独审固定；不是由所加载材料自填证明。"""
    if not isinstance(reference, dict):
        raise ValueError("公开参考必须是JSON对象。")
    if any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None
           for value in (expected_reference_sha256, annotation_sha256)):
        raise ValueError("公开参考需要明确的独审和中文判据摘要。")
    try:
        actual_sha256 = _sha(reference)
    except (TypeError, ValueError) as error:
        raise ValueError("公开参考必须能够安全规范化。") from error
    if (actual_sha256 != expected_reference_sha256
            or reference.get("annotation_sha256") != annotation_sha256):
        raise ValueError("公开参考或中文判据摘要不一致。")
    provenance = reference.get("provenance")
    if (reference.get("annotation_path") != _ANNOTATION_PATH
            or not isinstance(provenance, dict)
            or provenance.get("oracle_aware") is not True
            or provenance.get("blind_annotation") is not False
            or provenance.get("quality_certified") is not False):
        raise ValueError("公开参考的来源与认证边界不一致。")
    structured = provenance.get("structured_review")
    human = provenance.get("human_review")
    if (not isinstance(structured, dict) or structured.get("status") != "passed"
            or not isinstance(structured.get("reviewer"), str)
            or not structured["reviewer"].strip()
            or not isinstance(human, list) or len(human) != 1
            or not isinstance(human[0], dict) or human[0].get("case_id") != "A14"
            or human[0].get("decision") != "none"
            or human[0].get("covered_fields") != ["inclusion"]):
        raise ValueError("公开参考缺实际装配复审或扩大了用户抽查范围。")
    windows = reference.get("windows")
    if not isinstance(windows, list) or len(windows) != 21:
        raise ValueError("公开参考必须保留全部21窗。")
    from .adapters import EXTRACTION_SCHEMA
    from .evaluation import build_window
    from .evaluation_cases import CASES
    from .evaluation_records import canonical_sha256
    from .evaluation_review import prepare_case_review
    from .semantic_evaluation_cases import SEMANTIC_CASES
    from .verification_adapters import SOURCE_VERIFICATION_SCHEMA

    if (reference.get("e_fields") !=
            EXTRACTION_SCHEMA["properties"]["facts"]["items"]["required"]
            or reference.get("v_fields") !=
            SOURCE_VERIFICATION_SCHEMA["properties"]["results"]["items"]["required"]):
        raise ValueError("公开参考的E/V字段与当前原工具不一致。")

    cases = tuple(case for case in CASES if case.dimension == "reference") + tuple(
        case for case in SEMANTIC_CASES if case.dimension == "reference"
    ) + tuple(case for case in SEMANTIC_CASES if case.name in {
        "严格：报价判断与条件咨询", "严格：第三人历史经历与当前未知",
    })
    identities = [f"A{index:02d}" for index in range(1, 20)] + ["B01", "B02"]
    if len(cases) != 21:
        raise ValueError("当前公开计划不再是已审21窗。")
    empty_evidence = {
        "run_status": "unrun", "extraction": [], "verification_inputs": [],
        "verification": [], "final_facts": [], "original_result": {},
    }
    for position, (window, case, identity) in enumerate(zip(windows, cases, identities)):
        if (not isinstance(window, dict)
                or window.get("id") != identity
                or window.get("position") != position
                or window.get("case_name") != case.name
                or window.get("input_sha256") != canonical_sha256(build_window(case))
                or window.get("target_indices") != list(case.targets)
                or window.get("inclusion") != ("none" if identity in {"A12", "A14"}
                                                else "retain")):
            raise ValueError("公开参考窗口与固定输入、顺序或纳入范围不一致。")
        prepare_case_review(reference, identity, empty_evidence)
    claims = [claim for window in windows for claim in window["claims"]]
    required = sum(claim["required"] is True for claim in claims)
    optional = sum(claim["required"] is False for claim in claims)
    if required != 28 or optional != 1:
        raise ValueError("公开参考的必需与可选分母不一致。")
    if [claim["id"] for claim in claims if not claim["required"]] != ["A15-P2"]:
        raise ValueError("公开参考的可选命题不是原借书关系。")
    return {
        "reference_sha256": expected_reference_sha256,
        "annotation_sha256": annotation_sha256,
        "planned_windows": len(reference["windows"]),
        "required_claims": required,
        "optional_claims": optional,
        "quality_certified": False,
    }
