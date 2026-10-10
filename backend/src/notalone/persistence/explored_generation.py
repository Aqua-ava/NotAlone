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
        task = store.read_in_transaction(connection, scope, reference.task_id,
                                         purpose=ExplorationReadPurpose.CURRENT, generation_required=generation_required)
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
                or command.idempotency_key != task.request_key or command.scope != scope
                or scene != task.content.scene or command.skill != skill
                or command.continued_from_candidate_id is not None
                or (direction.text.strip(), direction.source) != (task.selected_intent, task.selection_source)
                or isinstance(content, ReplyToMessage) and content.target_message_id != task.content.target_message_id
                or (content.understanding_correction or "").strip() != task.content.correction.strip()
                or (content.user_instruction or "").strip() != task.content.requirements.strip()
                or (content.clarification_answer or "").strip() != task.content.answer.strip()):
            raise ExplorationError("生成输入与已确认探索不一致。")
        return task
    except ExplorationExpired:
        raise
    except ExplorationError:
        raise AssistantSessionRejected("exploration_stale") from None


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
