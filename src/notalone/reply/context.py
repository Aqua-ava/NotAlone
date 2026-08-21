"""候选回复 Context 的统一契约和 Retrieval 适配器。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal, Protocol
from uuid import UUID, uuid4

from notalone.reply.errors import (
    ReplyContextError,
    ReplyContextInvariantError,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    GenerateReply,
    ReplyToMessage,
    RewriteDraft,
)
from notalone.reply.risk import DeterministicRiskHints, RiskHintPort
from notalone.retrieval import (
    RetrievalError,
    RetrievalPort,
    RetrievedMemory,
    RetrievedMessage,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


@dataclass(frozen=True, slots=True, repr=False)
class ContextEvidence:
    """经范围校验后进入本次上下文的一项证据。"""

    evidence_id: UUID
    kind: Literal["message", "confirmed_memory", "user_draft"]
    text: str
    scope: ContactScope
    source_ids: tuple[UUID, ...] = ()
    selection_reason: str = ""


@dataclass(frozen=True, slots=True, repr=False)
class PreviousUnsentCandidate:
    """同一已验证桌面会话中上一轮未发送候选的精简引用。"""

    candidate_id: UUID
    scope: ContactScope
    conversation_binding_id: UUID
    text: str


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
    previous_unsent_candidates: tuple[PreviousUnsentCandidate, ...] = ()
    risk_notes: tuple[str, ...] = ()

    def has_relationship_memory_for_rewrite(self) -> bool:
        """当前改写上下文是否包含长期关系记忆。"""

        return (
            isinstance(self.command.content, RewriteDraft)
            and any(item.kind == "confirmed_memory" for item in self.evidence)
        )


# 旧名称暂时保留给 Runtime/Store adapter；它与 ReplyContext 相同。
PreparedReply = ReplyContext


class ReplyContextPort(Protocol):
    """Reply 入口使用的上下文组装 seam。"""

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyContext:
        """在已验证联系人范围内形成上下文快照。"""


class LegacyReplyPreparationPort(Protocol):
    """Store.prepare 迁移期间的最小兼容接口。"""

    def prepare(self, command: GenerateReply) -> ReplyContext: ...


class StoreBackedReplyContext:
    """兼容旧纵切的 Context adapter，计划在 04 中删除。"""

    __slots__ = ("_store",)

    def __init__(self, store: LegacyReplyPreparationPort) -> None:
        self._store = store

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyContext:
        del verified_scope
        return self._store.prepare(command)


class RetrievalReplyContext:
    """通过独立 Retrieval 选择本次 Reply 可见证据的实现。"""

    __slots__ = (
        "_retrieval",
        "_skill_library_revision",
        "_id_factory",
        "_message_limit",
        "_memory_limit",
        "_risk_hints",
    )

    def __init__(
        self,
        *,
        retrieval: RetrievalPort,
        skill_library_revision: int,
        id_factory: Callable[[], UUID] = uuid4,
        message_limit: int = 50,
        memory_limit: int = 20,
        risk_hints: RiskHintPort | None = None,
    ) -> None:
        if not isinstance(skill_library_revision, int) or skill_library_revision < 0:
            raise ValueError("Skill 库修订号无效。")
        if not isinstance(message_limit, int) or not 1 <= message_limit <= 50:
            raise ValueError("消息上下文预算无效。")
        if not isinstance(memory_limit, int) or not 1 <= memory_limit <= 20:
            raise ValueError("关系记忆上下文预算无效。")
        self._retrieval = retrieval
        self._skill_library_revision = skill_library_revision
        self._id_factory = id_factory
        self._message_limit = message_limit
        self._memory_limit = memory_limit
        self._risk_hints = risk_hints or DeterministicRiskHints()

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyContext:
        scope = self._validate_request(command, verified_scope)
        reply_request_id = self._new_id()

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
            memories = self._search_memories(scope=scope)
            evidence = tuple(
                self._message_evidence(message, is_target=message is target[0])
                for message in messages
            ) + tuple(self._memory_evidence(memory) for memory in memories)
            self._validate_evidence(evidence, scope=scope)
            return ReplyContext(
                reply_request_id=reply_request_id,
                command=command,
                scope=scope,
                current_text=target[0].text,
                direction=command.content.direction,
                evidence=evidence,
                skill_library_revision=self._skill_library_revision,
                risk_notes=self._risk_notes(command, target[0].text),
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
                )
            ]
            if command.content.include_relationship_context:
                evidence.extend(
                    self._memory_evidence(memory)
                    for memory in self._search_memories(scope=scope)
                )
            self._validate_evidence(evidence, scope=scope)
            return ReplyContext(
                reply_request_id=reply_request_id,
                command=command,
                scope=scope,
                current_text=command.content.draft_text,
                direction=None,
                evidence=tuple(evidence),
                skill_library_revision=self._skill_library_revision,
                risk_notes=self._risk_notes(
                    command,
                    command.content.draft_text,
                ),
            )

        raise ReplyContextInvariantError("回复输入模式无效。")

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
        target_message_id: UUID,
    ) -> tuple[RetrievedMessage, ...]:
        try:
            messages = self._retrieval.search_messages(
                scope=scope,
                target_message_id=target_message_id,
                query=None,
                limit=self._message_limit,
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
    ) -> tuple[RetrievedMemory, ...]:
        try:
            memories = self._retrieval.search_confirmed_memories(
                scope=scope,
                query=None,
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
        return memories

    def _new_id(self) -> UUID:
        try:
            value = self._id_factory()
        except Exception:
            raise ReplyContextError("回复上下文标识生成失败。") from None
        if not isinstance(value, UUID):
            raise ReplyContextInvariantError("回复上下文标识结构无效。")
        return value

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
            ):
                raise ReplyContextInvariantError("回复证据结构或范围无效。")
            evidence_ids.add(item.evidence_id)

    def _risk_notes(self, command: GenerateReply, current_text: str) -> tuple[str, ...]:
        if isinstance(command.content, ReplyToMessage):
            text = f"{current_text}\n{command.content.direction.text}"
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
        )

    @staticmethod
    def _memory_evidence(memory: RetrievedMemory) -> ContextEvidence:
        return ContextEvidence(
            evidence_id=memory.memory_id,
            kind="confirmed_memory",
            text=memory.text,
            scope=memory.scope,
            source_ids=memory.source_ids,
            selection_reason="已确认且当前有效的联系人关系记忆。",
        )
