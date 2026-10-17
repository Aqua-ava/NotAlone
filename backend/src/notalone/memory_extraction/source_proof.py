"""同一次来源核验的纯证明接缝；位置提案不构成语义认证。"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import re
from types import MappingProxyType
from typing import Any, Callable, Mapping, TypeVar
from uuid import UUID

from notalone.memory_extraction.models import (
    AssertionStatus, ExtractedFact, ExtractionWindow, FigurativeType, MessageRef,
    SpeechAct,
)
from notalone.memory import MemoryCategory
from notalone.memory.dimension_evidence import AUTHOR_QUOTE_CAPABILITIES
from notalone.memory.bounded_evidence import RULE_VARIANTS as BOUNDED_RULE_VARIANTS, rule_set_sha256

RULE_VARIANTS: Mapping[str, tuple[str, ...]] = MappingProxyType({
    "AUTHOR_ARRIVAL_H1": ("direct_h",),
    "KIN_LEND_BA_H1": ("completed_h", "negative_h"),
    "REQUEST_ROLE_H1": ("quoted_request_h", "received_request_h"),
    "SOURCE_IDENTITY_H1": ("explicit_role_identity",),
    "COND_PLAN_RUN_V1": ("conditional_plan",),
})
AUTHOR_QUOTE_RULE_VARIANTS: Mapping[str, tuple[str, ...]] = MappingProxyType({
    "AUTHOR_ARRIVAL_H1": ("author_quote_h1",),
})
FRAMES = frozenset({"direct", "quoted_request_h", "received_request_h"})
MAX_TEXT_LENGTH = 4096
_RELATED = {"我姐": "elder_sister", "我哥": "elder_brother", "我同事": "colleague"}
_OBJECTS = {"车": "vehicle", "书": "book", "雨伞": "umbrella"}
_CANDIDATE_ROLES = {"姐姐": "elder_sister", "哥哥": "elder_brother", "同事": "colleague"}
_PERSON = r"(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?"
_IDENTITY = r"(?P<identity>这里的“(?P<identity_pronoun>她|他)”指(?P<identity_role>我姐|我哥|我同事))"
_REQUEST_TIME = r"(?:周末|明天|后天)"
_BENEFICIARY = rf"(?:{_PERSON}|该(?:姐姐|哥哥|同事))"
_NUMBER = r"(?:[1-9][0-9]{0,5}(?:\.[0-9]{1,3})?)"
_UNIT = r"(?:公里|米)"
_GRAMMARS = {
    "arrival_source": r"(?P<author>我)(?P<time>刚刚|刚)到家",
    "arrival_candidate": r"(?P<author>用户|联系人)(?P<time>刚刚|刚)到家",
    "lend_source": (
        r"(?P<action>(?P<related>我姐|我哥)(?P<time>昨天|前天)?(?P<negative>没有|没)?"
        r"把(?P<pronoun>她|他)的(?P<object>车|书|雨伞)借给(?P<author>我)(?P<completion>了)?)"
        rf"(?:。{_IDENTITY})?"
    ),
    "lend_candidate": (
        rf"(?P<action>(?P<agent>{_PERSON})(?P<time>昨天|前天)?(?P<negative>没有)?把"
        rf"(?P<owner>自己|{_PERSON})的(?P<object>车|书|雨伞)借给(?P<completion>了)?(?P<recipient>{_PERSON}))"
    ),
    "request_source": (
        rf"(?P<action>(?P<related>我姐|我哥|我同事)让"
        rf"(?P<inner>(?P<author>我)(?P<time>{_REQUEST_TIME})帮(?P<pronoun>她|他)顶个班))"
        rf"(?:。{_IDENTITY})?"
    ),
    "quoted_request_h": rf"(?P<requester>{_PERSON})已提出请托，内容是希望(?P<inner>(?P<actor>{_PERSON})(?P<time>{_REQUEST_TIME})?替(?P<beneficiary>{_BENEFICIARY})顶班)，未说明接受",
    "received_request_h": rf"(?P<recipient>{_PERSON})(?P<outer_time>{_REQUEST_TIME})?已收到(?P<requester>{_PERSON})请托；所请内容为(?P<inner>(?P<actor>{_PERSON})(?P<time>{_REQUEST_TIME})?替(?P<beneficiary>{_BENEFICIARY})顶班)，未说明接受",
    "commitment_candidate": rf"(?P<actor>{_PERSON})(?P<commitment>已答应|答应|有义务|已经|已)(?P<time>{_REQUEST_TIME})?替(?P<beneficiary>{_BENEFICIARY})顶班(?:了)?",
    "execution_candidate": rf"(?P<actor>{_PERSON})(?P<commitment>已经|已)顶班(?:了)?",
}


@dataclass(frozen=True, slots=True)
class ProposalSpan:
    start: int
    end: int
    message_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class AtomLink:
    rule_id: str
    variant_id: str
    source: ProposalSpan
    candidate: ProposalSpan


@dataclass(frozen=True, slots=True)
class ReferenceLink:
    rule_id: str
    mention: ProposalSpan
    target: ProposalSpan
    binding: ProposalSpan | None


@dataclass(frozen=True, slots=True)
class ReportedLink:
    rule_id: str
    frame: str
    source: ProposalSpan
    candidate: ProposalSpan


@dataclass(frozen=True, slots=True)
class ProofProposal:
    version: int
    atom_links: tuple[AtomLink, ...] | None
    reference: tuple[ReferenceLink, ...] | None
    reported: tuple[ReportedLink, ...] | None


def _object(raw: object, keys: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != keys:
        raise ValueError("来源证明字段不符合契约。")
    return raw


def _span(raw: object, *, source: bool) -> ProposalSpan:
    keys = {"start", "end"} | ({"message_id"} if source else set())
    value = _object(raw, keys)
    start, end = value["start"], value["end"]
    if not (
        type(start) is int and type(end) is int
        and 0 <= start < end <= MAX_TEXT_LENGTH
    ):
        raise ValueError("证明位置必须为有界整数区间。")
    message_id = None
    if source:
        if type(value["message_id"]) is not str:
            raise ValueError("证明来源必须为消息UUID。")
        message_id = UUID(value["message_id"])
    return ProposalSpan(start, end, message_id)


def _rule(raw: object, rules: Mapping[str, tuple[str, ...]] = RULE_VARIANTS) -> str:
    if type(raw) is not str or raw not in rules:
        raise ValueError("证明规则不在已批准集合。")
    return raw


def _atom(raw: object, rules: Mapping[str, tuple[str, ...]] = RULE_VARIANTS) -> AtomLink:
    value = _object(raw, {"rule_id", "variant_id", "source", "candidate"})
    rule = _rule(value["rule_id"], rules)
    variant = value["variant_id"]
    if type(variant) is not str or variant not in rules[rule]:
        raise ValueError("证明变体不属于当前规则。")
    return AtomLink(
        rule, variant, _span(value["source"], source=True),
        _span(value["candidate"], source=False),
    )


def _reference(raw: object, rules: Mapping[str, tuple[str, ...]] = RULE_VARIANTS) -> ReferenceLink:
    value = _object(raw, {"rule_id", "mention", "target", "binding"})
    return ReferenceLink(
        _rule(value["rule_id"], rules), _span(value["mention"], source=True),
        _span(value["target"], source=True),
        None if value["binding"] is None else _span(value["binding"], source=True),
    )


def _reported(raw: object, rules: Mapping[str, tuple[str, ...]] = RULE_VARIANTS) -> ReportedLink:
    value = _object(raw, {"rule_id", "frame", "source", "candidate"})
    frame = value["frame"]
    frames = (FRAMES if rules is RULE_VARIANTS else frozenset({"direct", "reported_request", "received_request"})
              if rules is BOUNDED_RULE_VARIANTS else frozenset({"direct"}))
    if type(frame) is not str or frame not in frames:
        raise ValueError("证明转述框架不符合契约。")
    return ReportedLink(
        _rule(value["rule_id"], rules), frame, _span(value["source"], source=True),
        _span(value["candidate"], source=False),
    )


_T = TypeVar("_T")


def _links(raw: object, maximum: int, parse: Callable[[object], _T]) -> tuple[_T, ...] | None:
    if raw is None:
        return None
    if not isinstance(raw, list) or len(raw) > maximum:
        raise ValueError("证明链接超出有界集合。")
    return tuple(parse(item) for item in raw)


def bounded_runtime_rule_set_sha256() -> str:
    """返回版本三有限运行合同的稳定规则摘要，无I/O。"""
    return rule_set_sha256()


def validate_bounded_body_sources(window: ExtractionWindow, fact: ExtractedFact) -> tuple[UUID, ...]:
    """显式模式置ALL前核实际正文和规范消息依赖；不生成语义信用。"""
    from .bounded_proof import validate_body_sources
    return validate_body_sources(window, fact)


def bounded_source_occurred_at(message: MessageRef) -> datetime | None:
    """从活动来源的原ISO时刻独立核原偏移；不读已存依据或外部文件。"""
    from notalone.memory.evidence_binding import source_state_digest
    actual = message.occurred_at
    if actual is None or source_state_digest(message.source_snapshots) is None:
        return None
    times = []
    try:
        for snapshot in message.source_snapshots:
            payload = snapshot["raw_payload"]
            if not isinstance(payload, dict):
                return None
            raw = payload["time_iso"]
            if type(raw) is not str:
                return None
            value = datetime.fromisoformat(raw)
            if value.utcoffset() is None or value != actual:
                return None
            times.append(value)
    except (ValueError, TypeError, KeyError):
        return None
    if not times or len({item.utcoffset() for item in times}) != 1:
        return None
    return times[0]


def parse_proposal(raw: object, *, version: int = 1) -> ProofProposal | None:
    """只接收固定结构；缺失证明保留未知，非法证明不能被静默丢弃。"""

    if type(version) is not int or version not in {1, 2, 3}:
        raise ValueError("来源证明协议未受支持。")
    if raw is None:
        return None
    value = _object(raw, {"version", "atom_links", "reference", "reported"})
    if type(value["version"]) is not int or value["version"] != version:
        raise ValueError("来源证明版本不符合契约。")
    rules = RULE_VARIANTS if version == 1 else AUTHOR_QUOTE_RULE_VARIANTS if version == 2 else BOUNDED_RULE_VARIANTS
    proposal = ProofProposal(
        version, _links(value["atom_links"], 16, lambda raw: _atom(raw, rules)),
        _links(value["reference"], 8, lambda raw: _reference(raw, rules)),
        _links(value["reported"], 8, lambda raw: _reported(raw, rules)),
    )
    if version == 3:
        from .bounded_proof import validate_proposal_shape
        validate_proposal_shape(raw, proposal)
    return proposal


@dataclass(frozen=True, slots=True)
class ProofVerification:
    """不可变结论；依据读取返回副本，不允许调用者改写已核图。"""

    status: str
    reason: str
    _basis_json: str | None = None

    @property
    def semantic_basis(self) -> dict[str, Any] | None:
        return None if self._basis_json is None else json.loads(self._basis_json)


@dataclass(frozen=True, slots=True)
class _Parsed:
    rule_id: str
    variant: str
    frame: str
    values: dict[str, Any]
    spans: dict[str, tuple[int, int]]
    whole: tuple[int, int]


def _json(value: object) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    )


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _text_span(text: str, span: tuple[int, int]) -> dict[str, Any]:
    start, end = span
    return {"start": start, "end": end, "sha256": _digest(text[start:end])}


def _source_span(message: MessageRef, span: tuple[int, int]) -> dict[str, Any]:
    return {"message_id": str(message.message_id), "span": _text_span(message.text, span)}


def _trimmed(text: str) -> tuple[str, int]:
    start = len(text) - len(text.lstrip())
    result = text.strip()
    return (result[:-1] if result.endswith("。") else result), start


def _arrival(text: str, sender: str, *, source: bool) -> _Parsed | None:
    body, offset = _trimmed(text)
    match = re.fullmatch(_GRAMMARS["arrival_source" if source else "arrival_candidate"], body)
    if match is None:
        return None
    actual_sender = sender if source else (
        "self" if match["author"] == "用户" else "contact"
    )
    return _Parsed(
        "AUTHOR_ARRIVAL_H1", "direct_h", "direct",
        {"author": (actual_sender, "author"), "time": "just"},
        {key: (offset + match.start(key), offset + match.end(key))
         for key in ("author", "time")},
        (offset, offset + len(body)),
    )


def _author_quote(text: str, source_text: str) -> _Parsed | None:
    body = text.strip()
    offset = len(text) - len(text.lstrip())
    inner = source_text.strip()
    for author, sender in (("用户", "self"), ("联系人", "contact")):
        prefix = author + "原话：“"
        if body != prefix + inner + "”":
            continue
        parsed = _arrival(inner, sender, source=True)
        if parsed is None:
            return None
        inner_start = offset + len(prefix)
        spans = {key: (inner_start + start, inner_start + end)
                 for key, (start, end) in parsed.spans.items()}
        spans.update(outer_author=(offset, offset + len(author)),
                     inner=(inner_start, inner_start + len(inner)))
        return replace(parsed, variant="author_quote_h1", spans=spans,
                       whole=(offset, offset + len(body)))
    return None


def _author_quote_basis(source: _Parsed, candidate: _Parsed, message: MessageRef,
                        fact: ExtractedFact) -> dict[str, Any]:
    result = _basis(source, candidate, message, fact)
    source_start = len(message.text) - len(message.text.lstrip())
    result.update(
        version=2,
        rules=[{"rule_id": "AUTHOR_ARRIVAL_H1", "rule_version": 2}],
        rule_set_sha256=_digest(_json({
            "version": 2, "rules": dict(AUTHOR_QUOTE_RULE_VARIANTS),
            "source_grammar": _GRAMMARS["arrival_source"],
            "wrappers": {"self": ["用户原话：“", "”"], "contact": ["联系人原话：“", "”"]},
            "representation": "author_quote_h1-v1-exact-complete-trimmed-source-no-extra-text",
            "coordinates": "python-unicode-half-open-actual-source-and-candidate",
            "pragmatics": "common-fact-actual-sender-outer-author-inner-I-subject-direct-asserted-literal-null-H",
            "scope": "one-full-message-one-target-source-only-actual-text-complete-snapshots",
            "capabilities": AUTHOR_QUOTE_CAPABILITIES,
        })),
        representation={
            "version": 1, "kind": "author_quote_h1",
            "source": _source_span(message, (source_start, source_start + len(message.text.strip()))),
            "candidate": _text_span(fact.text, candidate.whole),
            "author": _text_span(fact.text, candidate.spans["outer_author"]),
            "inner": _text_span(fact.text, candidate.spans["inner"]),
        },
        capabilities=list(AUTHOR_QUOTE_CAPABILITIES),
    )
    return result


def _person(token: str) -> tuple[str, str]:
    base, _, relation = token.partition("的")
    return ("self" if base == "用户" else "contact", _CANDIDATE_ROLES[relation] if relation else "author")


def _spans(match: re.Match[str], offset: int) -> dict[str, tuple[int, int]]:
    return {key: (offset + match.start(key), offset + match.end(key))
            for key, value in match.groupdict().items() if value is not None and value != ""}


def _lend(text: str, sender: str, *, source: bool) -> _Parsed | None:
    body, offset = _trimmed(text)
    pattern = _GRAMMARS["lend_source" if source else "lend_candidate"]
    match = re.fullmatch(pattern, body)
    if match is None:
        return None
    negative = match["negative"] is not None
    if negative == (match["completion"] is not None) or (
        source and negative and match["time"] is None
    ):
        return None
    spans = _spans(match, offset)
    author = (sender, "author")
    if source:
        agent = (sender, _RELATED[match["related"]])
        recipient = author
        owner = None
        if match["identity"] is not None:
            if match["identity_pronoun"] != match["pronoun"] or match["identity_role"] != match["related"]:
                return None
            owner = agent
    else:
        agent, recipient = _person(match["agent"]), _person(match["recipient"])
        owner = agent if match["owner"] == "自己" else _person(match["owner"])
    return _Parsed(
        "KIN_LEND_BA_H1", "negative_h" if negative else "completed_h", "direct",
        {"author": author, "agent": agent, "recipient": recipient,
         "property_owner": owner, "object": _OBJECTS[match["object"]],
         "polarity": not negative, "phase": "completed", "time": match["time"]},
        spans, (offset, offset + len(body)),
    )


def _beneficiary(token: str, introduced: tuple[tuple[str, str], ...]) -> tuple[str, str] | None:
    if not token.startswith("该"):
        return _person(token)
    kind = _CANDIDATE_ROLES[token[1:]]
    choices = {person for person in introduced if person[1] == kind}
    return next(iter(choices)) if len(choices) == 1 else None


def _request(text: str, sender: str, *, source: bool) -> _Parsed | None:
    body, offset = _trimmed(text)
    if source:
        if sender != "self":
            return None
        match = re.fullmatch(_GRAMMARS["request_source"], body)
        if match is None:
            return None
        requester = (sender, _RELATED[match["related"]])
        beneficiary = None
        if match["identity"] is not None:
            if match["identity_pronoun"] != match["pronoun"] or match["identity_role"] != match["related"]:
                return None
            beneficiary = requester
        return _Parsed(
            "REQUEST_ROLE_H1", "quoted_request_h", "quoted_request_h",
            {"author": (sender, "author"), "requester": requester,
             "recipient": (sender, "author"), "actor": (sender, "author"),
             "beneficiary": beneficiary, "time": match["time"], "outer_time": None},
            _spans(match, offset), (offset, offset + len(body)),
        )
    for frame in ("quoted_request_h", "received_request_h"):
        match = re.fullmatch(_GRAMMARS[frame], body)
        if match is None:
            continue
        requester, actor = _person(match["requester"]), _person(match["actor"])
        recipient = actor if frame == "quoted_request_h" else _person(match["recipient"])
        beneficiary = _beneficiary(match["beneficiary"], (requester, actor, recipient))
        if beneficiary is None:
            return None
        return _Parsed(
            "REQUEST_ROLE_H1", frame, frame,
            {"author": (sender, "author"), "requester": requester, "recipient": recipient,
             "actor": actor, "beneficiary": beneficiary, "time": match["time"],
             "outer_time": match.groupdict().get("outer_time")},
            _spans(match, offset), (offset, offset + len(body)),
        )
    # 新增接受、义务及完成仅作完整候选的RAM诊断，不增加持久正例规则。
    match = re.fullmatch(_GRAMMARS["commitment_candidate"], body)
    if match is None:
        match = re.fullmatch(_GRAMMARS["execution_candidate"], body)
    if match is None:
        return None
    if "beneficiary" in match.groupdict() and _beneficiary(match["beneficiary"], (_person(match["actor"]),)) is None:
        return None
    diagnostic = "stage_change" if match["commitment"] in {"已", "已经"} else "unsupported_addition"
    return _Parsed("REQUEST_ROLE_H1", "diagnostic", "direct", {"diagnostic": diagnostic}, _spans(match, offset), (offset, offset + len(body)))


def _plan_grammar(source: bool) -> str:
    condition = r"如果(?P<condition>天晴)，"
    actor = "我" if source else _PERSON
    time = r"(?P<time>明天|后天)" + ("" if source else "?")
    number = rf"(?P<number>{_NUMBER})" + ("" if source else "?")
    unit = rf"(?P<unit>{_UNIT})" + ("" if source else "?")
    phase = r"(?P<phase>计划)" if source else r"(?P<phase>计划|已经|已|肯定)?"
    return (
        (condition if source else rf"(?:{condition})?")
        + rf"(?P<action>(?P<author>{actor}){phase}{time}(?P<only>只)?跑"
        + rf"(?P<approx>约)?(?P<distance>{number}{unit})"
        + (r")" if source else r"(?P<completion>了)?)")
    )


def _plan(text: str, sender: str, *, source: bool) -> _Parsed | None:
    body, offset = _trimmed(text)
    match = re.fullmatch(_plan_grammar(source), body)
    if match is None:
        return None
    quantity = None
    if match["number"] is not None:
        value = Decimal(match["number"])
        if value > Decimal(100000):
            return None
        if match["unit"] is not None:
            metres = value * (1000 if match["unit"] == "公里" else 1)
            quantity = format(metres, "f")
            if "." in quantity:
                quantity = quantity.rstrip("0").rstrip(".")
    author = (sender, "author")
    actor_value = author if source else _person(match["author"])
    diagnostic = None
    if not source:
        if match["phase"] in {"已", "已经"} or match["completion"] is not None:
            diagnostic = "stage_change"
        elif match["phase"] == "肯定":
            diagnostic = "unsupported_addition"
    values = {
        "author": author, "actor": actor_value, "condition": match["condition"],
        "phase": "planned" if match["phase"] == "计划" else None,
        "time": match["time"], "only": match["only"] is not None,
        "approx": match["approx"] is not None, "distance": quantity,
    }
    if diagnostic is not None:
        values["diagnostic"] = diagnostic
    return _Parsed("COND_PLAN_RUN_V1", "conditional_plan", "direct", values, _spans(match, offset), (offset, offset + len(body)))


def _parse_text(text: str, sender: str, *, source: bool) -> _Parsed | None:
    return (
        _arrival(text, sender, source=source) or _lend(text, sender, source=source)
        or _request(text, sender, source=source) or _plan(text, sender, source=source)
    )


def _align_frame(source: _Parsed, candidate: _Parsed) -> _Parsed:
    if source.rule_id == candidate.rule_id == "REQUEST_ROLE_H1" and candidate.frame in {
        "quoted_request_h", "received_request_h",
    }:
        return replace(source, frame=candidate.frame, variant=candidate.variant)
    return source


def _trusted_message(
    window: ExtractionWindow, fact: ExtractedFact,
    trusted_sources: Mapping[UUID, str] | None,
) -> tuple[MessageRef | None, str]:
    if (
        len(window.messages) != 1 or len(window.target_message_id_set) != 1
        or fact.source_message_ids != (window.messages[0].message_id,)
    ):
        return None, "scope_not_supported"
    message = window.messages[0]
    texts = {item.message_id: item.text for item in window.messages}
    if trusted_sources is not None and dict(trusted_sources) != texts:
        return None, "untrusted_source"
    # 只复用既有纯摘要规则；延迟导入避免与保存复核的反向调用成环。
    from notalone.memory.evidence_binding import source_state_digest

    if (
        message.message_type != "text" or message.text_representation != "text"
        or source_state_digest(message.source_snapshots) is None
        or len(message.text) > MAX_TEXT_LENGTH or len(fact.text) > MAX_TEXT_LENGTH
    ):
        return None, "untrusted_source"
    try:
        for item in message.source_snapshots:
            UUID(str(item["source_ref_id"]))
            UUID(str(item["source_id"]))
    except (KeyError, TypeError, ValueError):
        return None, "untrusted_source"
    return message, ""


def _validate_positions(
    proposal: ProofProposal | None, window: ExtractionWindow, fact: ExtractedFact,
) -> None:
    if proposal is None:
        return
    messages = {item.message_id: item.text for item in window.messages}
    source_spans = [item.source for item in proposal.atom_links or ()]
    source_spans.extend(item.source for item in proposal.reported or ())
    candidate_spans = [item.candidate for item in proposal.atom_links or ()]
    candidate_spans.extend(item.candidate for item in proposal.reported or ())
    for item in proposal.reference or ():
        source_spans.extend((item.mention, item.target))
        if item.binding is not None:
            source_spans.append(item.binding)
    for span in source_spans:
        if (
            span.message_id not in messages or span.message_id not in fact.source_message_ids
            or span.end > len(messages[span.message_id])
        ):
            raise ValueError("证明区间不属于实际候选来源。")
    if any(span.end > len(fact.text) for span in candidate_spans):
        raise ValueError("证明区间超出实际候选。")


def _pragmatics_match(fact: ExtractedFact, parsed: _Parsed) -> bool:
    sender = parsed.values["author"][0]
    speech, assertion = SpeechAct.ASSERTION, AssertionStatus.ASSERTED
    if parsed.frame == "quoted_request_h":
        speech, assertion = SpeechAct.REPORT, AssertionStatus.REPORTED
    elif parsed.rule_id == "COND_PLAN_RUN_V1":
        speech, assertion = SpeechAct.PLAN, AssertionStatus.CONDITIONAL
    return (
        fact.subject.value == sender and fact.speech_act is speech
        and fact.assertion_status is assertion
        and fact.figurative_type is FigurativeType.LITERAL
        and fact.valid_at is None and fact.invalid_at is None
        and (parsed.rule_id != "REQUEST_ROLE_H1" or fact.category is MemoryCategory.RELATIONSHIP_NOTE)
    )


def _range_matches(span: ProposalSpan, expected: tuple[int, int], whole: str) -> bool:
    start, end = expected
    # 尾句号和首尾空白可包含在提案中；实际持久锚点始终由解析器决定。
    return span.start <= start and span.end >= end and (
        not whole[span.start:start].strip()
        and whole[end:span.end].strip() in {"", "。"}
    )


def _proposal_matches(
    proposal: ProofProposal, source: _Parsed, candidate: _Parsed,
    message: MessageRef, fact: ExtractedFact,
) -> bool:
    if not proposal.atom_links or not proposal.reference or not proposal.reported:
        return False
    if len(proposal.atom_links) != 1 or len(proposal.reported) != 1:
        return False
    atom = proposal.atom_links[0]
    reported = proposal.reported[0]
    if (
        atom.rule_id != source.rule_id or atom.variant_id != candidate.variant
        or reported.rule_id != source.rule_id or reported.frame != candidate.frame
    ):
        return False
    for link in (atom, reported):
        if not (
            _range_matches(link.source, source.whole, message.text)
            and _range_matches(link.candidate, candidate.whole, fact.text)
        ):
            return False
    author = source.spans["author"]
    expected: list[tuple[str, tuple[int, int], tuple[int, int], tuple[int, int] | None]] = [
        (source.rule_id, author, author, None),
    ]
    if "identity" in source.spans:
        expected.append((
            "SOURCE_IDENTITY_H1", source.spans["pronoun"],
            source.spans["identity_role"], source.spans["identity"],
        ))
    actual = [(
        ref.rule_id, (ref.mention.start, ref.mention.end),
        (ref.target.start, ref.target.end),
        None if ref.binding is None else (ref.binding.start, ref.binding.end),
    ) for ref in proposal.reference]
    return len(actual) == len(set(actual)) and set(actual) == set(expected)


def _rule_set_digest() -> str:
    return _digest(_json({
        "version": 1, "rules": dict(RULE_VARIANTS),
        "grammar": {**_GRAMMARS, "plan_source": _plan_grammar(True), "plan_candidate": _plan_grammar(False)},
        "lexicon": {"related": _RELATED, "objects": _OBJECTS, "candidate_roles": _CANDIDATE_ROLES},
        "normalization": {
            "author": "actual-self-or-contact-sender", "recency": {"刚": "just", "刚刚": "just"},
            "identity": "complete-unique-same-role-and-pronoun", "number": "ascii-decimal-exact-metres-limit-100000",
            "degree": "only-and-approx-reference-distance", "condition": "planned-run-requires-clear-weather",
            "stage": "historical-request-requested-content-completed-lend-arrival-planned-run",
            "time": "event-time-and-requested-time-never-memory-validity", "negative": "diagnostic-only-never-positive",
        },
        "serialization": "utf8-sort-keys-no-whitespace-no-nan-python-unicode-half-open-v1",
        "limits": {"text": MAX_TEXT_LENGTH, "atom_links": 16, "reference": 8, "reported": 8},
        "scope": "one-full-message-one-target-source-only-actual-text-complete-snapshots",
        "pragmatics": {
            "direct": ["assertion", "asserted", "literal", "null-H"],
            "quoted_request_h": ["report", "reported", "literal", "self", "relationship_note", "null-H"],
            "received_request_h": ["assertion", "asserted", "literal", "self", "relationship_note", "null-H"],
            "conditional_plan": ["plan", "conditional", "literal", "null-H"],
        },
    }))


def _semantic_graph(parsed: _Parsed) -> dict[str, Any]:
    """全文独立语法树的规范图；定位和消息UUID不参与语义等价摘要。"""

    values = parsed.values
    roles: dict[str, Any] = {"author": values["author"]}
    atoms: list[dict[str, Any]] = []
    qualifiers: list[dict[str, Any]] = []
    unresolved = []
    if parsed.rule_id == "AUTHOR_ARRIVAL_H1":
        atoms.append({"atom_id": 0, "predicate": "arrive_home", "phase": "completed", "roles": {"actor": values["author"]}})
        qualifiers.append({"kind": "time", "atom_id": 0, "slot": "event_time", "value": "just"})
    elif parsed.rule_id == "KIN_LEND_BA_H1":
        roles.update(agent=values["agent"], recipient=values["recipient"], object=values["object"], property_owner=values["property_owner"])
        atoms.append({"atom_id": 0, "predicate": "lend", "phase": "completed", "roles": {key: values[key] for key in ("agent", "recipient", "object", "property_owner")}})
        qualifiers.append({"kind": "polarity", "atom_id": 0, "slot": "predicate", "value": values["polarity"]})
        if values["time"] is not None:
            qualifiers.append({"kind": "time", "atom_id": 0, "slot": "event_time", "value": values["time"]})
        if values["property_owner"] is None:
            unresolved.append({"atom_id": 0, "slot": "property_owner", "reason": "missing_source_identity"})
    elif parsed.rule_id == "REQUEST_ROLE_H1":
        roles.update(requester=values["requester"], recipient=values["recipient"], actor=values["actor"], beneficiary=values["beneficiary"])
        atoms.extend([
            {"atom_id": 0, "predicate": "request" if parsed.frame == "quoted_request_h" else "receive_request",
             "phase": "historical", "roles": {"agent": values["requester"], "recipient": values["recipient"]}},
            {"atom_id": 1, "predicate": "cover_shift", "phase": "requested",
             "roles": {"actor": values["actor"], "beneficiary": values["beneficiary"]}},
        ])
        qualifiers.append({"kind": "time", "atom_id": 1, "slot": "requested_time", "value": values["time"]})
        if values["outer_time"] is not None:
            qualifiers.append({"kind": "time", "atom_id": 0, "slot": "event_time", "value": values["outer_time"]})
        if values["beneficiary"] is None:
            unresolved.append({"atom_id": 1, "slot": "beneficiary", "reason": "missing_source_identity"})
    else:
        roles["actor"] = values["actor"]
        atoms.extend([
            {"atom_id": 0, "predicate": "clear_weather", "phase": "condition", "roles": {}},
            {"atom_id": 1, "predicate": "run", "phase": "planned", "roles": {"actor": values["actor"]}},
        ])
        qualifiers.append({"qualifier_id": 0, "kind": "quantity", "atom_id": 1, "slot": "distance", "value": values["distance"]})
        for modifier in ("only", "approx"):
            if values[modifier]:
                qualifiers.append({"kind": "degree", "quantity_qualifier_id": 0, "modifier": modifier, "value": values["distance"]})
        qualifiers.extend([
            {"kind": "condition", "condition_atom_id": 0, "action_atom_id": 1, "relation": "requires"},
            {"kind": "time", "atom_id": 1, "slot": "event_time", "value": values["time"]},
        ])
    return {"roles": roles, "atoms": atoms, "qualifiers": qualifiers, "frame": parsed.frame, "unresolved": unresolved}


def _basis(source: _Parsed, candidate: _Parsed, message: MessageRef, fact: ExtractedFact) -> dict[str, Any]:
    role_slots: dict[str, int | None] = {key: None for key in (
        "agent", "recipient", "object", "property_owner", "beneficiary", "actor",
    )}
    role_slots["actor"] = 0
    graph_hash = _digest(_json(_semantic_graph(source)))
    candidate_hash = _digest(_json(_semantic_graph(candidate)))
    rules = [{"rule_id": source.rule_id, "rule_version": 1}]
    result: dict[str, Any] = {
        "version": 1, "rule_set_sha256": _rule_set_digest(),
        "rules": rules,
        "roles": [{
            "role_id": 0, "kind": "author", "sender": message.sender.value,
            "source": _source_span(message, source.spans["author"]),
        }],
        "atoms": [{
            "atom_id": 0, "predicate": "arrive_home", "phase": "completed",
            "roles": role_slots, "source": _source_span(message, source.whole),
            "candidate": _text_span(fact.text, candidate.whole),
        }],
        "qualifiers": [{
            "qualifier_id": 0, "kind": "time", "atom_id": 0,
            "slot": "event_time", "value_sha256": _digest(_json({"event_time": "just"})),
            "source": _source_span(message, source.spans["time"]),
            "candidate": _text_span(fact.text, candidate.spans["time"]),
        }] if source.rule_id == "AUTHOR_ARRIVAL_H1" else [],
        "reference_bindings": [{
            "role_id": 0, "method": "actual_sender",
            "mention": _source_span(message, source.spans["author"]),
            "target": _source_span(message, source.spans["author"]), "binding": None,
        }],
        "frame": candidate.frame, "unresolved": [],
        "source_graph_sha256": graph_hash, "candidate_graph_sha256": candidate_hash,
    }
    if source.rule_id in {"KIN_LEND_BA_H1", "REQUEST_ROLE_H1"}:
        related = source.values["agent"] if source.rule_id == "KIN_LEND_BA_H1" else source.values["requester"]
        result["roles"].extend([
            {"role_id": 1, "kind": related[1], "sender": None,
             "source": _source_span(message, source.spans["related"])},
        ])
        if source.rule_id == "KIN_LEND_BA_H1":
            roles: dict[str, int | None] = {key: None for key in role_slots}
            roles.update(agent=1, recipient=0, object=2, property_owner=1)
            result["atoms"] = [{
                "atom_id": 0, "predicate": "lend", "phase": "completed", "roles": roles,
                "source": _source_span(message, source.spans["action"]),
                "candidate": _text_span(fact.text, candidate.spans["action"]),
            }]
            result["qualifiers"] = []
            if source.values["polarity"] is False:
                result["qualifiers"].append({
                    "qualifier_id": 0, "kind": "polarity", "atom_id": 0,
                    "slot": "predicate", "value_sha256": _digest(_json(False)),
                    "source": _source_span(message, source.spans["negative"]),
                    "candidate": _text_span(fact.text, candidate.spans["negative"]),
                })
            if source.values["time"] is not None:
                result["qualifiers"].append({
                    "qualifier_id": len(result["qualifiers"]), "kind": "time", "atom_id": 0,
                    "slot": "event_time", "value_sha256": _digest(_json({"event_time": source.values["time"]})),
                    "source": _source_span(message, source.spans["time"]),
                    "candidate": _text_span(fact.text, candidate.spans["time"]),
                })
        result["rules"].append({"rule_id": "SOURCE_IDENTITY_H1", "rule_version": 1})
        result["reference_bindings"].append({
            "role_id": 1, "method": "source_identity",
            "mention": _source_span(message, source.spans["pronoun"]),
            "target": _source_span(message, source.spans["identity_role"]),
            "binding": _source_span(message, source.spans["identity"]),
        })
        if source.rule_id == "REQUEST_ROLE_H1":
            outer_roles: dict[str, int | None] = {key: None for key in role_slots}
            outer_roles.update(agent=1, recipient=0)
            inner_roles: dict[str, int | None] = {key: None for key in role_slots}
            inner_roles.update(actor=0, beneficiary=1)
            result["atoms"] = [
                {"atom_id": 0, "predicate": "request" if candidate.frame == "quoted_request_h" else "receive_request",
                 "phase": "historical", "roles": outer_roles,
                 "source": _source_span(message, source.spans["action"]),
                 "candidate": _text_span(fact.text, candidate.whole)},
                {"atom_id": 1, "predicate": "cover_shift", "phase": "requested", "roles": inner_roles,
                 "source": _source_span(message, source.spans["inner"]),
                 "candidate": _text_span(fact.text, candidate.spans["inner"])},
            ]
            result["qualifiers"] = [{
                "qualifier_id": 0, "kind": "time", "atom_id": 1, "slot": "requested_time",
                "value_sha256": _digest(_json({"requested_time": source.values["time"]})),
                "source": _source_span(message, source.spans["time"]),
                "candidate": _text_span(fact.text, candidate.spans["time"]),
            }]
    if source.rule_id == "KIN_LEND_BA_H1":
        result["roles"].append({
            "role_id": 2, "kind": source.values["object"], "sender": None,
            "source": _source_span(message, source.spans["object"]),
        })
    if source.rule_id == "COND_PLAN_RUN_V1":
        empty_roles = {key: None for key in role_slots}
        result["atoms"] = [
            {"atom_id": 0, "predicate": "clear_weather", "phase": "condition", "roles": empty_roles,
             "source": _source_span(message, source.spans["condition"]),
             "candidate": _text_span(fact.text, candidate.spans["condition"])},
            {"atom_id": 1, "predicate": "run", "phase": "planned", "roles": role_slots,
             "source": _source_span(message, source.spans["action"]),
             "candidate": _text_span(fact.text, candidate.spans["action"])},
        ]
        result["qualifiers"] = [{
            "qualifier_id": 0, "kind": "quantity", "atom_id": 1, "slot": "distance",
            "value_sha256": _digest(_json(source.values["distance"])),
            "source": _source_span(message, source.spans["distance"]),
            "candidate": _text_span(fact.text, candidate.spans["distance"]),
        }]
        for modifier in ("only", "approx"):
            if source.values[modifier]:
                result["qualifiers"].append({
                    "qualifier_id": len(result["qualifiers"]), "kind": "degree",
                    "quantity_qualifier_id": 0, "modifier": modifier,
                    "value_sha256": _digest(_json({"modifier": modifier, "distance": source.values["distance"]})),
                    "source": _source_span(message, source.spans[modifier]),
                    "candidate": _text_span(fact.text, candidate.spans[modifier]),
                })
        result["qualifiers"].extend([
            {"qualifier_id": len(result["qualifiers"]), "kind": "condition",
             "condition_atom_id": 0, "action_atom_id": 1, "relation": "requires",
             "source": _source_span(message, source.spans["condition"]),
             "candidate": _text_span(fact.text, candidate.spans["condition"])},
            {"qualifier_id": len(result["qualifiers"]) + 1, "kind": "time", "atom_id": 1,
             "slot": "event_time", "value_sha256": _digest(_json({"event_time": source.values["time"]})),
             "source": _source_span(message, source.spans["time"]),
             "candidate": _text_span(fact.text, candidate.spans["time"])},
        ])
    return result


def unresolved_author_quote_note(
    window: ExtractionWindow, text: str, source_message_ids: tuple[UUID, ...],
) -> str | None:
    """仅说明完整引句中原语法明确缺失的角色，不生成可信来源或正向依据。"""

    if len(window.messages) != 1 or len(window.target_message_id_set) != 1:
        return None
    message = window.messages[0]
    if (
        message.message_id not in window.target_message_id_set
        or source_message_ids != (message.message_id,)
        or len(message.text) > MAX_TEXT_LENGTH or len(text) > MAX_TEXT_LENGTH
    ):
        return None
    author = "用户" if message.sender.value == "self" else "联系人"
    if text != author + "原话：“" + message.text + "”":
        return None
    source = (_lend(message.text, message.sender.value, source=True)
              or _request(message.text, message.sender.value, source=True))
    if source is not None:
        if "property_owner" in source.values and source.values["property_owner"] is None:
            return "原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。"
        if "beneficiary" in source.values and source.values["beneficiary"] is None:
            return "原句中顶班事项的受益人在本窗口无法唯一确定；不因提出请托认定受益人，不补接受或履行，保留原句。"
    return None


def unresolved_author_quote_reason(window: ExtractionWindow, fact: ExtractedFact) -> str | None:
    """V沿原接口复用同一负向识别，不改写候选或授予正向信用。"""
    if unresolved_author_quote_note(window, fact.text, fact.source_message_ids) is not None:
        return "missing_source_identity"
    return None


def verify_proposal(
    proposal: ProofProposal | None, window: ExtractionWindow, fact: ExtractedFact,
    trusted_sources: Mapping[UUID, str] | None = None,
    *, proof_version: int = 1,
) -> ProofVerification:
    """独立解析完整源与候选，只核有界规则，不增加读取或写入副作用。"""

    if type(proof_version) is not int or proof_version not in {1, 2, 3} or (
        proposal is not None and proposal.version != proof_version
    ):
        raise ValueError("来源证明与显式协议版本不一致。")
    if proof_version == 3:
        from .bounded_proof import validate_proposal_shape, verify
        if proposal is not None:
            validate_proposal_shape(None, proposal)
        _validate_positions(proposal, window, fact)
        return verify(proposal, window, fact, trusted_sources)
    _validate_positions(proposal, window, fact)
    message, reason = _trusted_message(window, fact, trusted_sources)
    if message is None:
        return ProofVerification("UNKNOWN", reason)
    source = (_arrival(message.text, message.sender.value, source=True) if proof_version == 2
              else _parse_text(message.text, message.sender.value, source=True))
    candidate = (_author_quote(fact.text, message.text) if proof_version == 2
                 else _parse_text(fact.text, message.sender.value, source=False))
    if source is None or candidate is None:
        return ProofVerification("UNKNOWN", "unsupported_grammar")
    if source.rule_id == candidate.rule_id and "diagnostic" in candidate.values:
        return ProofVerification("unsupported", candidate.values["diagnostic"])
    source = _align_frame(source, candidate)
    if source.rule_id != candidate.rule_id or any(
        not (key in {"property_owner", "beneficiary"} and value is None)
        and value != candidate.values.get(key)
        for key, value in source.values.items()
    ):
        return ProofVerification("unsupported", "known_graph_difference")
    if any(value is None for key, value in source.values.items() if key in {"property_owner", "beneficiary"}):
        return ProofVerification("UNKNOWN", "missing_source_identity")
    if not _pragmatics_match(fact, candidate) or (
        proof_version == 2 and fact.category is not MemoryCategory.COMMON_FACT
    ):
        return ProofVerification("UNKNOWN", "pragmatics_not_supported")
    if proposal is None:
        return ProofVerification("UNKNOWN", "missing_proof")
    if not _proposal_matches(proposal, source, candidate, message, fact):
        return ProofVerification("UNKNOWN", "proposal_not_matching")
    build = _author_quote_basis if proof_version == 2 else _basis
    return ProofVerification("verified", "verified", _json(build(source, candidate, message, fact)))


def reverify_basis(
    basis: Mapping[str, object], window: ExtractionWindow, fact: ExtractedFact,
    trusted_sources: Mapping[UUID, str] | None = None,
) -> ProofVerification:
    """保存及确认时重解析当前全文，完整关系和定位均须与已存依据相等。"""

    if type(basis.get("version")) is int and basis.get("version") == 3:
        from .bounded_proof import reverify
        return reverify(basis, window, fact, trusted_sources)
    message, reason = _trusted_message(window, fact, trusted_sources)
    if message is None:
        return ProofVerification("UNKNOWN", reason)
    version = basis.get("version")
    if type(version) is not int or version not in {1, 2, 3}:
        return ProofVerification("UNKNOWN", "basis_mismatch")
    source = (_arrival(message.text, message.sender.value, source=True) if version == 2
              else _parse_text(message.text, message.sender.value, source=True))
    candidate = (_author_quote(fact.text, message.text) if version == 2
                 else _parse_text(fact.text, message.sender.value, source=False))
    if source is not None and candidate is not None:
        source = _align_frame(source, candidate)
    if (
        source is None or candidate is None or source.rule_id != candidate.rule_id
        or source.values != candidate.values or not _pragmatics_match(fact, candidate)
        or (version == 2 and fact.category is not MemoryCategory.COMMON_FACT)
        or any(source.values.get(key) is None for key in ("property_owner", "beneficiary") if key in source.values)
    ):
        return ProofVerification("UNKNOWN", "basis_mismatch")
    build = _author_quote_basis if version == 2 else _basis
    expected = build(source, candidate, message, fact)
    try:
        # JSON规范比较保留bool/int、float/int差别，不让Python宽松相等绕过合同。
        if _json(dict(basis)) != _json(expected):
            return ProofVerification("UNKNOWN", "basis_mismatch")
    except (ValueError, TypeError):
        return ProofVerification("UNKNOWN", "basis_mismatch")
    return ProofVerification("verified", "verified", _json(expected))
