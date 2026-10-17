"""原03纯协议切片：实际E2编译与同次V；不认证模型或存储。"""
from dataclasses import replace
from pathlib import Path
import unittest
import json
from copy import copy, deepcopy
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded import compile_labels, source_units
from notalone.memory_extraction.source_proof import parse_proposal, verify_proposal
from notalone.memory_extraction.verification import validate_source_verification
from notalone.memory_extraction.evidence import build_dimension_evidence
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.test_source_proof import window_for as old_window_for


def window_for(text):
    window = old_window_for(text)
    message = window.messages[0]
    snapshots = tuple({**row, "raw_payload": {**row["raw_payload"], "time_iso": message.occurred_at.isoformat()}} for row in message.source_snapshots)
    return replace(window, messages=(replace(message, source_snapshots=snapshots),), target_message_ids=(message.message_id,))


def compiled_fact(window, *, kind="event", dependency=None, main_id=None, condition=False):
    main_id = main_id or next(unit.id for unit in source_units(window) if unit.target)
    rows = {unit.id: {"kind": kind if unit.id == main_id else "condition" if condition else "not_memory",
        "subject": unit.message.sender.value, "topic": "other",
        "dependency": dependency if unit.id == main_id else None, "unresolved": False, "confidence": .92, "sensitivity": "none"}
        for unit in source_units(window) if unit.target}
    payloads = compile_labels(window, {"units": rows})
    return ExtractionFlow(runtime=RecordingRuntime(payloads)).run(window).accepted[0]


def messages_window(texts, *, senders=None, all_targets=False):
    from notalone.memory_extraction.models import MessageSender
    base = window_for(texts[0])
    messages = tuple(replace(base.messages[0], message_id=uuid4(), text=text,
        sender=MessageSender(senders[index]) if senders else base.messages[0].sender) for index, text in enumerate(texts))
    return replace(base, messages=messages, target_message_ids=tuple(item.message_id for item in messages) if all_targets else (messages[-1].message_id,))


def expected_proposal(window, fact, rule, variant, *, question=False, request=False, condition=False):
    """由公开产生式独立定位提案，不读取证明器输出。"""
    message = window.messages[-1]
    event_unit = next(unit for unit in source_units(window) if unit.message == message and "这里的“" not in unit.text)
    quote_start = fact.text.index("原话：“") + len("原话：“")
    main_text = event_unit.text
    if condition:
        main_text = message.text
    def span(msg, start, end):
        return {"message_id": str(msg.message_id), "start": start, "end": end}
    def source(start, end):
        return span(message, start, end)
    def target(start, end):
        return {"start": quote_start + start - event_unit.start, "end": quote_start + end - event_unit.start}
    main_source = source(0 if condition else event_unit.start, len(message.text) if condition else event_unit.end)
    main_candidate = {"start": quote_start, "end": quote_start + len(main_text)}
    atom_ranges = [(main_source, main_candidate)]
    if condition:
        comma = message.text.index("，") + 1
        atom_ranges = [(source(0, comma), {"start": quote_start, "end": quote_start + comma}),
                       (source(comma, len(message.text)), {"start": quote_start + comma, "end": quote_start + len(message.text)})]
    if request:
        start = message.text.index("让我") + 1
        end = event_unit.end - (1 if event_unit.text.endswith("。") else 0)
        atom_ranges.append((source(start, end), target(start, end)))
    author_start = (message.text.index("我") if rule in {"BR_AUTHOR_ARRIVAL_V1", "BR_COND_RUN_V1"}
                    else message.text.index("让我") + 1 if request else event_unit.start + event_unit.text.rindex("我") if not question
                    else event_unit.start if event_unit.text.startswith("我") else -1)
    author = source(author_start, author_start + 1) if author_start >= 0 else source(0, len(message.text))
    references = [{"rule_id": rule, "mention": author, "target": author, "binding": None}]
    if question:
        q = window.messages[0]
        verb = next(token for token in ("到达", "抵达", "到") if token in message.text)
        d_start = q.text.index(verb) + len(verb)
        references.append({"rule_id": rule, "mention": source(message.text.index(verb), message.text.index(verb) + len(verb)),
            "target": span(q, d_start, q.text.index("了吗")), "binding": span(q, 0, len(q.text))})
    if rule in {"BR_KIN_LEND_V1", "BR_TWO_ROLES_V1", "BR_REQUEST_V1"}:
        identity = next(item for item in window.messages if "这里的“" in item.text)
        start = identity.text.index("这里的“")
        role_start = identity.text.index("指", start) + 1
        end = identity.text.index("。", role_start) + 1 if "。" in identity.text[role_start:] else len(identity.text)
        pronoun = identity.text[start + 4]
        mention = event_unit.start + event_unit.text.index(pronoun)
        role_end = role_start + (3 if identity.text.startswith("我同事", role_start) else 2)
        references.append({"rule_id": rule, "mention": source(mention, mention + 1), "target": span(identity, role_start, role_end),
            "binding": span(identity, start, end)})
    frame = "received_request" if variant.startswith("received") else "reported_request" if request else "direct"
    return {"version": 3, "atom_links": [{"rule_id": rule, "variant_id": variant, "source": first, "candidate": second} for first, second in atom_ranges],
        "reference": references, "reported": [{"rule_id": rule, "frame": frame, "source": main_source, "candidate": main_candidate}]}


def arrival_payload(window, fact):
    message = window.messages[0]
    rule = "BR_AUTHOR_ARRIVAL_V1"
    source = {"message_id": str(message.message_id), "start": 0, "end": len(message.text)}
    candidate = {"start": fact.text.index("我"), "end": fact.text.rindex("”")}
    anchor = {**source, "start": 0, "end": 1}
    return {"version": 3, "atom_links": [{"rule_id": rule, "variant_id": "direct_quote",
        "source": source, "candidate": candidate}],
        "reference": [{"rule_id": rule, "mention": anchor, "target": anchor, "binding": None}],
        "reported": [{"rule_id": rule, "frame": "direct", "source": source, "candidate": candidate}]}


class BoundedRuntimeProofTest(unittest.TestCase):
    def setUp(self):
        import notalone.memory_extraction.source_proof as loaded
        self.assertEqual(Path(loaded.__file__).resolve(), Path(__file__).resolve().parents[3] / "src/notalone/memory_extraction/source_proof.py")

    def test_proof3_requires_actual_explicit_targets_without_defaulting_context_to_target(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.source_proof import reverify_basis, validate_bounded_body_sources
        self.assertIsNone(old_window_for("我刚到家。").target_message_ids)
        cases = (
            (window_for("我刚到家。"), "event", None, "BR_AUTHOR_ARRIVAL_V1", "direct_quote"),
            (messages_window(("这里的“她”指我哥。", "我姐昨天把她的书借给我了。")),
                "relationship_event", "0:0", "BR_KIN_LEND_V1", "completed_cross"),
        )
        for window, kind, dependency, rule, variant in cases:
            with self.subTest(messages=len(window.messages)):
                fact = replace(compiled_fact(window, kind=kind, dependency=dependency), source_dependency_mode=SourceDependencyMode.ALL)
                proof = parse_proposal(expected_proposal(window, fact, rule, variant), version=3)
                checked = verify_proposal(proof, window, fact, proof_version=3)
                self.assertEqual(checked.status, "verified")
                self.assertEqual(window.target_message_ids, (window.messages[-1].message_id,))
                for targets in (None, (), window.target_message_ids * 2, (uuid4(),), tuple(reversed(tuple(row.message_id for row in window.messages))) if len(window.messages) > 1 else []):
                    with self.subTest(targets=targets):
                        invalid = copy(window)
                        # 仅负控模拟不可信调用方绕过dataclass构造，其他输入逐字段不变。
                        object.__setattr__(invalid, "target_message_ids", targets)
                        with self.assertRaises(ValueError):
                            validate_bounded_body_sources(invalid, fact)
                        for proposal in (None, proof):
                            with self.assertRaises(ValueError):
                                verify_proposal(proposal, invalid, fact, proof_version=3)
                        with self.assertRaises(ValueError):
                            reverify_basis(checked.semantic_basis, invalid, fact)
                        with self.assertRaises(ValueError):
                            build_dimension_evidence(invalid, fact, None, verification_mode="nullable-proof-v3")

    def test_actual_compiler_v3_proposal_producer_and_rebinding_keep_target_and_capabilities(self):
        from notalone.memory.dimension_evidence import DimensionEvidence
        window = window_for("我刚刚到家。")
        fact = compiled_fact(window)
        from notalone.memory import SourceDependencyMode
        fact = replace(fact, source_dependency_mode=SourceDependencyMode.ALL)
        proof = arrival_payload(window, fact)
        parsed = parse_proposal(proof, version=3)
        checked = verify_proposal(parsed, window, fact, proof_version=3)
        self.assertEqual(checked.status, "verified")
        result, = validate_source_verification(({"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}],
            "proof": proof},), window=window, facts=(fact,), mode="nullable-proof-v3")
        evidence = build_dimension_evidence(window, fact, result)
        self.assertEqual(evidence.version, 4)
        self.assertTrue(evidence.source_bound)
        self.assertEqual(evidence.to_payload()["target_message_ids"], [str(window.messages[0].message_id)])
        self.assertEqual(evidence.semantic_basis.to_payload()["capabilities"], ["subject_binding", "event_preservation",
            "reference_resolution", "direct_attribution", "temporal_preservation"])
        self.assertFalse(DimensionEvidence.from_payload(evidence.to_payload()).source_bound)
        self.assertEqual(fact.text, "联系人原话：“我刚刚到家。”")

    def test_v4_binding_recovers_offset_from_current_source_not_saved_evidence(self):
        from datetime import datetime, timezone
        from notalone.memory import SourceDependencyMode
        from notalone.memory.evidence_binding import bind_dimension_evidence, window_digest
        window = window_for("我刚到家。")
        message = window.messages[0]
        original = datetime.fromisoformat("2026-01-02T00:30:00+08:00")
        snapshots = tuple({**row, "raw_payload": {**row["raw_payload"], "time_iso": original.isoformat()}} for row in message.source_snapshots)
        window = replace(window, messages=(replace(message, occurred_at=original, source_snapshots=snapshots),))
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        result, = validate_source_verification(({"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(message.message_id), "quote": message.text}], "proof": arrival_payload(window, fact)},),
            window=window, facts=(fact,), mode="nullable-proof-v3")
        evidence = build_dimension_evidence(window, fact, result)
        current = (replace(evidence.messages[0], occurred_at=original.astimezone(timezone.utc)),)
        bound = bind_dimension_evidence(evidence, scope=evidence.scope, candidate=fact, messages=current,
            texts={message.message_id: message.text}, source_snapshots={message.message_id: snapshots})
        self.assertTrue(bound.source_bound)
        wrong_messages = (replace(evidence.messages[0], occurred_at=original.astimezone(timezone.utc)),)
        forged = replace(evidence, messages=wrong_messages,
            window_sha256=window_digest(evidence.scope, wrong_messages, version=4, target_message_ids=evidence.target_message_ids))
        self.assertFalse(bind_dimension_evidence(forged, scope=evidence.scope, candidate=fact, messages=current,
            texts={message.message_id: message.text}, source_snapshots={message.message_id: snapshots}).source_bound)

    def test_basis_shape_rejects_broken_order_frame_and_representation_closure(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory.dimension_evidence import SemanticBasis
        window = window_for("如果天晴，我计划明天只跑约3公里。")
        fact = replace(compiled_fact(window, kind="plan", main_id="0:1", condition=True), source_dependency_mode=SourceDependencyMode.ALL)
        proposal = expected_proposal(window, fact, "BR_COND_RUN_V1", "conditional_plan", condition=True)
        basis = verify_proposal(parse_proposal(proposal, version=3), window, fact, proof_version=3).semantic_basis
        changes = (
            lambda row: row.update(frame="reported_request"),
            lambda row: row["atoms"].reverse(),
            lambda row: row["qualifiers"].reverse(),
            lambda row: row["representation"]["quote_sources"].reverse(),
            lambda row: row["representation"]["whole"].update(start=1),
            lambda row: row["roles"][0]["source"].update(message_id=str(uuid4())),
            lambda row: row["roles"][0]["candidate"].update(end=4096),
        )
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                raw = deepcopy(basis)
                change(raw)
                with self.assertRaises((ValueError, TypeError)):
                    SemanticBasis.from_payload(raw)

    def test_oversize_keeps_whole_snapshot_none_but_invalid_proof_still_stops_batch(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        windows = (messages_window(("背景甲。", "背景乙。", "背景丙。", "背景丁。", "我刚到家。")),
                   window_for("我刚到家。" + " " * 4092), window_for("我" + "合成" * 2050 + "。"))
        for window in windows:
            with self.subTest(length=len(window.messages[-1].text), count=len(window.messages)):
                fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
                proposal = expected_proposal(window, fact, "BR_AUTHOR_ARRIVAL_V1", "direct_quote")
                # 超长原句的合法位置只提短片段；不能以其冒充完整正向覆盖。
                if len(window.messages[-1].text) > 4096:
                    for row in (*proposal["atom_links"], *proposal["reported"]):
                        row["source"]["end"] = min(row["source"]["end"], 5)
                        row["candidate"]["end"] = row["candidate"]["start"] + 1
                base = {"candidate_index": 0, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": str(window.messages[-1].message_id), "quote": window.messages[-1].text}]}
                for proof in (None, proposal):
                    result, = validate_source_verification(({**base, "proof": proof},), window=window, facts=(fact,), mode="nullable-proof-v3")
                    self.assertEqual(result.proof_verification.status, "UNKNOWN")
                    self.assertIsNone(build_dimension_evidence(window, fact, result))
                changes = (lambda p: p["atom_links"][0]["source"].update(message_id=str(uuid4())),
                    lambda p: p["atom_links"][0]["source"].update(start=True),
                    lambda p: p["atom_links"].append(deepcopy(p["atom_links"][0])),
                    lambda p: p.update(version=2),
                    lambda p: p["reference"][0]["mention"].update(end=4097))
                for change in changes:
                    invalid = deepcopy(proposal)
                    change(invalid)
                    with self.assertRaises(ExtractionInvalidOutputError):
                        validate_source_verification(({**base, "proof": invalid},), window=window, facts=(fact,), mode="nullable-proof-v3")

    def test_supported_model_never_upgrades_unknown_or_unsupported_and_all_never_falls_back(self):
        from notalone.memory import FactSubject, SourceDependencyMode
        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        base = {"candidate_index": 0, "verdict": "uncertain", "issues": ["insufficient_evidence"],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}], "proof": arrival_payload(window, fact)}
        result, = validate_source_verification((base,), window=window, facts=(fact,), mode="nullable-proof-v3")
        self.assertEqual(result.verdict.value, "uncertain")
        self.assertIsNone(build_dimension_evidence(window, fact, result).semantic_basis)
        wrong = replace(fact, subject=FactSubject.SELF)
        result, = validate_source_verification(({**base, "verdict": "supported", "issues": []},), window=window, facts=(wrong,), mode="nullable-proof-v3")
        self.assertEqual(result.verdict.value, "unsupported")
        unknown = build_dimension_evidence(window, fact, None, verification_mode="nullable-proof-v3")
        self.assertEqual(unknown.version, 4)
        self.assertTrue(unknown.source_bound)
        self.assertIsNone(unknown.semantic_basis)
        for bad in (replace(fact, text=fact.text + "新增主张。"), replace(fact, source_message_ids=(uuid4(),))):
            with self.assertRaises(ValueError):
                build_dimension_evidence(window, bad, None, verification_mode="nullable-proof-v3")
        with self.assertRaises(ValueError):
            build_dimension_evidence(window, fact, None)
        with self.assertRaises(ValueError):
            build_dimension_evidence(window, replace(fact, source_dependency_mode=SourceDependencyMode.ANY), None, verification_mode="nullable-proof-v3")

    def test_parseable_candidate_graph_difference_is_explicit_unsupported(self):
        from notalone.memory import SourceDependencyMode
        window = messages_window(("这里的“她”指我哥。", "我姐昨天没有把她的车借给我。"))
        fact = replace(compiled_fact(window, kind="relationship_event", dependency="0:0"), source_dependency_mode=SourceDependencyMode.ALL)
        for text in (fact.text.replace("没有把", "把").replace("借给我。", "借给我了。"),
                     fact.text.replace("昨天", "前天"), fact.text.replace("她的车", "她的书")):
            with self.subTest(text=text):
                checked = verify_proposal(None, window, replace(fact, text=text), proof_version=3)
                self.assertEqual(checked.status, "unsupported")

    def test_parameter_variants_compile_produce_roundtrip_and_rebind_all_six_classes(self):
        from itertools import product
        from notalone.memory import SourceDependencyMode
        from notalone.memory.dimension_evidence import DimensionEvidence
        from notalone.memory.evidence_binding import bind_dimension_evidence
        cases = []
        for sender, punctuation, time in product(("self", "contact"), ("", "。"), ("刚", "刚刚")):
            cases.append(((f"我{time}到家{punctuation}",), {"senders": (sender,)}, "event", None, None, "BR_AUTHOR_ARRIVAL_V1", "direct_quote", {}))
        for sender, obj, negative, layout in product(("self", "contact"), ("车", "书", "雨伞"), (False, True), ("before", "after", "cross")):
            event = f"我哥前天{'没' if negative else ''}把他的{obj}借给我{'' if negative else '了'}。"
            identity = "这里的“他”指我姐。"
            texts = (identity, event) if layout == "cross" else (identity + event,) if layout == "before" else (event + identity,)
            dep = "0:0" if layout in {"before", "cross"} else "0:1"
            main = "0:1" if layout == "before" else None
            cases.append((texts, {"senders": (sender,) * len(texts)}, "relationship_event", dep, main,
                "BR_KIN_LEND_V1", ("negative" if negative else "completed") + ("_cross" if layout == "cross" else "_inline"), {}))
        for verb, destination, punctuation in product(("到", "到达", "抵达"), ("家", "公司", "学校", "机场", "车站"), ("?", "？")):
            cases.append(((f"你已{verb}{destination}了吗{punctuation}", f"我已经{verb}了"), {"senders": ("contact", "self")},
                "state", "0:0", None, "BR_COMPLETED_QA_V1", "completed_answer", {"question": True}))
        for kind, time, person, pronoun in product(("reported_event", "relationship_event"), ("周末", "明天", "后天"), ("我姐", "我哥", "我同事"), ("她", "他")):
            cases.append(((f"{person}昨天让我{time}帮{pronoun}顶个班。这里的“{pronoun}”指我同事。",), {}, kind,
                "0:1", "0:0", "BR_REQUEST_V1", "reported_inline" if kind == "reported_event" else "received_inline", {"request": True}))
        for day, only, approx, number, unit in product(("明天", "后天"), ("", "只"), ("", "约"), ("1", "2.500", "100000"), ("米", "公里")):
            cases.append(((f"如果天晴，我计划{day}{only}跑{approx}{number}{unit}。",), {}, "plan", None, "0:1",
                "BR_COND_RUN_V1", "conditional_plan", {"condition": True}))
        for texts, options, kind, dependency, main_id, rule, variant, flags in cases:
            with self.subTest(texts=texts, kind=kind):
                window = messages_window(texts, **options)
                fact = replace(compiled_fact(window, kind=kind, dependency=dependency, main_id=main_id, condition=flags.get("condition", False)), source_dependency_mode=SourceDependencyMode.ALL)
                proof = expected_proposal(window, fact, rule, variant, **flags)
                # 提案顺序不决定服务端原子/角色的规范编号。
                proof["atom_links"].reverse()
                proof["reference"].reverse()
                result, = validate_source_verification(({"candidate_index": 0, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": str(window.messages[-1].message_id), "quote": window.messages[-1].text}], "proof": proof},),
                    window=window, facts=(fact,), mode="nullable-proof-v3")
                self.assertEqual(result.proof_verification.status, "verified", result.proof_verification.reason)
                evidence = build_dimension_evidence(window, fact, result)
                restored = DimensionEvidence.from_payload(evidence.to_payload())
                self.assertFalse(restored.source_bound)
                self.assertTrue(bind_dimension_evidence(restored, scope=evidence.scope, candidate=fact, messages=evidence.messages,
                    texts={row.message_id: row.text for row in window.messages}, source_snapshots={row.message_id: row.source_snapshots for row in window.messages}).source_bound)

    def test_individual_capabilities_do_not_grant_missing_dimension_and_version_pairing_stays_explicit(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory.dimension_evidence import SemanticBasis
        from notalone.memory.evidence_binding import bind_dimension_evidence
        from notalone.memory_extraction.dimensions import valid_evidence_dimensions, required_dimensions
        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        result, = validate_source_verification(({"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}], "proof": arrival_payload(window, fact)},),
            window=window, facts=(fact,), mode="nullable-proof-v3")
        evidence = build_dimension_evidence(window, fact, result)
        raw = evidence.semantic_basis.to_payload()
        raw["capabilities"].remove("event_preservation")
        reduced = replace(evidence, semantic_basis=SemanticBasis.from_payload(raw))
        rebound = bind_dimension_evidence(reduced, scope=evidence.scope, candidate=fact, messages=evidence.messages,
            texts={row.message_id: row.text for row in window.messages}, source_snapshots={row.message_id: row.source_snapshots for row in window.messages})
        self.assertTrue(rebound.source_bound)
        dims = valid_evidence_dimensions(replace(fact, dimension_evidence=rebound))
        self.assertIn("subject", dims)
        self.assertNotIn("paraphrase", dims)
        any_fact = replace(fact, source_dependency_mode=SourceDependencyMode.ANY)
        self.assertFalse(bind_dimension_evidence(evidence, scope=evidence.scope, candidate=any_fact, messages=evidence.messages,
            texts={row.message_id: row.text for row in window.messages}).source_bound)
        self.assertEqual(len(required_dimensions(replace(fact, dimension_evidence=None))), 7)

    def test_quoted_identity_change_is_explicit_negative_and_full_unknown_tail_stays_unknown(self):
        from notalone.memory import SourceDependencyMode
        window = messages_window(("这里的“她”指我哥。", "我姐昨天没有把她的车借给我。"))
        fact = replace(compiled_fact(window, kind="relationship_event", dependency="0:0"), source_dependency_mode=SourceDependencyMode.ALL)
        checked = verify_proposal(None, window, replace(fact, text=fact.text.replace("指我哥", "指我姐")), proof_version=3)
        self.assertEqual(checked.status, "unsupported")

    def test_full_window_competition_author_order_and_outside_grammar_never_gain_basis(self):
        from notalone.memory import SourceDependencyMode
        cases = (
            (("这里的“她”指我哥。", "我姐昨天没有把她的车借给我。尾句仍有独立主张。"), None),
            (("这里的“她”指我哥。这里的“她”指我姐。", "我姐昨天没有把她的车借给我。"), None),
            (("这里的“她”指我哥。", "我姐昨天没有把她的车借给我。"), ("self", "contact")),
            (("这里的“他”指我哥。", "我姐昨天没有把她的车借给我。"), None),
            (("这里的“她”指我哥。", "我姐没有把她的车借给我。"), None),
            (("这里的“她”指我哥。", "我姐昨天没有把她的车借给我了。"), None),
            (("这里的“她”指我哥。", "我姐昨天把她的车借给我。"), None),
            (("这里的“她”指我哥。", "我姐昨天没有把她的车借给我！！"), None),
            (("你已到学校了吗？", "已经抵达了。"), ("self", "contact")),
            (("你已到学校了吗？", "已经到了。"), ("contact", "contact")),
            (("这里的“她”指我哥。", " ", "我姐昨天没有把她的车借给我。"), None),
        )
        for texts, senders in cases:
            with self.subTest(texts=texts):
                window = messages_window(texts, senders=senders)
                kind = "state" if texts[0].startswith("你") else "relationship_event"
                fact = replace(compiled_fact(window, kind=kind, dependency="0:0"), source_dependency_mode=SourceDependencyMode.ALL)
                checked = verify_proposal(None, window, fact, proof_version=3)
                self.assertEqual(checked.status, "UNKNOWN")
                evidence = build_dimension_evidence(window, fact, None, verification_mode="nullable-proof-v3")
                self.assertIsNone(evidence.semantic_basis)

    def test_existing_grouped_unknown_e2_continuations_are_checked_without_expanding_positive_grammar(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.source_proof import validate_bounded_body_sources
        window = window_for("她喜欢爬山。她喜欢海边。")
        rows = {unit.id: {"kind": "third_party_fact", "subject": "contact", "topic": "other", "dependency": None,
            "unresolved": True, "confidence": .9, "sensitivity": "none"} for unit in source_units(window)}
        payloads = compile_labels(window, {"units": rows})
        fact = ExtractionFlow(runtime=RecordingRuntime(payloads)).run(window).accepted[0]
        self.assertIn(" 同一原消息续句：“", fact.text)
        self.assertEqual(validate_bounded_body_sources(window, fact), (window.messages[0].message_id,))
        fact = replace(fact, source_dependency_mode=SourceDependencyMode.ALL)
        self.assertEqual(verify_proposal(None, window, fact, proof_version=3).status, "UNKNOWN")
        self.assertIsNone(build_dimension_evidence(window, fact, None, verification_mode="nullable-proof-v3").semantic_basis)
        with self.assertRaises(ValueError):
            validate_bounded_body_sources(window, replace(fact, text=fact.text + "救命尾句。"))

    def test_context_chain_cannot_recurse_through_a_non_target_without_e2_rows(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.source_proof import validate_bounded_body_sources
        window = messages_window(("这里提到我姐和我哥。", "这里的“她”指我哥。", "我姐昨天没有把她的书借给我。"))
        fact = compiled_fact(window, kind="relationship_event", dependency="1:0")
        forged = replace(fact, source_dependency_mode=SourceDependencyMode.ALL,
            text=fact.text[:-1] + "；联系人说“这里提到我姐和我哥。”）",
            source_message_ids=tuple(item.message_id for item in window.messages))
        with self.assertRaises(ValueError):
            validate_bounded_body_sources(window, forged)

    def test_v4_shape_canonical_ids_offsets_and_basis_version_reject_only_new_contract_variants(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory.dimension_evidence import DimensionEvidence, SemanticBasis
        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        result, = validate_source_verification(({"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}], "proof": arrival_payload(window, fact)},),
            window=window, facts=(fact,), mode="nullable-proof-v3")
        evidence = build_dimension_evidence(window, fact, result)
        mutations = (lambda row: row["messages"][0].update(message_id=row["messages"][0]["message_id"].upper()),
            lambda row: row["messages"][0].update(occurred_at=row["messages"][0]["occurred_at"].replace("+00:00", "Z")),
            lambda row: row.update(target_message_ids=row["target_message_ids"] * 2),
            lambda row: row.update(version=3),
            lambda row: row["semantic_basis"].update(version=2),
            lambda row: row["messages"][0].update(source_refs=[]),
            lambda row: row["messages"][0].update(text_representation="processed_text"))
        for change in mutations:
            raw = deepcopy(evidence.to_payload())
            change(raw)
            with self.assertRaises((ValueError, TypeError)):
                DimensionEvidence.from_payload(raw)
        duplicate = json.dumps(evidence.semantic_basis.to_payload()).replace('"version": 3', '"version": 3,"version": 3')
        with self.assertRaises(ValueError):
            SemanticBasis(duplicate)

    def test_allowed_message_edge_spaces_keep_actual_offsets_and_proposal_coverage(self):
        from notalone.memory import SourceDependencyMode
        for text in (" 我刚到家。 ", "  我刚刚到家  "):
            with self.subTest(text=text):
                window = window_for(text)
                fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
                proof = expected_proposal(window, fact, "BR_AUTHOR_ARRIVAL_V1", "direct_quote")
                checked = verify_proposal(parse_proposal(proof, version=3), window, fact, proof_version=3)
                self.assertEqual(checked.status, "verified", checked.reason)
                self.assertEqual(checked.semantic_basis["roles"][0]["source"]["span"]["start"], text.index("我"))

    def test_only_original_message_edges_allow_spaces_without_repairing_internal_whitespace(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.source_proof import validate_bounded_body_sources
        event = "我姐把她的车借给我了。"
        identity = "这里的“她”指我姐。"
        for separator in (" ", "\t", "\n", "\u00a0"):
            for before in (False, True):
                text = identity + separator + event if before else event + separator + identity
                with self.subTest(separator=repr(separator), before=before):
                    window = window_for(text)
                    fact = replace(compiled_fact(window, kind="relationship_event", main_id="0:1" if before else "0:0",
                        dependency="0:0" if before else "0:1"), source_dependency_mode=SourceDependencyMode.ALL)
                    proof = parse_proposal(expected_proposal(window, fact, "BR_KIN_LEND_V1", "completed_inline"), version=3)
                    self.assertEqual(verify_proposal(proof, window, fact, proof_version=3).status, "UNKNOWN")
                    self.assertIsNone(build_dimension_evidence(window, fact, None, verification_mode="nullable-proof-v3").semantic_basis)
                    if separator == " " and not before:
                        with self.assertRaises(ValueError):
                            validate_bounded_body_sources(window, replace(fact, text=fact.text.replace("说“ ", "说“")))
        for text in (event.replace("把", " 把") + identity, event + identity.replace("指", " 指")):
            with self.subTest(internal=text):
                window = window_for(text)
                fact = replace(compiled_fact(window, kind="relationship_event", dependency="0:1"),
                    source_dependency_mode=SourceDependencyMode.ALL)
                proof = parse_proposal(expected_proposal(window, fact, "BR_KIN_LEND_V1", "completed_inline"), version=3)
                self.assertEqual(verify_proposal(proof, window, fact, proof_version=3).status, "UNKNOWN")
        cases = ((("  " + event + identity + "  ",), "0:0", "0:1", "completed_inline"),
                 (("  " + identity + event + "  ",), "0:1", "0:0", "completed_inline"),
                 (("  " + identity + "  ", "  " + event + "  "), None, "0:0", "completed_cross"))
        for texts, main_id, dependency, variant in cases:
            with self.subTest(valid=texts):
                window = messages_window(texts)
                fact = replace(compiled_fact(window, kind="relationship_event", main_id=main_id, dependency=dependency),
                    source_dependency_mode=SourceDependencyMode.ALL)
                payload = expected_proposal(window, fact, "BR_KIN_LEND_V1", variant)
                proof = parse_proposal(payload, version=3)
                checked = verify_proposal(proof, window, fact, proof_version=3)
                self.assertEqual(checked.status, "verified", checked.reason)
                atom = checked.semantic_basis["atoms"][0]
                self.assertEqual(atom["source"]["span"]["start"], window.messages[-1].text.index(event))
                result, = validate_source_verification(({"candidate_index": 0, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": str(window.messages[-1].message_id), "quote": window.messages[-1].text}], "proof": payload},),
                    window=window, facts=(fact,), mode="nullable-proof-v3")
                self.assertTrue(build_dimension_evidence(window, fact, result).source_bound)

    def test_execution_rule_hash_changes_from_pre_target_and_whitespace_fix_version(self):
        from notalone.memory_extraction.source_proof import bounded_runtime_rule_set_sha256
        self.assertNotEqual(bounded_runtime_rule_set_sha256(), "efe8ac85059c632366d1286ed80a2fc5245a41e1da67ce02088823b587d6fe2f")

    def test_plan_rebinding_verifies_original_calendar_offset_with_utcized_candidate_instants(self):
        from datetime import datetime, timezone
        from notalone.memory import SourceDependencyMode
        from notalone.memory.evidence_binding import bind_dimension_evidence
        window = window_for("如果天晴，我计划明天只跑约3公里。")
        message = window.messages[0]
        original = datetime.fromisoformat("2026-10-13T00:30:00+08:00")
        snapshots = tuple({**row, "raw_payload": {**row["raw_payload"], "time_iso": original.isoformat()}} for row in message.source_snapshots)
        window = replace(window, messages=(replace(message, occurred_at=original, source_snapshots=snapshots),))
        fact = replace(compiled_fact(window, kind="plan", main_id="0:1", condition=True), source_dependency_mode=SourceDependencyMode.ALL)
        proof = expected_proposal(window, fact, "BR_COND_RUN_V1", "conditional_plan", condition=True)
        result, = validate_source_verification(({"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(message.message_id), "quote": message.text}], "proof": proof},), window=window, facts=(fact,), mode="nullable-proof-v3")
        evidence = build_dimension_evidence(window, fact, result)
        pg_fact = replace(fact, valid_at=fact.valid_at.astimezone(timezone.utc), invalid_at=fact.invalid_at.astimezone(timezone.utc))
        current = (replace(evidence.messages[0], occurred_at=original.astimezone(timezone.utc)),)
        rebound = bind_dimension_evidence(evidence, scope=evidence.scope, candidate=pg_fact, messages=current,
            texts={message.message_id: message.text}, source_snapshots={message.message_id: snapshots})
        self.assertTrue(rebound.source_bound)

    def test_finite_cross_message_two_roles_qa_request_and_quantity_keep_independent_graphs(self):
        from notalone.memory import SourceDependencyMode
        cases = (
            (("这里的“他”指我姐。", "我哥前天把他的雨伞借给我了。"), {}, "relationship_event", "0:0", None, "BR_KIN_LEND_V1", "completed_cross", {}),
            (("这里提到我姐和我同事。", "这里的“她”指我同事。", "我姐昨天没有把她的书借给我。"), {}, "relationship_event", "1:0", None, "BR_TWO_ROLES_V1", "negative_cross", {}),
            (("你已经抵达机场了吗？", "已抵达了。"), {"senders": ("self", "contact")}, "state", "0:0", None, "BR_COMPLETED_QA_V1", "completed_answer", {"question": True}),
            (("我哥前天让我后天帮她顶个班。这里的“她”指我姐。",), {}, "reported_event", "0:1", "0:0", "BR_REQUEST_V1", "reported_inline", {"request": True}),
            (("这里的“他”指我同事。", "我姐昨天让我明天帮他顶个班。"), {}, "relationship_event", "0:0", None, "BR_REQUEST_V1", "received_cross", {"request": True}),
            (("如果天晴，我计划后天只跑约2.5公里。",), {}, "plan", None, "0:1", "BR_COND_RUN_V1", "conditional_plan", {"condition": True}),
        )
        for texts, options, kind, dep, main_id, rule, variant, flags in cases:
            with self.subTest(rule=rule, variant=variant):
                window = messages_window(texts, **options)
                fact = replace(compiled_fact(window, kind=kind, dependency=dep, main_id=main_id, condition=flags.get("condition", False)),
                    source_dependency_mode=SourceDependencyMode.ALL)
                payload = expected_proposal(window, fact, rule, variant, **flags)
                checked = verify_proposal(parse_proposal(payload, version=3), window, fact, proof_version=3)
                self.assertEqual(checked.status, "verified", checked.reason)
                basis = checked.semantic_basis
                self.assertEqual(basis["source_graph_sha256"], basis["candidate_graph_sha256"])
                self.assertEqual(basis["rules"], [{"rule_id": rule, "rule_version": 1}])


class BoundedRuntimeSdkTest(unittest.TestCase):
    def setUp(self):
        import notalone.memory_trace.transport as loaded
        self.assertEqual(Path(loaded.__file__).resolve(), Path(__file__).resolve().parents[3] / "src/notalone/memory_trace/transport.py")
        from tests.integration.memory_extraction.test_evaluation_wire_contract import EvaluationWireContractTest
        EvaluationWireContractTest.setUp(self)

    def model(self, **options):
        from tests.integration.memory_extraction.test_evaluation_wire_contract import EvaluationWireContractTest
        from notalone.memory_trace.transport import _request_hook, _response_hook
        model = EvaluationWireContractTest.model(self, **options)
        model.root_client._client.event_hooks = {"request": [_request_hook], "response": [_response_hook]}
        return model

    def test_invalid_sdk_raw_responses_are_traced_before_strict_proof3_rejection(self):
        import base64
        import httpx
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.memory_trace.adapters import InMemoryTraceStore
        from notalone.memory_trace.context import TraceSession
        from notalone.scopes import ContactScope

        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        arguments = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}],
            "proof": arrival_payload(window, fact)}]}
        for variant in ("duplicate_proof_key", "malformed_json", "two_tools"):
            with self.subTest(variant=variant):
                model = self.model(tool_name="SourceVerificationOutput", arguments=arguments)
                transport = model.root_client._client._transport
                original = transport.handler
                received = []

                def invalid(request):
                    body = original(request).json()
                    if variant == "duplicate_proof_key":
                        function = body["choices"][0]["message"]["tool_calls"][0]["function"]
                        function["arguments"] = function["arguments"].replace('"version": 3', '"version": 3,"version": 3')
                    elif variant == "two_tools":
                        body["choices"][0]["message"]["tool_calls"] *= 2
                    raw = b'{"choices":[broken' if variant == "malformed_json" else (" \n" + json.dumps(body) + "\n").encode()
                    received.append(raw)
                    return httpx.Response(200, request=request, content=raw, headers={
                        "content-type": "application/json", "x-request-id": "synthetic-invalid-response"})

                transport.handler = invalid
                scope = ContactScope(window.owner_id, window.contact_id)
                store = InMemoryTraceStore()
                trace_id = store.begin(scope, run_id=uuid4(), batch_key="synthetic-proof3-invalid", payload={})
                trace = TraceSession(store, scope, trace_id)
                before = len(self.requests)
                with trace:
                    with self.assertRaises(ExtractionInvalidOutputError):
                        LangChainSourceVerificationRuntime(model=model, verification_mode="nullable-proof-v3").verify(window=window, facts=(fact,))
                events = store.get_batch(scope, trace_id)["events"]
                responses = [event for event in events if event["stage"] == "provider_response"]
                self.assertEqual(len(responses), 1)
                self.assertEqual(base64.b64decode(responses[0]["payload"]["body_base64"]), received[0])
                self.assertEqual(responses[0]["payload"]["body_text"], received[0].decode())
                self.assertEqual(responses[0]["payload"]["request_id"], "synthetic-invalid-response")
                self.assertEqual(responses[0]["payload"]["status_code"], 200)
                observation, = trace.observations.values()
                self.assertEqual(observation.response_status, "received")
                self.assertEqual(responses[0]["call_id"], str(observation.call_id))
                self.assertFalse(any(event["stage"] == "model_response" for event in events))
                self.assertEqual(len(self.requests) - before, 1)

    def test_proof3_response_trace_write_failure_stops_before_guard_without_sdk_retry(self):
        import httpx
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.memory_trace import TraceWriteError
        from notalone.memory_trace.adapters import InMemoryTraceStore
        from notalone.memory_trace.context import TraceSession
        from notalone.scopes import ContactScope

        class FailingStore(InMemoryTraceStore):
            def append(self, *args, stage, **kwargs):
                if stage == "provider_response":
                    raise RuntimeError("合成响应追踪写入故障")
                return super().append(*args, stage=stage, **kwargs)

        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        arguments = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}], "proof": None}]}
        model = self.model(tool_name="SourceVerificationOutput", arguments=arguments)
        transport = model.root_client._client._transport
        original = transport.handler

        def invalid(request):
            response = original(request)
            return httpx.Response(200, request=request, content=response.text.replace('"arguments":', '"arguments":"{}","arguments":', 1))

        transport.handler = invalid
        scope = ContactScope(window.owner_id, window.contact_id)
        store = FailingStore()
        trace_id = store.begin(scope, run_id=uuid4(), batch_key="synthetic-proof3-trace-failure", payload={})
        trace = TraceSession(store, scope, trace_id)
        runtime = LangChainSourceVerificationRuntime(model=model, verification_mode="nullable-proof-v3")
        with self.assertRaises(TraceWriteError) as failure:
            with trace:
                runtime.verify(window=window, facts=(fact,))
        self.assertEqual(failure.exception.stage, "provider_response")
        self.assertIs(trace.failure, failure.exception)
        observation, = trace.observations.values()
        self.assertEqual(observation.response_status, "received")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(store.get_batch(scope, trace_id)["status"], "trace_failed")
        # 异常后同一客户端的新同次V可正常执行，旧上下文不泄漏。
        transport.handler = original
        runtime.verify(window=window, facts=(fact,))
        self.assertEqual(len(self.requests), 2)

    def test_sdk_without_actual_raw_json_hook_fails_closed_and_null_proof_works_with_hook(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from tests.integration.memory_extraction.test_evaluation_wire_contract import EvaluationWireContractTest
        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        arguments = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}], "proof": None}]}
        model = EvaluationWireContractTest.model(self, tool_name="SourceVerificationOutput", arguments=arguments)
        with self.assertRaises(ExtractionInvalidOutputError):
            LangChainSourceVerificationRuntime(model=model, verification_mode="nullable-proof-v3").verify(window=window, facts=(fact,))
        guarded = self.model(tool_name="SourceVerificationOutput", arguments=arguments)
        payloads = LangChainSourceVerificationRuntime(model=guarded, verification_mode="nullable-proof-v3").verify(window=window, facts=(fact,))
        result, = validate_source_verification(payloads, window=window, facts=(fact,), mode="nullable-proof-v3")
        self.assertEqual(result.proof_verification.status, "UNKNOWN")
        self.assertIsNone(build_dimension_evidence(window, fact, result).semantic_basis)
        self.assertEqual(len(self.requests), 2)

    def test_same_sdk_model_explicit_protocol_reaches_pure_v4_without_default_change(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.memory_extraction.source_proof import validate_bounded_body_sources
        window = window_for("我刚到家。")
        fact = compiled_fact(window)
        validate_bounded_body_sources(window, fact)
        fact = replace(fact, source_dependency_mode=SourceDependencyMode.ALL)
        raw = {"candidate_index": 0, "verdict": "supported", "issues": [], "evidence": [
            {"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}],
            "proof": arrival_payload(window, fact)}
        model = self.model(tool_name="SourceVerificationOutput", arguments={"results": [raw]})
        legacy = LangChainSourceVerificationRuntime(model=model)
        runtime = legacy.for_mode("nullable-proof-v3")
        self.assertEqual(len(self.requests), 0)
        self.assertEqual(legacy.verification_mode.value, "legacy-v4")
        payloads = runtime.verify(window=window, facts=(fact,))
        self.assertEqual(len(self.requests), 1)
        schema = self.requests[0][2]["tools"][0]["function"]["parameters"]
        self.assertEqual(schema["properties"]["results"]["items"]["properties"]["proof"]["properties"]["version"]["const"], 3)
        checked, = validate_source_verification(payloads, window=window, facts=(fact,), mode=runtime.verification_mode)
        evidence = build_dimension_evidence(window, fact, checked)
        self.assertTrue(evidence.source_bound)
        self.assertEqual(evidence.semantic_basis.to_payload()["version"], 3)

    def test_sdk_duplicate_json_keys_stop_instead_of_accepting_last_proof_value(self):
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        window = window_for("我刚刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        arguments = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}],
            "proof": arrival_payload(window, fact)}]}
        model = self.model(tool_name="SourceVerificationOutput", arguments=arguments)
        runtime = LangChainSourceVerificationRuntime(model=model, verification_mode="nullable-proof-v3")
        dumps = json.dumps
        duplicate = dumps(arguments).replace('"version": 3', '"version": 3, "version": 3')
        with patch.object(json, "dumps", side_effect=lambda value, *args, **kwargs: duplicate if value is arguments else dumps(value, *args, **kwargs)):
            with self.assertRaises(ExtractionInvalidOutputError):
                runtime.verify(window=window, facts=(fact,))
        self.assertEqual(len(self.requests), 1)

    def test_sdk_outer_duplicate_arguments_and_tool_ambiguity_each_stop_after_one_http(self):
        import httpx
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        arguments = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}], "proof": None}]}
        for change in ("duplicate_arguments", "two_tools", "two_choices"):
            with self.subTest(change=change):
                model = self.model(tool_name="SourceVerificationOutput", arguments=arguments)
                transport = model.root_client._client._transport
                original = transport.handler
                def mutated(request):
                    response = original(request)
                    if change == "duplicate_arguments":
                        raw = response.text.replace('"arguments":', '"arguments":"{}", "arguments":', 1)
                    else:
                        body = response.json()
                        if change == "two_tools":
                            body["choices"][0]["message"]["tool_calls"] *= 2
                        else:
                            body["choices"] *= 2
                        raw = json.dumps(body)
                    return httpx.Response(200, request=request, content=raw, headers={"content-type": "application/json"})
                transport.handler = mutated
                before = len(self.requests)
                with self.assertRaises(ExtractionInvalidOutputError):
                    LangChainSourceVerificationRuntime(model=model, verification_mode="nullable-proof-v3").verify(window=window, facts=(fact,))
                self.assertEqual(len(self.requests) - before, 1)

    def test_raw_guard_nested_concurrent_and_exception_cleanup_remain_per_invocation(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        import httpx
        from notalone.memory_trace.transport import build_trace_http_client, proof3_json_guard, Proof3JSONGuardError
        calls = []
        barrier = None
        def response(request):
            calls.append(1)
            if barrier is not None:
                barrier.wait(timeout=5)
            return httpx.Response(200, json={"choices": [{"index": 0, "message": {"tool_calls": [
                {"type": "function", "function": {"name": "SourceVerificationOutput", "arguments": '{"results":[]}'}}]}}]})
        client = self.stack.enter_context(build_trace_http_client(transport=httpx.MockTransport(response)))
        def call():
            client.post("https://synthetic.invalid/test", json={"tools": [{"function": {"name": "SourceVerificationOutput"}}]})
        with proof3_json_guard():
            call()
            with proof3_json_guard():
                call()
        with self.assertRaisesRegex(RuntimeError, "合成异常"):
            with proof3_json_guard():
                raise RuntimeError("合成异常")
        with self.assertRaises(Proof3JSONGuardError):
            with proof3_json_guard():
                pass
        with proof3_json_guard():
            call()
        # 作用域外没有proof3门禁，也不要求工具正文。
        client.post("https://synthetic.invalid/test", json={})
        barrier = Barrier(2)
        def guarded():
            with proof3_json_guard():
                call()
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: guarded(), range(2)))
        self.assertEqual(len(calls), 6)

    def test_actual_sdk_nested_concurrent_and_error_cleanup_preserve_one_http_per_v(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        import httpx
        from notalone.memory import SourceDependencyMode
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        window = window_for("我刚到家。")
        fact = replace(compiled_fact(window), source_dependency_mode=SourceDependencyMode.ALL)
        arguments = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
            "evidence": [{"message_id": str(window.messages[0].message_id), "quote": window.messages[0].text}], "proof": None}]}
        def runtime():
            model = self.model(tool_name="SourceVerificationOutput", arguments=arguments)
            return LangChainSourceVerificationRuntime(model=model, verification_mode="nullable-proof-v3"), model.root_client._client._transport
        inner, _ = runtime()
        outer, transport = runtime()
        original = transport.handler
        def nested(request):
            inner.verify(window=window, facts=(fact,))
            return original(request)
        transport.handler = nested
        outer.verify(window=window, facts=(fact,))
        self.assertEqual(len(self.requests), 2)
        concurrent, transport = runtime()
        original_parallel = transport.handler
        barrier = Barrier(2)
        def parallel(request):
            barrier.wait(timeout=5)
            return original_parallel(request)
        transport.handler = parallel
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: concurrent.verify(window=window, facts=(fact,)), range(2)))
        self.assertEqual(len(self.requests), 4)
        retry, transport = runtime()
        original_failure = transport.handler
        def invalid(request):
            response = original_failure(request)
            return httpx.Response(200, request=request, content=response.text.replace('"arguments":', '"arguments":"{}","arguments":', 1))
        transport.handler = invalid
        with self.assertRaises(ExtractionInvalidOutputError):
            retry.verify(window=window, facts=(fact,))
        transport.handler = original_failure
        retry.verify(window=window, facts=(fact,))
        self.assertEqual(len(self.requests), 6)
