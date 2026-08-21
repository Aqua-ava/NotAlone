"""候选回复的确定性外壳。"""

from __future__ import annotations

from uuid import UUID

from notalone.reply.context import (
    ContextEvidence,
    PreparedReply,
    PreviousUnsentCandidate,
)
from notalone.reply.runtime import (
    ReplyRuntime,
    ReplyRuntimeResult,
    RuntimeCandidate,
)
from notalone.reply.store import (
    ReplyStore,
    ValidatedReply,
)
from notalone.reply.errors import (
    ReplyError,
    ReplyInvariantError,
    ReplyPersistenceError,
    ReplyRunError,
)
from notalone.reply.interface import (
    ContextReceipt,
    GenerateReply,
    ReplyCandidate,
    ReplyGenerated,
    ReplyOutcome,
    ReplyToMessage,
    RewriteDraft,
    SkillUse,
)
from notalone.scopes import VerifiedConversationScope


class ReplyGenerator:
    """通过一个深 Interface 隐藏范围、运行时和持久化细节。"""

    __slots__ = ("_runtime", "_store")

    def __init__(self, *, store: ReplyStore, runtime: ReplyRuntime) -> None:
        self._store = store
        self._runtime = runtime

    def generate(
        self,
        command: GenerateReply,
        *,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyOutcome:
        """在外层已验证范围内生成候选；持久化成功前不返回。"""

        if not (
            isinstance(command, GenerateReply)
            and isinstance(verified_scope, VerifiedConversationScope)
            and command.matches_verified_scope(verified_scope)
        ):
            raise ReplyInvariantError("回复范围未通过会话验证。")

        try:
            prepared = self._store.prepare(command)
        except ReplyError:
            raise
        except Exception:
            raise ReplyPersistenceError("候选回复准备失败。") from None
        try:
            self._validate_prepared(command, prepared)
        except ReplyError:
            raise
        except Exception:
            raise ReplyInvariantError("回复准备结果结构无效。") from None
        try:
            runtime_result = self._runtime.generate(prepared)
            self._validate_runtime_result(runtime_result)
        except ReplyError:
            raise
        except Exception:
            raise ReplyRunError("候选回复运行失败。") from None
        evidence_ids = {item.evidence_id for item in prepared.evidence}
        if any(
            not set(candidate.citation_ids) <= evidence_ids
            for candidate in runtime_result.candidates
        ):
            raise ReplyInvariantError("候选引用不属于本次上下文快照。")
        validated = ValidatedReply(
            candidates=runtime_result.candidates,
            used_skill=runtime_result.used_skill,
        )
        try:
            persisted = self._store.save(prepared, validated)
            self._validate_persisted(prepared, validated, persisted)
        except ReplyError:
            raise
        except Exception:
            raise ReplyPersistenceError("候选回复持久化失败。") from None
        return persisted

    @staticmethod
    def _validate_prepared(command: GenerateReply, prepared: object) -> None:
        if not isinstance(prepared, PreparedReply):
            raise ReplyInvariantError("回复准备 adapter 返回了无效结果。")
        if prepared.scope != command.scope or prepared.command != command:
            raise ReplyInvariantError("回复准备结果超出本次联系人范围。")
        if (
            not isinstance(prepared.reply_request_id, UUID)
            or not isinstance(prepared.current_text, str)
            or not prepared.current_text.strip()
            or not isinstance(prepared.evidence, tuple)
            or not prepared.evidence
            or not isinstance(prepared.skill_library_revision, int)
            or prepared.skill_library_revision < 0
        ):
            raise ReplyInvariantError("回复上下文快照结构无效。")

        evidence_ids: set[UUID] = set()
        for item in prepared.evidence:
            if (
                not isinstance(item, ContextEvidence)
                or item.scope != prepared.scope
                or not isinstance(item.evidence_id, UUID)
                or item.evidence_id in evidence_ids
                or item.kind not in ("message", "confirmed_memory", "user_draft")
                or not isinstance(item.text, str)
                or not item.text.strip()
            ):
                raise ReplyInvariantError("回复依据超出范围或结构无效。")
            evidence_ids.add(item.evidence_id)

        if (
            not isinstance(prepared.previous_unsent_candidates, tuple)
            or len(prepared.previous_unsent_candidates) > 3
            or any(
                not isinstance(item, PreviousUnsentCandidate)
                or item.scope != prepared.scope
                or item.conversation_binding_id
                != command.conversation_binding_id
                or not isinstance(item.candidate_id, UUID)
                or not isinstance(item.text, str)
                or not item.text.strip()
                for item in prepared.previous_unsent_candidates
            )
        ):
            raise ReplyInvariantError("上一轮候选超出本次联系人或会话范围。")

        if isinstance(command.content, ReplyToMessage):
            target_evidence = tuple(
                item
                for item in prepared.evidence
                if item.evidence_id == command.content.target_message_id
            )
            if (
                len(target_evidence) != 1
                or target_evidence[0].kind != "message"
                or target_evidence[0].text != prepared.current_text
                or prepared.direction != command.content.direction
            ):
                raise ReplyInvariantError("待回复消息或表达方向与请求不一致。")
            return

        if isinstance(command.content, RewriteDraft):
            if prepared.has_relationship_memory_for_rewrite():
                raise ReplyInvariantError("当前改写不能使用长期关系资料。")
            draft_evidence = tuple(
                item
                for item in prepared.evidence
                if item.kind == "user_draft"
                and item.text == command.content.draft_text
            )
            if (
                prepared.direction is not None
                or prepared.current_text != command.content.draft_text
                or len(draft_evidence) != 1
            ):
                raise ReplyInvariantError("改写草稿与回复上下文不一致。")
            return

        raise ReplyInvariantError("回复输入模式无效。")

    @staticmethod
    def _validate_runtime_result(result: ReplyRuntimeResult) -> None:
        if not isinstance(result, ReplyRuntimeResult) or not isinstance(
            result.candidates,
            tuple,
        ):
            raise ReplyInvariantError("模型返回了无效结果。")
        if not 1 <= len(result.candidates) <= 3:
            raise ReplyInvariantError("一次回复必须生成 1 到 3 条候选。")
        for candidate in result.candidates:
            if (
                not isinstance(candidate, RuntimeCandidate)
                or not isinstance(candidate.text, str)
                or not candidate.text.strip()
                or not isinstance(candidate.basis, str)
                or not candidate.basis.strip()
                or not isinstance(candidate.citation_ids, tuple)
                or not candidate.citation_ids
                or any(
                    not isinstance(evidence_id, UUID)
                    for evidence_id in candidate.citation_ids
                )
                or not isinstance(candidate.risk_notes, tuple)
                or any(
                    not isinstance(note, str) or not note.strip()
                    for note in candidate.risk_notes
                )
            ):
                raise ReplyInvariantError("模型返回了无效候选。")
        if result.used_skill is not None and (
            not isinstance(result.used_skill, SkillUse)
            or not isinstance(result.used_skill.skill_id, UUID)
            or not isinstance(result.used_skill.version_id, UUID)
            or not isinstance(result.used_skill.name, str)
            or not result.used_skill.name.strip()
        ):
            raise ReplyInvariantError("模型返回了无效 Skill 记录。")

    @staticmethod
    def _validate_persisted(
        prepared: object,
        validated: ValidatedReply,
        persisted: object,
    ) -> None:
        if (
            not isinstance(prepared, PreparedReply)
            or not isinstance(persisted, ReplyGenerated)
            or persisted.reply_request_id != prepared.reply_request_id
            or persisted.used_skill != validated.used_skill
            or not isinstance(persisted.candidates, tuple)
            or len(persisted.candidates) != len(validated.candidates)
            or not isinstance(persisted.context_receipt, ContextReceipt)
            or not isinstance(persisted.context_receipt.evidence_ids, tuple)
        ):
            raise ReplyInvariantError("持久化 adapter 返回了不一致结果。")

        candidate_ids: set[UUID] = set()
        cited_ids: set[UUID] = set()
        for saved, expected in zip(
            persisted.candidates,
            validated.candidates,
            strict=True,
        ):
            if (
                not isinstance(saved, ReplyCandidate)
                or not isinstance(saved.candidate_id, UUID)
                or saved.candidate_id in candidate_ids
                or saved.text != expected.text
                or saved.basis != expected.basis
                or saved.citation_ids != expected.citation_ids
                or saved.risk_notes != expected.risk_notes
            ):
                raise ReplyInvariantError("持久化候选与已校验结果不一致。")
            candidate_ids.add(saved.candidate_id)
            cited_ids.update(saved.citation_ids)

        if (
            any(
                not isinstance(evidence_id, UUID)
                for evidence_id in persisted.context_receipt.evidence_ids
            )
            or set(persisted.context_receipt.evidence_ids) != cited_ids
        ):
            raise ReplyInvariantError("持久化依据记录与候选引用不一致。")
