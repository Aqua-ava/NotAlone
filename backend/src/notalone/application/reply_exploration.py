"""理解、不同意愿、澄清与明确确认；复用助手会话的生成和输入权威。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from uuid import UUID

from notalone.reply.exploration import (
    ExplorationContext, ExplorationError, ExplorationInput, ExplorationRuntime,
    ExplorationStale, validate_exploration_output,
)
from notalone.reply.exploration_context import EvidenceSnapshot, ExplorationEvidence
from notalone.reply.exploration_skill import ExplorationSkillSelection, select_exploration_skill
from notalone.reply.exploration_task import (
    ExplorationCompletedInput, ExplorationGeneration, ExplorationGenerationPort, ExplorationOpen, ExplorationReadPurpose,
    ExplorationStore, ExplorationTask,
)
from notalone.reply.interface import DirectionSource, NoSkill, UserSkillChoice
from notalone.scopes import ContactScope
from notalone.skills import SkillPort


def _snapshots(task: ExplorationTask) -> tuple[EvidenceSnapshot, ...]:
    # 原确认窗口与最新窗口有界延续；不能不断积累每次纠正的全文。
    material = {item.evidence_id: item for item in task.intent_snapshots}
    for item in task.snapshots:
        previous = material.get(item.evidence_id)
        if previous is not None and previous != item:
            raise ExplorationStale("原意愿的来源已改变。")
        material[item.evidence_id] = item
    if len(material) > 14:
        raise ExplorationStale("原意愿的材料超出当前任务边界。")
    return tuple(material.values())


def _previous_group(
    previous: ExplorationTask | None, selected: ExplorationSkillSelection, *, change_group: bool,
) -> tuple[str, ...]:
    if (not change_group or previous is None or previous.result is None
            or previous.skill_library_revision != selected.catalog.revision
            or previous.skill_version_id != (selected.entry.version_id if selected.entry else None)):
        return ()
    return tuple(option["intent"] for option in previous.result["options"])


class ReplyExplorationService:
    def __init__(
        self, *, store: ExplorationStore, evidence: ExplorationEvidence,
        skills: SkillPort, runtime: ExplorationRuntime, generation: ExplorationGenerationPort,
    ) -> None:
        self._store, self._evidence, self._skills = store, evidence, skills
        self._runtime, self._generation = runtime, generation

    def open(
        self, *, scope: ContactScope, session_id: UUID, content: ExplorationInput,
        operation_key: UUID, expected_input_version_id: UUID | None = None,
        previous_id: UUID | None = None, automatic: bool = False,
        change_group: bool = False,
    ) -> dict[str, Any]:
        # 本字段只由服务端已选择记录延续，不能用公开input伪造确认。
        if content.confirmed_intent or content.answer:
            raise ExplorationError("请分别使用方向确认或关键问题应答。")
        return self._open(scope, ExplorationOpen(
            session_id, content, operation_key, expected_input_version_id, previous_id,
            automatic=automatic, change_group=change_group,
        ))

    def _open(
        self, scope: ContactScope, request: ExplorationOpen,
    ) -> dict[str, Any]:
        content = request.content
        replay = self._store.replay(scope, request)
        if replay is not None:
            self._validate_task(scope, replay)
            if replay.state == "failed":
                if request.automatic:
                    raise ExplorationError("自动探索失败，请手动刷新。")
                selected = self._pinned_skill(scope, replay)
                previous = self._store.read(scope, request.previous_id,
                                            purpose=ExplorationReadPurpose.HISTORY) if request.previous_id else None
                return self._run(self._store.retry(replay), selected, previous, change_group=request.change_group)
            return self._public(replay)
        previous = self._store.read(
            scope, request.previous_id, purpose=ExplorationReadPurpose.CURRENT
            if request.automatic else ExplorationReadPurpose.CONTINUE,
        ) if request.previous_id else None
        if previous is not None:
            if previous.state == "paused":
                raise ExplorationStale("当前探索已停止，请明确开启新的任务。")
            self._validate_task(scope, previous, check_skill=request.automatic)
            if (previous.session_id != request.session_id or previous.content.scene != content.scene
                    or previous.content.target_message_id != content.target_message_id
                    or previous.content.purpose_hint != content.purpose_hint):
                raise ExplorationStale("旧探索不属于当前目标或目的。")
            # 纠正保留已确认意愿，客户端传入的同名文字不能建立或替换确认。
            content = replace(content, confirmed_intent=previous.selected_intent or ""
                              if previous.has_confirmed_intent else "")
        if request.automatic and (previous is None or previous.state != "ready" or previous.has_confirmed_intent):
            raise ExplorationStale("只有活跃且尚未选定方向的任务允许更新。")
        if previous is not None and request.automatic and previous.automatic_call_count >= 3:
            raise ExplorationError("探索更新预算已用完，请手动刷新。")
        selected = select_exploration_skill(skills=self._skills, scope=scope, content=content)
        snapshots = self._evidence.capture(scope, content)
        if previous is not None and previous.has_confirmed_intent:
            self._evidence.validate(scope, previous.intent_snapshots)
        task = self._store.begin(
            scope=scope, request=replace(request, content=content),
            snapshots=snapshots, skill=selected, previous=previous,
        )
        return self._run(task, selected, previous, change_group=request.change_group)

    def _run(
        self, task: ExplorationTask, selected: ExplorationSkillSelection,
        previous: ExplorationTask | None, *, change_group: bool,
    ) -> dict[str, Any]:
        scope, content, snapshots = task.scope, task.content, task.snapshots
        try:
            if not task.skill_selection_complete:
                self._require_running(task)
                context = ExplorationContext(scope, content, tuple(item.model_payload for item in snapshots),
                                             validate_current=lambda current=task: self._require_running(current))
                version_id = self._runtime.select_skill(context, selected.catalog)
                if version_id is not None and not any(entry.version_id == version_id for entry in selected.catalog.entries):
                    raise ExplorationError("自动策略选择不属于当前目录。")
                task = self._store.pin_skill(task, version_id)
                selected = self._pinned_skill(scope, task)
            self._require_running(task)
            context = ExplorationContext(
                scope, content, tuple(item.model_payload for item in snapshots), selected.model_payload,
                _previous_group(previous, selected, change_group=change_group),
                validate_current=lambda current=task: self._require_running(current),
            )
            result = validate_exploration_output(self._runtime.explore(context), context)
            self._validate_task(scope, task)
            result = {**result, "evidence": [item.model_payload for item in snapshots],
                      "used_skill": {"name": selected.entry.name, "version_id": str(selected.entry.version_id),
                                     "version_number": selected.entry.version_number,
                                     "selection_method": "auto" if content.skill_mode == "auto" else "user"} if selected.entry else None,
                      "skill_choices": [{"name": entry.name, "version_id": str(entry.version_id),
                                         "version_number": entry.version_number} for entry in selected.catalog.entries]}
            return self._public(self._store.complete(task, result))
        except Exception:
            self._store.fail(task)
            raise

    def _require_running(self, task: ExplorationTask) -> None:
        current = self._store.read(task.scope, task.exploration_id)
        if current != task or current.state != "running":
            raise ExplorationStale("探索任务已停止或替换。")
        self._validate_task(task.scope, task)

    def read(self, *, scope: ContactScope, exploration_id: UUID) -> dict[str, Any]:
        task = self._store.read(scope, exploration_id)
        self._validate_task(scope, task)
        return self._public(task)

    def require_session(self, *, scope: ContactScope, session_id: UUID, exploration_id: UUID) -> None:
        """历史读取只核对操作归属，执行权限仍由confirm/answer/stop自身复验。"""

        task = self._store.read(scope, exploration_id, purpose=ExplorationReadPurpose.HISTORY)
        if task.session_id != session_id:
            raise ExplorationStale("探索不属于当前助手会话。")

    def confirm(
        self, *, scope: ContactScope, exploration_id: UUID, input_version_id: UUID,
        suggestion_id: UUID | None = None, direct_intent: str | None = None,
        session_id: UUID | None = None,
        prepare_only: bool = False,
        selection_only: bool = False,
    ) -> dict[str, Any]:
        if (suggestion_id is None) == (direct_intent is None):
            raise ExplorationError("请明确选择一个方向或输入本次意愿。")
        if direct_intent is not None and (not isinstance(direct_intent, str)
                                         or not 0 < len(direct_intent.strip()) <= 4096):
            raise ExplorationError("本次意愿文字无效。")
        if session_id is not None and not selection_only:
            completed = self._store.replay_confirmation(scope, session_id, exploration_id, input_version_id,
                                                        suggestion_id=suggestion_id, direct_intent=direct_intent)
            if completed is not None:
                if prepare_only:
                    return self._prepare_completed(scope, session_id, completed)
                return self._completed(scope, session_id, completed)
        if session_id is not None:
            self.require_session(scope=scope, session_id=session_id, exploration_id=exploration_id)
        task = self._store.read(scope, exploration_id)
        self._validate_task(scope, task)
        task = self._store.select(scope, exploration_id, input_version_id,
                                  suggestion_id=suggestion_id, direct_intent=direct_intent.strip()
                                  if direct_intent is not None else None)
        if task.state == "paused":
            return {"kind": "paused", "exploration_id": str(exploration_id),
                    "input_version_id": str(input_version_id), "confirmed_intent": task.selected_intent}
        if selection_only or not self._clear_intent(task):
            return self._public(task)
        return self._prepare(task) if prepare_only else self._generate(task)

    def answer(
        self, *, scope: ContactScope, exploration_id: UUID, input_version_id: UUID,
        question_id: UUID, answer: str, operation_key: UUID,
        session_id: UUID | None = None,
        prepare_only: bool = False,
        selection_only: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(answer, str) or not 0 < len(answer.strip()) <= 4096:
            raise ExplorationError("关键问题的回答无效。")
        if session_id is not None and not selection_only:
            completed = self._store.replay_answer(scope, session_id, exploration_id, input_version_id,
                                                  question_id=question_id, answer=answer, operation_key=operation_key)
            if completed is not None:
                if prepare_only:
                    return self._prepare_completed(scope, session_id, completed)
                return self._completed(scope, session_id, completed)
        if session_id is not None:
            self.require_session(scope=scope, session_id=session_id, exploration_id=exploration_id)
        task = self._store.read(scope, exploration_id, purpose=ExplorationReadPurpose.HISTORY)
        if task.state == "paused":
            raise ExplorationStale("当前探索已停止，旧问题不能恢复生成。")
        self._validate_task(scope, task)
        if (task.input_version_id != input_version_id or task.result is None
                or task.result["question_id"] != str(question_id)):
            raise ExplorationStale("关键问题不属于当前输入。")
        content = replace(task.content, answer=answer.strip(),
                          confirmed_intent=task.selected_intent or "" if task.has_confirmed_intent else "")
        result = self._open(scope, ExplorationOpen(
            task.session_id, content, operation_key, input_version_id, exploration_id, question_id=question_id,
        ))
        next_task = self._store.read(scope, UUID(result["exploration_id"]))
        # 回答不是确认；只沿已存在的服务器选择继续，未明时保留探索。
        if not selection_only and task.has_confirmed_intent and self._clear_intent(next_task):
            return self._prepare(next_task) if prepare_only else self._generate(next_task)
        return result

    def reconfirm(
        self, *, scope: ContactScope, session_id: UUID, exploration_id: UUID, input_version_id: UUID,
        expected_input_version_id: UUID, request_key: UUID,
        suggestion_id: UUID | None = None, direct_intent: str | None = None,
    ) -> dict[str, Any]:
        """显式重试只确认新的执行身份；模型仍由原助手会话入口运行。"""

        if (suggestion_id is None) == (direct_intent is None):
            raise ExplorationError("请明确再次确认原意愿。")
        if direct_intent is not None and (not isinstance(direct_intent, str)
                                         or not 0 < len(direct_intent.strip()) <= 4096):
            raise ExplorationError("本次意愿文字无效。")
        parent = self._store.read(scope, exploration_id, purpose=ExplorationReadPurpose.HISTORY)
        self._validate_task(scope, parent)
        task = self._store.reconfirm(
            scope, session_id, exploration_id, input_version_id,
            expected_input_version_id=expected_input_version_id, request_key=request_key,
            suggestion_id=suggestion_id, direct_intent=direct_intent.strip() if direct_intent is not None else None,
        )
        if task.selection_source is None or not isinstance(task.selection_id, UUID):
            raise ExplorationStale("重试确认没有可靠保存。")
        return {"kind": "confirmed", "session_id": str(task.session_id),
                "exploration_id": str(task.exploration_id), "input_version_id": str(task.input_version_id),
                "request_key": str(task.request_key), "suggestion_id": str(task.selection_id),
                "direction_source": task.selection_source.value,
                "skill_version_id": str(task.skill_version_id) if task.skill_version_id else None,
                "skill_library_revision": task.skill_library_revision}

    def stop(self, *, scope: ContactScope, exploration_id: UUID, input_version_id: UUID) -> None:
        self._store.stop(scope, exploration_id, input_version_id)

    def _validate_task(self, scope: ContactScope, task: ExplorationTask, *, check_skill: bool = True) -> None:
        if task.scope != scope:
            raise ExplorationStale("探索资料不属于当前联系人。")
        self._evidence.validate(scope, _snapshots(task))
        if check_skill:
            selection = self._pinned_skill(scope, task)
            if selection.catalog.revision != task.skill_library_revision:
                raise ExplorationStale("Skill目录已变化，请重新探索。")

    def _pinned_skill(self, scope: ContactScope, task: ExplorationTask) -> ExplorationSkillSelection:
        # 生成阶段固定为实际版本或NoSkill；关闭后绝不再次自动匹配。
        return select_exploration_skill(
            skills=self._skills, scope=scope,
            content=replace(task.content, skill_mode="user" if task.skill_version_id else "disabled",
                            skill_version_id=task.skill_version_id),
        )

    @staticmethod
    def _clear_intent(task: ExplorationTask) -> bool:
        return bool(task.has_confirmed_intent and task.result is not None
                    and task.result["question"] is None and not task.result["ambiguities"])

    @staticmethod
    def _public(task: ExplorationTask) -> dict[str, Any]:
        if task.result is None or task.state not in ("ready", "selected", "confirmed"):
            raise ExplorationError("探索尚未可靠完成，请手动重试。")
        return {**task.result, "kind": "clarification" if task.result["question"] else "directions",
                "session_id": str(task.session_id), "exploration_id": str(task.exploration_id),
                "input_version_id": str(task.input_version_id),
                "skill_version_id": str(task.skill_version_id) if task.skill_version_id else None,
                "skill_library_revision": task.skill_library_revision,
                "confirmed_intent": task.selected_intent if task.has_confirmed_intent else None}

    def _generation_command(self, task: ExplorationTask) -> ExplorationGeneration:
        self._validate_task(task.scope, task)
        if not self._clear_intent(task) or task.state not in ("selected", "confirmed"):
            raise ExplorationStale("本次意愿仍未明确确认。")
        intent, source = task.selected_intent, task.selection_source
        if not isinstance(intent, str) or not isinstance(source, DirectionSource):
            raise ExplorationStale("本次意愿没有可靠的确认记录。")
        skill = UserSkillChoice(task.skill_version_id) if task.skill_version_id else NoSkill()
        return ExplorationGeneration(task, intent, source, skill)

    def _prepare(self, task: ExplorationTask) -> dict[str, Any]:
        # 只领取 A 的实际两 UUID 身份；意愿未明确的探索不会到达此处。
        receipt = self._generation.prepare(self._generation_command(task))
        return {"kind": "prepared", "exploration_id": str(task.exploration_id), "generation": receipt}

    def _prepare_completed(
        self, scope: ContactScope, session_id: UUID, completed: ExplorationCompletedInput,
    ) -> dict[str, Any]:
        receipt = self._generation.prepare_replay(scope, session_id, completed)
        return {"kind": "prepared", "exploration_id": str(completed.exploration_id), "generation": receipt}

    def _generate(self, task: ExplorationTask) -> dict[str, Any]:
        turn = self._generation.generate(self._generation_command(task))
        self._store.finish(task)
        return {"kind": "generated", "turn": turn, "confirmed_intent": task.selected_intent,
                "exploration_id": str(task.exploration_id)}

    def _completed(self, scope: ContactScope, session_id: UUID, completed: ExplorationCompletedInput) -> dict[str, Any]:
        turn = self._generation.replay(scope, session_id, completed)
        content = completed.input_payload["content"]
        intent = content["direction"] if content["type"] == "reply_to_message" else content["purpose"]
        return {"kind": "generated", "turn": turn, "confirmed_intent": intent,
                "exploration_id": str(completed.exploration_id)}
