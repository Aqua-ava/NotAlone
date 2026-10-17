"""复核供应商的私有协议：逐项判断、原文定位和失败封闭。"""

from __future__ import annotations

from typing import Any

from notalone.reply.errors import ReplyInvariantError


CHECK_CATEGORIES = {
    "intent": ["changed_intent"],
    "instruction": ["unmet_instruction"],
    "facts": ["unsupported_fact"],
    "commitments": ["added_obligation", "expanded_availability", "transferred_decision"],
    "explanation": ["inaccurate_explanation"],
}
EXPRESSION_CHANGES = ["expanded", "same_or_compressed", "not_applicable", "unknown"]


def _string() -> dict[str, Any]:
    # 严格供应商不支持字符串与数组长度关键字；原有限额由下方本地校验保留。
    return {"type": "string"}


def _record(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False,
            "properties": properties, "required": list(properties)}


def _check_schema(name: str, categories: list[str]) -> dict[str, Any]:
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
    if name == "commitments":
        common["propositions"] = {"type": "array", "items": _record({
            "candidate_path": _string(), "candidate_quote": _string(),
            "actor": _string(), "action": _string(), "object": _string(),
            "time_scope": _string(),
            "modality": {"type": "string", "enum": ["optional", "required", "stated"]},
        })}
    common["reason"] = _string()
    common["result"] = {"anyOf": branches}
    return _record(common)


def build_review_tool(candidate_count: int) -> dict[str, Any]:
    """将本次候选完整覆盖写入供应商协议；本地仍独立核验身份。"""
    if type(candidate_count) is not int or not 1 <= candidate_count <= 3:
        raise ReplyInvariantError("候选复核数量无效。")
    return {
        "name": "ReplyFidelityReview", "strict": True,
        "description": "逐候选五项独立比较后返回结果；不实具体说明必须拒绝，正文安全不能豁免。",
        "parameters": _record({
            "instruction_requires_expansion": {"type": "boolean"},
            "reviews": _record({f"candidate_{number}": _record({
                "candidate_number": {"type": "integer", "enum": [number]},
                "expression_change": {"type": "string", "enum": EXPRESSION_CHANGES},
                "checks": _record({name: _check_schema(name, categories)
                                   for name, categories in CHECK_CATEGORIES.items()}),
            }) for number in range(1, candidate_count + 1)}),
        }),
    }


REVIEW_TOOL = build_review_tool(3)


def accepted_candidate_numbers(output: object, payload: dict[str, Any]) -> frozenset[int]:
    """校验完整响应后才筛选；引文存在不等于模型的语义比较正确。"""
    report = _object(output, {"instruction_requires_expansion", "reviews"})
    requires_expansion = report["instruction_requires_expansion"]
    if type(requires_expansion) is not bool:
        raise ReplyInvariantError("候选复核展开要求无效。")
    candidates = payload["candidates"]
    if not 1 <= len(candidates) <= 3:
        raise ReplyInvariantError("候选复核没有覆盖全部候选。")
    rows = _object(report["reviews"], {f"candidate_{number}" for number in range(1, len(candidates) + 1)})
    sources = _source_texts(payload)
    seen: set[int] = set()
    accepted: set[int] = set()
    for expected in range(1, len(candidates) + 1):
        value = rows[f"candidate_{expected}"]
        row = _object(value, {"candidate_number", "expression_change", "checks"})
        number = row["candidate_number"]
        if type(number) is not int or number != expected or number in seen:
            raise ReplyInvariantError("候选复核身份无效。")
        seen.add(number)
        change = _choice(row["expression_change"], EXPRESSION_CHANGES)
        checks = _object(row["checks"], set(CHECK_CATEGORIES))
        candidate = _candidate_texts(candidates[number - 1])
        statuses = [_validate_check(name, checks[name], candidate,
                    sources if name in {"facts", "explanation"} else
                    {path: text for path, text in sources.items() if not path.startswith(("/layered_context/", "/layered_scenario_reads/", "/owner_layered_context/", "/owner_layered_scenario_reads/"))})
                    for name in CHECK_CATEGORIES]
        if (all(status == "supported" for status in statuses) and change != "unknown"
                and (not requires_expansion or change == "expanded")):
            accepted.add(number)
    return frozenset(accepted)


def _validate_check(name: str, value: object, candidate: dict[str, str],
                    sources: dict[str, str]) -> str:
    if not isinstance(value, dict):
        raise ReplyInvariantError("候选复核结构无效。")
    fields = {"reason", "result"}
    if name == "commitments":
        fields.add("propositions")
    check = _object(value, fields)
    _text(check["reason"], 256)
    result = check["result"]
    if not isinstance(result, dict):
        raise ReplyInvariantError("候选复核裁决结构无效。")
    status = _choice(result.get("status"), ["supported", "violation", "unknown"])
    _object(result, {"status", "violation"} if status == "violation" else {"status"})
    located = None
    allowed = {path: text for path, text in candidate.items()
               if (path == "/basis" or path.startswith("/risk_notes/")) == (name == "explanation")}
    if status == "violation":
        violation = _object(result["violation"], {"category", "candidate_path", "candidate_quote",
                                               "source_path", "source_quote"})
        _choice(violation["category"], CHECK_CATEGORIES[name])
        located = _quote(violation, "candidate", allowed, 64)
        _quote(violation, "source", sources, 96)
    if name == "commitments":
        propositions = _array(check["propositions"], maximum=6)
        actual = {_validate_proposition(value, allowed) for value in propositions}
        # 违反项可以汇总多个动作，而命题逐个分拆；已验证的同字段引文允许完整包含。
        if located is not None and not any(
                located[0] == path and (located[1] in quote or quote in located[1])
                for path, quote in actual):
            raise ReplyInvariantError("承诺违反项没有对应的主体与动作分析。")
    return status


def _validate_proposition(value: object, candidate: dict[str, str]) -> tuple[str, str]:
    proposition = _object(value, {"candidate_path", "candidate_quote", "actor", "action",
                                  "object", "time_scope", "modality"})
    for key, limit in (("actor", 64), ("action", 128), ("object", 128), ("time_scope", 128)):
        _text(proposition[key], limit)
    _choice(proposition["modality"], ["optional", "required", "stated"])
    return _quote(proposition, "candidate", candidate, 64)


def _candidate_texts(candidate: dict[str, Any]) -> dict[str, str]:
    texts = {"/text": candidate["text"], "/basis": candidate["basis"]}
    for field in ("messages", "risk_notes"):
        texts.update({f"/{field}/{index}": text for index, text in enumerate(candidate[field])})
    return texts


def _source_texts(payload: dict[str, Any]) -> dict[str, str]:
    # 只允许真实输入正文，不让候选自评、策略标签或模型理由充当用户依据。
    texts = {f"/{key}": payload[key] for key in ("draft_text", "user_instruction")
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
        raise ReplyInvariantError("候选复核的原文定位无效。")
    return path, quote


def _object(value: object, fields: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ReplyInvariantError("候选复核结构无效。")
    return value


def _array(value: object, *, maximum: int, minimum: int = 0) -> list[Any]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ReplyInvariantError("候选复核列表无效。")
    return value


def _text(value: object, maximum: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value.strip()) or len(value) > maximum:
        raise ReplyInvariantError("候选复核文字无效。")
    return value


def _choice(value: object, choices: list[str]) -> str:
    text = _text(value, 64)
    if text not in choices:
        raise ReplyInvariantError("候选复核判断无效。")
    return text
