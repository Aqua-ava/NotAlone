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
    kind: Literal[
        "message",
        "confirmed_memory",
        "user_draft",
        "continued_candidate",
    ]
    text: str
    scope: ContactScope
    source_ids: tuple[UUID, ...] = ()
    selection_reason: str = ""


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

    def has_relationship_memory_for_rewrite(self) -> bool:
        """当前改写上下文是否包含长期关系记忆。"""

        return (
            isinstance(self.command.content, RewriteDraft)
            and any(item.kind == "confirmed_memory" for item in self.evidence)
        )


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
    """只提供 L2 导航；L1 事实仍由 Retrieval 重新读取。"""

    def locate_memory_ids(
        self,
        scope: ContactScope,
        *,
        query: str | None = None,
        limit: int = 20,
    ) -> tuple[UUID, ...] | None:
        """返回当前目录定位到的 L1 ID；目录不可用时返回 None。"""


class RetrievalReplyContext:
    """通过独立 Retrieval 选择本次 Reply 可见证据的实现。"""

    __slots__ = (
        "_retrieval",
        "_skill_library_revision",
        "_id_factory",
        "_message_limit",
        "_memory_limit",
        "_memory_index",
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
        memory_index: ContactMemoryIndexPort | None = None,
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
        self._memory_index = memory_index
        self._risk_hints = risk_hints or DeterministicRiskHints()

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
            memories = self._search_memories(scope=scope)
            evidence = list(
                self._message_evidence(message, is_target=message is target[0])
                for message in messages
            ) + [self._memory_evidence(memory) for memory in memories]
            if continuation is not None:
                evidence.append(continuation)
            self._validate_evidence(evidence, scope=scope)
            return ReplyContext(
                reply_request_id=request_id,
                command=command,
                scope=scope,
                current_text=target[0].text,
                direction=command.content.direction,
                evidence=tuple(evidence),
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
            if continuation is not None:
                evidence.append(continuation)
            self._validate_evidence(evidence, scope=scope)
            return ReplyContext(
                reply_request_id=request_id,
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
        query: str | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        memory_ids: tuple[UUID, ...] | None = None
        if self._memory_index is not None:
            try:
                located = self._memory_index.locate_memory_ids(
                    scope,
                    query=query,
                    limit=self._memory_limit,
                )
            except ReplyContextInvariantError:
                raise
            except Exception:
                located = None
            if located is not None and (
                not isinstance(located, tuple)
                or any(not isinstance(memory_id, UUID) for memory_id in located)
            ):
                raise ReplyContextInvariantError("记忆目录导航结果结构无效。")
            memory_ids = located
        try:
            retrieval_kwargs: dict[str, object] = {
                "scope": scope,
                "query": query,
                "limit": self._memory_limit,
            }
            if memory_ids is not None:
                retrieval_kwargs["memory_ids"] = memory_ids
            memories = self._retrieval.search_confirmed_memories(
                **retrieval_kwargs,
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
