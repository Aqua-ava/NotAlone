"""后台任务和固定步骤的领域值对象。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID


class BackgroundTaskType(StrEnum):
    """后台任务的业务类型。"""

    IMPORT = "import"
    DELETE = "delete"


class BackgroundTaskStatus(StrEnum):
    """父任务的生命周期状态。"""

    QUEUED = "queued"
    RUNNING = "running"
    VERIFYING = "verifying"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class BackgroundTaskStepName(StrEnum):
    """导入与删除任务允许出现的固定步骤。"""

    MARK_DELETED = "mark_deleted"
    DELETE_DERIVED = "delete_derived"
    DELETE_INDEX = "delete_index"
    CLEAR_CACHE = "clear_cache"
    VERIFY_NOT_RETRIEVABLE = "verify_not_retrievable"
    PARSE = "parse"
    NORMALIZE = "normalize"
    EXTRACT_MEMORY = "extract_memory"
    INDEX = "index"
    VERIFY = "verify"


class BackgroundTaskStepStatus(StrEnum):
    """单个后台步骤的生命周期状态。"""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    RETRYABLE = "retryable"
    FAILED = "failed"
    CANCELLED = "cancelled"


IMPORT_TASK_STEPS: tuple[
    tuple[BackgroundTaskStepName, int],
    ...
] = (
    (BackgroundTaskStepName.PARSE, 1),
    (BackgroundTaskStepName.NORMALIZE, 2),
    (BackgroundTaskStepName.EXTRACT_MEMORY, 3),
    (BackgroundTaskStepName.INDEX, 4),
    (BackgroundTaskStepName.VERIFY, 5),
)


DELETE_TASK_STEPS = tuple(enumerate((
    BackgroundTaskStepName.MARK_DELETED,
    BackgroundTaskStepName.DELETE_DERIVED,
    BackgroundTaskStepName.DELETE_INDEX,
    BackgroundTaskStepName.CLEAR_CACHE,
    BackgroundTaskStepName.VERIFY_NOT_RETRIEVABLE,
), start=1))

VERIFY_STEPS = (BackgroundTaskStepName.VERIFY, BackgroundTaskStepName.VERIFY_NOT_RETRIEVABLE)


@dataclass(frozen=True, slots=True)
class BackgroundTaskStep:
    """可恢复执行的后台任务步骤，不保存聊天或模型正文。"""

    step_id: UUID
    task_id: UUID
    name: BackgroundTaskStepName
    order: int
    status: BackgroundTaskStepStatus
    attempt_count: int
    processed_count: int
    total_count: int | None
    created_at: datetime
    updated_at: datetime
    worker_id: UUID | None = None
    lease_expires_at: datetime | None = None
    last_error_code: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.step_id, UUID) or not isinstance(self.task_id, UUID):
            raise TypeError("后台步骤必须使用内部 UUID。")
        if not isinstance(self.name, BackgroundTaskStepName):
            raise TypeError("后台步骤名称无效。")
        if not isinstance(self.status, BackgroundTaskStepStatus):
            raise TypeError("后台步骤状态无效。")
        if self.order < 1 or self.attempt_count < 0 or self.processed_count < 0:
            raise ValueError("后台步骤计数无效。")
        if self.total_count is not None and self.total_count < 0:
            raise ValueError("后台步骤总数无效。")
        if self.worker_id is not None and not isinstance(self.worker_id, UUID):
            raise TypeError("后台步骤 worker_id 无效。")


@dataclass(frozen=True, slots=True)
class BackgroundTask:
    """联系人范围后台任务的非正文状态快照。"""

    task_id: UUID
    owner_id: UUID
    contact_id: UUID
    source_document_id: UUID
    task_type: BackgroundTaskType
    status: BackgroundTaskStatus
    current_step: BackgroundTaskStepName
    message_count: int
    created_at: datetime
    updated_at: datetime
    steps: tuple[BackgroundTaskStep, ...]
    retry_count: int = 0
    last_error_code: str | None = None
    model_version: str | None = None
    rule_version: str | None = None

    def __post_init__(self) -> None:
        ids = (
            self.task_id,
            self.owner_id,
            self.contact_id,
            self.source_document_id,
        )
        if any(not isinstance(value, UUID) for value in ids):
            raise TypeError("后台任务范围必须使用内部 UUID。")
        if not isinstance(self.task_type, BackgroundTaskType):
            raise TypeError("后台任务类型无效。")
        if not isinstance(self.status, BackgroundTaskStatus):
            raise TypeError("后台任务状态无效。")
        if not isinstance(self.current_step, BackgroundTaskStepName):
            raise TypeError("后台任务当前步骤无效。")
        if self.message_count < 0:
            raise ValueError("后台任务消息数量无效。")
        if self.retry_count < 0:
            raise ValueError("后台任务重试数量无效。")


@dataclass(frozen=True, slots=True)
class ClaimedBackgroundTaskStep:
    """Worker 获得的单个步骤租约，不携带聊天正文。"""

    task_id: UUID
    owner_id: UUID
    contact_id: UUID
    source_document_id: UUID
    step_id: UUID
    name: BackgroundTaskStepName
    worker_id: UUID
    attempt_count: int
    message_count: int
    lease_expires_at: datetime
