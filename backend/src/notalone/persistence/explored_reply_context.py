"""实际A生成领取后保留探索原根的删除依赖，不扩大模型可见窗口。"""

from dataclasses import replace

import psycopg
from psycopg.rows import dict_row

from notalone.application.assistant_session_service import AssistantSessionError
from notalone.persistence.explored_generation import exploration_reference, read_explored_generation
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.reply_exploration import PostgresExplorationStore
from notalone.reply.context import ReplyContext, ReplyContextPort
from notalone.reply.errors import ReplyContextInvariantError
from notalone.reply.exploration import ExplorationError, ExplorationExpired
from notalone.reply.exploration_context import ExplorationEvidence
from notalone.reply.exploration_task import ExplorationTask
from notalone.reply.interface import GenerateReply


class ExploredReplyContext:
    def __init__(self, context: ReplyContextPort, *, database_url: str, evidence: ExplorationEvidence) -> None:
        self._context, self._database_url, self._evidence = context, database_url, evidence

    def build(self, **kwargs) -> ReplyContext:
        command = kwargs["command"]
        task = self._read(command)
        context = self._context.build(**kwargs)
        if task is None:
            return context
        self._require_revision(context, task)
        dependencies = self._evidence.generation_dependencies(command.scope, (*task.intent_snapshots, *task.snapshots))
        known = {item.evidence_id for item in context.evidence}
        additional = []
        for item in dependencies:
            if item.evidence_id not in known:
                known.add(item.evidence_id)
                additional.append(item)
        return replace(context, evidence=context.evidence + tuple(additional))

    def validate_current(self, context: ReplyContext) -> None:
        task = self._read(context.command)
        if task is not None:
            self._require_revision(context, task)
        self._context.validate_current(context)

    @staticmethod
    def _require_revision(context: ReplyContext, task: ExplorationTask) -> None:
        if context.skill_library_revision != task.skill_library_revision:
            raise ReplyContextInvariantError("探索与生成的Skill目录版本不同。")

    def _read(self, command: GenerateReply) -> ExplorationTask | None:
        if exploration_reference(command) is None:
            return None
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=command.scope.owner_id)
                return read_explored_generation(connection, command.scope, None, command, generation_required=True)
        except ExplorationExpired:
            PostgresExplorationStore(self._database_url, evidence=self._evidence).prune_expired(command.scope)
            raise ReplyContextInvariantError("探索任务已过期。") from None
        except (AssistantSessionError, ExplorationError, psycopg.Error):
            raise ReplyContextInvariantError("探索确认或原始来源已经失效。") from None
