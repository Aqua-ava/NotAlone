"""有限运行证明的全文解析；模型只能提出位置，不能提供图或可信状态。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import re
from typing import Any, Mapping, TYPE_CHECKING
from uuid import UUID

from notalone.memory.bounded_evidence import RULE_VARIANTS, canonical, digest
from notalone.memory.models import SourceDependencyMode
from .models import ExtractionWindow, ExtractedFact, MessageRef

if TYPE_CHECKING:
    from .source_proof import ProofProposal, ProofVerification


def validate_proposal_shape(raw: Any, proposal: ProofProposal) -> None:
    from .source_proof import AtomLink, ReferenceLink, ReportedLink
    if type(proposal.version) is not int or proposal.version != 3:
        raise ValueError("有限提案版本无效。")
    for links, kind, maximum in ((proposal.atom_links, AtomLink, 16),
            (proposal.reference, ReferenceLink, 8), (proposal.reported, ReportedLink, 8)):
        if links is not None and (not isinstance(links, tuple) or len(links) > maximum or any(not isinstance(item, kind) for item in links)):
            raise ValueError("有限提案必须使用有界受控类型。")
        for link in links or ():
            if link.rule_id not in RULE_VARIANTS:
                raise ValueError("有限提案规则无效。")
    origins = [row.source for row in proposal.atom_links or ()] + [row.source for row in proposal.reported or ()]
    origins.extend(item for row in proposal.reference or () for item in (row.mention, row.target, row.binding) if item is not None)
    targets = [row.candidate for row in proposal.atom_links or ()] + [row.candidate for row in proposal.reported or ()]
    for span in (*origins, *targets):
        if type(span.start) is not int or type(span.end) is not int or not 0 <= span.start < span.end <= 4096:
            raise ValueError("有限提案必须使用实际有界整数位置。")
    if any(not isinstance(span.message_id, UUID) for span in origins) or any(span.message_id is not None for span in targets):
        raise ValueError("有限提案来源位置种类无效。")
    if any(row.variant_id not in RULE_VARIANTS[row.rule_id] for row in proposal.atom_links or ()):
        raise ValueError("有限提案变体无效。")
    def uuid_fields(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "message_id" and (not isinstance(item, str) or str(UUID(item)) != item):
                    raise ValueError("有限证明UUID必须使用规范表示。")
                uuid_fields(item)
        elif isinstance(value, list):
            for item in value:
                uuid_fields(item)
    uuid_fields(raw)
    for links in (proposal.atom_links, proposal.reference, proposal.reported):
        if links is not None and len(set(links)) != len(links):
            raise ValueError("有限证明链接不能重复。")
    rules = {item.rule_id for links in (proposal.atom_links, proposal.reference, proposal.reported) for item in links or ()}
    if len(rules) > 1:
        raise ValueError("有限证明只能选择一个主规则。")
    variants = {item.variant_id for item in proposal.atom_links or ()}
    if len(variants) > 1:
        raise ValueError("有限证明只能选择一个变体。")
    for item in proposal.reported or ():
        if item.frame not in {"direct", "reported_request", "received_request"}:
            raise ValueError("有限提案框架无效。")
        if (item.rule_id == "BR_REQUEST_V1") != (item.frame in {"reported_request", "received_request"}):
            raise ValueError("有限主规则与归属框架不符。")
        if item.rule_id == "BR_REQUEST_V1" and variants and next(iter(variants)).split("_")[0] != item.frame.split("_")[0]:
            raise ValueError("有限请托变体与归属框架不符。")


def text_span(text: str, start: int, end: int) -> dict:
    return {"start": start, "end": end, "sha256": hashlib.sha256(text[start:end].encode()).hexdigest()}


def message_span(message: MessageRef, start: int, end: int) -> dict:
    return {"message_id": str(message.message_id), "span": text_span(message.text, start, end)}


@dataclass(frozen=True)
class Unit:
    message: MessageRef
    start: int
    end: int

    @property
    def text(self) -> str:
        return self.message.text[self.start:self.end]


@dataclass(frozen=True)
class Representation:
    target: MessageRef
    main: tuple[Unit, ...]
    contexts: tuple[tuple[Unit, int, int], ...]
    quote_start: int
    quote_end: int
    author_start: int
    author: str
    observation_end: int


def units(window: ExtractionWindow) -> tuple[Unit, ...]:
    # 与现E2相同的分句定位表达式；不以分句结果认证语义。
    return tuple(Unit(message, match.start(), match.end()) for message in window.messages
        for match in re.finditer(r"[^，；;。！？!?\n]+[，；;。！？!?\n]*", message.text) if match.group().strip())


def representations(window: ExtractionWindow, fact: ExtractedFact, *, copy_main: bool = True,
                    copy_context: bool = True) -> list[Representation]:
    """枚举实际单元重建包装，保留源内引号；至多返回两解以判唯一性。"""
    all_units = units(window)
    found = []
    text = fact.text
    diagnostic_event = None
    if not copy_main:
        from .bounded_graph import parse, source_parts
        graph = parse(source_parts(window), "reported_request" if fact.speech_act.value == "report" else "received_request", source=True)
        if graph is None:
            return []
        diagnostic_event = graph.event
    for index, unit in enumerate(all_units):
        if unit.message.message_id not in window.target_message_id_set:
            continue
        members: list[tuple[Unit, ...]] = [(unit,)]
        if index + 1 < len(all_units):
            following = all_units[index + 1]
            if following.message.message_id == unit.message.message_id and following.start == unit.end:
                members.append((unit, following))
        for main in members:
            quote = "".join(member.text for member in main)
            if diagnostic_event is not None and (unit.message.message_id != diagnostic_event.message.message_id
                    or quote.strip(" ") != diagnostic_event.text):
                continue
            for author in ("用户", "联系人"):
                prefixes = [""]
                if unit.message.occurred_at is not None:
                    prefixes.append(f"截至{unit.message.occurred_at.date().isoformat()}，")
                for observation in prefixes:
                    prefix = observation + author + "原话：“"
                    if not copy_main:
                        # 只用于明确矛盾诊断；绝不从自由主句生成正向basis。
                        quotes = [text[len(prefix):end] for end in range(len(prefix), len(text))
                            if text[end] == "”"] if text.startswith(prefix) else []
                        for inner in quotes:
                            changed = text[:len(prefix)] + quote + text[len(prefix) + len(inner):]
                            from dataclasses import replace
                            for matched in representations(window, replace(fact, text=changed), copy_context=False):
                                if matched.main != main or matched.author_start != len(observation):
                                    continue
                                shift = len(inner) - len(quote)
                                found.append(Representation(matched.target, main,
                                    tuple((item, start + shift, end + shift) for item, start, end in matched.contexts),
                                    matched.quote_start, matched.quote_end + shift, matched.author_start, matched.author,
                                    matched.observation_end))
                                if len(found) >= 2:
                                    return found
                        continue
                    opening = prefix + quote + "”"
                    if not text.startswith(opening):
                        continue
                    offset = len(opening)
                    choices: list[tuple[tuple[Unit, int, int], ...]] = []
                    if offset == len(text):
                        choices.append(())
                    elif text.startswith("（相关原文：", offset):
                        def visit(cursor: int, chain: tuple[tuple[Unit, int, int], ...]) -> None:
                            if len(choices) >= 2 or len(chain) > 16:
                                return
                            if chain and text[cursor:] == "）":
                                choices.append(chain)
                                return
                            if chain:
                                if not text.startswith("；", cursor):
                                    return
                                cursor += 1
                            for context in all_units:
                                if context in main or any(row[0] == context for row in chain):
                                    continue
                                context_author = "用户" if context.message.sender.value == "self" else "联系人"
                                opening = context_author + "说“"
                                if copy_context:
                                    token = opening + context.text + "”"
                                    if text.startswith(token, cursor):
                                        visit(cursor + len(token), (*chain, (context, cursor, cursor + len(token))))
                                elif text.startswith(opening, cursor):
                                    for end in range(cursor + len(opening) + 1, len(text)):
                                        if text[end] == "”":
                                            visit(end + 1, (*chain, (context, cursor, end + 1)))
                        visit(offset + len("（相关原文："), ())
                    for chain in choices:
                        found.append(Representation(unit.message, main, chain, len(prefix), len(prefix) + len(quote),
                            len(observation), author, len(observation)))
                        if len(found) >= 2:
                            return found
    return found


def _validate_targets(window: ExtractionWindow) -> None:
    """新合同只接受实际目标声明，不借旧窗口属性默认化上下文。"""
    targets = window.target_message_ids
    ordered_ids = tuple(item.message_id for item in window.messages)
    if (not isinstance(targets, tuple) or not targets
            or any(not isinstance(item, UUID) for item in targets)
            or len(set(targets)) != len(targets)
            or len(set(ordered_ids)) != len(ordered_ids)
            or not set(targets) <= set(ordered_ids)
            or targets != tuple(item for item in ordered_ids if item in targets)):
        raise ValueError("有限运行必须显式提供非空、唯一、按窗口原序的实际目标。")


def validate_body_sources(window: ExtractionWindow, fact: ExtractedFact) -> tuple[UUID, ...]:
    """独立核正文复制及规范消息合取依赖；不产生正向语义依据。"""
    from dataclasses import replace
    from notalone.memory.evidence_binding import source_state_digest
    _validate_targets(window)
    if len(set(fact.source_message_ids)) != len(fact.source_message_ids):
        raise ValueError("有限运行正文来源集合不能重复。")
    reps = representations(window, fact)
    # 此分支仅核已有E2续句的整串复制，不扩正向Representation或有限图。
    marker = " 同一原消息续句：“"
    if not reps and marker in fact.text:
        for split in (match.start() for match in re.finditer(re.escape(marker), fact.text)):
            for rep in representations(window, replace(fact, text=fact.text[:split])):
                cursor = split
                used = {(unit.message.message_id, unit.start) for unit in rep.main}
                previous = rep.main[-1].start
                while cursor < len(fact.text):
                    matches = [unit for unit in units(window)
                        if unit.message.message_id == rep.target.message_id and unit.start > previous
                        and (unit.message.message_id, unit.start) not in used
                        and fact.text.startswith(marker + unit.text + "”", cursor)]
                    if len(matches) != 1:
                        break
                    unit = matches[0]
                    used.add((unit.message.message_id, unit.start))
                    previous = unit.start
                    cursor += len(marker + unit.text + "”")
                if cursor == len(fact.text):
                    reps.append(rep)
    if len(reps) != 1:
        raise ValueError("有限运行正文不能唯一重建实际E2包装。")
    rep = reps[0]
    author = "用户" if rep.target.sender.value == "self" else "联系人"
    if rep.author != author:
        raise ValueError("有限运行正文外层作者错误。")
    # 非target没有标签行，不能继续递归；每个主成员至多提供一条依赖链。
    breaks = sum(unit.message.message_id not in window.target_message_id_set for unit, _, _ in rep.contexts[:-1])
    if rep.contexts and breaks + 1 > len(rep.main):
        raise ValueError("有限运行上下文不能由现有依赖递归顺序生成。")
    required = {unit.message.message_id for unit in rep.main}
    required.update(unit.message.message_id for unit, _, _ in rep.contexts)
    if required != set(fact.source_message_ids):
        raise ValueError("有限运行正文的必需消息与来源集合不符。")
    if not required <= window.message_id_set:
        raise ValueError("有限运行正文来源越界。")
    if any(source_state_digest(item.source_snapshots) is None for item in window.messages if item.message_id in required):
        raise ValueError("有限运行正文缺少活动规范来源。")
    for item in window.messages:
        if item.message_id not in required:
            continue
        for row in item.source_snapshots:
            for key in ("source_ref_id", "source_id"):
                if not isinstance(row[key], str) or str(UUID(row[key])) != row[key]:
                    raise ValueError("有限运行活动来源标识无效。")
    # 旧E2解释是固定程序文案；本切片不接受自由解释暗引未引用上下文。
    if fact.interpretation_reason not in {
        "按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。",
        "原文完成问答明确表示动作已完成，程序据此保留历史动作，不设置当天失效。",
    }:
        raise ValueError("有限运行解释不属于实际E2完整表示。")
    if any(value != "原文指代在本窗口无法唯一确定，保留原句。" for value in fact.alternatives):
        raise ValueError("有限运行备选含未核定来源。")
    return tuple(item.message_id for item in window.messages if item.message_id in required)


def representation_payload(rep: Representation, window: ExtractionWindow, fact: ExtractedFact) -> dict:
    contexts = []
    for unit, start, end in rep.contexts:
        author = "用户" if unit.message.sender.value == "self" else "联系人"
        quote_start = start + len(author + "说“")
        contexts.append({"source": message_span(unit.message, unit.start, unit.end),
            "whole": text_span(fact.text, start, end), "author": text_span(fact.text, start, start + len(author)),
            "quote": text_span(fact.text, quote_start, quote_start + len(unit.text))})
    return {"version": 1, "kind": "grounded_window_quote_v1", "target_message_id": str(rep.target.message_id),
        "source_full": [message_span(message, 0, len(message.text)) for message in window.messages],
        "whole": text_span(fact.text, 0, len(fact.text)),
        "observation": {"message_id": str(rep.target.message_id), "candidate": text_span(fact.text, 0, rep.observation_end)} if rep.observation_end else None,
        "author": text_span(fact.text, rep.author_start, rep.author_start + len(rep.author)),
        "quote": text_span(fact.text, rep.quote_start, rep.quote_end),
        "quote_sources": [message_span(unit.message, unit.start, unit.end) for unit in rep.main], "contexts": contexts}


def _basis(rep: Representation, window: ExtractionWindow, fact: ExtractedFact) -> tuple[dict | None, str]:
    from .bounded_graph import source_parts, candidate_parts, parse, assemble
    frame = "reported_request" if fact.speech_act.value == "report" else "received_request"
    original = parse(source_parts(window), frame, source=True)
    candidate = parse(candidate_parts(window, fact, rep), frame, source=False)
    if original is None or candidate is None:
        return None, "unsupported_grammar"
    if original.event.message.message_id != rep.target.message_id or original.event.text != "".join(unit.text for unit in rep.main).strip(" "):
        return None, "uncovered_main_structure"
    if original.semantic() != candidate.semantic():
        return None, "known_graph_difference"
    expected = {
        "BR_AUTHOR_ARRIVAL_V1": ("common_fact", "assertion", "asserted"),
        "BR_COMPLETED_QA_V1": ("common_fact", "assertion", "asserted"),
        "BR_KIN_LEND_V1": ("relationship_note", "assertion", "asserted"),
        "BR_TWO_ROLES_V1": ("relationship_note", "assertion", "asserted"),
        "BR_REQUEST_V1": ("relationship_note", "report", "reported") if frame == "reported_request" else ("relationship_note", "assertion", "asserted"),
        "BR_COND_RUN_V1": ("recent_state", "plan", "conditional"),
    }[original.rule]
    if ((fact.category.value, fact.speech_act.value, fact.assertion_status.value) != expected
            or fact.figurative_type.value != "literal" or fact.alternatives):
        return None, "pragmatics_not_supported"
    if original.rule == "BR_COND_RUN_V1":
        time = next(item["value"] for item in original.qualifiers if item["kind"] == "time")
        interval = time["interval"]
        if fact.valid_at is None or fact.invalid_at is None:
            return None, "known_time_difference"
        # H槽沿既有时间模型比较绝对瞬间；原日历偏移由活动来源另行严格核定。
        if fact.valid_at != datetime.fromisoformat(interval["start"]) or fact.invalid_at != datetime.fromisoformat(interval["end"]):
            return None, "known_time_difference"
    elif fact.valid_at is not None or fact.invalid_at is not None:
        return None, "known_time_difference"
    return assemble(original, candidate, window, fact, rep), ""


def validate_link_domains(proposal: ProofProposal | None, rep: Representation) -> None:
    """超限前仍核实际主目标及主引句位置，不能用context冒充事件。"""
    if proposal is None:
        return
    source_start, source_end = rep.main[0].start, rep.main[-1].end
    links: list[Any] = [*(proposal.atom_links or ()), *(proposal.reported or ())]
    for link in links:
        if (link.source.message_id != rep.target.message_id or link.source.start < source_start or link.source.end > source_end
                or link.candidate.start < rep.quote_start or link.candidate.end > rep.quote_end):
            raise ValueError("有限事件提案不属于实际主目标及引句。")
    for link in proposal.reference or ():
        if link.mention.message_id != rep.target.message_id or link.mention.start < source_start or link.mention.end > source_end:
            raise ValueError("有限指称提及不属于实际主目标。")


def verify(proposal: ProofProposal | None, window: ExtractionWindow, fact: ExtractedFact,
           trusted_sources: Mapping[UUID, str] | None = None) -> ProofVerification:
    from .source_proof import ProofVerification
    from notalone.memory.evidence_binding import source_state_digest
    _validate_targets(window)
    if proposal is not None:
        if any(link.source.message_id not in window.target_message_id_set for links in (proposal.atom_links, proposal.reported) for link in links or ()):
            raise ValueError("有限事件提案必须属于实际目标。")
    reps = representations(window, fact)
    if len(reps) != 1:
        if len(window.messages) <= 4 and len(fact.text) <= 4096 and all(len(item.text) <= 4096 for item in window.messages):
            diagnoses = [_basis(rep, window, fact)[1] for rep in representations(window, fact, copy_main=False)]
            if diagnoses and all(reason == "known_graph_difference" for reason in diagnoses):
                return ProofVerification("unsupported", "known_graph_difference")
        return ProofVerification("UNKNOWN", "unsupported_representation")
    rep = reps[0]
    validate_link_domains(proposal, rep)
    if fact.source_dependency_mode is not SourceDependencyMode.ALL:
        return ProofVerification("UNKNOWN", "dependency_mode_mismatch")
    if trusted_sources is not None and dict(trusted_sources) != {item.message_id: item.text for item in window.messages}:
        return ProofVerification("UNKNOWN", "untrusted_source")
    if rep.author != ("用户" if rep.target.sender.value == "self" else "联系人") or fact.subject.value != rep.target.sender.value:
        return ProofVerification("unsupported", "known_author_difference")
    try:
        validate_body_sources(window, fact)
    except ValueError:
        return ProofVerification("UNKNOWN", "body_source_mismatch")
    if len(window.messages) > 4 or any(len(item.text) > 4096 for item in window.messages) or len(fact.text) > 4096:
        return ProofVerification("UNKNOWN", "scope_not_supported")
    if len(rep.contexts) > 4 or len(set(window.target_message_ids or ())) != len(window.target_message_ids or ()):
        return ProofVerification("UNKNOWN", "scope_not_supported")
    if any(item.message_type != "text" or item.text_representation != "text" or source_state_digest(item.source_snapshots) is None for item in window.messages):
        return ProofVerification("UNKNOWN", "untrusted_source")
    basis, reason = _basis(rep, window, fact)
    if basis is None:
        return ProofVerification("unsupported" if reason.startswith("known_") else "UNKNOWN", reason)
    if proposal is None:
        return ProofVerification("UNKNOWN", "missing_proof")
    if not proposal_matches(proposal, basis, window, fact):
        return ProofVerification("UNKNOWN", "proposal_not_matching")
    return ProofVerification("verified", "verified", canonical(basis))


def variant(basis: dict) -> str:
    rule = basis["rules"][0]["rule_id"]
    if rule == "BR_AUTHOR_ARRIVAL_V1":
        return "direct_quote"
    if rule == "BR_COMPLETED_QA_V1":
        return "completed_answer"
    if rule == "BR_COND_RUN_V1":
        return "conditional_plan"
    inline = next(item for item in basis["reference_bindings"] if item["method"] == "source_identity")["binding"]["message_id"] == basis["representation"]["target_message_id"]
    prefix = ("reported" if basis["frame"] == "reported_request" else "received") if rule == "BR_REQUEST_V1" else (
        "negative" if any(item["kind"] == "polarity" and item["value_sha256"] == digest(False) for item in basis["qualifiers"]) else "completed")
    return prefix + ("_inline" if inline else "_cross")


def whole_main(basis: dict) -> tuple[dict, dict]:
    sources = basis["representation"]["quote_sources"]
    source = {"message_id": sources[0]["message_id"], "span": {"start": sources[0]["span"]["start"], "end": sources[-1]["span"]["end"]}}
    return source, basis["representation"]["quote"]


def proposal_matches(proposal: ProofProposal, basis: dict, window: ExtractionWindow, fact: ExtractedFact) -> bool:
    def position(span) -> tuple:
        return (str(span.message_id) if span.message_id is not None else None, span.start, span.end)
    def expected(raw: dict) -> tuple:
        return (raw.get("message_id"), raw["span"]["start"], raw["span"]["end"]) if "span" in raw else (None, raw["start"], raw["end"])
    texts = {str(item.message_id): item.text for item in window.messages}
    def covers(span, raw: dict) -> bool:
        identifier, start, end = expected(raw)
        actual_id, actual_start, actual_end = position(span)
        text = texts[identifier] if identifier is not None else fact.text
        return (identifier == actual_id and actual_start <= start < end <= actual_end
            and not text[actual_start:start].strip(" ") and not text[end:actual_end].strip(" "))
    rule = basis["rules"][0]["rule_id"]
    if len(proposal.atom_links or ()) != len(basis["atoms"]) or len(proposal.reference or ()) != len(basis["reference_bindings"]) or len(proposal.reported or ()) != 1:
        return False
    remaining = list(proposal.atom_links or ())
    for atom in basis["atoms"]:
        matches = [index for index, link in enumerate(remaining) if link.rule_id == rule and link.variant_id == variant(basis)
            and covers(link.source, atom["source"]) and covers(link.candidate, atom["candidate"])]
        if len(matches) != 1:
            return False
        remaining.pop(matches[0])
    references = list(proposal.reference or ())
    for binding in basis["reference_bindings"]:
        matched = [index for index, link in enumerate(references) if link.rule_id == rule
            and covers(link.mention, binding["mention"]) and covers(link.target, binding["target"])
            and (link.binding is None and binding["binding"] is None or link.binding is not None
                and binding["binding"] is not None and covers(link.binding, binding["binding"]))]
        if len(matched) != 1:
            return False
        references.pop(matched[0])
    assert proposal.reported is not None
    reported = proposal.reported[0]
    return (reported.rule_id == rule and reported.frame == basis["frame"] and position(reported.source) == expected(whole_main(basis)[0])
            and position(reported.candidate) == expected(whole_main(basis)[1]))


def reverify(basis: Mapping[str, object], window: ExtractionWindow, fact: ExtractedFact,
             trusted_sources: Mapping[UUID, str] | None = None) -> ProofVerification:
    from .source_proof import ProofVerification
    _validate_targets(window)
    reps = representations(window, fact)
    if len(reps) != 1:
        return ProofVerification("UNKNOWN", "basis_mismatch")
    expected, _ = _basis(reps[0], window, fact)
    if expected is None:
        return ProofVerification("UNKNOWN", "basis_mismatch")
    from notalone.memory.bounded_evidence import validate_basis
    try:
        actual = validate_basis(dict(basis))
    except (TypeError, ValueError):
        return ProofVerification("UNKNOWN", "basis_mismatch")
    if any(item not in expected["capabilities"] for item in actual["capabilities"]):
        return ProofVerification("UNKNOWN", "basis_mismatch")
    expected["capabilities"] = actual["capabilities"]
    if canonical(dict(basis)) != canonical(expected):
        return ProofVerification("UNKNOWN", "basis_mismatch")
    # 重走同一纯验证路径，不能只相信保存过的摘要。
    from .source_proof import parse_proposal
    def source(raw):
        return {"message_id": raw["message_id"], "start": raw["span"]["start"], "end": raw["span"]["end"]}
    def target(raw):
        return {"start": raw["start"], "end": raw["end"]}
    rule = expected["rules"][0]["rule_id"]
    proof = {"version": 3, "atom_links": [{"rule_id": rule, "variant_id": variant(expected), "source": source(row["source"]), "candidate": target(row["candidate"])} for row in expected["atoms"]],
        "reference": [{"rule_id": rule, "mention": source(row["mention"]), "target": source(row["target"]), "binding": source(row["binding"]) if row["binding"] is not None else None} for row in expected["reference_bindings"]],
        "reported": [{"rule_id": rule, "frame": expected["frame"], "source": source(whole_main(expected)[0]), "candidate": target(whole_main(expected)[1])}]}
    checked = verify(parse_proposal(proof, version=3), window, fact, trusted_sources)
    return ProofVerification("verified", "verified", canonical(expected)) if checked.status == "verified" else checked
