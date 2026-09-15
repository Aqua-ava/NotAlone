"""合成记忆评测：复用正式链路，只计算去向，不访问存储。"""
from __future__ import annotations

import argparse
import json
import os
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from uuid import NAMESPACE_URL, uuid5

from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory_extraction.evaluation_cases import CASES, EvaluationCase
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_extraction.pragmatics import MemoryDisposition, PragmaticInterpreter
from notalone.memory_extraction.runtime import MemoryExtractionRuntime

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


@dataclass(frozen=True)
class DimensionSummary:
    """一个维度的达标签计数；放行还需要用户确认，工具只给数字。"""

    dimension: str
    cases: int
    passed: int
    false_facts: int
    wrong_subjects: int
    general_errors: int
    meets_gate: bool


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


def evaluate_case(
    case: EvaluationCase, window: ExtractionWindow, runtime: MemoryExtractionRuntime,
) -> EvaluationResult:
    """消息窗口经正式外壳、语用与风险门槛到最终去向。"""
    outcome = ExtractionFlow(runtime=runtime).run(window)
    interpreter = PragmaticInterpreter()
    facts = []
    destinations = []
    for fact in outcome.accepted:
        decision = interpreter.interpret(fact)
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
    passed = (actual == case.expect and subject_ok and labels_ok and text_ok
              and validity_ok
              and outcome.failure_reason is None and outcome.rejected_count == 0)
    return EvaluationResult(
        name=case.name, dimension=case.dimension, expected=case.expect,
        actual=actual, passed=passed, subject_ok=subject_ok, labels_ok=labels_ok,
        text_ok=text_ok, validity_ok=validity_ok,
        error_kind=_classify_error(
            passed=passed, actual=actual, expected=case.expect,
            subject_ok=subject_ok,
        ),
        expected_subject=case.expect_subject, expected_labels=case.expected_labels,
        facts=tuple(facts), rejected_count=outcome.rejected_count,
        failure_reason=outcome.failure_reason,
    )


def _text_matches(case: EvaluationCase, facts: list[dict]) -> bool:
    """保真检查：禁用词不得出现；要求的语义标记至少出现在一条候选文本里。"""
    texts = [str(fact.get('text', '')) for fact in facts]
    if any(
        forbidden in text
        for text in texts
        for forbidden in case.expect_text_excludes
    ):
        return False
    return all(
        any(required in text for text in texts)
        for required in case.expect_text_contains
    )


def _validity_matches(case: EvaluationCase, facts: list[dict]) -> bool:
    """有效期存在性检查：需要时间限定的事实要填对字段，其余不填。"""
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
    return True


def _classify_error(
    *, passed: bool, actual: str, expected: str, subject_ok: bool,
) -> str | None:
    """给失败用例归类：假事优先，其次记错人，其余为一般错误。"""
    if passed:
        return None
    if actual == 'auto' and expected != 'auto':
        return ERROR_FALSE_FACT
    if not subject_ok:
        return ERROR_WRONG_SUBJECT
    return ERROR_GENERAL


def summarize(results: Sequence[EvaluationResult]) -> tuple[DimensionSummary, ...]:
    """按维度汇总达标签计数，供放行记录使用。"""
    grouped: dict[str, list[EvaluationResult]] = {}
    for result in results:
        grouped.setdefault(result.dimension, []).append(result)
    summaries = []
    for dimension in sorted(grouped):
        items = grouped[dimension]
        false_facts = sum(
            result.error_kind == ERROR_FALSE_FACT for result in items
        )
        wrong_subjects = sum(
            result.error_kind == ERROR_WRONG_SUBJECT for result in items
        )
        general_errors = sum(
            result.error_kind == ERROR_GENERAL for result in items
        )
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
        ))
    return tuple(summaries)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', action='append', default=[], help='按名称选择，可重复。')
    parser.add_argument('--dimension', action='append', default=[], help='按维度选择，可重复。')
    args = parser.parse_args(argv)
    if not os.environ.get(API_KEY_ENV, '').strip():
        print(f'[skip] 未显式提供 {API_KEY_ENV}；未读取 .env、未发起网络请求。')
        return 2
    selected = [case for case in CASES
                if (not args.case or case.name in args.case)
                and (not args.dimension or case.dimension in args.dimension)]
    if not selected:
        parser.error('没有匹配的合成用例。')
    from notalone.memory_extraction.adapters import LangChainExtractionRuntime
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model

    model = build_deepseek_model(api_key=os.environ[API_KEY_ENV])
    runtime = LangChainExtractionRuntime(model=model)
    print(json.dumps({
        'model': getattr(model, 'model_name', 'unreported'),
        'cases': len(selected), 'synthetic_only': True,
    }, ensure_ascii=False), flush=True)
    results = []
    for case in selected:
        result = evaluate_case(case, build_window(case), runtime)
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
