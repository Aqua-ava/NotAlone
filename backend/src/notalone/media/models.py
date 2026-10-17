"""公共媒体结果与内部授权事实；不携带原始载荷或源路径。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import BinaryIO, Protocol
from uuid import UUID

from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True)
class SourceOption:
    source_ref_id: UUID
    source_kind: str = "source_document"


@dataclass(frozen=True, slots=True)
class MediaArtifact:
    artifact_id: UUID
    role: str
    media_type: str
    size: int
    duration_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class MediaResult:
    status: str
    resource_id: UUID | None = None
    source_ref_id: UUID | None = None
    artifacts: tuple[MediaArtifact, ...] = ()
    source_options: tuple[SourceOption, ...] = ()
    variant_options: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True, repr=False)
class MediaReadResult:
    """交付已授权打开的内存句柄；删除不能撤回调用方已取得的字节。"""

    status: str
    handle: BinaryIO | None = None

    @property
    def data(self) -> bytes | None:
        """便利读取不改变句柄位置；调用方负责关闭句柄。"""
        if self.handle is None:
            return None
        position = self.handle.tell()
        self.handle.seek(0)
        data = self.handle.read()
        self.handle.seek(position)
        return data


@dataclass(frozen=True, slots=True)
class MediaBudgets:
    max_input_bytes: int = 64 * 1024 * 1024
    max_output_bytes: int = 128 * 1024 * 1024
    max_artifacts: int = 4
    max_runtime_seconds: float = 60
    max_concurrent_per_scope: int = 2
    max_duration_seconds: float = 600
    max_image_pixels: int = 40_000_000


ERROR_CODES = frozenset({
    "message_unavailable", "unsupported_target", "source_unavailable",
    "scope_mismatch", "upstream_unverified", "resource_missing",
    "association_ambiguous", "variant_ambiguous", "invalid_request",
    "request_conflict", "attempt_invalidated", "budget_exceeded", "invalid_output",
    "unsafe_cache", "cleanup_pending", "storage_failed", "resource_unavailable",
    "upstream_failed", "scope_busy",
})


@dataclass(frozen=True, slots=True, repr=False)
class ProducedArtifact:
    role: str
    media_type: str
    data: bytes
    duration_seconds: float | None = None


class MediaProducer(Protocol):
    """只接收有界字节流；格式探测和像素预算由对应格式的实现负责。"""

    def produce(
        self, source: BinaryIO, target: str, budgets: MediaBudgets,
    ) -> tuple[ProducedArtifact, ...]: ...


class OriginalMediaProducer:
    """仅保留原始副本；不把未探测的字节标成可查看或可播放格式。"""

    def produce(
        self, source: BinaryIO, target: str, budgets: MediaBudgets,
    ) -> tuple[ProducedArtifact, ...]:
        if target != "original":
            raise MediaError("unsupported_target")
        data = source.read(budgets.max_input_bytes + 1)
        if len(data) > budgets.max_input_bytes:
            raise MediaError("budget_exceeded")
        if not data:
            raise MediaError("resource_missing")
        return (ProducedArtifact("managed_original", "application/octet-stream", data),)


class MediaError(RuntimeError):
    """只有白名单错误码可以越过公共接缝。"""

    def __init__(self, code: str, *, variant_options: tuple[str, ...] = ()) -> None:
        super().__init__(code)
        self.code = code
        self.variant_options = variant_options


@dataclass(frozen=True, slots=True, repr=False)
class MediaAuthorization:
    scope: ContactScope
    message_id: UUID
    source_ref_id: UUID
    source_document_id: UUID
    kind: str
    owner_external_id: str
    talker: str
    local_id: int
    server_id: str | None
    create_time: int | None
    generation: str
