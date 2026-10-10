"""已确认探索只进入现有助手会话生成端口，不建立第二生成链。"""

from typing import Callable
import json
from uuid import UUID

from notalone.application.assistant_session_service import AssistantSessionService, AssistantTurn
from notalone.application.reply_service import ReplyServiceRequest
from notalone.application.reply_request import parse_reply_request
from notalone.reply.exploration_task import ExplorationCompletedInput, ExplorationGeneration
from notalone.reply.interface import ConfirmedDirection, InitiateConversation, NoSkill, ReplyToMessage, SuggestionReference
from notalone.scopes import ContactScope


class AssistantExplorationGeneration:
    def __init__(self, sessions: Callable[[], AssistantSessionService]) -> None:
        self._sessions = sessions

    def generate(self, command: ExplorationGeneration) -> AssistantTurn:
        task = command.task
        reference = SuggestionReference(task.exploration_id, task.input_version_id, task.selection_id)
        intent = ConfirmedDirection(command.intent, command.source, reference)
        declarations = {"understanding_correction": task.content.correction or None,
                        "user_instruction": task.content.requirements or None,
                        "clarification_answer": task.content.answer or None}
        content = (ReplyToMessage(task.content.target_message_id, intent, **declarations)
                   if task.content.scene == "reply_to_message" else InitiateConversation(intent, **declarations))
        request = ReplyServiceRequest(task.request_key, content, suggestion=reference,
                                      skill_disabled=isinstance(command.skill, NoSkill),
                                      skill_version_id=task.skill_version_id,
                                      expected_input_version_id=task.input_version_id)
        return self._sessions().generate(owner_id=task.scope.owner_id, contact_id=task.scope.contact_id,
                                         session_id=task.session_id, request=request)

    def replay(self, scope: ContactScope, session_id: UUID, completed: ExplorationCompletedInput) -> AssistantTurn:
        # 原A摘要/绑定/保存来源沿同一生成入口复验；只会命中已完成同键，不推进输入。
        payload = completed.input_payload
        content = dict(payload["content"])
        reference = content.pop("suggestion")
        _, request = parse_reply_request(json.dumps({
            **payload, "content": content, "contact_id": str(scope.contact_id),
            "idempotency_key": str(completed.request_key), "suggestion": reference,
        }).encode())
        return self._sessions().generate(owner_id=scope.owner_id, contact_id=scope.contact_id,
                                         session_id=session_id, request=request)
