"""候选回复 Context 的统一契约和 Retrieval 适配器。"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable, Literal, Protocol, TypeVar, get_args
from uuid import UUID, uuid4

from notalone.memory.timing import MemoryTiming
from notalone.reply.errors import (
    ReplyContextError,
    ReplyContextInvariantError,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    GenerateReply,
    InitiateConversation,
    ReplyToMessage,
    RewriteDraft,
)
from notalone.reply.risk import DeterministicRiskHints, RiskHintPort
from notalone.retrieval import (
    RetrievalError,
    RetrievalPort,
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
    RetrievedPendingCandidate,
)
from notalone.retrieval.lexical import RELEVANCE_THRESHOLD
from notalone.scopes import ContactScope, VerifiedConversationScope


CONTACT_MEMORY_LIMIT = 5
CONTACT_MEMORY_CHAR_BUDGET = 600
OWNER_MEMORY_LIMIT = 3
OWNER_MEMORY_CHAR_BUDGET = 240
# 待确认候选使用独立预算：联系人确认记忆的 5 条/600 字符不因此改变。
PENDING_CANDIDATE_LIMIT = 3
PENDING_CANDIDATE_CHAR_BUDGET = 300
# 强制未确认标注：候选正文只能作为提问、确认或留余地的参考。
PENDING_CANDIDATE_SELECTION_REASON = "未确认候选、仅供参考、不得当作事实。"
PENDING_CANDIDATE_STATUS = "pending"
# 回复链路的取数查询都要有界：数值与历史 Tool 的默认超时保持一致，
# 避免连接池或慢查询把整次生成挂住。
RETRIEVAL_TIMEOUT_MS = 500

# 证据类型与状态的单一契约：reply/context、reply/generator、reply/store 与
# persistence/reply_store 都引用这里的常量，不再各自复制白名单字面量。
# 迁移 `037_pending_candidate_evidence_kind.sql` 的 SQL 列表必须与
# ``EVIDENCE_KINDS`` 保持一致（SQL 无法引用 Python 常量，故手写并注明来源）。
EvidenceKind = Literal[
    "message",
    "confirmed_memory",
    "owner_memory",
    "user_draft",
    "user_purpose",
    "continued_candidate",
    "pending_candidate",
]
EVIDENCE_KINDS: tuple[EvidenceKind, ...] = get_args(EvidenceKind)

EvidenceStatus = Literal["active", "user_input", "candidate", "pending"]
EVIDENCE_STATUSES: tuple[EvidenceStatus, ...] = get_args(EvidenceStatus)
EVIDENCE_STATUSES_BY_KIND: dict[EvidenceKind, frozenset[str]] = {
    "message": frozenset({"active"}),
    "confirmed_memory": frozenset({"active"}),
    "owner_memory": frozenset({"active"}),
    "user_draft": frozenset({"active", "user_input"}),
    "user_purpose": frozenset({"user_input"}),
    "continued_candidate": frozenset({"active", "candidate"}),
    # 待确认候选只能带 pending 状态进入模型和持久化边界；它不得被当成
    # 已确认资料，也不能借用 active 状态冒充事实。
    "pending_candidate": frozenset({PENDING_CANDIDATE_STATUS}),
}


def evidence_contract_is_valid(
    *,
    kind: str,
    status: str,
    selection_reason: str,
) -> bool:
    """证据 kind/status 与强制未确认标注的统一契约。

    ``pending_candidate`` 必须同时满足两个条件：状态是 ``pending``，且
    ``selection_reason`` 以 ``PENDING_CANDIDATE_SELECTION_REASON`` 开头。
    只在构造点拼串不够——伪造标注（例如状态仍是 pending、理由却写成
    「已确认」）必须在上下文组装、生成边界和两个落库边界都被拒绝。
    """

    if kind not in EVIDENCE_KINDS or status not in EVIDENCE_STATUSES:
        return False
    if status not in EVIDENCE_STATUSES_BY_KIND[kind]:
        return False
    if kind == "pending_candidate":
        return selection_reason.startswith(PENDING_CANDIDATE_SELECTION_REASON)
    return True


def pending_candidate_selection_reason(
    candidate: RetrievedPendingCandidate,
) -> str:
    """待确认候选的解释理由：强制未确认标注 + 这条候选为什么待确认。

    ``selection_reason`` 已落库并进入模型 payload，所以候选的置信度、
    风险标记、分类与主题必须并入这段文本，而不是只留在证据对象上。
    前半段（标注 + 候选自身属性）是稳定前缀，``validate_current`` 用它
    比对重新读取到的候选是否仍是同一条。
    """

    flags = "、".join(candidate.risk_flags) or "无"
    reason = (
        f"{PENDING_CANDIDATE_SELECTION_REASON}"
        f"候选分类 {candidate.category}；主题 {candidate.topic or '未分类'}；"
        f"置信度 {float(candidate.confidence):.2f}；风险标记 {flags}。"
    )
    if candidate.relevance_score is not None:
        hits = "、".join(candidate.matched_terms) or "无"
        reason += (
            f"与当前正文相关度 {candidate.relevance_score:.2f}；"
            f"命中词 {hits}；排序按相关性优先。"
        )
    return reason


def allows_history(command: GenerateReply) -> bool:
    """回复消息可用历史；草稿润色只有本次明确要求背景时才可用。"""

    return isinstance(command.content, (ReplyToMessage, InitiateConversation)) or (
        isinstance(command.content, RewriteDraft)
        and command.content.include_relationship_context
    )


class _ScoredMemory(Protocol):
    """阈值与字符预算需要的最小记忆形状。"""

    @property
    def text(self) -> str: ...

    @property
    def relevance_score(self) -> float | None: ...


_MemoryT = TypeVar("_MemoryT", bound=_ScoredMemory)


@dataclass(frozen=True, slots=True, repr=False)
class ContextEvidence:
    """经范围校验后进入本次上下文的一项证据。"""

    evidence_id: UUID
    kind: EvidenceKind
    text: str
    scope: ContactScope
    source_ids: tuple[UUID, ...] = ()
    selection_reason: str = ""
    status: str = "active"
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    revision: int | None = None
    timing: MemoryTiming = MemoryTiming()

    def __post_init__(self) -> None:
        if not isinstance(self.timing, MemoryTiming):
            raise TypeError("回复依据时间结构无效。")


@dataclass(frozen=True, slots=True, repr=False)
class ToolCallTrace:
    """本轮只读 Tool 的最小审计摘要，不保存 Tool 原始返回全文。"""

    tool_name: str
    status: Literal[
        "succeeded",
        "empty",
        "failed",
        "timeout",
        "budget_exceeded",
    ]
    evidence_ids: tuple[UUID, ...] = ()
    latency_ms: int | None = None


@dataclass(frozen=True, slots=True, repr=False)
class ContinuedReplyCandidate:
    """用户明确选择后，允许进入新请求的历史候选引用。"""

    candidate_id: UUID
    scope: ContactScope
    conversation_binding_id: UUID
    text: str

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, UUID):
            raise TypeError("候选标识必须是 UUID。")
        if not isinstance(self.conversation_binding_id, UUID):
            raise TypeError("会话绑定标识必须是 UUID。")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("继续候选文本不能为空。")


@dataclass(frozen=True, slots=True, repr=False)
class ReplyContext:
    """一次生成实际可见的最小上下文快照。"""

    reply_request_id: UUID
    command: GenerateReply
    scope: ContactScope
    current_text: str
    direction: ConfirmedDirection | None
    evidence: tuple[ContextEvidence, ...]
    skill_library_revision: int
    risk_notes: tuple[str, ...] = ()
    memory_revision: int | None = None
    index_revision: int | None = None
    tool_calls: tuple[ToolCallTrace, ...] = ()

    def has_unauthorized_history(self) -> bool:
        """草稿和显式继续候选之外的历史证据是否超出本次请求权限。"""

        return (
            not allows_history(self.command)
            and any(
                item.kind
                in (
                    "message",
                    "confirmed_memory",
                    "owner_memory",
                    "pending_candidate",
                )
                for item in self.evidence
            )
        )


class ReplyContextFreshnessPort(Protocol):
    """重新确认快照中的依据和版本仍可用于本次生成的 seam。"""

    def validate_current(self, context: ReplyContext) -> None:
        """在模型调用前后验证当前联系人范围内的 live 状态。"""


class ReplyContextPort(Protocol):
    """Reply 入口使用的上下文组装 seam。"""

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        reply_request_id: UUID | None = None,
        continued_candidate: ContinuedReplyCandidate | None = None,
    ) -> ReplyContext:
        """在已验证联系人范围内形成上下文快照。"""


class ContactMemoryIndexPort(Protocol):
    """只提供 L1 版本快照；召回候选由 Retrieval 直接评分。"""

    def revision_snapshot(
        self,
        scope: ContactScope,
    ) -> tuple[int, int | None] | None:
        """返回当前 L1 revision 与目录构建 revision。"""


class RetrievalReplyContext:
    """通过独立 Retrieval 选择本次 Reply 可见证据的实现。"""

    __slots__ = (
        "_retrieval",
        "_skill_library_revision",
        "_id_factory",
        "_message_limit",
        "_memory_limit",
        "_memory_char_budget",
        "_owner_memory_limit",
        "_owner_memory_char_budget",
        "_pending_limit",
        "_pending_char_budget",
        "_memory_index",
        "_risk_hints",
        "_skill_revision_reader",
    )

    def __init__(
        self,
        *,
        retrieval: RetrievalPort,
        skill_library_revision: int,
        id_factory: Callable[[], UUID] = uuid4,
        message_limit: int = 50,
        memory_limit: int = CONTACT_MEMORY_LIMIT,
        memory_char_budget: int = CONTACT_MEMORY_CHAR_BUDGET,
        owner_memory_limit: int = OWNER_MEMORY_LIMIT,
        owner_memory_char_budget: int = OWNER_MEMORY_CHAR_BUDGET,
        pending_limit: int = PENDING_CANDIDATE_LIMIT,
        pending_char_budget: int = PENDING_CANDIDATE_CHAR_BUDGET,
        memory_index: ContactMemoryIndexPort | None = None,
        risk_hints: RiskHintPort | None = None,
        skill_revision_reader: Callable[[ContactScope], int] | None = None,
    ) -> None:
        if not isinstance(skill_library_revision, int) or skill_library_revision < 0:
            raise ValueError("Skill 库修订号无效。")
        if not isinstance(message_limit, int) or not 1 <= message_limit <= 50:
            raise ValueError("消息上下文预算无效。")
        if not isinstance(memory_limit, int) or not 1 <= memory_limit <= 20:
            raise ValueError("关系记忆上下文预算无效。")
        if (
            not isinstance(memory_char_budget, int)
            or not 1 <= memory_char_budget <= 10000
        ):
            raise ValueError("关系记忆字符预算无效。")
        if (
            not isinstance(owner_memory_limit, int)
            or not 1 <= owner_memory_limit <= 20
        ):
            raise ValueError("本人记忆上下文预算无效。")
        if (
            not isinstance(owner_memory_char_budget, int)
            or not 1 <= owner_memory_char_budget <= 10000
        ):
            raise ValueError("本人记忆字符预算无效。")
        if not isinstance(pending_limit, int) or not 1 <= pending_limit <= 20:
            raise ValueError("待确认候选上下文预算无效。")
        if (
            not isinstance(pending_char_budget, int)
            or not 1 <= pending_char_budget <= 10000
        ):
            raise ValueError("待确认候选字符预算无效。")
        self._retrieval = retrieval
        self._skill_library_revision = skill_library_revision
        self._id_factory = id_factory
        self._message_limit = message_limit
        self._memory_limit = memory_limit
        self._memory_char_budget = memory_char_budget
        self._owner_memory_limit = owner_memory_limit
        self._owner_memory_char_budget = owner_memory_char_budget
        self._pending_limit = pending_limit
        self._pending_char_budget = pending_char_budget
        self._memory_index = memory_index
        self._risk_hints = risk_hints or DeterministicRiskHints()
        if skill_revision_reader is not None and not callable(skill_revision_reader):
            raise TypeError("Skill revision 读取器必须是 callable。")
        self._skill_revision_reader = skill_revision_reader

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        reply_request_id: UUID | None = None,
        continued_candidate: ContinuedReplyCandidate | None = None,
    ) -> ReplyContext:
        scope = self._validate_request(command, verified_scope)
        request_id = (
            self._new_id()
            if reply_request_id is None
            else self._validate_request_id(reply_request_id)
        )
        continuation = self._continuation_evidence(
            command=command,
            verified_scope=verified_scope,
            candidate=continued_candidate,
        )

        if isinstance(command.content, ReplyToMessage):
            messages = self._search_messages(
                scope=scope,
                target_message_id=command.content.target_message_id,
            )
            target = tuple(
                message
                for message in messages
                if message.message_id == command.content.target_message_id
            )
            if len(target) != 1:
                raise ReplyContextInvariantError(
                    "待回复消息未在当前联系人范围内找到。"
                )
            evidence = list(
                self._message_evidence(message, is_target=message is target[0])
                for message in messages
            ) + self._related_memory_evidence(scope=scope, query=target[0].text)
            if continuation is not None:
                evidence.append(continuation)
            self._validate_evidence(evidence, scope=scope)
            memory_revision, index_revision = self._version_snapshot(scope)
            return ReplyContext(
                reply_request_id=request_id,
                command=command,
                scope=scope,
                current_text=target[0].text,
                direction=command.content.direction,
                evidence=tuple(evidence),
                skill_library_revision=self._current_skill_revision(scope),
                risk_notes=self._risk_notes(command, target[0].text),
                memory_revision=memory_revision,
                index_revision=index_revision,
            )

        if isinstance(command.content, InitiateConversation):
            purpose = command.content.purpose
            evidence = [ContextEvidence(
                evidence_id=self._new_id(), kind="user_purpose", text=purpose.text,
                scope=scope, selection_reason="用户本次明确的主动联系目的。",
                status="user_input",
            )]
            evidence.extend(
                self._message_evidence(message, is_target=False)
                for message in self._search_messages(scope=scope)
            )
            evidence.extend(self._related_memory_evidence(scope=scope, query=purpose.text))
            if continuation is not None:
                evidence.append(continuation)
            self._validate_evidence(evidence, scope=scope)
            memory_revision, index_revision = self._version_snapshot(scope)
            return ReplyContext(
                reply_request_id=request_id, command=command, scope=scope,
                current_text=purpose.text, direction=purpose, evidence=tuple(evidence),
                skill_library_revision=self._current_skill_revision(scope),
                risk_notes=self._risk_notes(command, purpose.text),
                memory_revision=memory_revision, index_revision=index_revision,
            )

        if isinstance(command.content, RewriteDraft):
            evidence = [
                ContextEvidence(
                    evidence_id=self._new_id(),
                    kind="user_draft",
                    text=command.content.draft_text,
                    scope=scope,
                    selection_reason=(
                        "用户原句是改写模式的唯一默认输入。"
                    ),
                    status="user_input",
                )
            ]
            if allows_history(command):
                evidence.extend(self._related_memory_evidence(scope=scope, query=command.content.draft_text))
            if continuation is not None:
                evidence.append(continuation)
            self._validate_evidence(evidence, scope=scope)
            memory_revision, index_revision = self._version_snapshot(scope)
            return ReplyContext(
                reply_request_id=request_id,
                command=command,
                scope=scope,
                current_text=command.content.draft_text,
                direction=None,
                evidence=tuple(evidence),
                skill_library_revision=self._current_skill_revision(scope),
                risk_notes=self._risk_notes(
                    command,
                    command.content.draft_text,
                ),
                memory_revision=memory_revision,
                index_revision=index_revision,
            )

        raise ReplyContextInvariantError("回复输入模式无效。")

    def _related_memory_evidence(self, *, scope: ContactScope, query: str) -> list[ContextEvidence]:
        """共享三类有界资料召回，是否允许历史仍由各场景决定。"""

        return [
            self._memory_evidence(memory)
            for memory in self._search_memories_or_empty(scope=scope, query=query)
        ] + [
            self._owner_memory_evidence(memory, scope=scope)
            for memory in self._search_owner_memories_or_empty(scope=scope, query=query)
        ] + [
            self._pending_candidate_evidence(candidate, scope=scope)
            for candidate in self._search_pending_candidates_or_empty(scope=scope, query=query)
        ]

    def _current_skill_revision(self, scope: ContactScope) -> int:
        """build 盖章"当下"的 skill 库修订号。

        构造参数里的 revision 只是进程启动时的快照（或无 reader 时的
        回退值）；装配层传入 reader 时必须现场读取，否则 skill 库在
        进程启动后发生任何变更，都会让后续所有请求的
        ``validate_current`` 永远失败。
        """

        if self._skill_revision_reader is None:
            return self._skill_library_revision
        revision = self._skill_revision_reader(scope)
        if not isinstance(revision, int) or revision < 0:
            raise ReplyContextInvariantError("Skill revision 结构无效。")
        return revision

    def validate_current(self, context: ReplyContext) -> None:
        """在生成前后重新读取依据，阻止删除或 revision 变化后的旧快照继续生效。"""

        if not isinstance(context, ReplyContext):
            raise ReplyContextInvariantError("回复上下文快照结构无效。")
        if context.has_unauthorized_history():
            raise ReplyContextInvariantError("当前改写不能使用历史资料。")
        scope = context.scope
        self._validate_evidence(context.evidence, scope=scope)

        memory_revision, index_revision = self._version_snapshot(scope)
        if context.memory_revision is not None and (
            memory_revision is None
            or memory_revision != context.memory_revision
        ):
            raise ReplyContextInvariantError("关系记忆 revision 已变化。")
        if context.index_revision is not None and (
            index_revision is None
            or index_revision != context.index_revision
        ):
            raise ReplyContextInvariantError("关系记忆目录 revision 已变化。")

        if self._skill_revision_reader is not None:
            try:
                current_skill_revision = self._skill_revision_reader(scope)
            except Exception:
                raise ReplyContextError("Skill revision 重新读取失败。") from None
            if not isinstance(current_skill_revision, int) or current_skill_revision < 0:
                raise ReplyContextInvariantError("Skill revision 结构无效。")
            if current_skill_revision != context.skill_library_revision:
                raise ReplyContextInvariantError("Skill revision 已变化。")

        now = datetime.now(timezone.utc)
        for item in context.evidence:
            if item.kind == "message":
                self._validate_current_message(item, now=now)
            elif item.kind == "confirmed_memory":
                self._validate_current_memory(item, now=now)
            elif item.kind == "owner_memory":
                self._validate_current_owner_memory(item, now=now)
            elif item.kind == "pending_candidate":
                self._validate_current_pending_candidate(item, now=now)

    def _validate_current_message(
        self,
        evidence: ContextEvidence,
        *,
        now: datetime,
    ) -> None:
        if not evidence.source_ids:
            raise ReplyContextInvariantError("回复消息依据缺少来源。")
        try:
            messages = self._retrieval.search_messages(
                scope=evidence.scope,
                target_message_id=evidence.evidence_id,
                query=None,
                limit=1,
                timeout_ms=RETRIEVAL_TIMEOUT_MS,
            )
        except ReplyContextError:
            raise
        except Exception:
            raise ReplyContextError("回复消息依据重新读取失败。") from None
        if not isinstance(messages, tuple) or any(
            not isinstance(message, RetrievedMessage)
            or message.scope != evidence.scope
            for message in messages
        ):
            raise ReplyContextInvariantError("回复消息依据超出联系人范围。")
        matched = tuple(
            message
            for message in messages
            if message.message_id == evidence.evidence_id
        )
        if len(matched) != 1:
            raise ReplyContextInvariantError("回复消息依据已删除或不可用。")
        message = matched[0]
        if (
            not self._is_current(message.status, message.valid_at, message.invalid_at, now)
            or message.text != evidence.text
            or set(message.source_ids) != set(evidence.source_ids)
            or len(message.source_ids) != len(evidence.source_ids)
            or message.valid_at != evidence.valid_at
            or message.invalid_at != evidence.invalid_at
            or message.status != evidence.status
            or MemoryTiming.from_source_times((message.occurred_at,)) != evidence.timing
        ):
            raise ReplyContextInvariantError("回复消息依据已失效或版本不一致。")

    def _validate_current_memory(
        self,
        evidence: ContextEvidence,
        *,
        now: datetime,
    ) -> None:
        if not evidence.source_ids or evidence.revision is None:
            raise ReplyContextInvariantError("关系记忆依据缺少来源或 revision。")
        try:
            memories = self._retrieval.search_confirmed_memories(
                scope=evidence.scope,
                query=None,
                limit=1,
                memory_ids=(evidence.evidence_id,),
            )
        except ReplyContextError:
            raise
        except Exception:
            raise ReplyContextError("关系记忆依据重新读取失败。") from None
        if not isinstance(memories, tuple) or any(
            not isinstance(memory, RetrievedMemory)
            or memory.scope != evidence.scope
            for memory in memories
        ):
            raise ReplyContextInvariantError("关系记忆依据超出联系人范围。")
        if len(memories) != 1:
            raise ReplyContextInvariantError("关系记忆依据已删除或不可用。")
        memory = memories[0]
        if (
            not self._is_current(memory.status, memory.valid_at, memory.invalid_at, now)
            or memory.text != evidence.text
            or set(memory.source_ids) != set(evidence.source_ids)
            or len(memory.source_ids) != len(evidence.source_ids)
            or memory.revision != evidence.revision
            or memory.valid_at != evidence.valid_at
            or memory.invalid_at != evidence.invalid_at
            or memory.status != evidence.status
            or memory.timing != evidence.timing
        ):
            raise ReplyContextInvariantError("关系记忆依据已失效或版本不一致。")

    def _validate_current_owner_memory(
        self,
        evidence: ContextEvidence,
        *,
        now: datetime,
    ) -> None:
        if not evidence.source_ids or evidence.revision is None:
            raise ReplyContextInvariantError("本人记忆依据缺少来源或 revision。")
        try:
            memories = self._retrieval.search_owner_memories(
                owner_id=evidence.scope.owner_id,
                query=None,
                limit=1,
                memory_ids=(evidence.evidence_id,),
            )
        except ReplyContextError:
            raise
        except Exception:
            raise ReplyContextError("本人记忆依据重新读取失败。") from None
        if not isinstance(memories, tuple) or any(
            not isinstance(memory, RetrievedOwnerMemory)
            or memory.owner_id != evidence.scope.owner_id
            for memory in memories
        ):
            raise ReplyContextInvariantError("本人记忆依据超出 owner 范围。")
        if len(memories) != 1:
            raise ReplyContextInvariantError("本人记忆依据已删除或不可用。")
        memory = memories[0]
        if (
            not self._is_current(memory.status, memory.valid_at, memory.invalid_at, now)
            or memory.text != evidence.text
            or set(memory.source_ids) != set(evidence.source_ids)
            or len(memory.source_ids) != len(evidence.source_ids)
            or memory.revision != evidence.revision
            or memory.valid_at != evidence.valid_at
            or memory.invalid_at != evidence.invalid_at
            or memory.status != evidence.status
            or memory.timing != evidence.timing
        ):
            raise ReplyContextInvariantError("本人记忆依据已失效或版本不一致。")

    @staticmethod
    def _is_current(
        status: str,
        valid_at: datetime | None,
        invalid_at: datetime | None,
        now: datetime,
        *,
        expected_status: str = "active",
    ) -> bool:
        """状态仍等于期望值，且 ``now`` 落在半开区间 ``[valid_at, invalid_at)``。

        消息、已确认记忆、本人记忆与待确认候选共用这一个 helper：差别只是
        期望状态字面量，不再维护两份只差一个常量的实现。
        """

        try:
            return (
                status == expected_status
                and (valid_at is None or valid_at <= now)
                and (invalid_at is None or now < invalid_at)
            )
        except TypeError:
            return False

    def _validate_current_pending_candidate(
        self,
        evidence: ContextEvidence,
        *,
        now: datetime,
    ) -> None:
        """重新确认候选仍是同一联系人范围内的 pending 候选。

        已确认、已否决、已失效、超出有效期、来源不可用或超出范围的候选
        都视为不可继续使用；强制未确认标注也要与重新读取到的候选一致，
        理由被改写（例如写成「已确认」或换了另一条候选的属性）即拒绝本轮。
        """

        if not evidence.source_ids or evidence.revision is not None:
            raise ReplyContextInvariantError("待确认候选依据缺少来源或带有版本号。")
        try:
            candidates = self._search_pending_candidates(
                scope=evidence.scope,
                candidate_ids=(evidence.evidence_id,),
            )
        except ReplyContextError:
            raise
        except Exception:
            raise ReplyContextError("待确认候选依据重新读取失败。") from None
        matched = tuple(
            candidate
            for candidate in candidates
            if candidate.candidate_id == evidence.evidence_id
        )
        if len(matched) != 1:
            raise ReplyContextInvariantError(
                "待确认候选依据已确认、否决、失效或不可用。"
            )
        candidate = matched[0]
        # 复验读取不带 query，因此只比对稳定前缀：强制未确认标注 +
        # 候选自身的分类、主题、置信度与风险标记。
        expected_reason = pending_candidate_selection_reason(
            replace(candidate, relevance_score=None, matched_terms=())
        )
        if (
            not self._is_current(
                candidate.status,
                candidate.valid_at,
                candidate.invalid_at,
                now,
                expected_status=PENDING_CANDIDATE_STATUS,
            )
            or candidate.text != evidence.text
            or set(candidate.source_ids) != set(evidence.source_ids)
            or len(candidate.source_ids) != len(evidence.source_ids)
            or candidate.valid_at != evidence.valid_at
            or candidate.invalid_at != evidence.invalid_at
            or candidate.status != evidence.status
            or candidate.timing != evidence.timing
            or not evidence.selection_reason.startswith(expected_reason)
        ):
            raise ReplyContextInvariantError(
                "待确认候选依据已失效或版本不一致。"
            )

    @staticmethod
    def _validate_request(
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ContactScope:
        if not (
            isinstance(command, GenerateReply)
            and isinstance(verified_scope, VerifiedConversationScope)
            and command.has_valid_content()
            and command.matches_verified_scope(verified_scope)
        ):
            raise ReplyContextInvariantError("回复请求范围未通过验证。")
        return ContactScope(verified_scope.owner_id, verified_scope.contact_id)

    def _search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        try:
            messages = self._retrieval.search_messages(
                scope=scope,
                target_message_id=target_message_id,
                query=None,
                limit=self._message_limit,
                timeout_ms=RETRIEVAL_TIMEOUT_MS,
            )
        except RetrievalError:
            raise ReplyContextError("联系人消息检索失败。") from None
        except Exception:
            raise ReplyContextError("联系人消息检索失败。") from None
        if not isinstance(messages, tuple) or any(
            not isinstance(message, RetrievedMessage) or message.scope != scope
            for message in messages
        ):
            raise ReplyContextInvariantError(
                "消息检索结果超出联系人范围。"
            )
        return messages

    def _search_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        try:
            memories = self._retrieval.search_confirmed_memories(
                scope=scope,
                query=query,
                limit=self._memory_limit,
            )
        except RetrievalError:
            raise ReplyContextError("联系人关系记忆检索失败。") from None
        except Exception:
            raise ReplyContextError("联系人关系记忆检索失败。") from None
        if not isinstance(memories, tuple) or any(
            not isinstance(memory, RetrievedMemory) or memory.scope != scope
            for memory in memories
        ):
            raise ReplyContextInvariantError(
                "关系记忆检索结果超出联系人范围。"
            )
        return self._select_memories(
            memories,
            limit=self._memory_limit,
            char_budget=self._memory_char_budget,
        )

    def _search_owner_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        try:
            memories = self._retrieval.search_owner_memories(
                owner_id=scope.owner_id,
                query=query,
                limit=self._owner_memory_limit,
            )
        except RetrievalError:
            raise ReplyContextError("本人记忆检索失败。") from None
        except Exception:
            raise ReplyContextError("本人记忆检索失败。") from None
        if not isinstance(memories, tuple) or any(
            not isinstance(memory, RetrievedOwnerMemory)
            or memory.owner_id != scope.owner_id
            for memory in memories
        ):
            raise ReplyContextInvariantError("本人记忆检索结果超出 owner 范围。")
        return self._select_memories(
            memories,
            limit=self._owner_memory_limit,
            char_budget=self._owner_memory_char_budget,
        )

    def _search_pending_candidates(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        candidate_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedPendingCandidate, ...]:
        """读取待确认候选轨；适配器必须实现协议声明的这条轨。"""

        try:
            # 直接调用协议方法：缺失即契约破坏，必须失败关闭，不能用
            # getattr 探测后静默当成「没有候选」。
            searcher = self._retrieval.search_pending_candidates
        except AttributeError:
            raise ReplyContextInvariantError(
                "检索适配器未实现待确认候选轨。"
            ) from None
        try:
            if candidate_ids is None:
                candidates = searcher(
                    scope=scope,
                    query=query,
                    limit=self._pending_limit,
                )
            else:
                candidates = searcher(
                    scope=scope,
                    query=None,
                    limit=max(1, len(candidate_ids)),
                    candidate_ids=candidate_ids,
                )
        except RetrievalError:
            raise ReplyContextError("待确认候选检索失败。") from None
        except Exception:
            raise ReplyContextError("待确认候选检索失败。") from None
        if not isinstance(candidates, tuple) or any(
            not isinstance(candidate, RetrievedPendingCandidate)
            or candidate.scope != scope
            for candidate in candidates
        ):
            raise ReplyContextInvariantError(
                "待确认候选检索结果超出联系人范围。"
            )
        return self._select_memories(
            candidates,
            limit=self._pending_limit,
            char_budget=self._pending_char_budget,
        )

    def _search_pending_candidates_or_empty(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
    ) -> tuple[RetrievedPendingCandidate, ...]:
        """待确认候选不可用时安全降级，不阻断消息和已确认资料。

        只有可用性故障才降级；检索结果越界属于联系人隔离失效，必须
        fail closed，不能静默当成「没有候选」。
        """

        try:
            return self._search_pending_candidates(scope=scope, query=query)
        except ReplyContextInvariantError:
            raise
        except ReplyContextError:
            return ()

    def _select_memories(
        self,
        memories: tuple[_MemoryT, ...],
        *,
        limit: int,
        char_budget: int,
    ) -> tuple[_MemoryT, ...]:
        """按相关性阈值与字符预算保留排序前缀，不截断单条正文。"""

        selected: list[_MemoryT] = []
        used_chars = 0
        for memory in memories:
            if memory.relevance_score is not None and (
                memory.relevance_score < RELEVANCE_THRESHOLD
            ):
                continue
            if len(selected) >= limit:
                break
            if used_chars + len(memory.text) > char_budget:
                break
            selected.append(memory)
            used_chars += len(memory.text)
        return tuple(selected)

    def _search_memories_or_empty(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        """关系记忆缺失时安全降级，不阻断当前消息和近期对话。"""

        try:
            return self._search_memories(scope=scope, query=query)
        except ReplyContextError:
            return ()

    def _search_owner_memories_or_empty(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        """本人记忆缺失时安全降级，不阻断当前消息和近期对话。"""

        try:
            return self._search_owner_memories(scope=scope, query=query)
        except ReplyContextError:
            return ()

    def _version_snapshot(self, scope: ContactScope) -> tuple[int | None, int | None]:
        if self._memory_index is None:
            return (None, None)
        snapshot_reader = getattr(self._memory_index, "revision_snapshot", None)
        if not callable(snapshot_reader):
            return (None, None)
        try:
            snapshot = snapshot_reader(scope)
        except Exception:
            # 与校验阶段保持一致：读不到 revision 就不能当成“没有变化”，
            # 否则瞬时故障会让本轮缺少粗粒度 tripwire。
            raise ReplyContextError("关系记忆 revision 读取失败。") from None
        if snapshot is None:
            return (None, None)
        if (
            not isinstance(snapshot, tuple)
            or len(snapshot) != 2
            or not isinstance(snapshot[0], int)
            or snapshot[0] < 0
            or (
                snapshot[1] is not None
                and (not isinstance(snapshot[1], int) or snapshot[1] < 0)
            )
        ):
            raise ReplyContextInvariantError("记忆目录版本快照结构无效。")
        return snapshot

    def _new_id(self) -> UUID:
        try:
            value = self._id_factory()
        except Exception:
            raise ReplyContextError("回复上下文标识生成失败。") from None
        if not isinstance(value, UUID):
            raise ReplyContextInvariantError("回复上下文标识结构无效。")
        return value

    @staticmethod
    def _validate_request_id(value: UUID) -> UUID:
        if not isinstance(value, UUID):
            raise ReplyContextInvariantError("回复请求标识结构无效。")
        return value

    @staticmethod
    def _continuation_evidence(
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        candidate: ContinuedReplyCandidate | None,
    ) -> ContextEvidence | None:
        candidate_id = command.continued_from_candidate_id
        if candidate_id is None and candidate is not None:
            raise ReplyContextInvariantError(
                "历史候选必须由用户显式选择。"
            )
        if candidate_id is not None and candidate is None:
            raise ReplyContextInvariantError("显式继续候选未找到。")
        if candidate is None:
            return None
        expected_scope = ContactScope(
            verified_scope.owner_id,
            verified_scope.contact_id,
        )
        if (
            candidate.candidate_id != candidate_id
            or candidate.scope != expected_scope
            or candidate.conversation_binding_id
            != verified_scope.conversation_binding_id
        ):
            raise ReplyContextInvariantError(
                "历史候选超出当前联系人会话范围。"
            )
        return ContextEvidence(
            evidence_id=candidate.candidate_id,
            kind="continued_candidate",
            text=candidate.text,
            scope=expected_scope,
            selection_reason="用户明确选择的历史候选。",
            status="candidate",
        )

    @staticmethod
    def _validate_evidence(
        evidence: tuple[ContextEvidence, ...] | list[ContextEvidence],
        *,
        scope: ContactScope,
    ) -> None:
        evidence_ids: set[UUID] = set()
        for item in evidence:
            if (
                not isinstance(item, ContextEvidence)
                or item.scope != scope
                or not isinstance(item.evidence_id, UUID)
                or item.evidence_id in evidence_ids
                or not isinstance(item.text, str)
                or not item.text.strip()
                or not isinstance(item.source_ids, tuple)
                or any(not isinstance(source_id, UUID) for source_id in item.source_ids)
                or not isinstance(item.selection_reason, str)
                or not isinstance(item.status, str)
                or not item.status.strip()
                or not evidence_contract_is_valid(
                    kind=item.kind,
                    status=item.status,
                    selection_reason=item.selection_reason,
                )
                or item.revision is not None
                and (
                    not isinstance(item.revision, int)
                    or item.revision < 1
                )
            ):
                raise ReplyContextInvariantError("回复证据结构或范围无效。")
            evidence_ids.add(item.evidence_id)

    def _risk_notes(self, command: GenerateReply, current_text: str) -> tuple[str, ...]:
        if isinstance(command.content, ReplyToMessage):
            text = f"{current_text}\n{command.content.direction.text}"
        elif isinstance(command.content, InitiateConversation):
            text = command.content.purpose.text
        elif isinstance(command.content, RewriteDraft):
            text = "\n".join(
                value
                for value in (
                    current_text,
                    command.content.user_instruction or "",
                )
                if value
            )
        else:
            raise ReplyContextInvariantError("回复输入模式无效。")
        try:
            notes = self._risk_hints.assess(text)
        except Exception:
            raise ReplyContextError("回复风险提示评估失败。") from None
        if not isinstance(notes, tuple) or any(
            not isinstance(note, str) or not note.strip() for note in notes
        ):
            raise ReplyContextInvariantError("回复风险提示结构无效。")
        return notes

    @staticmethod
    def _message_evidence(
        message: RetrievedMessage,
        *,
        is_target: bool,
    ) -> ContextEvidence:
        return ContextEvidence(
            evidence_id=message.message_id,
            kind="message",
            text=message.text,
            scope=message.scope,
            source_ids=message.source_ids,
            selection_reason=(
                "待回复消息。"
                if is_target
                else "同一联系人范围内的近期消息。"
            ),
            status=message.status,
            valid_at=message.valid_at,
            invalid_at=message.invalid_at,
            timing=MemoryTiming.from_source_times((message.occurred_at,)),
        )

    @staticmethod
    def _memory_evidence(memory: RetrievedMemory) -> ContextEvidence:
        selection_reason = "已确认且当前有效的联系人关系记忆。"
        if memory.relevance_score is not None:
            hits = "、".join(memory.matched_terms) or "无"
            selection_reason = (
                f"与当前正文相关度 {memory.relevance_score:.2f}；"
                f"命中词 {hits}；排序按相关性优先；"
                f"已确认且当前有效的联系人关系记忆。"
            )
        return ContextEvidence(
            evidence_id=memory.memory_id,
            kind="confirmed_memory",
            text=memory.text,
            scope=memory.scope,
            source_ids=memory.source_ids,
            selection_reason=selection_reason,
            status=memory.status,
            valid_at=memory.valid_at,
            invalid_at=memory.invalid_at,
            revision=memory.revision,
            timing=memory.timing,
        )

    @staticmethod
    def _owner_memory_evidence(
        memory: RetrievedOwnerMemory,
        *,
        scope: ContactScope,
    ) -> ContextEvidence:
        selection_reason = "已确认且当前有效的本人记忆。"
        if memory.relevance_score is not None:
            hits = "、".join(memory.matched_terms) or "无"
            selection_reason = (
                f"与当前正文相关度 {memory.relevance_score:.2f}；"
                f"命中词 {hits}；排序按相关性优先；"
                f"已确认且当前有效的本人记忆。"
            )
        return ContextEvidence(
            evidence_id=memory.memory_id,
            kind="owner_memory",
            text=memory.text,
            scope=scope,
            source_ids=memory.source_ids,
            selection_reason=selection_reason,
            status=memory.status,
            valid_at=memory.valid_at,
            invalid_at=memory.invalid_at,
            revision=memory.revision,
            timing=memory.timing,
        )

    @staticmethod
    def _pending_candidate_evidence(
        candidate: RetrievedPendingCandidate,
        *,
        scope: ContactScope,
    ) -> ContextEvidence:
        """待确认候选只能带强制未确认标注进入上下文。

        它不使用 ``revision``：候选的生命周期由状态表达，重新读取时以
        「仍是 pending」为复验条件。解释理由由
        ``pending_candidate_selection_reason`` 统一生成，置信度与风险标记
        都在这段已落库、已进入模型 payload 的文本里。
        """

        return ContextEvidence(
            evidence_id=candidate.candidate_id,
            kind="pending_candidate",
            text=candidate.text,
            scope=scope,
            source_ids=candidate.source_ids,
            selection_reason=pending_candidate_selection_reason(candidate),
            status=PENDING_CANDIDATE_STATUS,
            valid_at=candidate.valid_at,
            invalid_at=candidate.invalid_at,
            timing=candidate.timing,
        )
