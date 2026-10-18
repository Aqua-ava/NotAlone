"""隔离的逐字段证据诊断：只核结构与来源绑定，不修改候选或认证语义。"""
from copy import deepcopy
import hashlib
import json
from typing import Any


FIELDS = ("meaning", "subject", "category", "speech_act", "assertion_status", "figurative_type", "time", "dependency")
STATES = ("supported", "mismatch", "insufficient", "ambiguous")


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def _unique(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate_json_key")
        result[key] = value
    return result


def _object(raw: str | dict) -> dict:
    value = json.loads(raw, object_pairs_hook=_unique) if isinstance(raw, str) else deepcopy(raw)
    _require(type(value) is dict, "object_required")
    return value


def _digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def prepare_reference_field_diagnostic_input(raw: str | dict) -> dict:
    """完整复制原V输入；摘要不包含额外诊断字段。"""
    value = _object(raw)
    _require(set(value) == {"messages", "candidates"}, "input_keys_invalid")
    messages, candidates = value["messages"], value["candidates"]
    _require(type(messages) is list and bool(messages) and type(candidates) is list and bool(candidates), "input_lists_invalid")
    ids = []
    for message in messages:
        _require(type(message) is dict and type(message.get("message_id")) is str
                 and bool(message["message_id"]) and type(message.get("text")) is str
                 and message.get("role") in ("target", "context") and message.get("sender") in ("self", "contact")
                 and type(message.get("occurred_at")) is str, "message_invalid")
        ids.append(message["message_id"])
    _require(len(set(ids)) == len(ids), "duplicate_message_id")
    target_ids = {message["message_id"] for message in messages if message["role"] == "target"}
    _require(bool(target_ids), "target_message_required")
    for index, candidate in enumerate(candidates):
        _require(type(candidate) is dict and type(candidate.get("candidate_index")) is int
                 and candidate["candidate_index"] == index, "candidate_index_invalid")
        _require(all(type(candidate.get(key)) is str and bool(candidate[key].strip())
                     for key in ("text", "subject", "category", "speech_act", "assertion_status", "figurative_type")), "candidate_axis_input_invalid")
        _require(all(key in candidate and (candidate[key] is None or type(candidate[key]) is str)
                     for key in ("valid_at", "invalid_at")), "candidate_time_input_invalid")
        sources = candidate.get("source_message_ids")
        _require(type(sources) is list and bool(sources) and all(type(item) is str and item in ids for item in sources)
                 and len(set(sources)) == len(sources) and bool(set(sources) & target_ids), "candidate_sources_invalid")
    return {"input_sha256": _digest(value), "input": value}


def _prepared(value: dict) -> dict:
    _require(type(value) is dict and set(value) == {"input_sha256", "input"}, "prepared_input_invalid")
    expected = prepare_reference_field_diagnostic_input(value["input"])
    _require(value["input_sha256"] == expected["input_sha256"], "input_digest_changed")
    return expected


def _evidence(field_name: str, field: dict, sources: list[str], messages: dict[str, dict]) -> set[str]:
    evidence = field["evidence"]
    _require(type(evidence) is list and len(evidence) <= 4, "evidence_count_invalid")
    _require(field["state"] not in ("supported", "mismatch") or bool(evidence), "evidence_required")
    targets = set()
    text_count = 0
    for item in evidence:
        _require(type(item) is dict and set(item) == {"kind", "message_id", "start", "end", "quote", "value", "scope"}, "evidence_keys_invalid")
        message_id = item["message_id"]
        _require(type(message_id) is str and message_id in messages, "evidence_message_invalid")
        message = messages[message_id]
        scope = "candidate_source" if message_id in sources else "window_context"
        _require(item["scope"] == scope, "evidence_scope_invalid")
        _require(field["state"] != "supported" or scope == "candidate_source", "supported_context_forbidden")
        if item["kind"] == "text":
            text_count += 1
            start, end = item["start"], item["end"]
            _require(type(start) is int and type(end) is int and 0 <= start < end <= len(message["text"]), "evidence_span_invalid")
            _require(type(item["quote"]) is str and item["quote"] == message["text"][start:end]
                     and item["value"] is None, "evidence_quote_invalid")
        else:
            _require(field_name == "time" and item["kind"] == "occurred_at" and item["start"] is None and item["end"] is None
                     and item["quote"] is None, "metadata_evidence_invalid")
            _require(type(item["value"]) is str and bool(item["value"]) and item["value"] != "unknown"
                     and item["value"] == message.get("occurred_at"), "metadata_value_invalid")
        if item["kind"] == "text" and scope == "candidate_source" and message["role"] == "target":
            targets.add(message_id)
    _require(not any(item["kind"] == "occurred_at" for item in evidence) or text_count > 0, "metadata_text_evidence_required")
    _require(field["state"] != "supported" or text_count > 0, "supported_text_evidence_required")
    return targets


def validate_reference_field_diagnostic(prepared: dict, raw: str | dict) -> dict:
    """unsupported只表示模型报告字段失败，不证明内容已证伪；不映射旧V裁决。"""
    prepared = _prepared(prepared)
    output = _object(raw)
    _require(set(output) == {"input_sha256", "results"} and output["input_sha256"] == prepared["input_sha256"], "output_identity_invalid")
    rows = output["results"]
    _require(type(rows) is list and len(rows) == len(prepared["input"]["candidates"]), "candidate_coverage_invalid")
    messages = {message["message_id"]: message for message in prepared["input"]["messages"]}
    seen = set()
    for row in rows:
        _require(type(row) is dict and set(row) == {"candidate_index", "fields"}, "result_keys_invalid")
        index = row["candidate_index"]
        _require(type(index) is int and 0 <= index < len(rows) and index not in seen, "candidate_coverage_invalid")
        seen.add(index)
        fields = row["fields"]
        _require(type(fields) is dict and set(fields) == set(FIELDS), "field_coverage_invalid")
        target_evidence = set()
        for field_name, field in fields.items():
            _require(type(field) is dict and set(field) == {"state", "evidence"} and field["state"] in STATES, "field_invalid")
            target_evidence.update(_evidence(field_name, field, prepared["input"]["candidates"][index]["source_message_ids"], messages))
        states = [field["state"] for field in fields.values()]
        _require(any(state != "supported" for state in states) or bool(target_evidence), "supported_target_evidence_required")
        row["diagnostic_verdict"] = "unsupported" if "mismatch" in states else "uncertain" if any(state != "supported" for state in states) else "supported"
    return {**output, "semantic_verified": False}


def reference_field_diagnostic_contract(prepared: dict) -> tuple[str, dict]:
    """原语义基线加独立输出合同；未声明供应商schema兼容或语义准确率。"""
    from .verification_adapters import source_verification_contract, REFERENCE_RETENTION_PROFILE

    prepared = _prepared(prepared)
    baseline, _ = source_verification_contract("legacy-v4", prompt_profile=REFERENCE_RETENTION_PROFILE)
    prompt = baseline + """

以下仅替换旧四槽输出合同，保留上文全部来源忠实性语义规则。输入为input_sha256和input；
input完整保留原messages/candidates。不要修正文、字段、source_message_ids或补候选。
不返回旧verdict/issues/evidence四槽，不返回候选或顶层verdict。只返回input_sha256/results，
摘要逐字回传；每个candidate_index恰一次，每条只含candidate_index/fields。
fields固定八键：meaning核正文原命题；subject核资料归属；category核资料类别；speech_act核言语行为；
assertion_status核断言状态；figurative_type核字面/非字面；time核valid_at/invalid_at与来源期间；
dependency核候选声明的来源是否涵盖理解主张必需的依据。沿上文规则，不扩查topic/risk/confidence。
每字段只含state/evidence。state取supported、mismatch、insufficient、ambiguous：分别表示该字段
有来源支持、与来源或既有规则不吻合、依据不足、仍有未决读法。此状态不是现实真假证明。
evidence为0至4项，每项精确七键kind/message_id/start/end/quote/value/scope。
kind=text时，start/end为原message.text的Unicode码点半开整数范围，quote必须逐字等于切片，value=null。
kind=occurred_at仅用于time辅助，start/end/quote均null，value逐字等于该消息非unknown的occurred_at。
时间元数据绑定不证明事件发生日期、完成阶段或期间正确，不能替代正文证据；任何state只要引用时间元数据，该字段必须同时提供合法text证据。
scope只能candidate_source或window_context；按message_id是否在候选原source_message_ids中标注，不能自创来源。
supported字段至少一项合法原来源text证据，不得使用window_context；可用原已声明context来源。
候选八字段全supported时，各字段text证据并集必须覆盖至少一个原来源中的target；timestamp不能充当target文本覆盖。
mismatch必须非空证据，允许window_context作为反证；insufficient/ambiguous可空。
程序仅合成诊断状态：有mismatch则unsupported，否则有insufficient/ambiguous则uncertain，否则supported。
诊断unsupported表示字段未通过，不等于旧V的unsupported语义或内容已证伪；正确证据也不认证模型判断。
无论状态如何，结果始终semantic_verified=false，不用于自动采纳，不输出该程序专属字段。
"""
    evidence = {"type": "object", "additionalProperties": False,
        "required": ["kind", "message_id", "start", "end", "quote", "value", "scope"], "properties": {
            "kind": {"type": "string", "enum": ["text", "occurred_at"]}, "message_id": {"type": "string"},
            "start": {"type": ["integer", "null"], "minimum": 0}, "end": {"type": ["integer", "null"], "minimum": 0},
            "quote": {"type": ["string", "null"]}, "value": {"type": ["string", "null"]},
            "scope": {"type": "string", "enum": ["candidate_source", "window_context"]}}}
    field = {"type": "object", "additionalProperties": False, "required": ["state", "evidence"], "properties": {
        "state": {"type": "string", "enum": list(STATES)},
        "evidence": {"type": "array", "maxItems": 4, "items": evidence}}}
    count = len(prepared["input"]["candidates"])
    schema = {"title": "ReferenceFieldDiagnosticOutput", "type": "object", "additionalProperties": False,
        "required": ["input_sha256", "results"], "properties": {
            "input_sha256": {"type": "string", "const": prepared["input_sha256"]},
            "results": {"type": "array", "minItems": count, "maxItems": count, "items": {
                "type": "object", "additionalProperties": False, "required": ["candidate_index", "fields"], "properties": {
                    "candidate_index": {"type": "integer", "minimum": 0, "maximum": count - 1},
                    "fields": {"type": "object", "additionalProperties": False, "required": list(FIELDS),
                               "properties": {name: deepcopy(field) for name in FIELDS}}}}}}}
    return prompt, schema
