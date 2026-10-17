"""版本三有限关系的封闭词法与无正文形状；不执行来源读取。"""
from __future__ import annotations

import hashlib
import json
from types import MappingProxyType
from typing import Any
from uuid import UUID


RULE_VARIANTS = MappingProxyType({
    "BR_AUTHOR_ARRIVAL_V1": ("direct_quote",),
    "BR_KIN_LEND_V1": ("completed_inline", "negative_inline", "completed_cross", "negative_cross"),
    "BR_COMPLETED_QA_V1": ("completed_answer",),
    "BR_TWO_ROLES_V1": ("completed_inline", "negative_inline", "completed_cross", "negative_cross"),
    "BR_REQUEST_V1": ("reported_inline", "reported_cross", "received_inline", "received_cross"),
    "BR_COND_RUN_V1": ("conditional_plan",),
})
CAPABILITIES = ("subject_binding", "event_preservation", "reference_resolution",
                "direct_attribution", "reported_attribution", "temporal_preservation")
ROLE_KINDS = ("author", "elder_sister", "elder_brother", "colleague", "vehicle", "book", "umbrella",
              "home", "company", "school", "airport", "station")
ROLE_SLOTS = ("agent", "recipient", "object", "property_owner", "beneficiary", "actor", "destination")
RELATION_TOKENS = MappingProxyType({"我姐": "elder_sister", "我哥": "elder_brother", "我同事": "colleague"})
OBJECT_TOKENS = MappingProxyType({"车": "vehicle", "书": "book", "雨伞": "umbrella"})
DESTINATION_TOKENS = MappingProxyType({"家": "home", "公司": "company", "学校": "school", "机场": "airport", "车站": "station"})
TIME_TOKENS = MappingProxyType({"刚": "just", "刚刚": "just", "昨天": "yesterday", "前天": "day_before_yesterday",
    "周末": "weekend", "明天": "tomorrow", "后天": "day_after_tomorrow"})
CAPABILITY_DIMENSIONS = MappingProxyType({"subject_binding": "subject", "event_preservation": "paraphrase",
    "reference_resolution": "reference", "direct_attribution": "reported", "reported_attribution": "reported",
    "temporal_preservation": "time"})
ATOM_POLICY = MappingProxyType({
    "arrive": ("completed", ("actor", "destination")),
    "lend": ("completed", ("agent", "recipient", "object", "property_owner")),
    "request": ("historical", ("agent", "recipient")), "receive_request": ("historical", ("agent", "recipient")),
    "cover_shift": ("requested", ("actor", "beneficiary")), "clear_weather": ("condition", ()), "run": ("planned", ("actor",)),
})
GRAMMARS = MappingProxyType({
    "arrival": r"(?P<author>我)(?P<time>刚刚|刚)到(?P<destination>家)。?",
    "identity": r"这里的“(?P<pronoun>她|他)”指(?P<role>我姐|我哥|我同事)。?",
    "roles": r"这里提到(?P<first>我姐|我哥|我同事)和(?P<second>我姐|我哥|我同事)。",
    "lend": r"(?P<agent>我姐|我哥)(?P<time>昨天|前天)?(?P<negative>没有|没)?把(?P<pronoun>她|他)的(?P<object>车|书|雨伞)借给(?P<author>我)(?P<completion>了)?。?",
    "question": r"你(?:已经|已)?(?P<verb>到达|抵达|到)(?P<destination>家|公司|学校|机场|车站)了吗[？?]",
    "answer": r"(?P<author>我)?(?:已经|已)?(?P<verb>到达|抵达|到)了。?",
    "request": r"(?P<agent>我姐|我哥|我同事)(?P<outer_time>昨天|前天)?让(?P<author>我)(?P<time>周末|明天|后天)帮(?P<pronoun>她|他)顶个班。?",
    "plan": r"如果(?P<condition>天晴)，(?P<author>我)计划(?P<time>明天|后天)(?P<only>只)?跑(?P<approx>约)?(?P<number>[1-9][0-9]{0,5}(?:\.[0-9]{1,3})?)(?P<unit>公里|米)。?",
})


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def rule_set_sha256() -> str:
    """绑定有限执行语义，不接受自由规则、文件摘要或调用者配置。"""
    return digest({"execution_version": 2, "proof_version": 3, "basis_version": 3, "evidence_version": 4,
        "rules": dict(RULE_VARIANTS), "rule_version": 1, "grammars": dict(GRAMMARS),
        "role_order": ROLE_KINDS, "role_slots": ROLE_SLOTS, "capabilities": CAPABILITIES,
        "tokens": {"relations": dict(RELATION_TOKENS), "objects": dict(OBJECT_TOKENS),
            "destinations": dict(DESTINATION_TOKENS), "times": dict(TIME_TOKENS)},
        "atom_policy": dict(ATOM_POLICY), "capability_dimensions": dict(CAPABILITY_DIMENSIONS),
        "bindings": ["actual_sender", "source_identity", "completed_question"],
        "qualifiers": {"order": ["polarity", "quantity", "degree", "condition", "time"],
            "polarity": ["lend", "predicate", "boolean"], "quantity": ["run", "distance", "metres"],
            "degree": ["only", "approx"], "condition": ["clear_weather", "run", "requires"],
            "time": ["token", "anchor", "interval", "event_time", "requested_time"]},
        "normalization": {"spaces": "U+0020-only", "unit": "Unicode-codepoint-half-open", "max_number": "100000",
            "distance": "Decimal-metres-trim-zero", "calendar": "actual-offset-local-midnight", "past_H": "null-null",
            "plan_H": "absolute-instant-slots-independent-exact-original-source-offset",
            "main": "one-unit-or-adjacent-condition-pair", "identity": "same-author-one-chain-before-or-inline",
            "contexts": "dependency-preorder-one-edge-per-main-or-target-nontarget-terminal",
            "qa": "two-adjacent-opposite-authors-identical-verb", "graph": "independent-source-and-candidate-v1"},
        "shapes": {"basis": "strict-role-owner-source-candidate-seven-slots-qualifiers-three-anchor-v1",
            "representation": "grounded_window_quote_v1-full-window-unique-enumeration-v1",
            "evidence": "twelve-keys-target-ordered-all-dependency-actual-offset-v1"},
        "limits": {"messages": 4, "text": 4096, "roles": 2, "chain_or_qa": 1, "links": [16, 8, 8]},
        "capability_policy": "per-item-no-alternatives-pragmatics-known-media-independent-AND-empty-release"})


def validate_basis(value: object) -> dict[str, Any]:
    """只校验新版本形状；当前全文与实际语义必须另行重解析。"""
    from .dimension_evidence import _fields, _digest, MessageSpan, TextSpan
    data = _fields(value, {"version", "rule_set_sha256", "rules", "roles", "atoms", "qualifiers", "reference_bindings",
        "frame", "unresolved", "source_graph_sha256", "candidate_graph_sha256", "representation", "capabilities"})
    canonical(data).encode("utf-8")
    if type(data["version"]) is not int or data["version"] != 3:
        raise ValueError("有限关系版本或规则摘要不符。")
    _digest(data["rule_set_sha256"])
    if not isinstance(data["rules"], list) or len(data["rules"]) != 1:
        raise ValueError("有限关系只允许一个主规则。")
    rule = _fields(data["rules"][0], {"rule_id", "rule_version"})
    if rule["rule_id"] not in RULE_VARIANTS or type(rule["rule_version"]) is not int or rule["rule_version"] != 1:
        raise ValueError("有限主规则未受支持。")
    if data["frame"] not in {"direct", "reported_request", "received_request"} or data["unresolved"] != []:
        raise ValueError("有限依据不能包含未解关系。")
    _digest(data["source_graph_sha256"])
    if data["candidate_graph_sha256"] != data["source_graph_sha256"]:
        raise ValueError("来源与候选图摘要不等。")

    def rows(name: str, minimum: int, maximum: int, id_name: str) -> list[dict]:
        items = data[name]
        if not isinstance(items, list) or not minimum <= len(items) <= maximum:
            raise ValueError("有限关系数组长度无效。")
        for index, row in enumerate(items):
            if not isinstance(row, dict) or type(row.get(id_name)) is not int or row[id_name] != index:
                raise ValueError("有限关系编号须连续有序。")
        return items

    def source(raw: Any) -> None:
        span = MessageSpan.from_payload(raw)
        if str(span.message_id) != raw["message_id"] or span.span.end > 4096:
            raise ValueError("有限来源位置无效。")

    def candidate(raw: object) -> None:
        if TextSpan.from_payload(raw).end > 4096:
            raise ValueError("有限候选位置超限。")

    roles = rows("roles", 1, 16, "role_id")
    order = []
    for row in roles:
        _fields(row, {"role_id", "kind", "owner", "sender", "source", "candidate"})
        kind, owner, sender = row["kind"], row["owner"], row["sender"]
        if kind not in ROLE_KINDS or owner not in {"self", "contact", None}:
            raise ValueError("有限角色种类或范围无效。")
        if (kind == "author" and (owner not in {"self", "contact"} or sender != owner)
                or kind in ROLE_KINDS[1:4] and (owner is None or sender is not None)
                or kind in ROLE_KINDS[4:] and (owner is not None or sender is not None)):
            raise ValueError("有限角色归属无效。")
        order.append((("self", "contact", None).index(owner), ROLE_KINDS.index(kind)))
        source(row["source"])
        candidate(row["candidate"])
    if order != sorted(set(order)):
        raise ValueError("有限角色身份须唯一且按规范排序。")
    if sum(row["kind"] in ROLE_KINDS[1:4] for row in roles) > 2:
        raise ValueError("有限关系最多两名第三方。")
    predicates = {key: (phase, set(slots)) for key, (phase, slots) in ATOM_POLICY.items()}
    atoms = rows("atoms", 1, 16, "atom_id")
    for row in atoms:
        _fields(row, {"atom_id", "predicate", "phase", "roles", "source", "candidate"})
        if row["predicate"] not in predicates or row["phase"] != predicates[row["predicate"]][0]:
            raise ValueError("有限事件阶段无效。")
        slots = _fields(row["roles"], set(ROLE_SLOTS))
        if {key for key, item in slots.items() if item is not None} != predicates[row["predicate"]][1]:
            raise ValueError("有限事件角色槽不完整。")
        for slot, identifier in slots.items():
            if identifier is None:
                continue
            if type(identifier) is not int or not 0 <= identifier < len(roles):
                raise ValueError("有限事件角色断链。")
            kind = roles[identifier]["kind"]
            if (slot == "object" and kind not in ROLE_KINDS[4:7] or slot == "destination" and kind not in ROLE_KINDS[7:]
                    or slot not in {"object", "destination"} and kind not in ROLE_KINDS[:4]):
                raise ValueError("有限事件角色种类不相容。")
        source(row["source"])
        candidate(row["candidate"])
    expected_atoms = {
        "BR_AUTHOR_ARRIVAL_V1": ["arrive"], "BR_COMPLETED_QA_V1": ["arrive"],
        "BR_KIN_LEND_V1": ["lend"], "BR_TWO_ROLES_V1": ["lend"],
        "BR_REQUEST_V1": ["request" if data["frame"] == "reported_request" else "receive_request", "cover_shift"],
        "BR_COND_RUN_V1": ["clear_weather", "run"],
    }
    if ([row["predicate"] for row in atoms] != expected_atoms[rule["rule_id"]]
            or (rule["rule_id"] == "BR_REQUEST_V1") != (data["frame"] != "direct")):
        raise ValueError("有限主规则、框架和原子顺序不符。")
    # 限定的交叉关系沿既有严格检查，仅扩展本版arrive及外层历史时间。
    qualifiers = rows("qualifiers", 0, 32, "qualifier_id")
    seen = set()
    for row in qualifiers:
        kind = row.get("kind")
        extra = {"polarity": {"atom_id", "slot", "value_sha256"}, "quantity": {"atom_id", "slot", "value_sha256"},
            "degree": {"quantity_qualifier_id", "modifier", "value_sha256"},
            "condition": {"condition_atom_id", "action_atom_id", "relation"}, "time": {"atom_id", "slot", "value_sha256"}}
        if kind not in extra:
            raise ValueError("有限限定种类无效。")
        _fields(row, {"qualifier_id", "kind", "source", "candidate"} | extra[kind])
        source(row["source"])
        candidate(row["candidate"])
        if kind != "condition":
            _digest(row["value_sha256"])
        if kind in {"polarity", "quantity", "time"}:
            identifier = row["atom_id"]
            if type(identifier) is not int or not 0 <= identifier < len(atoms):
                raise ValueError("有限限定命题断链。")
            predicate, slot = atoms[identifier]["predicate"], row["slot"]
            if (kind == "polarity" and (predicate, slot) != ("lend", "predicate")
                    or kind == "quantity" and (predicate, slot) != ("run", "distance")
                    or kind == "time" and not (slot == "event_time" and predicate in {"arrive", "lend", "request", "receive_request", "run"}
                        or slot == "requested_time" and predicate == "cover_shift")):
                raise ValueError("有限限定槽无效。")
            edge = (kind, identifier, slot)
        elif kind == "degree":
            identifier = row["quantity_qualifier_id"]
            if (type(identifier) is not int or not 0 <= identifier < len(qualifiers)
                    or qualifiers[identifier]["kind"] != "quantity" or row["modifier"] not in {"only", "approx"}):
                raise ValueError("有限程度限定断链。")
            edge = (kind, identifier, row["modifier"])
        else:
            first, second = row["condition_atom_id"], row["action_atom_id"]
            if (type(first) is not int or type(second) is not int or not 0 <= first < second < len(atoms)
                    or atoms[first]["predicate"] != "clear_weather" or atoms[second]["predicate"] != "run" or row["relation"] != "requires"):
                raise ValueError("有限条件关系无效。")
            edge = (kind, first, second)
        if edge in seen:
            raise ValueError("有限限定重复。")
        seen.add(edge)
    def qualifier_order(row: dict) -> tuple:
        return (("polarity", "quantity", "degree", "condition", "time").index(row["kind"]),
            row.get("atom_id", row.get("action_atom_id", 0)), row.get("slot", ""),
            ("only", "approx").index(row["modifier"]) if row["kind"] == "degree" else 0)
    if qualifiers != sorted(qualifiers, key=qualifier_order):
        raise ValueError("有限限定未按规范排序。")
    bindings = data["reference_bindings"]
    if not isinstance(bindings, list) or not 1 <= len(bindings) <= 8:
        raise ValueError("有限指称数组无效。")
    for row in bindings:
        _fields(row, {"role_id", "method", "mention", "target", "binding"})
        identifier = row["role_id"]
        if type(identifier) is not int or not 0 <= identifier < len(roles):
            raise ValueError("有限指称角色断链。")
        source(row["mention"])
        source(row["target"])
        if row["binding"] is not None:
            source(row["binding"])
        if (row["method"] == "actual_sender" and (roles[identifier]["kind"] != "author" or row["mention"] != row["target"] or row["binding"] is not None)
                or row["method"] == "source_identity" and (roles[identifier]["kind"] not in ROLE_KINDS[1:4] or row["binding"] is None)
                or row["method"] == "completed_question" and (roles[identifier]["kind"] not in ROLE_KINDS[7:] or row["binding"] is None)
                or row["method"] not in {"actual_sender", "source_identity", "completed_question"}):
            raise ValueError("有限指称方法无效。")
    if len({canonical(row) for row in bindings}) != len(bindings):
        raise ValueError("有限指称重复。")
    rep = _fields(data["representation"], {"version", "kind", "target_message_id", "source_full", "whole", "observation", "author", "quote", "quote_sources", "contexts"})
    if type(rep["version"]) is not int or rep["version"] != 1 or rep["kind"] != "grounded_window_quote_v1" or str(UUID(rep["target_message_id"])) != rep["target_message_id"]:
        raise ValueError("有限包装版本或目标无效。")
    for name in ("whole", "author", "quote"):
        candidate(rep[name])
    for name, low, high in (("source_full", 1, 4), ("quote_sources", 1, 2)):
        if not isinstance(rep[name], list) or not low <= len(rep[name]) <= high:
            raise ValueError("有限包装来源数量无效。")
        for item in rep[name]:
            source(item)
    if any(item["span"]["start"] != 0 for item in rep["source_full"]) or len({item["message_id"] for item in rep["source_full"]}) != len(rep["source_full"]):
        raise ValueError("有限包装须保留完整窗口。")
    if any(item["message_id"] != rep["target_message_id"] for item in rep["quote_sources"]):
        raise ValueError("有限主引句须属于实际目标。")
    if (rep["whole"]["start"] != 0 or rep["target_message_id"] not in {item["message_id"] for item in rep["source_full"]}
            or any(left["span"]["end"] != right["span"]["start"] for left, right in zip(rep["quote_sources"], rep["quote_sources"][1:]))
            or sum(item["span"]["end"] - item["span"]["start"] for item in rep["quote_sources"]) != rep["quote"]["end"] - rep["quote"]["start"]):
        raise ValueError("有限主引句须连续完整覆盖。")
    if len(rep["quote_sources"]) == 1 and rep["quote_sources"][0]["span"]["sha256"] != rep["quote"]["sha256"]:
        raise ValueError("有限单主引句须逐字复制。")
    if rep["observation"] is not None:
        observation = _fields(rep["observation"], {"message_id", "candidate"})
        if observation["message_id"] != rep["target_message_id"]:
            raise ValueError("有限观察前缀目标无效。")
        candidate(observation["candidate"])
    if not isinstance(rep["contexts"], list) or len(rep["contexts"]) > 4:
        raise ValueError("有限包装上下文数量无效。")
    for row in rep["contexts"]:
        _fields(row, {"source", "whole", "author", "quote"})
        source(row["source"])
        for name in ("whole", "author", "quote"):
            candidate(row[name])
    source_full = {item["message_id"]: item["span"] for item in rep["source_full"]}
    origin_spans = [row["source"] for row in (*roles, *atoms, *qualifiers)]
    origin_spans.extend(item for row in bindings for item in (row["mention"], row["target"], row["binding"]) if item is not None)
    origin_spans.extend((*rep["quote_sources"], *(row["source"] for row in rep["contexts"])))
    target_spans = [row["candidate"] for row in (*roles, *atoms, *qualifiers)]
    target_spans.extend((rep["author"], rep["quote"]))
    target_spans.extend(row[name] for row in rep["contexts"] for name in ("whole", "author", "quote"))
    if rep["observation"] is not None:
        target_spans.append(rep["observation"]["candidate"])
    if any(item["message_id"] not in source_full or item["span"]["end"] > source_full[item["message_id"]]["end"] for item in origin_spans):
        raise ValueError("有限来源定位未封闭于完整窗口。")
    if any(item["end"] > rep["whole"]["end"] for item in target_spans):
        raise ValueError("有限候选定位超出完整包装。")
    positions = {item["message_id"]: index for index, item in enumerate(rep["source_full"])}
    if bindings != sorted(bindings, key=lambda row: (row["role_id"],
            ("actual_sender", "source_identity", "completed_question").index(row["method"]),
            positions[row["mention"]["message_id"]], row["mention"]["span"]["start"], row["mention"]["span"]["end"])):
        raise ValueError("有限指称须保持规范窗口顺序。")
    for row in bindings:
        binding = row["binding"]
        if binding is not None and (row["target"]["message_id"] != binding["message_id"]
                or not binding["span"]["start"] <= row["target"]["span"]["start"] < row["target"]["span"]["end"] <= binding["span"]["end"]):
            raise ValueError("有限指称目标必须属于完整绑定句。")
    if (rep["author"]["end"] - rep["author"]["start"] not in {2, 3}
            or rep["quote"]["start"] != rep["author"]["end"] + len("原话：“")
            or (rep["observation"] is None and rep["author"]["start"] != 0)
            or rep["observation"] is not None and (rep["observation"]["candidate"]["start"] != 0
                or rep["observation"]["candidate"]["end"] != rep["author"]["start"])):
        raise ValueError("有限主作者与观察包装不完整。")
    cursor = rep["quote"]["end"] + 1
    seen_contexts = set()
    for index, row in enumerate(rep["contexts"]):
        context_key = canonical(row["source"])
        if (context_key in seen_contexts or row["whole"]["start"] != cursor + (len("（相关原文：") if index == 0 else 1)
                or row["author"]["start"] != row["whole"]["start"]
                or row["author"]["end"] - row["author"]["start"] not in {2, 3}
                or row["quote"]["start"] != row["author"]["end"] + len("说“")
                or row["whole"]["end"] != row["quote"]["end"] + 1
                or row["quote"]["end"] - row["quote"]["start"] != row["source"]["span"]["end"] - row["source"]["span"]["start"]
                or row["quote"]["sha256"] != row["source"]["span"]["sha256"]):
            raise ValueError("有限上下文包装未保持完整复制和顺序。")
        seen_contexts.add(context_key)
        cursor = row["whole"]["end"]
    if rep["whole"]["end"] != cursor + (1 if rep["contexts"] else 0):
        raise ValueError("有限包装含未覆盖尾部。")
    capabilities = data["capabilities"]
    if (not isinstance(capabilities, list) or any(item not in CAPABILITIES for item in capabilities)
            or capabilities != [item for item in CAPABILITIES if item in capabilities]
            or "direct_attribution" in capabilities and data["frame"] != "direct"
            or "reported_attribution" in capabilities and data["frame"] == "direct"):
        raise ValueError("有限能力须逐项按规范声明。")
    return data
