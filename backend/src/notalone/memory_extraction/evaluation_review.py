"""显式审核证据的纯机械装配和计数，不自行判断中文语义。"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime
from typing import Any
from uuid import NAMESPACE_URL, uuid5


_E_FIELDS = (
    "text", "category", "subject", "topic", "source_message_ids", "confidence",
    "risk_flags", "valid_at", "invalid_at", "speech_act", "assertion_status",
    "figurative_type", "alternatives", "interpretation_reason",
)
_V_FIELDS = ("candidate_index", "verdict", "issues", "evidence")
_LAYERS = ("extraction", "verification_inputs", "verification", "final_facts")
_GROUP_CHECKS = ("raw_meaning", "coherence", "branch", "source", "time", "lineage", "destination")
_STATUSES = frozenset({"pass", "fail", "unresolved"})
_RUN_STATUSES = frozenset({"completed", "empty", "failed", "unknown", "unrun"})
_WINDOW_CHECKS = frozenset({"inclusion", "forbidden_meanings", "lineage"})
_CLASSIFICATIONS = frozenset({"required", "optional", "extra", "duplicate", "excluded"})
# safety描述输出的忠实与风险；输入身份未知不等于输出不安全，safe也不授权auto。
_SAFETY = frozenset({"safe", "false_fact", "wrong_person", "ambiguous", "unresolved"})
_REFERENCE_FIELDS = frozenset({
    "format_version", "status", "annotation_path", "annotation_sha256",
    "provenance", "e_fields", "v_fields", "common_rules", "windows",
})


def _json_copy(value: Any) -> Any:
    def check(item: Any) -> None:
        if type(item) is dict:
            if any(type(key) is not str for key in item):
                raise ValueError("review_non_json_value")
            for nested in item.values():
                check(nested)
        elif type(item) is list:
            for nested in item:
                check(nested)
        elif type(item) is float:
            if not math.isfinite(item):
                raise ValueError("review_non_finite_number")
        elif item is not None and type(item) not in (str, int, bool):
            raise ValueError("review_non_json_value")

    check(value)
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def _sha(value: Any) -> str:
    content = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def _case(reference: dict, case_id: str) -> dict:
    matches = [window for window in reference["windows"] if window["id"] == case_id]
    if len(matches) != 1:
        raise ValueError("review_unknown_or_duplicate_case")
    return matches[0]


def _keys(value: Any, keys: set[str] | frozenset[str]) -> None:
    if type(value) is not dict or set(value) != keys:
        raise ValueError("review_invalid_fields")


def _enum(value: Any, allowed: frozenset[str]) -> None:
    if type(value) is not str or value not in allowed:
        raise ValueError("review_invalid_enum")


def _nonempty(value: Any) -> None:
    if type(value) is not str or not value.strip():
        raise ValueError("review_required_text_missing")


def _indices(value: Any, size: int, *, nonempty: bool = False) -> None:
    if (type(value) is not list or (nonempty and not value)
            or any(type(index) is not int or not 0 <= index < size for index in value)
            or len(set(value)) != len(value)):
        raise ValueError("review_invalid_indices")


def _field_statuses(value: Any, fields: tuple[str, ...] | frozenset[str]) -> None:
    _keys(value, frozenset(fields))
    for status in value.values():
        _enum(status, _STATUSES)


def validate_reference_structure(reference: dict, case_id: str) -> None:
    """只核九键参考及窗口结构；不生成审核packet或授予执行资格。"""
    _keys(reference, _REFERENCE_FIELDS)
    if (type(reference["format_version"]) is not int or reference["format_version"] != 1
            or reference["e_fields"] != list(_E_FIELDS)
            or reference["v_fields"] != list(_V_FIELDS)
            or type(reference["provenance"]) is not dict
            or type(reference["common_rules"]) is not dict
            or type(reference["windows"]) is not list):
        raise ValueError("review_reference_invalid")
    _nonempty(reference["status"])
    _nonempty(reference["annotation_path"])
    window_ids: list[str] = []
    for position, window in enumerate(reference["windows"]):
        _keys(window, {
            "id", "position", "case_name", "input_sha256", "target_indices",
            "inclusion", "claims", "forbidden_meanings",
        })
        _nonempty(window["id"])
        _nonempty(window["case_name"])
        if type(window["position"]) is not int or window["position"] != position:
            raise ValueError("review_case_order_invalid")
        _enum(window["inclusion"], frozenset({"retain", "none"}))
        if type(window["claims"]) is not list or type(window["forbidden_meanings"]) is not list:
            raise ValueError("review_reference_invalid")
        window_ids.append(window["id"])
        claim_ids: list[str] = []
        for claim in window["claims"]:
            _keys(claim, {"id", "required", "meaning_requirements", "variants"})
            _nonempty(claim["id"])
            if type(claim["required"]) is not bool or type(claim["variants"]) is not list:
                raise ValueError("review_claim_invalid")
            if not claim["variants"]:
                raise ValueError("review_claim_variants_missing")
            variant_ids: list[str] = []
            for variant in claim["variants"]:
                _keys(variant, {
                    "id", "body_requirements", "subject", "category", "allowed_topics",
                    "source_choices", "speech_act", "assertion_status", "figurative_type",
                    "valid_at", "invalid_at", "time_rule", "ideal_destination", "risk_rule",
                    "alternatives_rule", "reason_rule",
                })
                _nonempty(variant["id"])
                _enum(variant["ideal_destination"], frozenset({"auto", "pending", "none"}))
                variant_ids.append(variant["id"])
            if len(set(variant_ids)) != len(variant_ids):
                raise ValueError("review_duplicate_variant")
            claim_ids.append(claim["id"])
        if len(set(claim_ids)) != len(claim_ids):
            raise ValueError("review_duplicate_claim")
    if len(set(window_ids)) != len(window_ids):
        raise ValueError("review_duplicate_case")
    _case(reference, case_id)


def _validate_reference(reference: dict, case_id: str) -> dict:
    _keys(reference, _REFERENCE_FIELDS)
    if reference["status"] != "agent_reviewed_reference":
        raise ValueError("review_reference_invalid")
    validate_reference_structure(reference, case_id)
    return _case(reference, case_id)


def _validate_evidence(evidence: dict) -> None:
    _keys(evidence, {"run_status", *_LAYERS, "original_result"})
    _enum(evidence["run_status"], _RUN_STATUSES)
    if type(evidence["original_result"]) is not dict:
        raise ValueError("review_original_result_invalid")
    for layer in _LAYERS:
        if type(evidence[layer]) is not list or any(type(item) is not dict for item in evidence[layer]):
            raise ValueError("review_evidence_layer_invalid")
    unsuccessful = evidence["run_status"] in {"failed", "unknown"}
    if not unsuccessful:
        for fact in evidence["extraction"]:
            _keys(fact, frozenset(_E_FIELDS))
    for fact in evidence["final_facts"]:
        _enum(fact.get("destination"), frozenset({"auto", "pending", "none"}))
    size = len(evidence["verification_inputs"])
    for index, item in enumerate(evidence["verification_inputs"]):
        if "candidate_index" in item and (type(item["candidate_index"]) is not int
                                         or item["candidate_index"] != index):
            raise ValueError("review_verification_input_index_invalid")
    returned: list[int] = []
    for result in evidence["verification"]:
        if unsuccessful:
            continue
        _keys(result, frozenset(_V_FIELDS))
        _indices([result["candidate_index"]], size)
        _enum(result["verdict"], frozenset({"supported", "uncertain", "unsupported"}))
        if type(result["issues"]) is not list or type(result["evidence"]) is not list:
            raise ValueError("review_verification_schema_invalid")
        returned.append(result["candidate_index"])
    if len(set(returned)) != len(returned):
        raise ValueError("review_duplicate_verification_result")
    status = evidence["run_status"]
    if status in {"empty", "unrun"} and any(evidence[layer] for layer in _LAYERS):
        raise ValueError("review_nonempty_terminal_status")
    if status == "completed" and (
        not evidence["extraction"] or not size or set(returned) != set(range(size))
    ):
        raise ValueError("review_incomplete_verification")


def _validate_review(packet: dict, review: dict, window: dict) -> None:
    _keys(review, {
        "reviewer", "case_id", "reference_sha256", "evidence_sha256", "run_status",
        "e_rows", "v_rows", "claims", "window_checks",
    })
    _nonempty(review["reviewer"])
    evidence = packet["evidence"]
    if review["run_status"] != evidence["run_status"]:
        raise ValueError("review_run_status_changed")
    _field_statuses(review["window_checks"], _WINDOW_CHECKS)
    if type(review["e_rows"]) is not list or len(review["e_rows"]) != len(evidence["extraction"]):
        raise ValueError("review_extraction_rows_incomplete")
    for index, row in enumerate(review["e_rows"]):
        _keys(row, {
            "raw_index", "payload_sha256", "fields", "meaning", "inclusion", "safety",
            "classification", "lineage", "basis",
        })
        if (type(row["raw_index"]) is not int or row["raw_index"] != index
                or row["payload_sha256"] != packet["layers"]["extraction"][index]["payload_sha256"]):
            raise ValueError("review_extraction_row_binding_changed")
        _field_statuses(row["fields"], _E_FIELDS)
        for field in _E_FIELDS:
            if field not in evidence["extraction"][index] and row["fields"][field] != "fail":
                raise ValueError("review_missing_extraction_field_cannot_pass")
        for key in ("meaning", "inclusion"):
            _enum(row[key], _STATUSES)
        _enum(row["safety"], _SAFETY)
        _enum(row["classification"], _CLASSIFICATIONS)
        _nonempty(row["basis"])
        _keys(row["lineage"], {"v_input_indices", "final_indices", "status"})
        _enum(row["lineage"]["status"], _STATUSES)
        _indices(row["lineage"]["v_input_indices"], len(evidence["verification_inputs"]))
        _indices(row["lineage"]["final_indices"], len(evidence["final_facts"]))
    if type(review["v_rows"]) is not list or len(review["v_rows"]) != len(evidence["verification"]):
        raise ValueError("review_verification_rows_incomplete")
    for index, row in enumerate(review["v_rows"]):
        _keys(row, {"result_index", "payload_sha256", "fields", "semantic", "e_indices", "lineage", "basis"})
        if (type(row["result_index"]) is not int or row["result_index"] != index
                or row["payload_sha256"] != packet["layers"]["verification"][index]["payload_sha256"]):
            raise ValueError("review_verification_row_binding_changed")
        _field_statuses(row["fields"], _V_FIELDS)
        for field in _V_FIELDS:
            if field not in evidence["verification"][index] and row["fields"][field] != "fail":
                raise ValueError("review_missing_verification_field_cannot_pass")
        _enum(row["semantic"], _STATUSES)
        _enum(row["lineage"], _STATUSES)
        _indices(row["e_indices"], len(evidence["extraction"]))
        _nonempty(row["basis"])
        if row["lineage"] == "pass":
            v_index = evidence["verification"][index].get("candidate_index")
            if type(v_index) is not int or not 0 <= v_index < len(evidence["verification_inputs"]):
                raise ValueError("review_invalid_verification_index_cannot_have_lineage")
            parents = {raw_index for raw_index, e_row in enumerate(review["e_rows"])
                       if v_index in e_row["lineage"]["v_input_indices"]}
            if set(row["e_indices"]) != parents:
                raise ValueError("review_verification_lineage_conflict")
    if type(review["claims"]) is not list:
        raise ValueError("review_claim_rows_invalid")
    expected_claims = {claim["id"]: claim for claim in window["claims"]}
    seen_claims: list[str] = []
    for row in review["claims"]:
        _keys(row, {"claim_id", "groups"})
        _nonempty(row["claim_id"])
        if row["claim_id"] not in expected_claims or type(row["groups"]) is not list:
            raise ValueError("review_claim_row_invalid")
        variants = {variant["id"] for variant in expected_claims[row["claim_id"]]["variants"]}
        for group in row["groups"]:
            _keys(group, {"raw_indices", "variant_id", "final_indices", *_GROUP_CHECKS})
            _nonempty(group["variant_id"])
            if group["variant_id"] not in variants:
                raise ValueError("review_unknown_variant")
            _indices(group["raw_indices"], len(evidence["extraction"]), nonempty=True)
            _indices(group["final_indices"], len(evidence["final_facts"]))
            for key in _GROUP_CHECKS:
                _enum(group[key], _STATUSES)
        seen_claims.append(row["claim_id"])
    if len(seen_claims) != len(expected_claims) or set(seen_claims) != set(expected_claims):
        raise ValueError("review_claim_rows_incomplete")
    unmapped_v, unmapped_final = _mapping_gaps(review, evidence)
    if (unmapped_v or unmapped_final) and review["window_checks"]["lineage"] == "pass":
        raise ValueError("review_incomplete_lineage_cannot_pass")


def prepare_case_review(reference: dict, case_id: str, evidence: dict) -> dict:
    """复制允许证据并绑定每层摘要；不证明盲审或先封存 raw 的时序。"""
    reference = _json_copy(reference)
    evidence = _json_copy(evidence)
    _validate_reference(reference, case_id)
    _validate_evidence(evidence)
    packet = {
        "format_version": 1, "case_id": case_id,
        "reference": reference, "reference_sha256": _sha(reference),
        "evidence": evidence, "evidence_sha256": _sha(evidence),
        "layers": {
            layer: [{"index": index, "payload": payload, "payload_sha256": _sha(payload)}
                    for index, payload in enumerate(evidence[layer])]
            for layer in _LAYERS
        },
    }
    packet["packet_sha256"] = _sha(packet)
    return packet


def _counts(statuses: list[str]) -> dict:
    return {"fail": statuses.count("fail"), "unresolved": statuses.count("unresolved")}


def _mapping_gaps(review: dict, evidence: dict) -> tuple[list[int], list[int]]:
    covered_v = {index for row in review["e_rows"] for index in row["lineage"]["v_input_indices"]}
    covered_final = {index for row in review["e_rows"] for index in row["lineage"]["final_indices"]}
    return (
        sorted(set(range(len(evidence["verification_inputs"]))) - covered_v),
        sorted(set(range(len(evidence["final_facts"]))) - covered_final),
    )


def _review_statuses(review: dict) -> list[str]:
    values = list(review["window_checks"].values())
    for row in review["e_rows"]:
        values.extend(row["fields"].values())
        values.extend((row["meaning"], row["inclusion"], row["lineage"]["status"], row["safety"]))
    for row in review["v_rows"]:
        values.extend(row["fields"].values())
        values.extend((row["semantic"], row["lineage"]))
    for row in review["claims"]:
        for group in row["groups"]:
            values.extend(group[key] for key in _GROUP_CHECKS)
    return values


def _safety_counts(review: dict, evidence: dict, unmapped_final: list[int]) -> dict:
    autos = {index for index, fact in enumerate(evidence["final_facts"])
             if fact["destination"] == "auto"}
    flags: dict[str, set[int]] = {
        "false_fact": set(), "wrong_person": set(), "ambiguous_auto": set(),
        "bad_auto": set(), "unresolved_auto": set(),
    }
    for row in review["e_rows"]:
        mapped = autos.intersection(row["lineage"]["final_indices"])
        alternatives = evidence["extraction"][row["raw_index"]].get("alternatives")
        has_alternatives = type(alternatives) is list and bool(alternatives)
        if row["safety"] in {"false_fact", "wrong_person"}:
            flags[row["safety"]].update(mapped)
        if row["safety"] == "ambiguous" or has_alternatives:
            flags["ambiguous_auto"].update(mapped)
        checks = [*row["fields"].values(), row["meaning"], row["inclusion"], row["lineage"]["status"]]
        if (row["safety"] in {"false_fact", "wrong_person", "ambiguous"}
                or has_alternatives or "fail" in checks or row["classification"] == "excluded"):
            flags["bad_auto"].update(mapped)
        if row["safety"] == "unresolved" or "unresolved" in checks:
            flags["unresolved_auto"].update(mapped)
    for claim in review["claims"]:
        for group in claim["groups"]:
            if group["destination"] == "fail":
                flags["bad_auto"].update(autos.intersection(group["final_indices"]))
    return {
        **{key: len(indices) for key, indices in flags.items()},
        "raw_false_fact": sum(row["safety"] == "false_fact" for row in review["e_rows"]),
        "raw_wrong_person": sum(row["safety"] == "wrong_person" for row in review["e_rows"]),
        "unmapped_auto": len(autos.intersection(unmapped_final)),
    }


def _duplicate_sources(evidence: dict) -> int:
    total = 0
    for fact in evidence["extraction"]:
        values = fact.get("source_message_ids")
        if type(values) is list and all(type(value) is str for value in values):
            total += len(values) - len(set(values))
    return total


def _same_time(actual: Any, expected: Any) -> bool:
    if actual is None or expected is None:
        return actual is expected
    try:
        if type(actual) is not str or type(expected) is not str:
            return False
        left, right = datetime.fromisoformat(actual), datetime.fromisoformat(expected)
        return left.utcoffset() is not None and right.utcoffset() is not None and left == right
    except ValueError:
        return False


def _variant_matches(fact: dict, variant: dict, case_name: str) -> bool:
    if not {
        "subject", "category", "topic", "source_message_ids", "speech_act",
        "assertion_status", "figurative_type", "valid_at", "invalid_at",
    } <= set(fact):
        return False
    if any(fact.get(key) != variant[key] for key in (
        "subject", "category", "speech_act", "assertion_status", "figurative_type",
    )) or fact.get("topic") not in variant["allowed_topics"]:
        return False
    if not all(_same_time(fact.get(key), variant[key]) for key in ("valid_at", "invalid_at")):
        return False
    source_ids = fact.get("source_message_ids")
    if (type(source_ids) is not list or not source_ids
            or any(type(item) is not str for item in source_ids)
            or len(set(source_ids)) != len(source_ids)):
        return False
    # 来源的正文条件仍由 group.source/coherence 审核，机械层只核有限集合。
    return any(set(source_ids) == {
        str(uuid5(NAMESPACE_URL, f"notalone-evaluation/{case_name}/{index}"))
        for index in choice["indices"]
    } for choice in variant["source_choices"])


def _accepted_group(group: dict, review: dict, evidence: dict) -> bool:
    if (group["lineage"] != "pass" or not group["final_indices"]
            or any(evidence["final_facts"][index]["destination"] == "none"
                   for index in group["final_indices"])):
        return False
    finals = set(group["final_indices"])
    members = [review["e_rows"][index]["lineage"] for index in group["raw_indices"]]
    return (
        all(member["status"] == "pass" and finals.intersection(member["final_indices"])
            for member in members)
        and finals <= {index for member in members for index in member["final_indices"]}
    )


def _complete_group(
    group: dict, variant: dict, review: dict, evidence: dict, case_name: str,
) -> bool:
    if (not all(group[key] == "pass" for key in _GROUP_CHECKS)
            or not all(value == "pass" for value in review["window_checks"].values())):
        return False
    v_inputs: set[int] = set()
    for index in group["raw_indices"]:
        row = review["e_rows"][index]
        if (not all(value == "pass" for value in row["fields"].values())
                or row["meaning"] != "pass" or row["inclusion"] != "pass"
                or row["safety"] != "safe" or row["classification"] == "excluded"
                or not _variant_matches(evidence["extraction"][index], variant, case_name)
                or not row["lineage"]["v_input_indices"]):
            return False
        v_inputs.update(row["lineage"]["v_input_indices"])
    related = [index for index, value in enumerate(evidence["verification"])
               if value["candidate_index"] in v_inputs]
    if len(related) != len(v_inputs):
        return False
    if not all(_variant_matches(evidence["verification_inputs"][index], variant, case_name)
               for index in v_inputs):
        return False
    for index in related:
        row = review["v_rows"][index]
        if (not all(value == "pass" for value in row["fields"].values())
                or row["semantic"] != "pass" or row["lineage"] != "pass"):
            return False
    return all(
        evidence["final_facts"][index]["destination"] == variant["ideal_destination"]
        and _variant_matches(evidence["final_facts"][index], variant, case_name)
        for index in group["final_indices"]
    )


def score_case_review(packet: dict, review: dict) -> dict:
    """只计显式审核和真实最终层对应；摘要不是签名或质量证明。"""
    packet = _json_copy(packet)
    review = _json_copy(review)
    _keys(packet, {
        "format_version", "case_id", "reference", "reference_sha256",
        "evidence", "evidence_sha256", "layers", "packet_sha256",
    })
    _keys(review, {
        "reviewer", "case_id", "reference_sha256", "evidence_sha256", "run_status",
        "e_rows", "v_rows", "claims", "window_checks",
    })
    if packet != prepare_case_review(packet["reference"], packet["case_id"], packet["evidence"]):
        raise ValueError("review_packet_bindings_changed")
    digest = packet.pop("packet_sha256")
    if digest != _sha(packet):
        raise ValueError("review_packet_changed")
    if (review["case_id"] != packet["case_id"]
            or review["reference_sha256"] != _sha(packet["reference"])
            or review["evidence_sha256"] != _sha(packet["evidence"])):
        raise ValueError("review_binding_changed")
    evidence = packet["evidence"]
    window = _case(packet["reference"], packet["case_id"])
    _validate_review(packet, review, window)
    reviewed_claims = {item["claim_id"]: item for item in review["claims"]}
    unmapped_v, unmapped_final = _mapping_gaps(review, evidence)
    report: dict[str, Any] = {
        "case_id": packet["case_id"], "run_status": evidence["run_status"],
        "quality_certified": False,
        "required": {"total": 0, "raw": 0, "accepted": 0, "full": 0},
        "optional": {"total": 0, "raw": 0, "accepted": 0, "full": 0},
        "v_semantic": _counts([row["semantic"] for row in review["v_rows"]]),
        "e_fields": {field: _counts([row["fields"][field] for row in review["e_rows"]])
                     for field in _E_FIELDS},
        "v_fields": {field: _counts([row["fields"][field] for row in review["v_rows"]])
                     for field in _V_FIELDS},
        "e_meaning": _counts([row["meaning"] for row in review["e_rows"]]),
        "e_inclusion": _counts([row["inclusion"] for row in review["e_rows"]]),
        "e_lineage": _counts([row["lineage"]["status"] for row in review["e_rows"]]),
        "v_lineage": _counts([row["lineage"] for row in review["v_rows"]]),
        "classifications": {key: sum(row["classification"] == key for row in review["e_rows"])
                            for key in sorted(_CLASSIFICATIONS)},
        "safety": _safety_counts(review, evidence, unmapped_final),
        "review_unresolved": _review_statuses(review).count("unresolved"),
        "unmapped_v_inputs": unmapped_v, "unmapped_final_facts": unmapped_final,
        "duplicate_source_references": _duplicate_sources(evidence),
        "none_correct": (
            window["inclusion"] == "none" and evidence["run_status"] == "empty"
            and all(value == "pass" for value in review["window_checks"].values())
        ),
        "reference_sha256": packet["reference_sha256"],
        "evidence_sha256": packet["evidence_sha256"], "review_sha256": _sha(review),
        "original_result": evidence["original_result"],
    }
    for claim in window["claims"]:
        counts = report["required" if claim["required"] else "optional"]
        counts["total"] += 1
        if evidence["run_status"] == "unrun":
            continue
        raw = accepted = full = False
        for group in reviewed_claims[claim["id"]]["groups"]:
            group_raw = group["raw_meaning"] == group["coherence"] == "pass"
            variant = next(item for item in claim["variants"] if item["id"] == group["variant_id"])
            group_accepted = (group_raw and evidence["run_status"] == "completed"
                              and _accepted_group(group, review, evidence))
            group_full = group_accepted and _complete_group(
                group, variant, review, evidence, window["case_name"],
            )
            raw |= group_raw
            accepted |= group_accepted
            full |= group_full
        counts["raw"] += int(raw)
        counts["accepted"] += int(accepted)
        counts["full"] += int(full)
    return report
