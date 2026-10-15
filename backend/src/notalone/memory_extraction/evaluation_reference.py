"""公开参考的加载绑定；不认证中文语义，也不访问文件或供应商。"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any, NamedTuple


_ANNOTATION_PATH = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
PUBLIC_REFERENCE_PATH = ".scratch/unfinished-work/memory-gold-reference-20261012.json"
FULL_REFERENCE_PATH = ".scratch/unfinished-work/memory-gold-full140-reference-20261013.json"
FULL_ANNOTATION_PATH = (
    ".scratch/unfinished-work/memory-gold-full140-agent-annotations-20261013.md"
)
_PARENT_SHA = "5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32"
_PARENT_FILE_SHA = "5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6"
PUBLIC_REFERENCE_V2_PATH = ".scratch/unfinished-work/memory-gold-reference-v2-20261016.json"
PUBLIC_ANNOTATION_V2_PATH = ".scratch/unfinished-work/memory-gold-agent-annotations-v2-20261016.md"
FULL_REFERENCE_V2_PATH = ".scratch/unfinished-work/memory-gold-full140-reference-v2-20261016.json"
FULL_ANNOTATION_V2_PATH = ".scratch/unfinished-work/memory-gold-full140-agent-annotations-v2-20261016.md"
_PUBLIC_V2_FILE_SHA = "6ec7ee70a47b94d0cdf667be6478b8fe7cbe33e91bc3d4ec5e49ee340914f738"


class _ReferenceBinding(NamedTuple):
    reference_path: str
    reference_sha256: str
    annotation_path: str
    annotation_sha256: str


_PUBLIC_V2 = _ReferenceBinding(
    PUBLIC_REFERENCE_V2_PATH,
    "823d680bfa9e4c62024e570de0dddd2eb06e27d6fe05ba757e88e6dfb08f2635",
    PUBLIC_ANNOTATION_V2_PATH,
    "99efaae24d8d4175a2006ae8442e8ea8635728c3eef3d9c9bc8357d382683977",
)
_FULL_V2 = _ReferenceBinding(
    FULL_REFERENCE_V2_PATH,
    "e0edd5d6badafc23e63bd85375a21e126c962d4b0758bbf721786d58fa254040",
    FULL_ANNOTATION_V2_PATH,
    "df79166517ed9196d8f9011aeb59b2b496b5ce233a45df85a98ae1029a4e5560",
)


def _is_source_fidelity_v2(reference_version: str) -> bool:
    if type(reference_version) is not str or reference_version not in {
        "legacy-v1", "source-fidelity-v2",
    }:
        raise ValueError("公开参考版本必须显式选择已支持的封闭值。")
    return reference_version == "source-fidelity-v2"


def _validate_v2_binding(
    reference: dict, expected_reference_sha256: str, annotation_sha256: str,
    binding: _ReferenceBinding,
) -> None:
    """v2只接受实际两轴复审后的固定材料；不由调用方自填状态授予资格。"""
    provenance = reference.get("provenance")
    if (
        reference.get("status") != "agent_reviewed_reference"
        or reference.get("annotation_path") != binding.annotation_path
        or reference.get("annotation_sha256") != binding.annotation_sha256
        or expected_reference_sha256 != binding.reference_sha256
        or annotation_sha256 != binding.annotation_sha256
        or type(provenance) is not dict
        or provenance.get("reference_version") != "source-fidelity-v2"
        or provenance.get("reference_path") != binding.reference_path
        or not isinstance(provenance.get("structured_review"), dict)
        or provenance["structured_review"].get("status") != "passed"
        or not isinstance(provenance.get("independent_review"), dict)
        or provenance["independent_review"].get("status") != "passed"
    ):
        raise ValueError("来源保真v2须绑定固定路径、摘要与实际已复审状态。")


def public_window_projection(window: object) -> dict[str, Any]:
    """固定公开输入的旧摘要形状；运行时窗口保留新增的类型元数据。"""
    from .evaluation_records import _json_value

    value = _json_value(window)
    if not isinstance(value, dict) or not isinstance(value.get("messages"), list):
        raise ValueError("公开窗口必须保留原消息集合。")
    fields = {"message_type", "text_representation"}
    for message in value["messages"]:
        if not isinstance(message, dict):
            raise ValueError("公开窗口消息必须是对象。")
        present = fields & message.keys()
        if not present:
            continue
        if present != fields or any(
            type(message[field]) is not str or message[field] != "unknown"
            for field in fields
        ):
            raise ValueError("公开输入不能静默丢弃非默认或不完整的类型元数据。")
        for field in fields:
            del message[field]
    return value


def _sha(reference: dict) -> str:
    return hashlib.sha256(json.dumps(
        reference, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")).hexdigest()


def validate_public_reference(
    reference: dict, *, expected_reference_sha256: str, annotation_sha256: str,
    reference_version: str = "legacy-v1",
) -> dict:
    """期望摘要由调用方沿实际独审固定；不是由所加载材料自填证明。"""
    source_fidelity = _is_source_fidelity_v2(reference_version)
    if not isinstance(reference, dict):
        raise ValueError("公开参考必须是JSON对象。")
    if source_fidelity:
        _validate_v2_binding(reference, expected_reference_sha256, annotation_sha256, _PUBLIC_V2)
    elif isinstance(reference.get("provenance"), dict) and reference["provenance"].get(
        "reference_version", "legacy-v1",
    ) != "legacy-v1":
        raise ValueError("来源保真v2不能冒充默认旧参考。")
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
    annotation_path = PUBLIC_ANNOTATION_V2_PATH if source_fidelity else _ANNOTATION_PATH
    if (reference.get("annotation_path") != annotation_path
            or not isinstance(provenance, dict)
            or provenance.get("oracle_aware") is not True
            or provenance.get("blind_annotation") is not False
            or provenance.get("quality_certified") is not False):
        raise ValueError("公开参考的来源与认证边界不一致。")
    structured = provenance.get("structured_review")
    human = provenance.get("human_review")
    if ((not source_fidelity and (
            not isinstance(structured, dict) or structured.get("status") != "passed"
            or not isinstance(structured.get("reviewer"), str)
            or not structured["reviewer"].strip()))
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
    from .evaluation_review import prepare_case_review, validate_reference_structure
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
                or window.get("input_sha256") != canonical_sha256(
                    public_window_projection(build_window(case)),
                )
                or window.get("target_indices") != list(case.targets)
                or window.get("inclusion") != ("none" if identity in {"A12", "A14"}
                                                else "retain")):
            raise ValueError("公开参考窗口与固定输入、顺序或纳入范围不一致。")
        if source_fidelity:
            validate_reference_structure(reference, identity)
        else:
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
        **({"reference_version": reference_version, "review_pending": False,
            "execution_ready": True} if source_fidelity else {}),
    }


def _fixed_case_sets() -> tuple[tuple, tuple]:
    from .evaluation_cases import CASES
    from .semantic_evaluation_cases import SEMANTIC_CASES

    full = (*CASES, *SEMANTIC_CASES)
    original = tuple(case for case in CASES if case.dimension == "reference") + tuple(
        case for case in SEMANTIC_CASES if case.dimension == "reference"
    ) + tuple(case for case in SEMANTIC_CASES if case.name in {
        "严格：报价判断与条件咨询", "严格：第三人历史经历与当前未知",
    })
    if (len(full) != 140 or len(original) != 21
            or len({case.name for case in full}) != 140):
        raise ValueError("完整公开集合与原固定计划不一致。")
    return original, full


def full_case_reference_positions() -> tuple[int, ...]:
    """运行顺序保持原140；参考保持旧21前缀和119原序追加。"""
    original, full = _fixed_case_sets()
    old_names = {case.name for case in original}
    ordered = (*original, *(case for case in full if case.name not in old_names))
    positions = {case.name: index for index, case in enumerate(ordered)}
    return tuple(positions[case.name] for case in full)


def _full_variant(variant: dict, message_count: int, targets: tuple[int, ...]) -> None:
    from .adapters import EXTRACTION_SCHEMA

    properties = EXTRACTION_SCHEMA["properties"]["facts"]["items"]["properties"]
    for field in ("subject", "category", "speech_act", "assertion_status", "figurative_type"):
        if type(variant[field]) is not str or variant[field] not in properties[field]["enum"]:
            raise ValueError("扩展命题的语用与主体标签不完整。")
    topics = variant["allowed_topics"]
    if (type(topics) is not list or not topics
            or any(type(topic) is not str or topic not in properties["topic"]["enum"]
                   for topic in topics) or len(set(topics)) != len(topics)):
        raise ValueError("扩展命题的topic范围不完整。")
    for field in ("time_rule", "risk_rule", "alternatives_rule", "reason_rule"):
        if type(variant[field]) is not str or not variant[field].strip():
            raise ValueError("扩展命题缺有据的字段判据。")
    requirements = variant["body_requirements"]
    if (type(requirements) is not list or not requirements
            or any(type(item) is not str or not item.strip() for item in requirements)):
        raise ValueError("扩展命题缺正文判据。")
    dates: dict[str, datetime] = {}
    for field in ("valid_at", "invalid_at"):
        value = variant[field]
        if value is not None:
            if type(value) is not str:
                raise ValueError("扩展命题日期须为明确空或带时区的ISO值。")
            dates[field] = datetime.fromisoformat(value)
            if dates[field].utcoffset() is None:
                raise ValueError("扩展命题日期须为明确空或带时区的ISO值。")
    if len(dates) == 2 and dates["invalid_at"] <= dates["valid_at"]:
        raise ValueError("扩展命题有效期结束必须晚于开始。")
    choices = variant["source_choices"]
    if type(choices) is not list or not choices:
        raise ValueError("扩展命题缺实际来源范围。")
    for choice in choices:
        if (type(choice) is not dict or set(choice) != {"indices", "when"}
                or type(choice["when"]) is not str or not choice["when"].strip()):
            raise ValueError("扩展命题来源判据不完整。")
        indices = choice["indices"]
        if (type(indices) is not list or not indices
                or any(type(index) is not int or not 0 <= index < message_count
                       for index in indices)
                or len(set(indices)) != len(indices) or not set(indices).intersection(targets)):
            raise ValueError("扩展命题来源必须落在原窗并含target。")


def validate_full_public_reference(
    reference: dict, *, expected_reference_sha256: str, annotation_sha256: str,
    reference_version: str = "legacy-v1",
) -> dict:
    """只核固定140装配与独审绑定，不认证119中文判据或模型质量。"""
    source_fidelity = _is_source_fidelity_v2(reference_version)
    if (type(reference) is not dict
            or any(type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None
                   for value in (expected_reference_sha256, annotation_sha256))):
        raise ValueError("完整公开参考需要明确的独审摘要。")
    if source_fidelity:
        _validate_v2_binding(reference, expected_reference_sha256, annotation_sha256, _FULL_V2)
    elif isinstance(reference.get("provenance"), dict) and reference["provenance"].get(
        "reference_version", "legacy-v1",
    ) != "legacy-v1":
        raise ValueError("来源保真v2不能冒充默认旧参考。")
    try:
        actual_sha = _sha(reference)
    except (TypeError, ValueError) as error:
        raise ValueError("完整公开参考必须能够安全规范化。") from error
    annotation_path = FULL_ANNOTATION_V2_PATH if source_fidelity else FULL_ANNOTATION_PATH
    if (actual_sha != expected_reference_sha256
            or reference.get("annotation_path") != annotation_path
            or reference.get("annotation_sha256") != annotation_sha256):
        raise ValueError("完整公开参考或中文判据绑定不一致。")
    provenance = reference.get("provenance")
    if (type(provenance) is not dict or provenance.get("oracle_aware") is not True
            or provenance.get("blind_annotation") is not False
            or provenance.get("quality_certified") is not False
            or provenance.get("human_review") != []
            or provenance.get("reference_complete") is not True
            or provenance.get("unresolved_cases") != []):
        raise ValueError("完整参考不能含未决项或扩大人工确认。")
    review = provenance.get("structured_review")
    if not source_fidelity and (type(review) is not dict or review.get("status") != "passed"
            or type(review.get("reviewer")) is not str or not review["reviewer"].strip()):
        raise ValueError("完整参考必须经过显式装配复审。")
    parent = provenance.get("parent21")
    parent_path = PUBLIC_REFERENCE_V2_PATH if source_fidelity else PUBLIC_REFERENCE_PATH
    parent_file_sha = _PUBLIC_V2_FILE_SHA if source_fidelity else _PARENT_FILE_SHA
    parent_sha = _PUBLIC_V2.reference_sha256 if source_fidelity else _PARENT_SHA
    if (type(parent) is not dict or set(parent) != {
        "reference_path", "reference_file_sha256", "reference_sha256", "reference",
    } or parent["reference_path"] != parent_path
            or parent["reference_file_sha256"] != parent_file_sha
            or parent["reference_sha256"] != parent_sha
            or type(parent["reference"]) is not dict):
        raise ValueError("完整参考须保留原21完整对象和文件绑定。")
    original = parent["reference"]
    parent_annotation = original.get("annotation_sha256")
    if type(parent_annotation) is not str:
        raise ValueError("原21判据摘要必须明确保留。")
    validate_public_reference(
        original, expected_reference_sha256=parent_sha,
        annotation_sha256=parent_annotation, reference_version=reference_version,
    )
    from .evaluation import build_window
    from .evaluation_records import canonical_sha256
    from .evaluation_review import prepare_case_review, validate_reference_structure

    _, cases = _fixed_case_sets()
    positions = full_case_reference_positions()
    provided = provenance.get("local_to_reference_positions")
    if (type(provided) is not list or any(type(index) is not int for index in provided)
            or provided != list(positions)
            or provenance.get("public_cases_sha256") != canonical_sha256(cases)):
        raise ValueError("完整参考映射或原公开oracle不一致。")
    windows = reference.get("windows")
    if (type(windows) is not list or len(windows) != 140
            or canonical_sha256(windows[:21]) != canonical_sha256(original["windows"])
            or reference.get("e_fields") != original["e_fields"]
            or reference.get("v_fields") != original["v_fields"]):
        raise ValueError("完整参考须保留原21前缀和完整14/4字段。")
    scopes = provenance.get("rule_scopes")
    if (type(reference.get("common_rules")) is not dict or not reference["common_rules"]
            or reference["common_rules"] == original["common_rules"]
            or type(scopes) is not dict or scopes != {
                "original21_common_rules_sha256": canonical_sha256(original["common_rules"]),
                "extended119_common_rules_sha256": canonical_sha256(reference["common_rules"]),
                "extended_case_ids": [f"R{index:03d}" for index in range(1, 120)],
            }):
        raise ValueError("原21与扩展119判据必须分范围绑定。")
    empty = {"run_status": "unrun", "extraction": [], "verification_inputs": [],
             "verification": [], "final_facts": [], "original_result": {}}
    if source_fidelity:
        validate_reference_structure(reference, "R001")
    else:
        prepare_case_review(reference, "R001", empty)
    for case, position in zip(cases, positions):
        window = windows[position]
        if (window["case_name"] != case.name
                or window["input_sha256"] != canonical_sha256(
                    public_window_projection(build_window(case)),
                )
                or type(window["target_indices"]) is not list
                or window["target_indices"] != list(case.targets)
                or any(type(index) is not int for index in window["target_indices"])):
            raise ValueError("完整参考case必须对应原公开输入和target。")
        if position < 21:
            continue
        if (window["id"] != f"R{position - 20:03d}"
                or window["inclusion"] != ("none" if case.expect == "none" else "retain")
                or bool(window["claims"]) != (window["inclusion"] == "retain")):
            raise ValueError("扩展119身份、原纳入范围或命题不完整。")
        for claim in window["claims"]:
            if (claim["required"] is not True
                    or type(claim["meaning_requirements"]) is not list
                    or not claim["meaning_requirements"]
                    or any(type(item) is not str or not item.strip()
                           for item in claim["meaning_requirements"])):
                raise ValueError("扩展119须保留完整必需命题，不新增可选救分。")
            for variant in claim["variants"]:
                _full_variant(variant, len(case.messages), case.targets)
    return {
        "reference_sha256": expected_reference_sha256,
        "annotation_sha256": annotation_sha256, "planned_windows": 140,
        "case_positions": positions, "quality_certified": False,
        **({"reference_version": reference_version, "review_pending": False,
            "execution_ready": True} if source_fidelity else {}),
    }
