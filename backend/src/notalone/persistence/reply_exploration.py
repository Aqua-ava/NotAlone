"""探索派生记录；输入UUID、当前指针、CAS及绑定核验复用A同事务接口。"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256
import json
from typing import Any, Iterator
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionRejected,
)
from notalone.persistence.assistant_session_inputs import (
    read_input_records, record_discussion_input_in_transaction, require_current_input,
)
from notalone.persistence.assistant_session_store import _active_binding
from notalone.persistence.locks import lock_owner_scope
from notalone.reply.exploration import ExplorationError, ExplorationExpired, ExplorationInput, ExplorationStale
from notalone.reply.exploration_context import EvidenceSnapshot, ExplorationEvidence
from notalone.reply.exploration_skill import ExplorationSkillSelection
from notalone.reply.exploration_task import (
    ExplorationCompletedInput, ExplorationOpen, ExplorationReadPurpose, ExplorationTask,
)
from notalone.reply.interface import DirectionSource
from notalone.scopes import ContactScope


class ExplorationInProgress(ExplorationError):
    """同操作正在运行；并发请求不能再消耗一次模型调用。"""


def _operation_digest(request: ExplorationOpen) -> str:
    payload = request.content.payload()
    # 此项是服务器选择的投影；客户端不能用它建立确认，重放也不受后来选择影响。
    payload.pop("confirmed_intent")
    value = {"content": payload, "session_id": str(request.session_id),
             "expected_input_version_id": str(request.expected_input_version_id) if request.expected_input_version_id else None,
             "previous_id": str(request.previous_id) if request.previous_id else None,
             "question_id": str(request.question_id) if request.question_id else None,
             "automatic": request.automatic, "change_group": request.change_group}
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _content(payload: dict[str, Any]) -> ExplorationInput:
    try:
        return ExplorationInput(
            "reply_to_message" if payload["type"] == "response_exploration" else "initiate_conversation",
            target_message_id=UUID(payload["target_message_id"]) if "target_message_id" in payload else None,
            purpose_hint=payload.get("purpose_hint", ""), correction=payload["correction"],
            requirements=payload["requirements"], answer=payload["answer"],
            confirmed_intent=payload["confirmed_intent"], skill_mode=payload["skill_mode"],
            skill_version_id=UUID(payload["skill_version_id"]) if payload["skill_version_id"] else None,
        )
    except (KeyError, TypeError, ValueError):
        raise ExplorationStale("探索输入记录无效。") from None


def _task(scope: ContactScope, row: dict[str, Any]) -> ExplorationTask:
    return ExplorationTask(
        row["id"], scope, row["session_id"], row["input_version_id"], row["operation_key"],
        row["request_key"], _content(row["input_payload"]),
        ExplorationEvidence.restore(scope, row["snapshots"]),
        ExplorationEvidence.restore(scope, row["intent_snapshots"]),
        row["skill_library_revision"], row["skill_version_id"], row["root_created_at"],
        row["automatic_call_count"], row["state"], row["result_payload"], row["selected_intent"],
        row["selection_id"], DirectionSource(row["selection_source"]) if row["selection_source"] else None,
    )


class PostgresExplorationStore:
    """操作键只占位B结果，不拥有或回退A当前输入。"""

    def __init__(self, database_url: str, *, evidence: ExplorationEvidence) -> None:
        self._database_url, self._evidence = database_url, evidence

    @contextmanager
    def _transaction(self, scope: ContactScope) -> Iterator[Any]:
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                yield connection
        except ExplorationExpired:
            self._prune(scope)
            raise ExplorationStale("探索任务已超过原有效期，请明确开启新任务。") from None
        except (AssistantSessionNotFound, AssistantSessionConflict, AssistantSessionRejected):
            raise ExplorationStale("探索输入、绑定或原始来源已经变化。") from None
        except psycopg.Error:
            raise ExplorationError("探索资料未可靠保存，请手动重试。") from None

    def _prune(self, scope: ContactScope) -> None:
        # 单独提交擦除；随后拒绝过期读取不能把清理一起回滚。
        with self._transaction(scope) as connection:
            connection.execute(
                "UPDATE public.reply_exploration SET state='expired', input_payload=NULL, result_payload=NULL, "
                "snapshots='[]', intent_snapshots='[]', selected_intent=NULL, selection_id=NULL, "
                "selection_source=NULL, source_ids='{}', updated_at=now() "
                "WHERE owner_id=%s AND contact_id=%s AND state NOT IN ('expired','redacted') "
                "AND root_created_at <= clock_timestamp()-interval '15 minutes'",
                (scope.owner_id, scope.contact_id),
            )

    def prune_expired(self, scope: ContactScope) -> None:
        """调用方必须先退出自身owner事务，防止同owner清理互锁。"""

        self._prune(scope)

    @staticmethod
    def _read(connection: Any, scope: ContactScope, exploration_id: UUID) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s AND id=%s FOR UPDATE",
            (scope.owner_id, scope.contact_id, exploration_id),
        ).fetchone()
        if row is None or row["state"] in ("redacted", "expired"):
            raise ExplorationStale("探索结果不存在或已经失效。")
        return row

    @staticmethod
    def _generation_turn(connection: Any, scope: ContactScope, row: dict[str, Any]) -> dict[str, Any] | None:
        return connection.execute(
            "SELECT input_version_id, state FROM public.assistant_session_turn "
            "WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND idempotency_key=%s",
            (scope.owner_id, scope.contact_id, row["session_id"], row["request_key"]),
        ).fetchone()

    def _validate(
        self, connection: Any, scope: ContactScope, row: dict[str, Any], purpose: ExplorationReadPurpose,
    ) -> ExplorationTask:
        actual_time = connection.execute("SELECT clock_timestamp() AS current_time").fetchone()["current_time"]
        if row["root_created_at"] + timedelta(minutes=15) <= actual_time:
            raise ExplorationExpired("探索任务已过期。")
        record = next((item for item in read_input_records(connection, scope, row["session_id"])
                       if item.input_version_id == row["input_version_id"]), None)
        if (record is None or record.state != "active" or record.type == "generation"
                or record.conversation_binding_id != _active_binding(connection, scope)):
            raise ExplorationStale("探索的原输入或绑定已经失效。")
        if purpose != ExplorationReadPurpose.HISTORY:
            try:
                require_current_input(connection, scope, row["session_id"], row["input_version_id"])
            except AssistantSessionRejected as error:
                if error.reason != "input_version_stale":
                    raise
                # 仅允许本B请求已发起的A生成接续/重放；核验的仍是A实际当前UUID。
                turn = self._generation_turn(connection, scope, row)
                if turn is None or turn["state"] == "redacted" or row["selection_id"] is None:
                    raise
                require_current_input(connection, scope, row["session_id"], turn["input_version_id"])
        task = _task(scope, row)
        self._evidence.validate(scope, tuple({item.evidence_id: item for item in
                                             (*task.intent_snapshots, *task.snapshots)}.values()))
        if purpose == ExplorationReadPurpose.CURRENT:
            self._require_skill(connection, scope, task.skill_library_revision, task.skill_version_id)
        return task

    @staticmethod
    def _require_skill(connection: Any, scope: ContactScope, revision: int, version_id: UUID | None) -> None:
        current = connection.execute("SELECT revision FROM public.skill_library WHERE owner_id=%s", (scope.owner_id,)).fetchone()
        if (current["revision"] if current else 0) != revision:
            raise ExplorationStale("Skill目录已经变化，请明确刷新探索。")
        if version_id is not None and connection.execute(
            "SELECT 1 FROM public.reply_skill_version AS version "
            "JOIN public.reply_skill AS skill ON skill.id=version.skill_id "
            "WHERE skill.owner_id=%s AND (skill.contact_id IS NULL OR skill.contact_id=%s) "
            "AND skill.status='active' AND version.id=%s AND version.status='active' "
            "AND version.enabled AND version.is_current AND version.name=skill.name "
            "AND version.content IS NOT NULL AND length(btrim(version.content))>0",
            (scope.owner_id, scope.contact_id, version_id),
        ).fetchone() is None:
            raise ExplorationStale("所选Skill版本已失效。")

    def replay(self, scope: ContactScope, request: ExplorationOpen) -> ExplorationTask | None:
        self._prune(scope)
        with self._transaction(scope) as connection:
            row = connection.execute(
                "SELECT * FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s "
                "AND session_id=%s AND operation_key=%s FOR UPDATE",
                (scope.owner_id, scope.contact_id, request.session_id, request.operation_key),
            ).fetchone()
            if row is None:
                return None
            if row["state"] in ("redacted", "expired", "paused", "stale") or row["operation_digest"] != _operation_digest(request):
                raise ExplorationStale("同操作输入已经变化或失效。")
            task = self._validate(connection, scope, row, ExplorationReadPurpose.CURRENT)
            if task.state == "running":
                raise ExplorationInProgress("同一探索正在运行，请等待后手动重读。")
            return task

    @staticmethod
    def _replay_row(connection: Any, scope: ContactScope, session_id: UUID, exploration_id: UUID) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND id=%s",
            (scope.owner_id, scope.contact_id, session_id, exploration_id),
        ).fetchone()
        if row is None or row["state"] == "redacted":
            raise ExplorationStale("探索操作已删除或不属于当前会话。")
        return row

    @staticmethod
    def _completed_input(connection: Any, scope: ContactScope, row: dict[str, Any]) -> ExplorationCompletedInput | None:
        turn = connection.execute(
            "SELECT input_payload FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s "
            "AND session_id=%s AND idempotency_key=%s AND state='completed'",
            (scope.owner_id, scope.contact_id, row["session_id"], row["request_key"]),
        ).fetchone()
        if turn is None:
            return None
        payload = turn["input_payload"]
        reference = payload["content"].get("suggestion")
        if (not isinstance(reference, dict) or reference.get("task_id") != str(row["id"])
                or reference.get("input_version") != str(row["input_version_id"])):
            raise ExplorationStale("已完成请求的探索身份不一致。")
        return ExplorationCompletedInput(row["id"], row["request_key"], payload)

    def replay_confirmation(
        self, scope: ContactScope, session_id: UUID, exploration_id: UUID, input_version_id: UUID,
        *, suggestion_id: UUID | None, direct_intent: str | None,
    ) -> ExplorationCompletedInput | None:
        with self._transaction(scope) as connection:
            row = self._replay_row(connection, scope, session_id, exploration_id)
            if row["input_version_id"] != input_version_id:
                raise ExplorationStale("确认不属于原输入版本。")
            completed = self._completed_input(connection, scope, row)
            if completed is None:
                return None
            content = completed.input_payload["content"]
            mode = content["type"]
            source = content["direction_source"] if mode == "reply_to_message" else content["purpose_source"]
            intent = content["direction"] if mode == "reply_to_message" else content["purpose"]
            reference = content["suggestion"]
            if (suggestion_id is not None and (source != "confirmed_suggestion" or reference["suggestion_id"] != str(suggestion_id))
                    or direct_intent is not None and (source != "direct_input" or intent != direct_intent.strip())):
                raise ExplorationStale("确认与已完成请求的原选择不同。")
            return completed

    def replay_answer(
        self, scope: ContactScope, session_id: UUID, exploration_id: UUID, input_version_id: UUID,
        *, question_id: UUID, answer: str, operation_key: UUID,
    ) -> ExplorationCompletedInput | None:
        with self._transaction(scope) as connection:
            parent = self._replay_row(connection, scope, session_id, exploration_id)
            if parent["input_version_id"] != input_version_id:
                raise ExplorationStale("回答不属于原输入版本。")
            child = connection.execute(
                "SELECT * FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND operation_key=%s",
                (scope.owner_id, scope.contact_id, session_id, operation_key),
            ).fetchone()
            if child is None:
                return None
            completed = self._completed_input(connection, scope, child)
            if completed is None:
                return None
            discussion = connection.execute(
                "SELECT content FROM public.assistant_session_input WHERE owner_id=%s AND contact_id=%s "
                "AND session_id=%s AND id=%s AND state='active'",
                (scope.owner_id, scope.contact_id, session_id, child["input_version_id"]),
            ).fetchone()
            if discussion is None or child["state"] == "redacted":
                raise ExplorationStale("原应答或来源已经失效。")
            request = ExplorationOpen(session_id, replace(_content(discussion["content"]), answer=answer.strip()),
                                      operation_key, input_version_id, exploration_id, question_id=question_id)
            if _operation_digest(request) != child["operation_digest"]:
                raise ExplorationStale("应答与已完成的原操作不同。")
            return completed

    def read(
        self, scope: ContactScope, exploration_id: UUID,
        *, purpose: ExplorationReadPurpose = ExplorationReadPurpose.CURRENT,
    ) -> ExplorationTask:
        self._prune(scope)
        with self._transaction(scope) as connection:
            return self.read_in_transaction(connection, scope, exploration_id, purpose=purpose)

    def read_in_transaction(
        self, connection: Any, scope: ContactScope, exploration_id: UUID,
        *, purpose: ExplorationReadPurpose = ExplorationReadPurpose.CURRENT, generation_required: bool = False,
    ) -> ExplorationTask:
        """沿调用方同owner连接核验；过期异常由外层退出后调用prune_expired。"""

        row = self._read(connection, scope, exploration_id)
        task = self._validate(connection, scope, row, purpose)
        if generation_required:
            turn = self._generation_turn(connection, scope, row)
            if turn is None or turn["state"] == "redacted":
                raise ExplorationStale("探索生成尚未由助手会话可靠领取。")
        return task

    def begin(
        self, *, scope: ContactScope, request: ExplorationOpen, snapshots: tuple[EvidenceSnapshot, ...],
        skill: ExplorationSkillSelection, previous: ExplorationTask | None,
    ) -> ExplorationTask:
        self._prune(scope)
        with self._transaction(scope) as connection:
            if connection.execute(
                "SELECT 1 FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s "
                "AND session_id=%s AND operation_key=%s",
                (scope.owner_id, scope.contact_id, request.session_id, request.operation_key),
            ).fetchone():
                raise ExplorationInProgress("同一探索已由另一请求建立，请手动重读。")
            if (previous is None) != (request.previous_id is None):
                raise ExplorationStale("探索接续身份无效。")
            if previous is not None:
                parent = self._validate(connection, scope, self._read(connection, scope, request.previous_id),
                                        ExplorationReadPurpose.CURRENT if request.automatic else ExplorationReadPurpose.CONTINUE)
                if (parent != previous or parent.session_id != request.session_id or parent.state == "paused"
                        or parent.content.scene != request.content.scene
                        or parent.content.target_message_id != request.content.target_message_id
                        or parent.content.purpose_hint != request.content.purpose_hint
                        or request.content.confirmed_intent != (parent.selected_intent if parent.has_confirmed_intent else "")):
                    raise ExplorationStale("探索接续输入或已选意愿已变化。")
                if request.automatic and (parent.state != "ready" or parent.has_confirmed_intent
                                          or parent.automatic_call_count >= 3):
                    raise ExplorationStale("探索更新已经超出活跃未选方向的预算。")
            elif request.automatic or request.content.confirmed_intent:
                raise ExplorationStale("不能从客户端输入建立自动任务或已选意愿。")
            self._require_skill(connection, scope, skill.catalog.revision, skill.entry.version_id if skill.entry else None)
            if skill.catalog.scope != scope:
                raise ExplorationStale("探索Skill范围无效。")
            roots = previous.intent_snapshots if previous and previous.has_confirmed_intent else ()
            self._evidence.validate(scope, (*roots, *snapshots))
            dependencies = self._evidence.dependencies((*roots, *snapshots))
            version = record_discussion_input_in_transaction(
                connection, scope, request.session_id, request.content.payload(), request.expected_input_version_id,
                verified_dependencies=tuple(sorted(dependencies)),
            )
            created = connection.execute("SELECT clock_timestamp() AS created").fetchone()["created"]
            task = ExplorationTask(
                uuid4(), scope, request.session_id, version, request.operation_key, uuid4(), request.content,
                snapshots, roots, skill.catalog.revision, skill.entry.version_id if skill.entry else None,
                previous.root_created_at if previous else created,
                previous.automatic_call_count + int(request.automatic) if previous else 0,
                selected_intent=previous.selected_intent if previous and previous.has_confirmed_intent else None,
                selection_id=previous.selection_id if previous and previous.has_confirmed_intent else None,
                selection_source=previous.selection_source if previous and previous.has_confirmed_intent else None,
            )
            connection.execute(
                "UPDATE public.reply_exploration SET state='stale', updated_at=now() "
                "WHERE owner_id=%s AND contact_id=%s AND session_id=%s AND state IN ('running','ready','selected','confirmed','failed')",
                (scope.owner_id, scope.contact_id, request.session_id),
            )
            connection.execute(
                "INSERT INTO public.reply_exploration "
                "(id,owner_id,contact_id,session_id,input_version_id,operation_key,operation_digest,request_key,"
                "input_payload,snapshots,intent_snapshots,source_ids,skill_library_revision,skill_version_id,state,"
                "root_created_at,automatic_call_count,selected_intent,selection_id,selection_source) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'running',%s,%s,%s,%s,%s)",
                (task.exploration_id, scope.owner_id, scope.contact_id, task.session_id, version, request.operation_key,
                 _operation_digest(request), task.request_key, Jsonb(task.content.payload()),
                 Jsonb([item.storage_payload for item in snapshots]), Jsonb([item.storage_payload for item in roots]),
                 list(dependencies), task.skill_library_revision, task.skill_version_id, task.root_created_at,
                 task.automatic_call_count, task.selected_intent, task.selection_id,
                 task.selection_source.value if task.selection_source else None),
            )
            return task

    def complete(self, task: ExplorationTask, result: dict[str, Any]) -> ExplorationTask:
        self._prune(task.scope)
        with self._transaction(task.scope) as connection:
            row = self._read(connection, task.scope, task.exploration_id)
            current = self._validate(connection, task.scope, row, ExplorationReadPurpose.CURRENT)
            if current.state != "running" or current != task:
                raise ExplorationStale("探索任务已停止或替换，迟到结果不能生效。")
            result = {**result, "options": [{**option, "suggestion_id": str(uuid4())} for option in result["options"]],
                      "question_id": str(uuid4()) if result["question"] else None}
            state = "selected" if task.has_confirmed_intent else "ready"
            connection.execute("UPDATE public.reply_exploration SET state=%s,result_payload=%s,updated_at=now() WHERE id=%s",
                               (state, Jsonb(result), task.exploration_id))
            return replace(task, state=state, result=result)

    def select(
        self, scope: ContactScope, exploration_id: UUID, input_version_id: UUID,
        *, suggestion_id: UUID | None, direct_intent: str | None,
    ) -> ExplorationTask:
        self._prune(scope)
        with self._transaction(scope) as connection:
            row = self._read(connection, scope, exploration_id)
            task = self._validate(connection, scope, row, ExplorationReadPurpose.CURRENT)
            if task.input_version_id != input_version_id or task.result is None or task.state not in ("ready","selected","confirmed"):
                raise ExplorationStale("方向不属于当前输入版本。")
            if (suggestion_id is None) == (direct_intent is None):
                raise ExplorationError("需要明确选择或输入本次意愿。")
            option = next((item for item in task.result["options"] if item["suggestion_id"] == str(suggestion_id)), None)
            if suggestion_id is not None and option is None:
                raise ExplorationStale("方向建议已经失效。")
            if direct_intent is not None and (not isinstance(direct_intent, str) or not 0 < len(direct_intent.strip()) <= 4096):
                raise ExplorationError("本次意愿文字无效。")
            intent = option["intent"] if option else direct_intent.strip()
            source = DirectionSource.CONFIRMED_SUGGESTION if option else DirectionSource.DIRECT_INPUT
            selection_id = suggestion_id or (task.selection_id if task.selected_intent == intent and task.selection_source == source else uuid4())
            if self._generation_turn(connection, scope, row) is not None:
                if (task.selected_intent, task.selection_id, task.selection_source) != (intent, selection_id, source):
                    raise ExplorationStale("本次意愿已发起生成，请使用新的输入修改。")
                return task
            state = "paused" if option and option["pause"] else "selected"
            roots = task.intent_snapshots or task.snapshots
            connection.execute(
                "UPDATE public.reply_exploration SET state=%s,selected_intent=%s,selection_id=%s,selection_source=%s,"
                "intent_snapshots=%s,updated_at=now() WHERE id=%s",
                (state, intent, selection_id, source.value, Jsonb([item.storage_payload for item in roots]), task.exploration_id),
            )
            return replace(task, state=state, selected_intent=intent, selection_id=selection_id,
                           selection_source=source, intent_snapshots=roots)

    def finish(self, task: ExplorationTask) -> None:
        with self._transaction(task.scope) as connection:
            row = self._read(connection, task.scope, task.exploration_id)
            current = self._validate(connection, task.scope, row, ExplorationReadPurpose.CURRENT)
            turn = self._generation_turn(connection, task.scope, row)
            if (current.state not in ("selected", "confirmed") or not current.has_confirmed_intent
                    or current.input_version_id != task.input_version_id or current.request_key != task.request_key
                    or (current.selected_intent, current.selection_id, current.selection_source)
                    != (task.selected_intent, task.selection_id, task.selection_source)
                    or turn is None or turn["state"] != "completed"):
                raise ExplorationStale("探索确认已经失效。")
            connection.execute("UPDATE public.reply_exploration SET state='confirmed',updated_at=now() WHERE id=%s", (task.exploration_id,))

    def fail(self, task: ExplorationTask) -> None:
        with self._transaction(task.scope) as connection:
            connection.execute(
                "UPDATE public.reply_exploration SET state='failed',result_payload=NULL,updated_at=now() "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s AND state='running'",
                (task.scope.owner_id, task.scope.contact_id, task.exploration_id),
            )

    def retry(self, task: ExplorationTask) -> ExplorationTask:
        self._prune(task.scope)
        with self._transaction(task.scope) as connection:
            current = self._validate(connection, task.scope, self._read(connection, task.scope, task.exploration_id), ExplorationReadPurpose.CURRENT)
            if current != task or current.state != "failed":
                raise ExplorationStale("失败探索已被替换，不能重新执行。")
            connection.execute("UPDATE public.reply_exploration SET state='running',updated_at=now() WHERE id=%s", (task.exploration_id,))
            return replace(current, state="running", result=None)

    def stop(self, scope: ContactScope, exploration_id: UUID, input_version_id: UUID) -> None:
        self._prune(scope)
        with self._transaction(scope) as connection:
            row = self._read(connection, scope, exploration_id)
            task = self._validate(connection, scope, row, ExplorationReadPurpose.CURRENT)
            if task.input_version_id != input_version_id:
                raise ExplorationStale("停止请求不属于当前探索。")
            # 关闭B面板不撤销已经发起的A候选生成；全局退出由A生命周期处理。
            if self._generation_turn(connection, scope, row) is None:
                connection.execute("UPDATE public.reply_exploration SET state='paused',updated_at=now() WHERE id=%s", (exploration_id,))
