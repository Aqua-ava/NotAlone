"""升级复用原完整追踪；预演写动作只记录计划，不伪造提交回执。"""

from pathlib import Path
from hashlib import sha256
from uuid import UUID
from contextlib import contextmanager

from notalone.memory_trace.context import event_payload, snapshot, current_trace
from notalone.memory_extraction.command import _trace_versions


def upgrade_trace_versions():
    versions = _trace_versions()
    for name in ('memory_upgrade', 'memory_upgrade_preview', 'memory_upgrade_trace'):
        versions[name] = sha256(Path(__file__).with_name(name + '.py').read_bytes()).hexdigest()
    root=Path(__file__).parents[1]
    for name,relative in (('upgrade_snapshot','memory/upgrade_snapshot.py'),
        ('upgrade_store','persistence/memory_upgrade.py'),('upgrade_apply','persistence/memory_upgrade_apply.py'),
        ('upgrade_generation','persistence/memory_upgrade_generation.py'),('upgrade_traces','persistence/memory_upgrade_traces.py')):
        versions[name]=sha256((root/relative).read_bytes()).hexdigest()
    return versions


def finish_upgrade_model_failure(trace, error):
    """E/V/A失败统一沿实际处理阶段结束；不冒称业务写入错误。"""
    trace.complete(status='model_failed', payload={'failure_kind':error.failure_kind.value,
        'failure_stage':trace.stage,'execution_mode':'preview_only',
        'watermark_commit':'not_advanced','business_writes':'not_applied'})


def preview_window_payload(prepared, claim, versions):
    return event_payload({
        'messages': [{**snapshot(message), 'role': 'target'} for message in prepared.window.messages],
        'target_count': len(prepared.window.messages), 'target_message_ids': snapshot(prepared.window.target_message_ids),
        'context_before_count': 0, 'context_after_count': 0, 'watermark_commit': 'not_advanced',
        'execution_mode': 'preview_only', 'versions': versions,
        'upgrade': {'batch_id': str(prepared.batch_id), 'phase': 'preview', 'target_kind': prepared.target_kind},
    })


def _planned_payload(payload):
    def planned(value):
        if isinstance(value, dict):
            return {key: ('planned' if key == 'commit_status' and item == 'committed' else planned(item))
                    for key, item in value.items() if key != '_execution'}
        if isinstance(value, list):
            return [planned(item) for item in value]
        return value
    result = event_payload({**planned(payload), 'execution_mode': 'preview_only'})
    # 保留原处理时刻和规则版本，摘要按实际保存的计划载荷重新计算。
    result['_execution'].update({key: value for key, value in payload.get('_execution', {}).items()
                                 if key != 'payload_sha256'})
    result['_execution']['status'] = 'preview_only'
    return result


@contextmanager
def using_upgrade_trace_store(store):
    """只切换当前尝试的写入事务；阶段、候选和失败事实始终沿同一会话。"""
    trace=current_trace()
    if trace is None:
        yield None
        return
    previous=trace.store
    trace.store=store
    try:
        yield trace
    finally:
        trace.store=previous


@contextmanager
def planned_upgrade_writes():
    """批准后的来源复比仍是预演，只有后续原正式采纳才写提交回执。"""
    trace=current_trace()
    if trace is None:
        yield
        return
    with using_upgrade_trace_store(UpgradePreviewTrace(trace.store)):
        yield


class UpgradePreviewTrace:
    """只接管预演产生的业务回执；原模型请求／响应载荷原样进入受控存储。"""

    def __init__(self, store):
        self.store = store
        self.virtual_ids = set()

    def append(self, scope, trace_id, *, stage, payload, links=(), dependency_ids=(), **metadata):
        if stage in ('write_plan', 'write_result', 'candidate_result'):
            if payload.get('operation') != 'invalidate':
                self.virtual_ids.update(UUID(str(link['record_id'])) for link in links)
            stage = 'upgrade_preview_' + stage
            payload = _planned_payload(payload)
            links = ()
        return self.store.append(scope, trace_id, stage=stage, payload=payload, links=links,
            dependency_ids=tuple(identifier for identifier in dependency_ids if identifier not in self.virtual_ids), **metadata)

    def mark_failed(self, *args, **kwargs):
        return self.store.mark_failed(*args, **kwargs)

    def record_call(self, *args, **kwargs):
        return self.store.record_call(*args, **kwargs)

    def complete(self, *args, **kwargs):
        return self.store.complete(*args, **kwargs)
