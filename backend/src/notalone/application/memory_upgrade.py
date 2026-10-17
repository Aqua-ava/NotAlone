"""显式升级的业务操作与持久任务恢复；没有自动历史重跑入口。"""

import logging
from uuid import UUID

from notalone.memory.upgrade import UpgradeScope, UpgradeBudget


class MemoryUpgradeService:
    def __init__(self, store, *, task_host=None):
        self.store, self.task_host = store, task_host

    def prepare(self, selected: UpgradeScope, budget: UpgradeBudget, operation: UUID) -> dict:
        identifier = self.store.prepare(selected, budget, operation)
        self._wake(selected, identifier)
        return self.store.read(selected, identifier)

    def list(self, selected: UpgradeScope) -> dict:
        result = self.store.list(selected)
        for job in result['jobs']:
            self._wake(selected, UUID(job['job_id']))
        return result

    def read(self, selected: UpgradeScope, job_id: UUID) -> dict:
        self._wake(selected, job_id)
        return self.store.read(selected, job_id)

    def operate(self, selected: UpgradeScope, job_id: UUID, **command) -> dict:
        result = self.store.operate(selected, job_id, **command)
        if command["action"] == "delete" and result is not None:
            return result
        self._wake(selected, job_id)
        return self.store.read(selected, job_id)

    def _wake(self, selected: UpgradeScope, job_id: UUID) -> None:
        if self.task_host is None:
            return
        for contact_id, task_id in self.store.pending_tasks(selected, job_id):
            try:
                self.task_host.wake(owner_id=selected.owner_id, contact_id=contact_id, task_id=task_id)
            except Exception:
                # 只恢复先前明确授权的工作；持久状态保留，暂时调度错误不改写用户动作。
                logging.getLogger(__name__).warning('memory_upgrade_schedule_failed')


class UpgradeModelCalls:
    """每次 E/V/A 沿原许可等待，最后复验并持久扣记总预算。"""

    def __init__(self, *, scope, claim, store, extraction, verification=None,
                 adjudication=None, priority=None, ledger=None, model_name='unreported'):
        self.scope, self.claim, self.store = scope, claim, store
        self.extraction, self.verification, self.adjudication = extraction, verification, adjudication
        self.priority, self.ledger, self.model_name = priority, ledger, model_name

    @property
    def verification_mode(self):
        from notalone.memory_extraction.verification import SourceVerificationMode
        return getattr(self.verification, 'verification_mode', SourceVerificationMode.LEGACY_V4)

    def _call(self, operation, *, purpose, accounted=False):
        from contextlib import nullcontext
        from datetime import datetime, timezone
        import time
        from uuid import uuid4
        from notalone.ledger.models import LedgerEntry, LedgerOutcome
        from notalone.memory_trace.context import record_ledger_entry, current_trace
        with self.priority.background_call() if self.priority else nullcontext():
            # 预算和来源在许可之后检查，排队期间删除不得进入 SDK。
            self.store.charge(self.claim)
            called_at, started = datetime.now(timezone.utc), time.perf_counter()
            succeeded = False
            try:
                result = operation()
                succeeded = True
            finally:
                trace = current_trace()
                invoked = trace is None or trace.call_was_invoked(purpose)
                if self.ledger is not None and not accounted and invoked:
                    record_ledger_entry(purpose, self.ledger, LedgerEntry(entry_id=uuid4(), owner_id=self.scope.owner_id,
                        contact_id=self.scope.contact_id, provider='deepseek', model_name=self.model_name,
                        input_tokens=None, output_tokens=None,
                        latency_ms=max(0, int((time.perf_counter()-started)*1000)),
                        outcome=LedgerOutcome.SUCCEEDED if succeeded else LedgerOutcome.RUN_FAILED,
                        called_at=called_at), started_at=called_at)
        try:
            if self.priority:
                self.priority.wait_for_foreground()
            self.store.validate(self.claim)
        except Exception:
            trace = current_trace()
            if trace is not None:
                trace.discard_call(purpose)
            raise
        return result

    def extract(self, window):
        return self._call(lambda: self.extraction.extract(window), purpose='extraction')

    def verify(self, *, window, facts):
        # 现行 V 运行时自行记无正文台账，不能重复计费。
        return self._call(lambda: self.verification.verify(window=window, facts=facts), purpose='verification', accounted=True)

    def adjudicate(self, **kwargs):
        return self._call(lambda: self.adjudication.adjudicate(**kwargs), purpose='adjudication')


class RecordedAdjudication:
    """预览记录原裁决，应用严格重放同一输入，不能增添模型决定。"""

    def __init__(self, *, runtime=None, records=None):
        self.runtime = runtime
        self.records = [] if records is None else list(records)
        self.position = 0

    def adjudicate(self, *, candidate_text, similar):
        from notalone.memory.upgrade import UpgradeConflict
        from notalone.memory.upgrade_snapshot import upgrade_digest
        from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
        digest = upgrade_digest({'candidate_text': candidate_text, 'similar': similar})
        if self.runtime is not None:
            decision = self.runtime.adjudicate(candidate_text=candidate_text, similar=similar)
            self.records.append({'digest': digest, 'action': decision.action.value,
                'replaced_memory_id': str(decision.replaced_memory_id) if decision.replaced_memory_id else None})
            return AdjudicationDecision(decision.action, decision.replaced_memory_id)
        if self.position >= len(self.records) or self.records[self.position]['digest'] != digest:
            raise UpgradeConflict('比较所用旧资料已变化。')
        row = self.records[self.position]
        self.position += 1
        return AdjudicationDecision(AdjudicationAction(row['action']),
            UUID(row['replaced_memory_id']) if row['replaced_memory_id'] else None)

    def assert_consumed(self):
        from notalone.memory.upgrade import UpgradeConflict
        if self.position != len(self.records):
            raise UpgradeConflict('比较裁决集合已变化。')


class MemoryUpgradeTaskRunner:
    """现行固定 Worker 的四个升级步骤；只有批准后才进入应用。"""

    def __init__(self, *, store, runtime_builder, trace_store, model_priority=None, dimension_release=None):
        self.store, self.runtime_builder = store, runtime_builder
        self.trace_store = trace_store
        self.model_priority, self.dimension_release = model_priority, dimension_release

    def preview(self, claim):
        from dataclasses import replace
        from notalone.memory_extraction.flow import ExtractionFlow
        from notalone.memory_extraction.errors import ExtractionRuntimeError, ExtractionInvalidOutputError
        from notalone.memory_extraction.models import ExtractionFailureKind
        from notalone.memory_extraction.models import FactSubject
        from notalone.application.memory_upgrade_preview import preview_upgrade
        from notalone.memory.upgrade_snapshot import comparison_payload
        from notalone.application.memory_upgrade_trace import (
            UpgradePreviewTrace, preview_window_payload, upgrade_trace_versions, finish_upgrade_model_failure,
        )
        from notalone.memory_trace import TraceSession
        from notalone.memory_trace.context import snapshot
        prepared = self.store.capture(claim)
        if prepared is None:
            return 0
        components = self.runtime_builder()
        versions = upgrade_trace_versions()
        trace_id = self.store.begin_trace(claim, preview_window_payload(prepared, claim, versions))
        preview_trace = UpgradePreviewTrace(self.trace_store)
        with TraceSession(preview_trace, prepared.scope, trace_id, versions=versions,
                          ledger=components.get('ledger'), model_name=components.get('model_name')) as trace:
            calls = UpgradeModelCalls(scope=prepared.scope, claim=claim, store=self.store,
                priority=self.model_priority, **components)
            result = ExtractionFlow(runtime=calls,
                verification_runtime=calls if calls.verification else None).run(prepared.window)
            if result.failure_reason is not None:
                error_type = ExtractionInvalidOutputError if result.failure_kind is ExtractionFailureKind.INVALID_OUTPUT else ExtractionRuntimeError
                error=error_type(result.failure_reason)
                finish_upgrade_model_failure(trace,error)
                raise error
            indices = [index for index, fact in enumerate(result.accepted)
                if (fact.subject is FactSubject.SELF) == (prepared.target_kind == 'owner')]
            result = replace(result, accepted=tuple(result.accepted[index] for index in indices),
                candidate_trace_ids=tuple(result.candidate_trace_ids[index] for index in indices))
            result = self.store.bind_outcome(claim, result)
            recorder = RecordedAdjudication(runtime=calls) if calls.adjudication else RecordedAdjudication(records=[])
            try:
                compared = preview_upgrade(prepared.scope, result, memory_port=prepared.memory_port,
                    owner_memory_port=prepared.owner_memory_port if prepared.target_kind == 'owner' else None,
                    adjudication_runtime=recorder if calls.adjudication else None,
                    dimension_release=self.dimension_release, candidate_namespace=prepared.batch_id,
                    target_kind=prepared.target_kind)
            except ExtractionRuntimeError as error:
                finish_upgrade_model_failure(trace,error)
                raise
            trace.record('upgrade_comparison', {'comparison': comparison_payload(compared), 'execution_mode': 'preview_only'})
            trace.stage = 'batch_end'
            return self.store.save_preview(claim, prepared, result, compared, recorder.records,
                trace_id=trace_id, trace_payload={'execution_mode': 'preview_only', 'adoption': snapshot(compared.stats),
                    'watermark_commit': 'not_advanced', 'business_writes': 'not_applied'})

    def apply(self, claim):
        from notalone.memory_trace import TraceSession
        from notalone.scopes import ContactScope
        trace_id = self.store.begin_apply_trace(claim)
        if trace_id is None:
            return self.store.apply(claim, dimension_release=self.dimension_release)
        from notalone.application.memory_upgrade_trace import upgrade_trace_versions
        with TraceSession(self.trace_store, ContactScope(claim.owner_id, claim.contact_id), trace_id,
                          versions=upgrade_trace_versions()):
            return self.store.apply(claim, dimension_release=self.dimension_release, trace_id=trace_id)

    def verify(self, claim):
        self.store.verify(claim)

    def failed(self, claim, code):
        self.store.failed(claim, code)
