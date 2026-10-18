"""复核供应商的私有协议：逐项判断、原文定位和失败封闭。"""

from __future__ import annotations

from typing import Any

from notalone.reply.errors import ReplyInvariantError, ReplyReviewInvalidError


CHECK_CATEGORIES = {
    "intent": ["changed_intent"],
    "instruction": ["unmet_instruction"],
    "facts": ["unsupported_fact"],
    "commitments": ["added_obligation", "expanded_availability", "transferred_decision"],
    "explanation": ["inaccurate_explanation"],
}
EXPRESSION_CHANGES = ["expanded", "same_or_compressed", "not_applicable", "unknown"]
CLAIM_LIMIT = 12
CLAIM_SOURCE_LIMIT = 2
REVIEW_PROTOCOL_VERSION = "reply-fidelity-units-v3"


def _string() -> dict[str, Any]:
    # 严格供应商不支持字符串与数组长度关键字；原有限额由下方本地校验保留。
    return {"type": "string"}


def _record(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False,
            "properties": properties, "required": list(properties)}


def _check_schema(categories: list[str]) -> dict[str, Any]:
    branches = []
    for status in ("supported", "unknown", "violation"):
        properties = {
            "status": {"type": "string", "enum": [status]},
        }
        if status == "violation":
            properties["violation"] = _record({
                "category": {"type": "string", "enum": categories},
                "candidate_path": _string(), "candidate_quote": _string(),
                "source_path": _string(), "source_quote": _string(),
            })
        branches.append(_record(properties))
    common = {}
    common["reason"] = _string()
    common["result"] = {"anyOf": branches}
    return _record(common)


def _claim_schema() -> dict[str, Any]:
    return _record({
        "claim_id": {"type": "integer"}, "start_unit_id": _string(), "end_unit_id": _string(),
        "actor": {"type": "string", "enum": ["owner", "contact", "other", "unspecified"]},
        "kind": {"type": "string", "enum": ["state", "fact", "speech_act", "commitment", "unknown"]},
        "time_scope": {"type": "string", "enum": ["current", "historical", "unspecified"]},
        "modality": {"type": "string", "enum": ["optional", "required", "stated"]},
        "support": _record({
            "status": {"type": "string", "enum": ["supported", "unknown", "not_required"]},
            "sources": {"type": "array", "items": _record({"source_path": _string(), "source_quote": _string()})},
        }),
    })


def build_review_tool(candidate_count: int) -> dict[str, Any]:
    """将本次候选完整覆盖写入供应商协议；本地仍独立核验身份。"""
    if type(candidate_count) is not int or not 1 <= candidate_count <= 3:
        raise ReplyInvariantError("候选复核数量无效。")
    return {
        "name": "ReplyFidelityReview", "strict": True,
        "description": "逐候选五项独立比较后返回结果；不实具体说明必须拒绝，正文安全不能豁免。",
        "parameters": _record({
            "protocol_version": {"type": "string", "enum": [REVIEW_PROTOCOL_VERSION]},
            "instruction_requires_expansion": {"type": "boolean"},
            "reviews": _record({f"candidate_{number}": _record({
                "candidate_number": {"type": "integer", "enum": [number]},
                "expression_change": {"type": "string", "enum": EXPRESSION_CHANGES},
                "claims": {"type": "array", "items": _claim_schema()},
                "checks": _record({name: _check_schema(categories)
                                   for name, categories in CHECK_CATEGORIES.items()}),
            }) for number in range(1, candidate_count + 1)}),
        }),
    }


REVIEW_TOOL = build_review_tool(3)


def accepted_candidate_numbers(output: object, payload: dict[str, Any]) -> frozenset[int]:
    """校验完整响应后才筛选；引文存在不等于模型的语义比较正确。"""
    # 可信请求字段先验证，内部构造错误不能归类为供应商输出错误。
    candidates = payload["candidates"]
    if not 1 <= len(candidates) <= 3:
        raise ReplyInvariantError("候选复核没有覆盖全部候选。")
    sources = _source_texts(payload)
    candidate_texts = [_candidate_texts(candidate) for candidate in candidates]
    targets = []
    for number, candidate in enumerate(candidates, 1):
        if "review_target" not in candidate:
            raise ReplyInvariantError("可信复核缺少字符编号表。")
        targets.append(review_target(candidate, candidate_number=number))
    roles = review_source_roles(payload)
    if payload.get("review_sources", roles) != roles:
        raise ReplyInvariantError("可信复核来源角色发生变化。")
    report = _object(output, {"protocol_version", "instruction_requires_expansion", "reviews"})
    _choice(report["protocol_version"], [REVIEW_PROTOCOL_VERSION])
    requires_expansion = report["instruction_requires_expansion"]
    if type(requires_expansion) is not bool:
        raise ReplyReviewInvalidError("候选复核展开要求无效。")
    rows = _object(report["reviews"], {f"candidate_{number}" for number in range(1, len(candidates) + 1)})
    seen: set[int] = set()
    accepted: set[int] = set()
    for expected in range(1, len(candidates) + 1):
        value = rows[f"candidate_{expected}"]
        row = _object(value, {"candidate_number", "expression_change", "claims", "checks"})
        number = row["candidate_number"]
        if type(number) is not int or number != expected or number in seen:
            raise ReplyReviewInvalidError("候选复核身份无效。")
        seen.add(number)
        change = _choice(row["expression_change"], EXPRESSION_CHANGES)
        checks = _object(row["checks"], set(CHECK_CATEGORIES))
        candidate = candidate_texts[number - 1]
        supported = _validate_claims(row["claims"], candidates[number - 1], targets[number - 1], roles, sources)
        # 两项事实/承诺检查固定作用于上述完整命题；不接受供应商自选范围。
        # 五项均完成结构校验后再合取，前项拒绝也不能隐藏坏后项。
        statuses = [_validate_check(name, checks[name], candidate,
                    sources if name in {"facts", "explanation"} else
                    {path: text for path, text in sources.items() if not path.startswith(("/layered_context/", "/layered_scenario_reads/", "/owner_layered_context/", "/owner_layered_scenario_reads/"))}) for name in CHECK_CATEGORIES]
        if (supported and all(status == "supported" for status in statuses) and change != "unknown"
                and (not requires_expansion or change == "expanded")):
            accepted.add(number)
    return frozenset(accepted)


def _validate_check(name: str, value: object, candidate: dict[str, str],
                    sources: dict[str, str]) -> str:
    if not isinstance(value, dict):
        raise ReplyReviewInvalidError("候选复核结构无效。")
    fields = {"reason", "result"}
    check = _object(value, fields)
    _text(check["reason"], 256)
    result = check["result"]
    if not isinstance(result, dict):
        raise ReplyReviewInvalidError("候选复核裁决结构无效。")
    status = _choice(result.get("status"), ["supported", "violation", "unknown"])
    _object(result, {"status", "violation"} if status == "violation" else {"status"})
    allowed = {path: text for path, text in candidate.items()
               if (path == "/basis" or path.startswith("/risk_notes/")) == (name == "explanation")}
    if status == "violation":
        violation = _object(result["violation"], {"category", "candidate_path", "candidate_quote",
                                               "source_path", "source_quote"})
        _choice(violation["category"], CHECK_CATEGORIES[name])
        _quote(violation, "candidate", allowed, 64)
        _quote(violation, "source", sources, 96)
    return status


def review_target(candidate: dict[str, Any], *, candidate_number: int | None = None) -> dict[str, Any]:
    """同一正文只覆盖一次；分条消息由真实正文的区间映射复验。"""
    number = candidate.get("candidate_number") if candidate_number is None else candidate_number
    if (type(number) is not int or not 1 <= number <= 3
            or type(candidate.get("candidate_number")) is not int or candidate["candidate_number"] != number):
        raise ReplyInvariantError("可信候选序号与字符命名空间不一致。")
    text, messages = candidate["text"], candidate.get("messages", [])
    if (not isinstance(text, str) or not text.strip() or len(text) > 65536
            or not isinstance(messages, list) or len(messages) > 8
            or any(not isinstance(message, str) or not message.strip() for message in messages)
            or messages and "\n\n".join(messages) != text):
        raise ReplyInvariantError("可信候选正文与分条消息不一致。")
    cursor, ranges = 0, []
    for index, message in enumerate(messages):
        ranges.append({"path": f"/messages/{index}", "start": cursor, "end": cursor + len(message)})
        cursor += len(message) + 2
    # 使用code point，不归一化、不合并字素；保留原来每一个合法字符串切分点。
    target = {"path": "/text", "characters": len(text), "message_ranges": ranges,
              "units": [[f"c{number}u{index}", char] for index, char in enumerate(text, 1)]}
    if candidate.get("review_target", target) != target:
        raise ReplyInvariantError("可信候选覆盖目标发生变化。")
    return target


def review_source_roles(payload: dict[str, Any]) -> dict[str, dict[str, str]]:
    """角色来自真实字段与资料类型；模型不能提交或升级来源角色。"""
    roles = {path: {"role": "reference", "time_scope": "unspecified"} for path in _source_texts(payload)}
    for key in ("draft_text", "confirmed_direction", "user_instruction"):
        if "/" + key in roles:
            role = ("current_user_input" if key != "draft_text" or payload.get("input_mode") == "rewrite_draft"
                    else "contact_input")
            roles["/" + key] = {"role": role, "time_scope": "current"}
    if "/current_text" in roles:
        roles["/current_text"] = {"role": "contact_input", "time_scope": "current"}
    for number, item in enumerate(payload.get("evidence", [])):
        path = f"/evidence/{number}/text"
        if path not in roles:
            continue
        kind = item.get("kind")
        if kind in {"user_draft", "user_purpose"}:
            roles[path] = {"role": "current_user_input", "time_scope": "current"}
        elif kind == "user_current_chat":
            roles[path] = {"role": "contact_input", "time_scope": "current"}
        else:
            role = {"owner_memory": "owner_record", "confirmed_memory": "contact_record",
                    "message": "history_message"}.get(kind, "reference")
            roles[path] = {"role": role, "time_scope": _record_time(item)}
    for path in roles:
        if path.startswith(("/owner_layered_context/", "/owner_layered_scenario_reads/")):
            roles[path] = {"role": "owner_record", "time_scope": _record_time(_source_parent(payload, path))}
        elif path.startswith(("/layered_context/", "/layered_scenario_reads/")):
            roles[path] = {"role": "contact_record", "time_scope": _record_time(_source_parent(payload, path))}
    return roles


def _source_parent(payload: dict[str, Any], path: str) -> dict:
    value = payload
    for key in path.strip("/").split("/")[:-1]:
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def _record_time(item: dict) -> str:
    if item.get("temporal_status") == "historical":
        return "historical"
    timings = ([item["timing"]] if "timing" in item else
               [reference.get("timing", {}) for reference in item.get("references", [])])
    statuses = {timing.get("current_status") for timing in timings}
    if statuses == {"current_verified"}:
        return "current"
    return "historical" if statuses == {"historical"} else "unspecified"


def _validate_claims(value: object, candidate: dict[str, Any], target: dict,
                     roles: dict[str, dict[str, str]], sources: dict[str, str]) -> bool:
    claims = _array(value, maximum=CLAIM_LIMIT, minimum=1)
    positions = {unit[0]: index for index, unit in enumerate(target["units"])}
    cursor, supported = 0, True
    for number, item in enumerate(claims, 1):
        claim = _object(item, {"claim_id", "start_unit_id", "end_unit_id", "actor", "kind",
                               "time_scope", "modality", "support"})
        first, last = (_text(claim[key], 16) for key in ("start_unit_id", "end_unit_id"))
        if (type(claim["claim_id"]) is not int or claim["claim_id"] != number
                or first not in positions or last not in positions
                or positions[first] != cursor or positions[last] < cursor):
            raise ReplyReviewInvalidError("命题范围必须引用本候选字符ID并按序无缝覆盖，不得重叠或遗漏。")
        end = positions[last] + 1
        _text(candidate["text"][cursor:end], 65536)
        cursor = end
        actor = _choice(claim["actor"], ["owner", "contact", "other", "unspecified"])
        kind = _choice(claim["kind"], ["state", "fact", "speech_act", "commitment", "unknown"])
        time = _choice(claim["time_scope"], ["current", "historical", "unspecified"])
        _choice(claim["modality"], ["optional", "required", "stated"])
        support = _object(claim["support"], {"status", "sources"})
        status = _choice(support["status"], ["supported", "unknown", "not_required"])
        references = _array(support["sources"], maximum=CLAIM_SOURCE_LIMIT)
        paths = []
        for reference in references:
            _object(reference, {"source_path", "source_quote"})
            path, _ = _quote(reference, "source", sources, 96)
            paths.append(path)
        if kind == "speech_act":
            permitted = status == "not_required" and not references
        else:
            permitted = kind != "unknown" and actor != "unspecified" and status == "supported" and bool(paths)
            permitted = permitted and all(roles[path]["role"] != "reference" for path in paths)
            if kind == "state" and actor == "owner":
                permitted = permitted and time != "unspecified"
                if time == "current":
                    permitted = permitted and all(roles[path] == {"role": "current_user_input", "time_scope": "current"}
                                                  for path in paths)
                # 明确过去的状态沿通用来源与语义复核，不把“过去说过”升级为现状。
            if kind == "commitment" and actor == "owner" and time != "historical":
                permitted = permitted and all(roles[path]["role"] == "current_user_input" for path in paths)
        supported = supported and permitted
    if cursor != target["characters"]:
        raise ReplyReviewInvalidError("正文命题没有覆盖完整正文与分条消息。")
    return supported


def _candidate_texts(candidate: dict[str, Any]) -> dict[str, str]:
    texts = {"/text": candidate["text"], "/basis": candidate["basis"]}
    for field in ("messages", "risk_notes"):
        texts.update({f"/{field}/{index}": text for index, text in enumerate(candidate[field])})
    return texts


def _source_texts(payload: dict[str, Any]) -> dict[str, str]:
    # 只允许真实输入正文，不让候选自评、策略标签或模型理由充当用户依据。
    texts = {f"/{key}": payload[key] for key in ("draft_text", "user_instruction", "current_text", "confirmed_direction")
             if isinstance(payload.get(key), str) and payload[key].strip()}
    for field in ("evidence", "expression_preferences"):
        texts.update({f"/{field}/{index}/text": item["text"]
                      for index, item in enumerate(payload.get(field, [])) if item["text"].strip()})
    # 目录没有正文；仅实际画像条目可以支持事实，版本/引用ID不是事实正文。
    for prefix in ("", "owner_"):
        material = payload.get(prefix + "layered_context")
        if isinstance(material, dict):
            texts.update({f"/{prefix}layered_context/profile_entries/{index}/text": item["text"]
                          for index, item in enumerate(material.get("profile_entries", []))
                          if isinstance(item.get("text"), str) and item["text"].strip()})
        for read_index, receipt in enumerate(payload.get(prefix + "layered_scenario_reads", [])):
            if receipt.get("status") == "succeeded":
                texts.update({f"/{prefix}layered_scenario_reads/{read_index}/document/paragraphs/{index}/text": item["text"]
                              for index, item in enumerate(receipt["document"]["paragraphs"])
                              if isinstance(item.get("text"), str) and item["text"].strip()})
    return texts


def _quote(value: dict[str, Any], prefix: str, texts: dict[str, str],
           path_limit: int) -> tuple[str, str]:
    path, quote = _text(value[prefix + "_path"], path_limit), _text(value[prefix + "_quote"], 512)
    if path not in texts or quote not in texts[path]:
        raise ReplyReviewInvalidError("候选复核的原文定位无效。")
    return path, quote


def _object(value: object, fields: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ReplyReviewInvalidError("候选复核结构无效。")
    return value


def _array(value: object, *, maximum: int, minimum: int = 0) -> list[Any]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ReplyReviewInvalidError("候选复核列表无效。")
    return value


def _text(value: object, maximum: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value.strip()) or len(value) > maximum:
        raise ReplyReviewInvalidError("候选复核文字无效。")
    return value


def _choice(value: object, choices: list[str]) -> str:
    text = _text(value, 64)
    if text not in choices:
        raise ReplyReviewInvalidError("候选复核判断无效。")
    return text
