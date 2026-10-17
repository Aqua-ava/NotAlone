"""后台任务和固定步骤的领域值对象。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID


class ExtractionRuntimeMode(StrEnum):
    """单个提取任务可显式固定的运行合同。"""

    LEGACY = "legacy"
    BOUNDED_RUNTIME_V1 = "bounded-runtime-v1"


@dataclass(frozen=True, slots=True)
class ExtractionRuntimeConfig:
    """任务配置的持久化值；规则是否仍可执行由领取路径另行核对。"""

    mode: ExtractionRuntimeMode
    rule_set_sha256: str | None
    version: int = 1

    def __post_init__(self) -> None:
        if type(self.version) is not int or self.version != 1:
            raise ValueError("提取任务配置版本无效。")
        if not isinstance(self.mode, ExtractionRuntimeMode):
            raise ValueError("提取任务运行模式无效。")
        if self.mode is ExtractionRuntimeMode.LEGACY:
            if self.rule_set_sha256 is not None:
                raise ValueError("旧运行模式不能绑定新规则摘要。")
        elif (type(self.rule_set_sha256) is not str
              or len(self.rule_set_sha256) != 64
              or any(char not in "0123456789abcdef" for char in self.rule_set_sha256)):
            raise ValueError("有限运行模式的规则摘要无效。")

    @classmethod
    def from_payload(cls, raw: object) -> ExtractionRuntimeConfig:
        if (type(raw) is not dict
                or set(raw) != {"version", "mode", "rule_set_sha256"}
                or type(raw["mode"]) is not str):
            raise ValueError("提取任务配置格式无效。")
        return cls(
            mode=ExtractionRuntimeMode(raw["mode"]),
            rule_set_sha256=raw["rule_set_sha256"],
            version=raw["version"],
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "version": self.version,
            "mode": self.mode.value,
            "rule_set_sha256": self.rule_set_sha256,
        }


class BackgroundTaskType(StrEnum):
    """后台任务的业务类型。"""

    IMPORT = "import"
    DELETE = "delete"
    OBSERVATION = "observation"
    SKILL_LEARNING = "skill_learning"
    MEMORY_UPGRADE = "memory_upgrade"
    LAYERED_MEMORY = "layered_memory"


class BackgroundTaskStatus(StrEnum):
    """父任务的生命周期状态。"""

    QUEUED = "queued"
    RUNNING = "running"
    VERIFYING = "verifying"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class BackgroundTaskStepName(StrEnum):
    """导入、观察与删除任务允许出现的固定步骤。"""

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
    PROPOSE_SKILL = "propose_skill"
    VERIFY_SKILL_DRAFTS = "verify_skill_drafts"
    PREVIEW_UPGRADE = "preview_upgrade"
    VERIFY_UPGRADE_PREVIEW = "verify_upgrade_preview"
    APPLY_UPGRADE = "apply_upgrade"
    VERIFY_UPGRADE_APPLY = "verify_upgrade_apply"
    ORGANIZE_MEMORY = "organize_memory"


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

OBSERVATION_TASK_STEPS: tuple[
    tuple[BackgroundTaskStepName, int],
    ...,
] = (
    (BackgroundTaskStepName.EXTRACT_MEMORY, 1),
    (BackgroundTaskStepName.INDEX, 2),
    (BackgroundTaskStepName.VERIFY, 3),
)


DELETE_TASK_STEPS = tuple(enumerate((
    BackgroundTaskStepName.MARK_DELETED,
    BackgroundTaskStepName.DELETE_DERIVED,
    BackgroundTaskStepName.DELETE_INDEX,
    BackgroundTaskStepName.CLEAR_CACHE,
    BackgroundTaskStepName.VERIFY_NOT_RETRIEVABLE,
), start=1))

SKILL_LEARNING_STEPS = ((BackgroundTaskStepName.PROPOSE_SKILL, 1),
                       (BackgroundTaskStepName.VERIFY_SKILL_DRAFTS, 2))
VERIFY_STEPS = (BackgroundTaskStepName.VERIFY, BackgroundTaskStepName.VERIFY_NOT_RETRIEVABLE,
                BackgroundTaskStepName.VERIFY_SKILL_DRAFTS, BackgroundTaskStepName.VERIFY_UPGRADE_PREVIEW,
                BackgroundTaskStepName.VERIFY_UPGRADE_APPLY, BackgroundTaskStepName.ORGANIZE_MEMORY)


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
    source_document_id: UUID | None
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
    extraction_runtime_config: ExtractionRuntimeConfig | None = None

    def __post_init__(self) -> None:
        ids = (self.task_id, self.owner_id, self.contact_id)
        if any(not isinstance(value, UUID) for value in ids):
            raise TypeError("后台任务范围必须使用内部 UUID。")
        if not isinstance(self.task_type, BackgroundTaskType):
            raise TypeError("后台任务类型无效。")
        if self.task_type in (BackgroundTaskType.OBSERVATION, BackgroundTaskType.SKILL_LEARNING, BackgroundTaskType.MEMORY_UPGRADE, BackgroundTaskType.LAYERED_MEMORY):
            if self.source_document_id is not None:
                raise ValueError("观察任务不能绑定 source_document_id。")
        elif not isinstance(self.source_document_id, UUID):
            raise TypeError("导入或删除任务必须绑定 source_document_id。")
        if not isinstance(self.status, BackgroundTaskStatus):
            raise TypeError("后台任务状态无效。")
        if not isinstance(self.current_step, BackgroundTaskStepName):
            raise TypeError("后台任务当前步骤无效。")
        if self.message_count < 0:
            raise ValueError("后台任务消息数量无效。")
        if self.retry_count < 0:
            raise ValueError("后台任务重试数量无效。")
        if (self.extraction_runtime_config is not None
                and not isinstance(self.extraction_runtime_config, ExtractionRuntimeConfig)):
            raise ValueError("后台任务提取配置无效。")


@dataclass(frozen=True, slots=True)
class ClaimedBackgroundTaskStep:
    """Worker 获得的单个步骤租约，不携带聊天正文。"""

    task_id: UUID
    owner_id: UUID
    contact_id: UUID
    source_document_id: UUID | None
    step_id: UUID
    name: BackgroundTaskStepName
    worker_id: UUID
    attempt_count: int
    message_count: int
    lease_expires_at: datetime
    lease_generation: int = 0
    extraction_runtime_config: ExtractionRuntimeConfig | None = None

    def __post_init__(self) -> None:
        if (self.extraction_runtime_config is not None
                and not isinstance(self.extraction_runtime_config, ExtractionRuntimeConfig)):
            raise ValueError("后台步骤提取配置无效。")
