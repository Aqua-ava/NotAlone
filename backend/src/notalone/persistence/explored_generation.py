"""A推进输入之前复验B选择与原意愿来源，不拥有输入指针或CAS。"""

from typing import Any
from uuid import UUID

from notalone.application.assistant_session_service import AssistantSessionRejected
from notalone.persistence.reply_exploration import PostgresExplorationStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.reply.exploration import ExplorationError, ExplorationExpired
from notalone.reply.exploration_context import ExplorationEvidence
from notalone.reply.exploration_task import ExplorationReadPurpose, ExplorationTask
from notalone.reply.context import ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.assistant_continuation_reference import ContinuationGenerateReply
from notalone.reply.interface import AccumulatedReplyRequirements
from notalone.reply.interface import GenerateReply, InitiateConversation, NoSkill, ReplyToMessage, SuggestionReference, UserSkillChoice
from notalone.scopes import ContactScope


def exploration_reference(command: GenerateReply) -> SuggestionReference | None:
    content = command.content
    direction = (content.direction if isinstance(content, ReplyToMessage)
                 else content.purpose if isinstance(content, InitiateConversation) else None)
    reference = direction.suggestion if direction is not None else None
    return reference if reference is not None and isinstance(reference.input_version, UUID) else None


def read_explored_generation(
    connection: Any, scope: ContactScope, session_id: UUID | None, command: GenerateReply,
    *, generation_required: bool = False,
) -> ExplorationTask | None:
    """调用方已持有同owner事务；生成上下文还须核对实际A领取记录。"""

    reference = exploration_reference(command)
    if reference is None:
        return None
    try:
        evidence = ExplorationEvidence(PostgresRetrieval(connection.info.dsn))
        store = PostgresExplorationStore(connection.info.dsn, evidence=evidence)
        historical_intent = isinstance(command, ContinuationGenerateReply) and connection.execute(
            "SELECT 1 FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s AND id=%s "
            "AND request_key<>%s",
            (scope.owner_id, scope.contact_id, reference.task_id, command.idempotency_key),
        ).fetchone() is not None
        task = store.read_in_transaction(connection, scope, reference.task_id,
            purpose=ExplorationReadPurpose.HISTORY if historical_intent else ExplorationReadPurpose.CURRENT,
            generation_required=generation_required and not historical_intent)
        content = command.content
        if not isinstance(content, (ReplyToMessage, InitiateConversation)):
            raise ExplorationError("生成场景无效。")
        direction = content.direction if isinstance(content, ReplyToMessage) else content.purpose
        scene = "reply_to_message" if isinstance(content, ReplyToMessage) else "initiate_conversation"
        skill = UserSkillChoice(task.skill_version_id) if task.skill_version_id else NoSkill()
        if (task.state not in ("selected", "confirmed") or not task.has_confirmed_intent
                or task.result is None or task.result["question"] is not None or task.result["ambiguities"]
                or session_id is not None and task.session_id != session_id
                or reference.input_version != task.input_version_id or reference.suggestion_id != task.selection_id
                or not historical_intent and command.idempotency_key != task.request_key or command.scope != scope
                or scene != task.content.scene or command.skill != skill
                or not historical_intent and command.continued_from_candidate_id is not None
                or (direction.text.strip(), direction.source) != (task.selected_intent, task.selection_source)
                or isinstance(content, ReplyToMessage) and content.target_message_id != task.content.target_message_id
                or (content.understanding_correction or "").strip() != task.content.correction.strip()
                or not historical_intent and (content.user_instruction or "").strip() != task.content.requirements.strip()
                or (content.clarification_answer or "").strip() != task.content.answer.strip()):
            raise ExplorationError("生成输入与已确认探索不一致。")
        if historical_intent:
            require_continued_confirmed_intent(connection, store, scope, task, command,
                                             generation_required=generation_required)
        return task
    except ExplorationExpired:
        raise
    except ExplorationError:
        raise AssistantSessionRejected("exploration_stale") from None


def require_continued_confirmed_intent(
    connection: Any, store: PostgresExplorationStore, scope: ContactScope, task: ExplorationTask,
    command: GenerateReply, *, generation_required: bool,
) -> None:
    """连续修改保留已确认意愿，只有表达要求由 A 权威元数据继续，不复用旧执行身份。"""

    if not isinstance(command, ContinuationGenerateReply):
        raise ExplorationError("连续输入身份无效。")
    store._require_skill(connection, scope, task.skill_library_revision, task.skill_version_id)
    original = connection.execute(
        "SELECT turn.input_payload,turn.conversation_binding_id,turn.reply_request_id "
        "FROM public.assistant_session_turn AS turn JOIN public.reply_request AS request "
        "ON request.owner_id=turn.owner_id AND request.contact_id=turn.contact_id "
        "AND request.conversation_binding_id=turn.conversation_binding_id "
        "AND request.id=turn.reply_request_id AND request.idempotency_key=turn.idempotency_key "
        "WHERE turn.owner_id=%s AND turn.contact_id=%s AND turn.session_id=%s "
        "AND turn.idempotency_key=%s AND turn.state='completed' AND request.state='completed'",
        (scope.owner_id, scope.contact_id, task.session_id, task.request_key),
    ).fetchone()
    if original is None or not isinstance(original["input_payload"], dict):
        raise ExplorationError("原确认生成未可靠完成。")
    from notalone.persistence.assistant_session_store import captured_generation_dependencies
    try:
        captured_generation_dependencies(connection, scope, task.request_key, original["conversation_binding_id"],
                                        original["reply_request_id"])
    except ReplyStoreInvariantError:
        raise ExplorationError("原确认来源已失效。") from None
    reference = exploration_reference(command)
    if reference is None or original["input_payload"]["content"].get("suggestion") != {
        "task_id": str(reference.task_id), "input_version": str(reference.input_version),
        "suggestion_id": str(reference.suggestion_id),
    }:
        raise ExplorationError("原确认身份不一致。")
    requirements = command.continuation.get("effective_requirements")
    if (command.continuation.get("intention_changed") is not False or not isinstance(requirements, list)
            or command.content.user_instruction != (AccumulatedReplyRequirements(tuple(requirements)) if requirements else None)):
        raise ExplorationError("持续要求未可靠绑定。")
    if generation_required:
        own = connection.execute(
            "SELECT input_version_id,input_payload FROM public.assistant_session_turn "
            "WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND idempotency_key=%s AND state<>'redacted'",
            (scope.owner_id, scope.contact_id, task.session_id, command.idempotency_key),
        ).fetchone()
        if own is None or not isinstance(own["input_payload"], dict) or own["input_payload"].get("continuation") != command.continuation:
            raise ExplorationError("持续要求生成未实际领取。")
        from notalone.persistence.assistant_session_inputs import require_current_input
        require_current_input(connection, scope, task.session_id, own["input_version_id"])


def prepare_explored_generation(
    connection: Any, scope: ContactScope, session_id: UUID, command: GenerateReply,
) -> set[UUID]:
    """同连接返回实际根与当前来源，A负责把它们存入自己的生成依赖。"""

    task = read_explored_generation(connection, scope, session_id, command)
    return ExplorationEvidence.dependencies((*task.intent_snapshots, *task.snapshots)) if task else set()


def require_explored_context(connection: Any, context: ReplyContext) -> None:
    """模型前保存和候选提交沿原owner事务复验实际探索版本与选择。"""

    try:
        task = read_explored_generation(connection, context.scope, None, context.command, generation_required=True)
        if task is not None and task.skill_library_revision != context.skill_library_revision:
            raise ReplyStoreInvariantError("探索与生成的Skill目录版本不同。")
    except ExplorationExpired:
        raise
    except (AssistantSessionRejected, ExplorationError):
        raise ReplyStoreInvariantError("已确认探索或原始来源已经失效。") from None
