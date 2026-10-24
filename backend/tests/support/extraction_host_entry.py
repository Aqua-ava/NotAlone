"""实际主宿主入口的TS A/B与Python只读消费验收；只接受显式合成库参数。"""
from datetime import datetime, timedelta, timezone
from dataclasses import asdict
import json
import os
import sys
from uuid import UUID, uuid4, uuid5, NAMESPACE_URL

from notalone.application.extraction_remote import RemoteExtractionRuntime
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.application.model_transport_accounting import physical_model_task
from notalone.memory_extraction.command import run_extraction, _plan_batch, _task_runtime_metadata
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.memory_trace.context import TraceSession
from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore, PostgresOutboundLedger, PostgresWatermarkStore
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.scopes import ContactScope
from notalone.tasks.models import ClaimedBackgroundTaskStep, BackgroundTaskStepName


def main():
    mode, dsn, owner, contact, source, raw_claim, url = sys.argv[1:]
    scope = ContactScope(UUID(owner), UUID(contact))
    fields = json.loads(raw_claim)
    claim = ClaimedBackgroundTaskStep(task_id=UUID(fields["task_id"]), owner_id=scope.owner_id,
        contact_id=scope.contact_id, source_document_id=UUID(source),
        step_id=UUID(fields["step_id"]), name=BackgroundTaskStepName.EXTRACT_MEMORY,
        worker_id=UUID(fields["worker_id"]), attempt_count=1, message_count=1,
        lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5), lease_generation=1)
    control = SharedModelPriorityControl(socket_path=os.environ["NOTALONE_MODEL_PERMIT_SOCKET"],
        token=os.environ["NOTALONE_MODEL_PERMIT_TOKEN"])
    runtime = RemoteExtractionRuntime.from_environment(os.environ,
        historical_runtime=object(), owner_id=scope.owner_id)
    messages = load_contact_messages(scope, dsn)
    watermark = PostgresWatermarkStore(dsn)
    trace = PostgresExtractionTraceStore(dsn)
    def physical(batch_key):
        return physical_model_task(control, request_id=uuid5(NAMESPACE_URL,
            f"notalone:extraction:{claim.task_id}:{batch_key}"),
            owner_id=scope.owner_id, contact_id=scope.contact_id, claim=fields)
    try:
        if mode == "lost":
            metadata = _task_runtime_metadata(claim.task_id, None, None)
            metadata["task_runtime"].update(fields)
            plan = _plan_batch(batch=messages, messages=messages,
                message_positions={m.message_id: i for i, m in enumerate(messages)}, scope=scope,
                context_before=5, context_after=0, batch_size=10, provider="deepseek",
                model_name="deepseek-flash", task_metadata=metadata, selection_receipts=(),
                previous_watermark=None)
            trace_id = trace.begin(scope, run_id=uuid4(), batch_key=plan.batch_key, payload=plan.window_payload)
            with physical(plan.batch_key), TraceSession(trace, scope, trace_id):
                outcome = runtime.run_remote_flow(plan.window)
            # 故意不交B消费；下一次进程只能恢复同一执行，不能重发E/V。
            print(json.dumps({"extracted": len(outcome.accepted), "trace_id": str(trace_id),
                "a_execution_id": str(outcome.a_execution_id), "watermark": watermark.get(scope)}))
        elif mode == "run":
            stats = run_extraction(scope=scope, messages=messages, watermark_message_id=watermark.get(scope),
                runtime=runtime, memory_port=PostgresMemoryStore(dsn), owner_memory_port=PostgresOwnerMemoryStore(dsn),
                ledger=PostgresOutboundLedger(dsn), watermark_port=watermark, trace_store=trace,
                model_name="deepseek-flash", task_id=claim.task_id, task_claim=claim,
                task_lease_generation=1, physical_scope_factory=physical,
                dimension_release=DimensionRelease(verified_sources=True))
            print(json.dumps({"stats": asdict(stats), "watermark": str(watermark.get(scope))}, default=str))
        else:
            raise ValueError("合成验收模式无效")
    finally:
        runtime.close()


if __name__ == "__main__":
    main()
