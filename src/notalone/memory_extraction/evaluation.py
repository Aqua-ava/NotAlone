"""合成记忆评测：复用正式链路，只计算去向，不访问存储。"""
from __future__ import annotations

import argparse
import json
import os
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


@dataclass(frozen=True)
class EvaluationResult:
    name: str
    dimension: str
    expected: str
    actual: str
    passed: bool
    subject_ok: bool
    labels_ok: bool
    expected_subject: str | None
    expected_labels: tuple[tuple[str, str], ...]
    facts: tuple[dict, ...]
    rejected_count: int
    failure_reason: str | None


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
    actual = max(destinations, key=('none', 'pending', 'auto').index, default='none')
    subject_ok = case.expect_subject is None or (
        bool(outcome.accepted)
        and all(fact.subject.value == case.expect_subject for fact in outcome.accepted)
    )
    labels_ok = not case.expected_labels or (
        bool(facts) and all(
            fact.get(label) == expected
            for fact in facts for label, expected in case.expected_labels
        )
    )
    passed = (actual == case.expect and subject_ok and labels_ok
              and outcome.failure_reason is None and outcome.rejected_count == 0)
    return EvaluationResult(
        name=case.name, dimension=case.dimension, expected=case.expect,
        actual=actual, passed=passed, subject_ok=subject_ok, labels_ok=labels_ok,
        expected_subject=case.expect_subject, expected_labels=case.expected_labels,
        facts=tuple(facts), rejected_count=outcome.rejected_count,
        failure_reason=outcome.failure_reason,
    )


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
    print(json.dumps({'cases': len(results), 'failures': failures}, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
