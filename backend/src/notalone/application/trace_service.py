"""已授权联系人范围内读取和删除实际追踪，不构建或调用模型。"""

from __future__ import annotations

from typing import Any, Protocol
from uuid import UUID

from notalone.application.contact_directory import ContactDirectory
from notalone.scopes import ContactScope


class TraceQueryPort(Protocol):
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


class TraceService:
    """两类敏感追踪共用范围验证，保留 Adapter 提供的真实缺口状态。"""

    def __init__(
        self,
        *,
        contacts: ContactDirectory,
        extraction: TraceQueryPort,
        processing: TraceQueryPort,
    ) -> None:
        self._contacts = contacts
        self._stores = {
            "memory-traces": extraction,
            "source-processing-traces": processing,
        }

    def _store(self, scope: ContactScope, resource: str) -> TraceQueryPort:
        if not any(
            row.contact_id == scope.contact_id
            for row in self._contacts.list_contacts(scope.owner_id)
        ):
            raise LookupError("指定范围不存在。")
        return self._stores[resource]

    def list_batches(
        self,
        scope: ContactScope,
        resource: str,
        *,
        limit: int = 100,
        before: UUID | None = None,
    ) -> dict[str, Any]:
        batches = self._store(scope, resource).list_batches(
            scope, limit=limit, before=before
        )
        identifier = "trace_id" if resource == "memory-traces" else "batch_id"
        return {
            "batches": batches,
            "next_before": (
                batches[-1][identifier] if len(batches) == limit else None
            ),
        }

    def get_batch(
        self, scope: ContactScope, resource: str, batch_id: UUID
    ) -> dict[str, Any]:
        return self._store(scope, resource).get_batch(scope, batch_id)

    def find_record(
        self,
        scope: ContactScope,
        resource: str,
        record_kind: str,
        record_id: UUID,
    ) -> dict[str, Any]:
        result = self._store(scope, resource).find_record(
            scope, record_kind, record_id
        )
        if result.get("record_exists") is False:
            raise LookupError("指定范围不存在。")
        return result

    def delete_batch(
        self, scope: ContactScope, resource: str, batch_id: UUID
    ) -> dict[str, Any]:
        self._store(scope, resource).delete_batch(scope, batch_id)
        return {"availability": "deleted", "batch_id": str(batch_id)}
