"""追踪的记录、查询与删除边界，错误不携带敏感载荷。"""

from __future__ import annotations

from typing import Any, Protocol
from uuid import UUID

from notalone.scopes import ContactScope


class TraceWriteError(RuntimeError):
    """独立于模型输出错误；本批停止且不进入非法输出跳过恢复。"""

    def __init__(self, stage: str, trace_id: UUID | None = None) -> None:
        super().__init__("记忆提取追踪保存失败，本批已停止。")
        self.stage = stage
        self.trace_id = trace_id
        # 未获提交回执时不假称回滚，调用者可通过 trace_id 读取真实权威状态。
        self.commit_outcome = "unknown"


class TracePort(Protocol):
    """所有写入可靠返回后才能使用下一阶段；complete 原子结束与推进水位。"""

    def begin(
        self,
        scope: ContactScope,
        *,
        run_id: UUID,
        batch_key: str,
        payload: dict[str, Any],
    ) -> UUID: ...

    def append(
        self,
        scope: ContactScope,
        trace_id: UUID,
        *,
        stage: str,
        payload: dict[str, Any],
        candidate_trace_id: UUID | None = None,
        call_id: UUID | None = None,
        links: tuple[dict[str, Any], ...] = (),
        dependency_ids: tuple[UUID, ...] = (),
    ) -> None: ...

    def complete(
        self,
        scope: ContactScope,
        trace_id: UUID,
        *,
        status: str,
        payload: dict[str, Any],
        watermark_port: Any = None,
        watermark_message_id: UUID | None = None,
        failure_state: Any = None,
        skipped_range: Any = None,
    ) -> None: ...

    def mark_failed(
        self,
        scope: ContactScope,
        trace_id: UUID,
        *,
        stage: str,
        error_code: str,
    ) -> None: ...

    def record_call(
        self, scope: ContactScope, trace_id: UUID, *, receipt: dict[str, Any]
    ) -> None:
        """独立无正文关联；可在停止／失败／正文删除后补记实际调用。"""
        ...

    def list_batches(
        self,
        scope: ContactScope,
        *,
        limit: int = 100,
        before: UUID | str | None = None,
    ) -> tuple[dict[str, Any], ...]: ...

    def get_batch(
        self, scope: ContactScope, trace_id: UUID | str
    ) -> dict[str, Any]: ...

    def find_record(
        self, scope: ContactScope, record_kind: str, record_id: UUID
    ) -> dict[str, Any]: ...

    def delete_batch(
        self, scope: ContactScope, trace_id: UUID | str
    ) -> None: ...
