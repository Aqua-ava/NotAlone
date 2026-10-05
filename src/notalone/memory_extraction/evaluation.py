"""固定合成记忆评测：主用例集加严格语义用例，不访问存储或私人资料。"""
from __future__ import annotations

import argparse
import json
import os
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from uuid import NAMESPACE_URL, uuid5

from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory_extraction.evaluation_cases import CASES, ClaimExpectation, EvaluationCase
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_extraction.pragmatics import MemoryDisposition, PragmaticInterpreter
from notalone.memory_extraction.runtime import ExtractionPayload, MemoryExtractionRuntime
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
from notalone.memory_extraction.verification import SourceVerificationRuntime

API_KEY_ENV = 'NOTALONE_EVALUATION_API_KEY'
GATE_MIN_CASES = 15
GATE_MAX_GENERAL_ERRORS = 1
ERROR_FALSE_FACT = 'false_fact'
ERROR_WRONG_SUBJECT = 'wrong_subject'
ERROR_GENERAL = 'general'
DESTINATION_ORDER = ('none', 'pending', 'auto')


@dataclass(frozen=True)
class EvaluationResult:
    name: str
    dimension: str
    expected: str
    actual: str
    passed: bool
    subject_ok: bool
    labels_ok: bool
    text_ok: bool
    validity_ok: bool
    error_kind: str | None
    expected_subject: str | None
    expected_labels: tuple[tuple[str, str], ...]
    facts: tuple[dict, ...]
    rejected_count: int
    failure_reason: str | None
    semantic_annotated: bool = False
    verification_enabled: bool = False
    claims_recalled: tuple[bool, ...] = ()
    unmatched_candidates: tuple[int, ...] = ()
    false_fact_count: int = 0
    wrong_subject_count: int = 0
    error_kinds: tuple[str, ...] = ()
    semantic_case_id: str | None = None
    destination_ok: bool = True


@dataclass(frozen=True)
class DimensionSummary:
    """一个维度的达标签计数；放行还需要用户确认，工具只给数字。

    达标签按 ADR-027 第 2 条判定：用例数 ≥ ``GATE_MIN_CASES``、假事 0、
    记错人 0、一般错误 ≤ ``GATE_MAX_GENERAL_ERRORS``。语义标注覆盖
    （``semantic_cases``／``semantic_scenarios``）保留为**单独报告字段**，
    不参与达标签判定；未标注用例不能证明语义维度达标，但也不能把达标签
    压成永假（ADR-036 的口径对齐）。
    """

    dimension: str
    cases: int
    passed: int
    false_facts: int
    wrong_subjects: int
    general_errors: int
    meets_gate: bool
    semantic_cases: int = 0
    semantic_scenarios: int = 0


def build_window(case: EvaluationCase) -> ExtractionWindow:
    """用固定合成身份与时间构造可重复窗口。"""
    base = datetime(2026, 9, 15, tzinfo=timezone.utc)
    messages = tuple(
        MessageRef(
            message_id=uuid5(NAMESPACE_URL, f'notalone-evaluation/{case.name}/{index}'),
            text=text,
            sender=MessageSender(sender),
            occurred_at=base + timedelta(minutes=index),
        )
        for index, (sender, text) in enumerate(case.messages)
    )
    return ExtractionWindow(
        owner_id=uuid5(NAMESPACE_URL, 'notalone-evaluation/owner'),
        contact_id=uuid5(NAMESPACE_URL, 'notalone-evaluation/contact'),
        messages=messages,
        target_message_ids=tuple(messages[index].message_id for index in case.targets),
    )


@dataclass
class _SyntheticBaselineRuntime:
    """只记本轮原输出已有风险，baseline 不删除模型原有的降级标记。"""

    runtime: MemoryExtractionRuntime
    originally_unverified: set[tuple[str, str, tuple[str, ...]]] = field(default_factory=set)

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        payloads = self.runtime.extract(window)
        self.originally_unverified = {
            _candidate_key(payload) for payload in payloads
            if isinstance(payload.get("risk_flags"), list)
            and "semantic:unverified" in payload["risk_flags"]
        }
        return payloads


def _candidate_key(fact: dict) -> tuple[str, str, tuple[str, ...]]:
    sources = fact.get("source_message_ids")
    source_key = tuple(str(source) for source in sources) if isinstance(sources, (list, tuple)) else ()
    return (str(fact.get("text")), str(fact.get("subject")), source_key)


def evaluate_case(
    case: EvaluationCase, window: ExtractionWindow, runtime: MemoryExtractionRuntime,
    *, verification_runtime: SourceVerificationRuntime | None = None,
    baseline: bool = False,
) -> EvaluationResult:
    """消息窗口经正式外壳、语用与风险门槛到最终去向。"""
    if baseline and verification_runtime is not None:
        raise ValueError("baseline 不能同时启用来源核验。")
    baseline_runtime = _SyntheticBaselineRuntime(runtime) if baseline else None
    outcome = ExtractionFlow(
        runtime=baseline_runtime or runtime, verification_runtime=verification_runtime,
    ).run(window)
    interpreter = PragmaticInterpreter()
    facts = []
    destinations = []
    for fact in outcome.accepted:
        if (baseline_runtime is not None
                and _candidate_key(asdict(fact)) not in baseline_runtime.originally_unverified):
            fact = replace(fact, risk_flags=tuple(
                flag for flag in fact.risk_flags if flag != "semantic:unverified"
            ))
        decision = interpreter.interpret(fact)
        # 这里只算原有三道门槛下的理想去向，作为该维度"若放行则如何"的
        # 准确率证据，不叠加运行时的维度放行门；否则未放行维度永远无法
        # 积累放行证据（ADR-036）。
        destination = 'none'
        if decision.disposition is not MemoryDisposition.NONE:
            destination = 'auto' if can_auto_adopt(fact, decision) else 'pending'
        destinations.append(destination)
        facts.append({**asdict(fact), 'destination': destination,
                      'pragmatic_disposition': decision.disposition.value,
                      'reasons': decision.reasons})
    actual = max(destinations, key=DESTINATION_ORDER.index, default='none')
    subject_ok = case.expect_subject is None or all(
        fact.subject.value == case.expect_subject for fact in outcome.accepted
    )
    labels_ok = not case.expected_labels or (
        bool(facts) and all(
            fact.get(label) == expected
            for fact in facts for label, expected in case.expected_labels
        )
    )
    text_ok = _text_matches(case, facts)
    validity_ok = _validity_matches(case, facts)
    claims_recalled: tuple[bool, ...] = ()
    unmatched_candidates: tuple[int, ...] = ()
    text_matches: tuple[tuple[int, ...], ...] = ()
    destination_ok = actual == case.expect
    if case.expected_claims is not None:
        claims = case.expected_claims
        text_matches = tuple(tuple(
            index for index, claim in enumerate(claims)
            if any(re.fullmatch(pattern, str(fact["text"]).strip())
                   for pattern in claim.text_patterns)
        ) for fact in facts)
        text_ok = all(bool(matches) for matches in text_matches)
        subject_ok = all(any(
            fact["subject"] == claims[index].subject for index in matches
        ) for fact, matches in zip(facts, text_matches))
        labels_ok = all(any(
            _claim_labels_match(claims[index], fact) for index in matches
        ) for fact, matches in zip(facts, text_matches))
        validity_ok = all(any(
            _claim_validity_matches(claims[index], fact) for index in matches
        ) for fact, matches in zip(facts, text_matches))
        complete_matches = tuple(tuple(
            index for index in matches
            if fact["subject"] == claims[index].subject
            and _claim_labels_match(claims[index], fact)
            and _claim_validity_matches(claims[index], fact)
            and fact["destination"] == claims[index].destination
        ) for fact, matches in zip(facts, text_matches))
        claims_recalled = tuple(
            any(index in matches for matches in complete_matches)
            for index in range(len(claims))
        )
        unmatched_candidates = tuple(
            index for index, matches in enumerate(complete_matches) if not matches
        )
        destination_ok = destination_ok and all(any(
            fact["destination"] == claims[index].destination for index in matches
        ) for fact, matches in zip(facts, text_matches))
    false_fact_count = sum(
        fact["destination"] == "auto" and (
            index in unmatched_candidates if case.expected_claims is not None
            else case.expect != "auto" or not _text_matches(case, [fact])
            or not _validity_matches(case, [fact])
        ) for index, fact in enumerate(facts)
    )
    wrong_subject_count = 0
    for index, candidate in enumerate(facts):
        if case.expected_claims:
            matching = text_matches[index]
            expected_subjects = {
                case.expected_claims[claim_index].subject for claim_index in matching
            } if matching else {claim.subject for claim in case.expected_claims}
            wrong_subject_count += candidate["subject"] not in expected_subjects
        elif case.expected_claims is None and case.expect_subject is not None:
            wrong_subject_count += candidate["subject"] != case.expect_subject
    if case.expected_claims is not None:
        subject_ok = wrong_subject_count == 0
    passed = (destination_ok and subject_ok and labels_ok and text_ok
              and validity_ok and all(claims_recalled)
              and outcome.failure_reason is None and outcome.rejected_count == 0)
    error_kinds = tuple(kind for kind, present in (
        (ERROR_FALSE_FACT, false_fact_count > 0),
        (ERROR_WRONG_SUBJECT, wrong_subject_count > 0),
        (ERROR_GENERAL, not passed and not false_fact_count and not wrong_subject_count),
    ) if present)
    return EvaluationResult(
        name=case.name, dimension=case.dimension, expected=case.expect,
        actual=actual, passed=passed, subject_ok=subject_ok, labels_ok=labels_ok,
        text_ok=text_ok, validity_ok=validity_ok,
        error_kind=error_kinds[0] if error_kinds else None,
        expected_subject=case.expect_subject, expected_labels=case.expected_labels,
        facts=tuple(facts), rejected_count=outcome.rejected_count,
        failure_reason=outcome.failure_reason,
        semantic_annotated=case.expected_claims is not None,
        verification_enabled=verification_runtime is not None,
        claims_recalled=claims_recalled, unmatched_candidates=unmatched_candidates,
        false_fact_count=false_fact_count, wrong_subject_count=wrong_subject_count,
        error_kinds=error_kinds, destination_ok=destination_ok,
        semantic_case_id=(str(uuid5(NAMESPACE_URL, repr((case.messages, case.targets))))
                          if case.expected_claims is not None else None),
    )


def _claim_labels_match(claim: ClaimExpectation, fact: dict) -> bool:
    return all(fact.get(label) == expected for label, expected in claim.expected_labels)


def _claim_validity_matches(claim: ClaimExpectation, fact: dict) -> bool:
    for field, expected_iso in (("valid_at", claim.valid_at_iso),
                                ("invalid_at", claim.invalid_at_iso)):
        expected = datetime.fromisoformat(expected_iso) if expected_iso else None
        if expected is not None and expected.tzinfo is None:
            raise ValueError("评测期望时间必须带时区。")
        if fact.get(field) != expected:
            return False
    return True


def _text_matches(case: EvaluationCase, facts: list[dict]) -> bool:
    """旧去向兼容检查：每条候选都需保留要求标记，不构成完整语义证明。"""
    texts = [str(fact.get('text', '')) for fact in facts]
    if any(
        forbidden in text
        for text in texts
        for forbidden in case.expect_text_excludes
    ):
        return False
    return all(
        bool(texts) and all(required in text for text in texts)
        for required in case.expect_text_contains
    )


def _validity_matches(case: EvaluationCase, facts: list[dict]) -> bool:
    """检查时间字段存在性，以及用例明确约定的带时区日期。"""
    values = {
        'valid_at': [fact.get('valid_at') for fact in facts],
        'invalid_at': [fact.get('invalid_at') for fact in facts],
    }
    for field, expectation in (
        ('valid_at', case.expect_valid_at),
        ('invalid_at', case.expect_invalid_at),
    ):
        if expectation is None:
            continue
        present = any(value is not None for value in values[field])
        if present is not expectation:
            return False
    for field, expected_iso in (
        ('valid_at', case.expect_valid_at_iso),
        ('invalid_at', case.expect_invalid_at_iso),
    ):
        if expected_iso is None:
            continue
        expected = datetime.fromisoformat(expected_iso)
        if expected.tzinfo is None:
            raise ValueError('评测期望时间必须带时区。')
        actual = values[field]
        if not actual or any(value != expected for value in actual):
            return False
    return True


def summarize(results: Sequence[EvaluationResult]) -> tuple[DimensionSummary, ...]:
    """按维度汇总达标签计数，供放行记录使用。

    达标签口径与 ADR-027 第 2 条一致：至少 ``GATE_MIN_CASES`` 条用例、
    假事 0、记错人 0、一般错误 ≤ ``GATE_MAX_GENERAL_ERRORS``。语义标注
    覆盖只作为单独字段报告，不参与判定。工具输出的 ``meets_gate`` 只是
    放行证据的一部分；放行还需要用户批准并写入放行台账（ADR-036）。
    """
    grouped: dict[str, list[EvaluationResult]] = {}
    for result in results:
        grouped.setdefault(result.dimension, []).append(result)
    summaries = []
    for dimension in sorted(grouped):
        items = grouped[dimension]
        false_facts = sum(
            result.false_fact_count or int(result.error_kind == ERROR_FALSE_FACT)
            for result in items
        )
        wrong_subjects = sum(
            result.wrong_subject_count or int(result.error_kind == ERROR_WRONG_SUBJECT)
            for result in items
        )
        general_errors = sum(
            result.error_kind == ERROR_GENERAL for result in items
        )
        semantic_cases = sum(result.semantic_annotated for result in items)
        semantic_scenarios = len({result.semantic_case_id for result in items
                                  if result.semantic_case_id is not None})
        meets_gate = (
            len(items) >= GATE_MIN_CASES
            and false_facts == 0
            and wrong_subjects == 0
            and general_errors <= GATE_MAX_GENERAL_ERRORS
        )
        summaries.append(DimensionSummary(
            dimension=dimension, cases=len(items),
            passed=sum(result.passed for result in items),
            false_facts=false_facts, wrong_subjects=wrong_subjects,
            general_errors=general_errors, meets_gate=meets_gate,
            semantic_cases=semantic_cases, semantic_scenarios=semantic_scenarios,
        ))
    return tuple(summaries)


def _model_options(*, thinking: bool) -> dict:
    """模型对照用选项：思考模式只在显式开启时注入，生产默认不变。"""
    if thinking:
        return {'extra_body': {'thinking': {'type': 'enabled'}}}
    return {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', action='append', default=[], help='按名称选择，可重复。')
    parser.add_argument('--dimension', action='append', default=[], help='按维度选择，可重复。')
    parser.add_argument('--baseline', action='store_true',
                        help='只对固定合成集合计算未核验的潜在去向，不作为生产入口。')
    parser.add_argument('--thinking', action='store_true', help='以同一模型开启思考模式对照。')
    args = parser.parse_args(argv)
    if not os.environ.get(API_KEY_ENV, '').strip():
        print(f'[skip] 未显式提供 {API_KEY_ENV}；未读取 .env、未发起网络请求。')
        return 2
    selected = [case for case in (*CASES, *SEMANTIC_CASES)
                if (not args.case or case.name in args.case)
                and (not args.dimension or case.dimension in args.dimension)]
    if not selected:
        parser.error('没有匹配的合成用例。')
    from notalone.memory_extraction.adapters import LangChainExtractionRuntime
    from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model

    model = build_deepseek_model(
        api_key=os.environ[API_KEY_ENV],
        **_model_options(thinking=args.thinking),
    )
    runtime = LangChainExtractionRuntime(model=model)
    verifier = None if args.baseline else LangChainSourceVerificationRuntime(model=model)
    print(json.dumps({
        'model': getattr(model, 'model_name', 'unreported'),
        'thinking': bool(args.thinking),
        'cases': len(selected), 'synthetic_only': True,
        'baseline': bool(args.baseline), 'verification_enabled': verifier is not None,
        'semantic_cases': sum(case.expected_claims is not None for case in selected),
    }, ensure_ascii=False), flush=True)
    results = []
    for case in selected:
        result = evaluate_case(case, build_window(case), runtime,
                               verification_runtime=verifier, baseline=bool(args.baseline))
        results.append(result)
        print(json.dumps(asdict(result), ensure_ascii=False, default=str), flush=True)
    failures = [result.name for result in results if not result.passed]
    print(json.dumps({
        'cases': len(results),
        'failures': failures,
        'dimensions': [asdict(item) for item in summarize(results)],
    }, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
