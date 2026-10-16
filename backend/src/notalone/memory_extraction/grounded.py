"""原文分句的纯编译器；验证结构与定位，不认证模型的语义判断。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import re
from typing import Any

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MemoryTopic
from notalone.memory_extraction.runtime import ExtractionPayload

# 类型决定相容的字段组合；不从案例名或参考答案生成事实。
KINDS = {
    "event": ("common_fact", "assertion", "asserted"),
    "relationship_event": ("relationship_note", "assertion", "asserted"),
    "reported_event": ("relationship_note", "report", "reported"),
    "third_party_fact": ("relationship_note", "report", "reported"),
    "assessment": ("relationship_note", "assertion", "asserted"),
    "preference": ("preference", "assertion", "asserted"),
    "taboo": ("taboo", "assertion", "asserted"),
    "state": ("recent_state", "assertion", "asserted"),
    "momentary_state": ("recent_state", "assertion", "asserted"),
    "plan": ("recent_state", "plan", "asserted"),
    "hypothesis": ("recent_state", "plan", "hypothetical"),
    "request": ("relationship_note", "request", "asserted"),
    "correction": ("relationship_note", "correction", "asserted"),
    "unknown": ("relationship_note", "unknown", "unknown"),
}
# 仅显式v4使用完整封闭组合，不向模型开放任意语用字段笛卡尔积。
V4_KIND_EXTENSIONS = {
    "stable_fact": ("common_fact", "assertion", "asserted", "literal"),
    "figurative_unknown_plan": ("recent_state", "plan", "asserted", "unknown"),
    "uncertain_plan": ("recent_state", "plan", "unknown", "literal"),
    "uncertain_state": ("recent_state", "assertion", "unknown", "literal"),
    "stage_unknown_state": ("recent_state", "unknown", "unknown", "literal"),
}
V4_STRUCTURAL_KINDS = {"continuation"}
OMISSIONS = {"question", "greeting", "nonliteral", "not_memory"}
ROW_KEYS = {"unit", "kind", "subject", "topic", "dependency", "unresolved", "confidence", "sensitivity"}
AMBIGUITY_CODES = ("entity_identity", "place_ownership", "borrowing_direction", "other_unresolved")
V4_AMBIGUITY_CODES = (*AMBIGUITY_CODES, "clock_period", "event_stage", "object_ownership")
MAX_V3_ALTERNATIVE_CHARS = 8400
_AMBIGUITY_TEMPLATES = {
    "entity_identity": ("原句所指人物身份在本窗口无法唯一确定，保留原句。",),
    "place_ownership": ("原句所指地点／家里归属在本窗口无法唯一确定，保留原句。",),
    "borrowing_direction": (
        "所引原句中的“借”，一种可能的方向是向对方借入；人物与是否发生均以同条原引句为准，本窗不确认此方向。",
        "所引原句中的“借”，另一种可能的方向是借给对方；人物与是否发生均以同条原引句为准，本窗不确认此方向。",
    ),
    "other_unresolved": ("原句在本窗口仍有其他未决解释，保留原句。",),
}
_V4_AMBIGUITY_TEMPLATES = {
    **_AMBIGUITY_TEMPLATES,
    "clock_period": ("所引原句中的时钟时制在本窗口无法唯一确定，保留原句，不补唯一的24小时制时刻。",),
    "event_stage": ("所引原句描述的活动是已经完成还是尚待安排，在本窗口无法唯一确定；保留原句，不选择其中一种。",),
    "object_ownership": ("所引原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。",),
}
SENSITIVITY = {"none", "financial", "health", "commitment", "other"}
_CONDITION = re.compile(r"^(?:如果|假如|要是|倘若|若)")
# 仅校验显式附属标签：整数紧接计数单位，不解释数量或自动选择角色。
_COUNT_CONTINUATION = re.compile(
    r"(?:0|[1-9][0-9]{0,3}|零|〇|[一二两三四五六七八九]|十[一二三四五六七八九]?|"
    r"[二三四五六七八九]十[一二三四五六七八九]?)"
    r"(?:个|位|名|人|张|份|本|件|台|套|把|双|只|支|瓶|盒|袋|包|辆|枚|颗|条)[。！!]?"
)


@dataclass(frozen=True)
class SourceUnit:
    id: str
    message: MessageRef
    start: int
    end: int
    target: bool

    @property
    def text(self) -> str:
        return self.message.text[self.start:self.end]


@dataclass
class _CompiledAmbiguity:
    codes: set[str]
    original_texts: list[str]


def source_units(window: ExtractionWindow) -> tuple[SourceUnit, ...]:
    """只按可见标点定位；不把标点切分当作语义已经解释。"""
    units = []
    for index, message in enumerate(window.messages):
        for ordinal, match in enumerate(re.finditer(r"[^，；;。！？!?\n]+[，；;。！？!?\n]*", message.text)):
            if match.group().strip():
                units.append(SourceUnit(f"{index}:{ordinal}", message, match.start(), match.end(),
                                        message.message_id in window.target_message_id_set))
    if len(units) > 512:
        raise ExtractionInvalidOutputError("原文分句超出单窗口结构预算。")
    return tuple(units)


def _period(text: str, anchor: datetime | None) -> tuple[datetime | None, datetime | None]:
    if anchor is None or anchor.utcoffset() is None:
        return None, None
    # 只计算受支持的完整日/周期间，不能从否定或更长时间词中截取子串。
    if re.search(r"不|没|非|除|别|勿|取消|改期", text):
        return None, None
    day = anchor.replace(hour=0, minute=0, second=0, microsecond=0)
    # 先取得含修饰语的最大时间短语，再做整词表匹配；不在失败后退回较短子串。
    tokens = set(re.findall(
        r"(?:[上下前后本这每大小]+个?)?(?:周末|周[一二三四五六日天]?|今天|明天|后天)"
        r"(?:之前|之后|以前|以后|前|后|起|左右|期间|内)?", text,
    ))
    supported = {"下周末", "本周末", "这周末", "周末", "下周", "本周", "这周", "今天", "明天", "后天"}
    if len(tokens) != 1 or not tokens <= supported:
        return None, None
    token = tokens.pop()
    if token.endswith("周末"):
        start = day - timedelta(days=day.weekday()) + timedelta(days=5 + (7 if token == "下周末" else 0))
        return start, start + timedelta(days=2)
    if token.endswith("周"):
        start = day - timedelta(days=day.weekday()) + timedelta(days=7 if token == "下周" else 0)
        return start, start + timedelta(days=7)
    start = day + timedelta(days={"今天": 0, "明天": 1, "后天": 2}[token])
    return start, start + timedelta(days=1)


def _period_v4(text: str, anchor: datetime | None) -> tuple[datetime | None, datetime | None]:
    """仅v4增加完整下月日历期间；旧协议仍使用原期间函数。"""
    quantity = r"(?:[0-9一二两三四五六七八九十百]+(?:多|来|几)?|半|几|数|若干)"
    phase = r"(?:初|中旬|中|底|末|[上中下]旬|之前|之后|以前|以后|前|后|起|左右|期间|内)"
    # 整条引句共用有限词法；月词须有相对/数量前缀或时段后缀，裸“月”不是时间词。
    time_word = re.compile(
        rf"(?P<month>(?:[上下前后本这每大小再隔另]+|{quantity})个?月(?:份)?(?:{phase})?|月{phase})|"
        rf"(?P<duration>{quantity}个?(?:年|周末|星期|礼拜|周|天|日|号|小时|时|点|分钟|分|秒))|"
        r"(?P<day_week>(?:[上下前后本这每大小]+个?)?(?:周末|周[一二三四五六日天]?|今天|明天|后天)"
        r"(?:之前|之后|以前|以后|前|后|起|左右|期间|内)?)|"
        r"(?P<other>[前去今明后本这每]+年|星期|礼拜|以后|将来|之前|之后)"
    )
    matches = list(time_word.finditer(text))
    if not any(match.lastgroup == "month" for match in matches):
        if any(match.lastgroup != "day_week" for match in matches):
            return None, None
        return _period(text, anchor)
    if anchor is None or anchor.utcoffset() is None or re.search(r"不|没|非|除|别|勿|取消|改期", text):
        return None, None
    if len(matches) != 1 or matches[0].group() not in {"下个月", "下月"}:
        return None, None
    before, after = text[:matches[0].start()].strip(), text[matches[0].end():].strip()
    subject = r"(?:我|你|他|她|它|我们|你们|他们|她们|它们|咱们)"
    modal = r"(?:可能|计划|打算|准备|想|要|将|会)"
    # 只承认完整的月状语计划形状，不用不断追加修饰黑名单来猜短语已经结束。
    # 其他主语/谓词、跨月范围或月内局部时段均UNKNOWN，原句仍完整保留。
    if (re.fullmatch(rf"(?:{subject})?(?:{modal}){{0,2}}(?:在|于)?", before) is None
            or re.fullmatch(
                rf"(?:{subject})?(?:{modal}){{0,2}}(?:一起)?(?:去|来|参加|办理|出发)"
                r"[^，；;。！？!?\n]{0,256}[，；;。！？!?\n]*", after,
            ) is None):
        return None, None
    try:
        start = anchor.replace(year=anchor.year + (anchor.month == 12),
                               month=anchor.month % 12 + 1, day=1,
                               hour=0, minute=0, second=0, microsecond=0, fold=0)
        end = start.replace(year=start.year + (start.month == 12), month=start.month % 12 + 1)
        for boundary in (start, end):
            # 来源若自带具名时区，月界必须是唯一且真实存在的本地午夜。
            if (boundary.utcoffset() != boundary.replace(fold=1).utcoffset()
                    or boundary.astimezone(timezone.utc).astimezone(boundary.tzinfo) != boundary):
                return None, None
    except (ValueError, OverflowError):
        return None, None
    return start, end


def _unit_id(raw: object) -> str:
    if not isinstance(raw, str):
        raise ValueError("分句编号必须是字符串。")
    match = re.fullmatch(r"(?:\[([0-9]+:[0-9]+)\]|([0-9]+:[0-9]+))", raw)
    if match is None:
        raise ValueError("分句编号格式错误。")
    return match[1] or match[2]


def _dependencies(
    members: list[SourceUnit], rows: dict[str, dict[str, Any]],
    by_id: dict[str, SourceUnit],
) -> list[SourceUnit]:
    """合并分句的依赖取并集；内部互指不新增来源，外部环拒绝。"""
    internal = {unit.id for unit in members}
    result: dict[str, SourceUnit] = {}

    def visit(key: str | None, path: frozenset[str]) -> None:
        if key is None or key in internal:
            return
        if key in path or len(path) >= 8:
            raise ValueError("上下文依赖成环或超出深度预算。")
        result[key] = by_id[key]
        if key in rows:
            visit(rows[key]["dependency"], path | {key})

    for member in members:
        visit(rows[member.id]["dependency"], frozenset())
    return list(result.values())


def _quantity_continuations(
    units: tuple[SourceUnit, ...], rows: dict[str, dict[str, Any]],
) -> dict[str, SourceUnit]:
    """只为显式v4角色建立一个相邻附属项；共享后续事实构建。"""
    result = {}
    for index, unit in enumerate(units):
        if not unit.target or rows[unit.id]["kind"] != "continuation":
            continue
        anchor = units[index - 1] if index else None
        if (anchor is None or not anchor.target
                or anchor.message.message_id != unit.message.message_id
                or anchor.end != unit.start or rows[anchor.id]["kind"] != "event"
                or not re.search(r"[，；;]+$", anchor.text)
                or re.search(r"[。！？!?\n]", anchor.text)):
            raise ValueError("附属数量必须紧邻同一目标消息中未结束整句的普通event。")
        if any(rows[anchor.id][field] != rows[unit.id][field] for field in ("subject", "topic")):
            raise ValueError("附属数量的归属或主题与主项冲突。")
        if _COUNT_CONTINUATION.fullmatch(unit.text.strip()) is None:
            raise ValueError("附属数量超出有限整数与计数单位语法。")
        result[anchor.id] = unit
    return result


def compile_draft(window: ExtractionWindow, draft: object) -> ExtractionPayload:
    """从完整分句标签编译原14槽；任何结构缺口停止整批而非静默漏记。"""
    return _checked_compile(window, draft, completed_answers=False)


def _checked_compile(
    window: ExtractionWindow, draft: object, *, completed_answers: bool,
    ambiguity_codes: dict[str, frozenset[str]] | None = None,
    version4: bool = False,
) -> ExtractionPayload:
    try:
        return _compile(window, draft, completed_answers=completed_answers,
                        ambiguity_codes=ambiguity_codes, version4=version4)
    except (ValueError, TypeError, KeyError) as error:
        raise ExtractionInvalidOutputError("原文结构提取不符合契约：" + str(error)) from None


def _compile(
    window: ExtractionWindow, draft: object, *, completed_answers: bool = False,
    ambiguity_codes: dict[str, frozenset[str]] | None = None,
    version4: bool = False,
) -> ExtractionPayload:
    if not isinstance(draft, dict) or set(draft) != {"units"} or not isinstance(draft["units"], list):
        raise ValueError("必须返回分句结构。")
    units = source_units(window)
    by_id = {unit.id: unit for unit in units}
    target_ids = {unit.id for unit in units if unit.target}
    allowed_kinds = {*KINDS, *OMISSIONS, "condition", "prefix"}
    observed_kinds = {"state", "momentary_state", "request"}
    period_kinds = {"plan", "hypothesis"}
    if version4:
        allowed_kinds.update(V4_KIND_EXTENSIONS)
        allowed_kinds.update(V4_STRUCTURAL_KINDS)
        observed_kinds.add("uncertain_state")
        period_kinds.update({"uncertain_plan", "figurative_unknown_plan"})
    rows: dict[str, dict[str, Any]] = {}
    for row in draft["units"]:
        if not isinstance(row, dict) or set(row) != ROW_KEYS:
            raise ValueError("分句字段不完整或包含自由改写字段。")
        row = dict(row)
        key = _unit_id(row["unit"])
        row["unit"] = key
        if row["dependency"] is not None:
            row["dependency"] = _unit_id(row["dependency"])
        if not isinstance(key, str) or key not in target_ids or key in rows:
            raise ValueError("分句越界、非目标或重复。")
        if row["kind"] not in allowed_kinds:
            raise ValueError("未知事实类型。")
        if row["subject"] not in {"self", "contact", "shared"}:
            raise ValueError("未知资料归属。")
        if row["topic"] not in {topic.value for topic in MemoryTopic}:
            raise ValueError("未知主题。")
        if row["sensitivity"] not in SENSITIVITY or type(row["unresolved"]) is not bool:
            raise ValueError("风险或指代结构无效。")
        confidence = row["confidence"]
        if type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("置信度无效。")
        dep = row["dependency"]
        if dep is not None and (not isinstance(dep, str) or dep not in by_id or dep == key):
            raise ValueError("上下文依赖不存在或自引用。")
        rows[key] = row
    if set(rows) != target_ids:
        raise ValueError("目标分句未完整交代。")

    continuations = _quantity_continuations(units, rows) if version4 else {}
    results: list[dict[str, Any]] = []
    pending_condition: SourceUnit | None = None
    unknown_groups: dict[tuple, dict[str, Any]] = {}
    compiled_ambiguities: dict[int, _CompiledAmbiguity] = {}
    for unit in units:
        if not unit.target:
            continue
        row = rows[unit.id]
        kind = row["kind"]
        if kind == "continuation":
            continue
        if kind in {"condition", "prefix"}:
            if pending_condition is not None or (kind == "condition" and not _CONDITION.match(unit.text)):
                raise ValueError("条件分句不能定位。")
            pending_condition = unit
            continue
        condition = pending_condition
        continuation = continuations.get(unit.id)
        if condition is not None and continuation is not None:
            raise ValueError("附属数量不能再与前缀或条件合并。")
        if condition is not None and (condition.message.message_id != unit.message.message_id or (rows[condition.id]["kind"] == "condition" and kind not in {"plan", "hypothesis"}) or kind in OMISSIONS):
            raise ValueError("条件必须绑定同一消息的下一计划分句。")
        pending_condition = None
        if kind in OMISSIONS:
            continue
        members = ([condition] if condition else []) + [unit]
        if continuation is not None:
            members.append(continuation)
        dependencies = _dependencies(members, rows, by_id)
        sources = [unit.message.message_id]
        for dep in dependencies:
            if dep.message.message_id not in sources:
                sources.append(dep.message.message_id)
        quote = "".join(member.text for member in members)
        author = "用户" if unit.message.sender.value == "self" else "联系人"
        completed = (completed_answers and condition is None
                     and kind in {"state", "momentary_state"}
                     and _is_completed_answer(unit, dependencies))
        if completed:
            kind = "event"
        figurative = "literal"
        if version4 and kind in V4_KIND_EXTENSIONS:
            category, speech, assertion, figurative = V4_KIND_EXTENSIONS[kind]
        else:
            category, speech, assertion = KINDS[kind]
        flags = [] if row["sensitivity"] == "none" else ["sensitivity:" + row["sensitivity"]]
        if condition is not None and rows[condition.id]["sensitivity"] != "none":
            flags.append("sensitivity:" + rows[condition.id]["sensitivity"])
        if continuation is not None and rows[continuation.id]["sensitivity"] != "none":
            flags = list(dict.fromkeys([*flags, "sensitivity:" + rows[continuation.id]["sensitivity"]]))
        valid: datetime | None = None
        invalid: datetime | None = None
        anchor = unit.message.occurred_at
        if kind in observed_kinds:
            valid = anchor
            if kind == "momentary_state" and anchor is not None:
                invalid = anchor.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        if kind in period_kinds:
            valid, invalid = (_period_v4 if version4 else _period)(quote, anchor)
            if valid is None:
                flags.append("grounded:unresolved_period")
            if (condition is not None and rows[condition.id]["kind"] == "condition") or _CONDITION.match(quote):
                if version4 and kind in V4_KIND_EXTENSIONS:
                    raise ValueError("v4未知计划不能被条件前件覆盖为另一字段组合。")
                assertion = "conditional"
        observed = f"截至{anchor.date().isoformat()}，" if anchor is not None and kind in observed_kinds else ""
        contexts = []
        for dep in dependencies:
            dep_author = "用户" if dep.message.sender.value == "self" else "联系人"
            contexts.append(f"{dep_author}说“{dep.text}”")
        context = "（相关原文：" + "；".join(contexts) + "）" if contexts else ""
        unresolved = any(rows[member.id]["unresolved"] for member in members)
        codes = (set().union(*(ambiguity_codes[member.id] for member in members))
                 if ambiguity_codes is not None else set())
        # 可见第三人指代缺少外部定位时不能因模型标 false 就宣称消歧。
        if re.match(r"^(?:现在|目前)?[他她它](?!们)", quote) and not dependencies:
            unresolved = True
            codes.add("entity_identity")
        alternatives = ["原文指代在本窗口无法唯一确定，保留原句。"] if unresolved else []
        if kind == "unknown" or version4 and kind == "stage_unknown_state":
            flags.append("grounded:unresolved_kind")
        fact = {
            "text": f"{observed}{author}原话：“{quote}”{context}",
            "category": category, "subject": row["subject"], "topic": row["topic"],
            "source_message_ids": [str(value) for value in sources], "confidence": min(rows[member.id]["confidence"] for member in members),
            "risk_flags": flags, "valid_at": valid.isoformat() if valid else None,
            "invalid_at": invalid.isoformat() if invalid else None,
            "speech_act": speech, "assertion_status": assertion, "figurative_type": figurative,
            "alternatives": alternatives,
            "interpretation_reason": (
                "原文完成问答明确表示动作已完成，程序据此保留历史动作，不设置当天失效。"
                if completed else "按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。"
            ),
        }
        # 同一消息的未知第三人资料保留原文连续关系，不制造新的具体人物身份。
        group = (unit.message.message_id, kind, row["topic"], row["subject"], tuple(str(value) for value in sources))
        if kind == "third_party_fact" and row["unresolved"] and group in unknown_groups:
            previous = unknown_groups[group]
            previous["text"] += f" 同一原消息续句：“{quote}”"
            previous["confidence"] = min(previous["confidence"], fact["confidence"])
            previous["risk_flags"] = list(dict.fromkeys(previous["risk_flags"] + flags))
            if ambiguity_codes is not None:
                previous_ambiguity = compiled_ambiguities[id(previous)]
                previous_ambiguity.codes.update(codes)
                previous_ambiguity.original_texts.append(fact["text"])
        else:
            results.append(fact)
            if ambiguity_codes is not None:
                compiled_ambiguities[id(fact)] = _CompiledAmbiguity(codes, [fact["text"]])
            if kind == "third_party_fact" and row["unresolved"]:
                unknown_groups[group] = fact
    if pending_condition is not None:
        raise ValueError("条件分句缺少对应计划。")
    if ambiguity_codes is not None:
        ordered_codes = V4_AMBIGUITY_CODES if version4 else AMBIGUITY_CODES
        templates = _V4_AMBIGUITY_TEMPLATES if version4 else _AMBIGUITY_TEMPLATES
        source_bound = ({"borrowing_direction", "clock_period", "event_stage", "object_ownership"}
                        if version4 else {"borrowing_direction"})
        for fact in results:
            compiled = compiled_ambiguities[id(fact)]
            originals = "；".join(compiled.original_texts)
            fact["alternatives"] = [
                text + (" 所附原引句及上下文：" + originals if code in source_bound else "")
                for code in ordered_codes if code in compiled.codes
                for text in templates[code]
            ]
            if any(len(text) > MAX_V3_ALTERNATIVE_CHARS for text in fact["alternatives"]):
                raise ValueError(("v4" if version4 else "v3") + "歧义说明超出单条8400字符预算，不能截断原句。")
    return tuple(results)



def needs_reference(unit: SourceUnit) -> bool:
    """仅识别有界的句首第三人指代；不是通用中文实体识别器。"""
    return re.match(r"^(?:现在|目前)?[他她它]", unit.text) is not None


def reference_choices(unit: SourceUnit, units: tuple[SourceUnit, ...]) -> tuple[str, ...]:
    """依据必须先出现且能独立定位，不能拿后面的回答或另一个裸指代作身份依据。"""
    choices = []
    for other in units:
        if other.id == unit.id:
            break
        if not needs_reference(other):
            choices.append(other.id)
    return tuple(choices)


def compile_labels(window: ExtractionWindow, draft: object) -> ExtractionPayload:
    """v2按程序给定的对象键绑定原文；禁止按输出顺序猜测编号。"""
    return _compile_named_labels(window, draft)


def compile_labels_v3(window: ExtractionWindow, draft: object) -> ExtractionPayload:
    """v3只新增受控歧义标签，不接收模型编写的替代解释。"""
    return _compile_typed_labels(window, draft)


def compile_labels_v4(window: ExtractionWindow, draft: object) -> ExtractionPayload:
    """显式离线v4增加封闭类型与附属角色，不接收自由字段。"""
    return _compile_typed_labels(window, draft, version4=True)


def _compile_typed_labels(
    window: ExtractionWindow, draft: object, *, version4: bool = False,
) -> ExtractionPayload:
    if not isinstance(draft, dict) or set(draft) != {"units"} or not isinstance(draft["units"], dict):
        raise ExtractionInvalidOutputError("原文标签必须按指定字段返回。")
    labels = {}
    codes = {}
    allowed_codes = V4_AMBIGUITY_CODES if version4 else AMBIGUITY_CODES
    protocol = "v4" if version4 else "v3"
    for key, label in draft["units"].items():
        if not isinstance(label, dict) or set(label) != (ROW_KEYS - {"unit"}) | {"ambiguity_codes"}:
            raise ExtractionInvalidOutputError(protocol + "标签字段不完整或包含自由文本。")
        raw_codes = label["ambiguity_codes"]
        if (not isinstance(raw_codes, list) or len(raw_codes) > len(allowed_codes)
                or any(type(code) is not str or code not in allowed_codes for code in raw_codes)
                or len(set(raw_codes)) != len(raw_codes)
                or type(label["unresolved"]) is not bool
                or label["unresolved"] != bool(raw_codes)):
            raise ExtractionInvalidOutputError(protocol + "歧义类别无效或与未决标记矛盾。")
        labels[key] = {name: value for name, value in label.items() if name != "ambiguity_codes"}
        codes[key] = frozenset(raw_codes)
    return _compile_named_labels(window, {"units": labels}, ambiguity_codes=codes, version4=version4)


def _compile_named_labels(
    window: ExtractionWindow, draft: object, *,
    ambiguity_codes: dict[str, frozenset[str]] | None = None,
    version4: bool = False,
) -> ExtractionPayload:
    if not isinstance(draft, dict) or set(draft) != {"units"} or not isinstance(draft["units"], dict):
        raise ExtractionInvalidOutputError("原文标签必须按指定字段返回。")
    units = source_units(window)
    target_ids = {unit.id for unit in units if unit.target}
    labels = draft["units"]
    if set(labels) != target_ids:
        raise ExtractionInvalidOutputError("原文标签字段缺失或越界。")
    rows = []
    for unit in units:
        if not unit.target:
            continue
        label = labels[unit.id]
        if not isinstance(label, dict) or set(label) != ROW_KEYS - {"unit"}:
            raise ExtractionInvalidOutputError("标签字段不完整或含自由编号。")
        rows.append({"unit": unit.id, **label})
    payloads = _checked_compile(window, {"units": rows}, completed_answers=True,
                                ambiguity_codes=ambiguity_codes, version4=version4)
    all_ids = {unit.id for unit in units}
    for unit in units:
        if not unit.target:
            continue
        label = labels[unit.id]
        dep = label["dependency"]
        if dep is not None and dep not in all_ids:
            raise ExtractionInvalidOutputError("依赖必须是窗口提供的精确字段名。")
        if needs_reference(unit) and label["kind"] not in OMISSIONS and not label["unresolved"]:
            if dep not in reference_choices(unit, units):
                raise ExtractionInvalidOutputError("已消歧的第三人指代缺少独立前文依据。")
            if dep in labels and labels[dep]["unresolved"]:
                raise ExtractionInvalidOutputError("未决前文不能作为已消歧依据。")
    return payloads


def _is_completed_answer(unit: SourceUnit, dependencies: list[SourceUnit]) -> bool:
    """只承认明确动作问答的完成短答，不借模型主题或时间到期语境推断抵达。"""
    if unit.start != 0 or len(dependencies) != 1:
        return False
    answer = re.fullmatch(
        r"(?:我)?(?:已经|已)?(?P<verb>抵达|到达|到|签收|办完|取到|送达|交完|完成)了[，。！!]*",
        unit.text,
    )
    question = dependencies[0]
    if answer is None or question.message.sender == unit.message.sender or question.start != 0:
        return False
    if int(question.id.split(":")[0]) >= int(unit.id.split(":")[0]):
        return False
    verb = answer["verb"]
    match = re.fullmatch(
        r"你(?:已经|已)?" + re.escape(verb) + r"(?P<object>[^，。！？!?]{0,32})了吗[？?]",
        question.text,
    )
    if match is None:
        return False
    obj = match["object"]
    if verb in {"到", "到达", "抵达"} and re.fullmatch(
        r"[\u4e00-\u9fffA-Za-z0-9]{0,20}(?:机场|车站|码头|公司|学校|医院|酒店|宾馆|场馆|办公室|目的地|家)",
        obj,
    ) is None:
        return False
    # 有时间、否定、将来或条件限定时不在这套有界完成语法内。
    return re.search(r"不|没|别|勿|如果|假如|明天|后天|将|打算|计划|时间|时候|期限|截止|到期|年龄|岁|点|日|周|月|年", obj) is None
