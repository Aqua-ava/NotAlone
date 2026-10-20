"""探索的派生结果与应用端口；当前输入身份始终由助手会话提供。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Protocol
from uuid import UUID

from notalone.reply.exploration import ExplorationInput
from notalone.reply.exploration_context import EvidenceSnapshot
from notalone.reply.exploration_skill import ExplorationSkillSelection
from notalone.reply.interface import DirectionSource, NoSkill, UserSkillChoice
from notalone.scopes import ContactScope

if TYPE_CHECKING:
    from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt


class ExplorationReadPurpose(StrEnum):
    """接续须是A当前输入；历史只供幂等应答核验，不授权新执行。"""

    CURRENT = "current"
    CONTINUE = "continue"
    HISTORY = "history"


@dataclass(frozen=True, slots=True, repr=False)
class ExplorationOpen:
    session_id: UUID
    content: ExplorationInput
    operation_key: UUID
    expected_input_version_id: UUID | None = None
    previous_id: UUID | None = None
    automatic: bool = False
    change_group: bool = False
    question_id: UUID | None = None

    def __post_init__(self) -> None:
        if (not isinstance(self.session_id, UUID) or not isinstance(self.operation_key, UUID)
                or not isinstance(self.content, ExplorationInput)
                or self.expected_input_version_id is not None and not isinstance(self.expected_input_version_id, UUID)
                or self.previous_id is not None and not isinstance(self.previous_id, UUID)
                or self.question_id is not None and not isinstance(self.question_id, UUID)
                or not isinstance(self.automatic, bool) or not isinstance(self.change_group, bool)):
            raise ValueError("探索请求身份或更新模式无效。")


@dataclass(frozen=True, slots=True, repr=False)
class ExplorationTask:
    exploration_id: UUID
    scope: ContactScope
    session_id: UUID
    input_version_id: UUID
    operation_key: UUID
    request_key: UUID
    content: ExplorationInput
    snapshots: tuple[EvidenceSnapshot, ...]
    intent_snapshots: tuple[EvidenceSnapshot, ...]
    skill_library_revision: int
    skill_version_id: UUID | None
    root_created_at: datetime
    automatic_call_count: int = 0
    state: str = "running"
    result: dict[str, Any] | None = None
    selected_intent: str | None = None
    selection_id: UUID | None = None
    selection_source: DirectionSource | None = None
    skill_selection_complete: bool = True

    @property
    def has_confirmed_intent(self) -> bool:
        return (bool(self.selected_intent) and isinstance(self.selection_id, UUID)
                and isinstance(self.selection_source, DirectionSource))


@dataclass(frozen=True, slots=True, repr=False)
class ExplorationGeneration:
    task: ExplorationTask
    intent: str
    source: DirectionSource
    skill: NoSkill | UserSkillChoice


@dataclass(frozen=True, slots=True, repr=False)
class ExplorationCompletedInput:
    """只读A已完成请求的原输入；不恢复探索正文或当前指针。"""

    exploration_id: UUID
    request_key: UUID
    input_payload: dict[str, Any]


class ExplorationGenerationPort(Protocol):
    def prepare(self, command: ExplorationGeneration) -> AssistantGenerationReceipt: ...

    def prepare_replay(
        self, scope: ContactScope, session_id: UUID, completed: ExplorationCompletedInput,
    ) -> AssistantGenerationReceipt: ...

    def generate(self, command: ExplorationGeneration) -> Any: ...

    def replay(self, scope: ContactScope, session_id: UUID, completed: ExplorationCompletedInput) -> Any: ...


class ExplorationStore(Protocol):
    """存储复用A的当前输入核验；begin需原子保存A输入与操作键。"""

    def replay(self, scope: ContactScope, request: ExplorationOpen) -> ExplorationTask | None: ...

    def read(
        self, scope: ContactScope, exploration_id: UUID,
        *, purpose: ExplorationReadPurpose = ExplorationReadPurpose.CURRENT,
    ) -> ExplorationTask: ...

    def begin(
        self, *, scope: ContactScope, request: ExplorationOpen,
        snapshots: tuple[EvidenceSnapshot, ...], skill: ExplorationSkillSelection,
        previous: ExplorationTask | None,
    ) -> ExplorationTask: ...

    def complete(
        self, task: ExplorationTask, result: dict[str, Any],
    ) -> ExplorationTask: ...

    def pin_skill(self, task: ExplorationTask, version_id: UUID | None) -> ExplorationTask: ...

    def select(
        self, scope: ContactScope, exploration_id: UUID, input_version_id: UUID,
        *, suggestion_id: UUID | None, direct_intent: str | None,
    ) -> ExplorationTask: ...

    def reconfirm(
        self, scope: ContactScope, session_id: UUID, exploration_id: UUID, input_version_id: UUID,
        *, expected_input_version_id: UUID, request_key: UUID,
        suggestion_id: UUID | None, direct_intent: str | None,
    ) -> ExplorationTask: ...

    def finish(self, task: ExplorationTask) -> None: ...

    def fail(self, task: ExplorationTask) -> None: ...

    def retry(self, task: ExplorationTask) -> ExplorationTask: ...

    def stop(self, scope: ContactScope, exploration_id: UUID, input_version_id: UUID) -> None: ...

    def replay_confirmation(
        self, scope: ContactScope, session_id: UUID, exploration_id: UUID, input_version_id: UUID,
        *, suggestion_id: UUID | None, direct_intent: str | None,
    ) -> ExplorationCompletedInput | None: ...

    def replay_answer(
        self, scope: ContactScope, session_id: UUID, exploration_id: UUID, input_version_id: UUID,
        *, question_id: UUID, answer: str, operation_key: UUID,
    ) -> ExplorationCompletedInput | None: ...
