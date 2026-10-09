"""固定合成资料的记忆机制实验；不读存储、不接生产入口。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import time
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any, cast

from langchain_core.language_models import BaseChatModel

from notalone.memory_extraction.evaluation import API_KEY_ENV, evaluate_case
from notalone.memory_extraction.evaluation_cases import (
    EvaluationCase,
    ExpectedDestination,
)
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction.runtime import ExtractionPayload, MemoryExtractionRuntime
from notalone.memory_extraction.verification import SourceVerificationRuntime

ARMS = ('A', 'B', 'C', 'D')
SCHEDULE_SEED = 20261002


class _CapturedRuntime:
    def __init__(self, runtime: MemoryExtractionRuntime) -> None:
        self.runtime = runtime
        self.payloads: ExtractionPayload = ()

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        self.payloads = self.runtime.extract(window)
        return self.payloads


class _ReplayRuntime:
    def __init__(self, payloads: ExtractionPayload) -> None:
        self.payloads = payloads

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        return self.payloads


def run_trial(
    *, case_id: str, dimension: str, arm: str, repeat: int,
    window: ExtractionWindow, runtime: MemoryExtractionRuntime,
    verifier: SourceVerificationRuntime,
) -> dict[str, Any]:
    """提取只执行一次；重放原输出比较核验前后，不使用旧正则作语义答案。"""
    if arm not in ARMS:
        raise ValueError('未知实验臂。')
    captured = _CapturedRuntime(runtime)
    case = EvaluationCase(case_id, dimension, (), (), ExpectedDestination.NONE)
    started = time.perf_counter()
    raw = evaluate_case(case, window, captured, baseline=True)
    guarded = None if raw.failure_reason else evaluate_case(
        case, window, _ReplayRuntime(captured.payloads), verification_runtime=verifier,
    )
    return {
        'case_id': case_id, 'dimension': dimension, 'arm': arm, 'repeat': repeat,
        'payloads': captured.payloads, 'raw': asdict(raw),
        'guarded': asdict(guarded) if guarded is not None else None,
        'elapsed_ms': int((time.perf_counter() - started) * 1000),
    }


def trial_schedule(case_ids: Sequence[str], repetitions: int) -> tuple[tuple[str, str, int], ...]:
    """冻结种子的交错顺序；每个场景的每个臂均保留全部重复。"""
    if not 1 <= repetitions <= 3 or len(set(case_ids)) != len(case_ids):
        raise ValueError('重复次数或用例 ID 无效。')
    trials = [(case_id, arm, repeat) for repeat in range(repetitions)
              for case_id in case_ids for arm in ARMS]
    random.Random(SCHEDULE_SEED).shuffle(trials)
    return tuple(trials)


def blind_trials(trials: Sequence[dict[str, Any]], cases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """语义裁判只看合成来源、gold 和输出，隐藏方法及模型核验判断。"""
    ordered = sorted(trials, key=lambda row: (row['case_id'], row['arm'], row['repeat']))
    random.Random(SCHEDULE_SEED + 1).shuffle(ordered)
    records, mapping = [], {}
    visible = ('text', 'subject', 'source_message_ids', 'valid_at', 'invalid_at',
               'speech_act', 'assertion_status', 'figurative_type', 'destination')
    for index, trial in enumerate(ordered):
        blind_id = f'R{index + 1:04d}'
        mapping[blind_id] = {
            key: trial[key] for key in ('case_id', 'arm', 'repeat')
        }
        outputs = {}
        for phase in ('raw', 'guarded'):
            outcome = trial[phase]
            outputs[phase] = None if outcome is None else {
                'facts': [{key: fact.get(key) for key in visible}
                          for fact in outcome['facts']],
                'failure': bool(outcome['failure_reason']),
                'rejected_count': outcome['rejected_count'],
            }
        records.append({'blind_id': blind_id, 'source': cases[trial['case_id']],
                        'outputs': outputs})
    return {'records': records, 'mapping': mapping}


class _ObservedBound:
    def __init__(self, bound: Any, stage: str, calls: list[dict[str, Any]]) -> None:
        self.bound, self.stage, self.calls = bound, stage, calls

    def invoke(self, messages: Any) -> Any:
        started = time.perf_counter()
        entry: dict[str, Any] = {'stage': self.stage, 'transport_succeeded': False}
        try:
            message = self.bound.invoke(messages)
            raw_usage = getattr(message, 'usage_metadata', None)
            raw_metadata = getattr(message, 'response_metadata', None)
            usage = raw_usage if isinstance(raw_usage, dict) else {}
            metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
            entry.update({
                'transport_succeeded': True,
                'usage': {key: value for key, value in usage.items()
                          if key in ('input_tokens', 'output_tokens', 'total_tokens')
                          and type(value) is int and value >= 0},
                'model': metadata.get('model_name') or metadata.get('model') or 'unreported',
            })
            return message
        finally:
            entry['latency_ms'] = int((time.perf_counter() - started) * 1000)
            self.calls.append(entry)


class _ObservedModel:
    """只记录单次请求的用量与传输状态，不记录模型输入或内部思考。"""

    def __init__(self, model: BaseChatModel) -> None:
        self.model = model
        self.calls: list[dict[str, Any]] = []

    def bind_tools(
        self, schemas: list[dict[str, Any]], **kwargs: Any,
    ) -> _ObservedBound:
        return _ObservedBound(
            self.model.bind_tools(schemas, **kwargs), schemas[0]['title'], self.calls,
        )


def _write_json(path: Path, value: Any) -> None:
    # 独占创建，确保首次输出不被覆盖；资料均为冻结的合成用例。
    with path.open('x', encoding='utf-8') as output:
        os.chmod(path, 0o600)
        json.dump(value, output, ensure_ascii=False, indent=2, default=str)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--split', choices=('development', 'holdout', 'all'), default='holdout')
    parser.add_argument('--repetitions', type=int, choices=(1, 2, 3), default=2)
    parser.add_argument('--workers', type=int, choices=(1, 2, 3), default=3)
    args = parser.parse_args(argv)
    if not os.environ.get(API_KEY_ENV, '').strip():
        print(f'[skip] 未显式提供 {API_KEY_ENV}，未读取 .env 或发起请求。')
        return 2
    from concurrent.futures import ThreadPoolExecutor, as_completed

    from notalone.memory_extraction.adapters import LangChainExtractionRuntime
    from notalone.memory_extraction.replica_adapters import (
        NarrativeExtractionRuntime, TemporalRefinementRuntime,
    )
    from notalone.memory_extraction.replica_cases import REPLICA_CASES, build_replica_window
    from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model

    selected = [case for case in REPLICA_CASES if args.split == 'all' or case.split == args.split]
    case_map = {case.case_id: case for case in selected}
    exported_cases = {
        case.case_id: {**asdict(case), 'window': asdict(build_replica_window(case))}
        for case in selected
    }
    schedule = trial_schedule(tuple(case_map), args.repetitions)
    directory = Path(args.output_dir).expanduser().absolute()
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    dataset_bytes = json.dumps(exported_cases, sort_keys=True, default=str).encode()
    source_hashes = {
        name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in ('replica_cases.py', 'replica_adapters.py', 'replica_experiment.py',
                     'adapters.py', 'verification_adapters.py')
    }
    _write_json(directory / 'manifest.json', {
        'synthetic_only': True, 'source_hashes': source_hashes,
        'baseline_commit': '739304d42521d86162e204b4f8dfc11e6153bb0c',
        'dataset_sha256': hashlib.sha256(dataset_bytes).hexdigest(),
        'cases': exported_cases, 'schedule': schedule, 'seed': SCHEDULE_SEED,
        'repetitions': args.repetitions, 'workers': args.workers,
        'temperature': 0, 'model': os.environ.get('NOTALONE_DEEPSEEK_MODEL', 'deepseek-chat'),
        'request_accounting': 'invoke次数；供应商适配器内部网络重试无法逐次观测',
    })

    def execute(item: tuple[str, str, int]) -> dict[str, Any]:
        case_id, arm, repeat = item
        model = build_deepseek_model(api_key=os.environ[API_KEY_ENV])
        observed = _ObservedModel(model)
        # 实验观察器只装饰既有 bind_tools/invoke 两个接口，未继承模型实现。
        instrumented = cast(BaseChatModel, observed)
        runtime: MemoryExtractionRuntime = (
            NarrativeExtractionRuntime(model=instrumented) if arm in ('B', 'D')
            else LangChainExtractionRuntime(model=instrumented)
        )
        if arm in ('C', 'D'):
            runtime = TemporalRefinementRuntime(runtime=runtime, model=instrumented)
        result = run_trial(
            case_id=case_id, dimension=case_map[case_id].dimension,
            arm=arm, repeat=repeat, window=build_replica_window(case_map[case_id]),
            runtime=runtime, verifier=LangChainSourceVerificationRuntime(model=instrumented),
        )
        result['calls'] = observed.calls
        _write_json(directory / f'{case_id}-{arm}-{repeat}.json', result)
        return result

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(execute, item) for item in schedule]
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            print(json.dumps({key: result[key] for key in ('case_id', 'arm', 'repeat')}
                             | {'completed': len(results), 'total': len(schedule)},
                             ensure_ascii=False), flush=True)
    blinded = blind_trials(results, exported_cases)
    _write_json(directory / 'blinded.json', blinded['records'])
    _write_json(directory / 'blind-mapping.json', blinded['mapping'])
    failures = sum(bool(result['raw']['failure_reason']) or bool(
        result['guarded'] and result['guarded']['failure_reason']
    ) for result in results)
    _write_json(directory / 'completion.json', {
        'completed': len(results), 'runtime_failures': failures, 'semantic_scored': False,
    })
    print(json.dumps({'completed': len(results), 'runtime_failures': failures,
                      'semantic_scored': False}, ensure_ascii=False), flush=True)
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
