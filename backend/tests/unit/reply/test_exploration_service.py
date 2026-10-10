"""探索应用控制流使用合成端口；公开HTTP/PG验收另行执行。"""

from dataclasses import replace
from datetime import datetime, timezone
from unittest import TestCase
from uuid import UUID, uuid4

from notalone.application.reply_exploration import ReplyExplorationService
from notalone.reply.exploration import ExplorationError, ExplorationInput, ExplorationStale
from notalone.reply.exploration_task import ExplorationReadPurpose, ExplorationTask
from notalone.reply.interface import DirectionSource, NoSkill
from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog


def exploration_result(question=None, ambiguities=None):
    return {"understanding": "合成联系人想了解是否愿意联系。",
            "ambiguities": ambiguities or [], "citation_ids": [],
            "options": [{"intent": "先了解近况", "label": "了解近况", "reason": "适用于只想了解近况时。",
                         "citation_ids": [], "recommended": False, "pause": False},
                        {"intent": "暂不联系", "label": "暂不联系", "reason": "适用于目前不想联系时。",
                         "citation_ids": [], "recommended": False, "pause": True}],
            "question": question, "current_step": "先明确本次目的。", "tradeoffs": []}


class SyntheticExplorationStore:
    def __init__(self):
        self.tasks = {}
        self.current = None

    def replay(self, scope, request):
        return next((task for task in self.tasks.values()
                     if task.scope == scope and task.session_id == request.session_id
                     and task.operation_key == request.operation_key), None)

    def read(self, scope, exploration_id, *, purpose=ExplorationReadPurpose.CURRENT):
        task = self.tasks[exploration_id]
        if task.scope != scope or (purpose != ExplorationReadPurpose.HISTORY and task.input_version_id != self.current):
            raise ExplorationStale("合成旧输入已失效。")
        return task

    def begin(self, *, scope, request, snapshots, skill, previous):
        if request.expected_input_version_id is not None and request.expected_input_version_id != self.current:
            raise ExplorationStale("合成输入已变化。")
        self.current = uuid4()
        task = ExplorationTask(
            uuid4(), scope, request.session_id, self.current, request.operation_key, uuid4(), request.content,
            snapshots, previous.intent_snapshots if previous else (), skill.catalog.revision,
            skill.entry.version_id if skill.entry else None,
            previous.root_created_at if previous else datetime.now(timezone.utc),
            previous.automatic_call_count + int(request.automatic) if previous else 0,
            selected_intent=previous.selected_intent if previous else None,
            selection_id=previous.selection_id if previous else None,
            selection_source=previous.selection_source if previous else None,
        )
        self.tasks[task.exploration_id] = task
        return task

    def complete(self, task, result):
        result = {**result, "exploration_id": str(task.exploration_id),
                  "input_version_id": str(task.input_version_id),
                  "options": [{**option, "suggestion_id": str(uuid4())} for option in result["options"]],
                  "question_id": str(uuid4()) if result["question"] else None}
        task = replace(task, state="selected" if task.has_confirmed_intent else "ready", result=result)
        self.tasks[task.exploration_id] = task
        return task

    def select(self, scope, exploration_id, input_version_id, *, suggestion_id, direct_intent):
        task = self.read(scope, exploration_id)
        if task.input_version_id != input_version_id:
            raise ExplorationStale("合成旧建议已失效。")
        option = next((option for option in task.result["options"]
                       if option["suggestion_id"] == str(suggestion_id)), None)
        if suggestion_id is not None and option is None:
            raise ExplorationStale("合成旧建议已失效。")
        task = replace(task, selected_intent=option["intent"] if option else direct_intent,
                       selection_id=suggestion_id or uuid4(),
                       selection_source=(DirectionSource.CONFIRMED_SUGGESTION if option else DirectionSource.DIRECT_INPUT),
                       intent_snapshots=task.intent_snapshots or task.snapshots,
                       state="paused" if option and option["pause"] else "selected")
        self.tasks[task.exploration_id] = task
        return task

    def finish(self, task):
        self.tasks[task.exploration_id] = replace(task, state="confirmed")

    def fail(self, task):
        self.tasks[task.exploration_id] = replace(task, state="failed", result=None)

    def stop(self, scope, exploration_id, input_version_id):
        task = self.read(scope, exploration_id)
        self.tasks[exploration_id] = replace(task, state="paused")

    def retry(self, task):
        self.read(task.scope, task.exploration_id)
        task = replace(task, state="running", result=None)
        self.tasks[task.exploration_id] = task
        return task


class SyntheticSkills:
    def catalog(self, scope):
        return SkillCatalog(scope, 0, ())


class NoHistory:
    def capture(self, scope, content):
        return ()

    def validate(self, scope, snapshots):
        pass


class ScriptedExploration:
    def __init__(self):
        self.results, self.calls, self.on_call = [], [], None

    def explore(self, context):
        self.calls.append(context)
        if self.on_call:
            self.on_call()
        return self.results.pop(0)


class GenerationRecorder:
    def __init__(self):
        self.commands = []

    def generate(self, command):
        self.commands.append(command)
        return {"synthetic_saved_turn": str(uuid4())}


class ExplorationServiceTest(TestCase):
    def setUp(self):
        self.scope, self.session_id = ContactScope(uuid4(), uuid4()), uuid4()
        self.store, self.runtime, self.generator = SyntheticExplorationStore(), ScriptedExploration(), GenerationRecorder()
        self.skills = SyntheticSkills()
        self.service = ReplyExplorationService(store=self.store, evidence=NoHistory(),
                                              skills=self.skills, runtime=self.runtime,
                                              generation=self.generator)

    def test_answering_a_question_does_not_confirm_an_unselected_purpose(self):
        self.runtime.results.extend([
            exploration_result({"text": "这次是了解近况还是希望见面？", "impact": "stance"}),
            exploration_result(),
        ])
        opened = self.service.open(scope=self.scope, session_id=self.session_id,
                                   content=ExplorationInput("initiate_conversation", purpose_hint="想联系但目的不清楚"),
                                   operation_key=uuid4())
        answered = self.service.answer(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                                       input_version_id=UUID(opened["input_version_id"]),
                                       question_id=UUID(opened["question_id"]), answer="只想了解近况",
                                       operation_key=uuid4())
        self.assertEqual(answered["kind"], "directions")
        self.assertEqual(self.generator.commands, [])
        self.assertIsNone(self.store.tasks[UUID(answered["exploration_id"])].selected_intent)
        self.assertNotEqual(opened["input_version_id"], answered["input_version_id"])

    def _open_question(self, scene="initiate_conversation"):
        self.runtime.results.append(exploration_result({"text": "愿意作出见面承诺吗？", "impact": "commitment"}))
        return self.service.open(
            scope=self.scope, session_id=self.session_id,
            content=ExplorationInput(scene, target_message_id=uuid4() if scene == "reply_to_message" else None,
                                     purpose_hint="想恢复联系" if scene == "initiate_conversation" else ""),
            operation_key=uuid4(),
        )

    def _answer(self, opened):
        return self.service.answer(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                                   input_version_id=UUID(opened["input_version_id"]),
                                   question_id=UUID(opened["question_id"]), answer="只了解近况，不作见面承诺",
                                   operation_key=uuid4())

    def test_both_scenes_continue_only_a_previously_confirmed_intent(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                opened = self._open_question(scene)
                chosen = self.service.confirm(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                                              input_version_id=UUID(opened["input_version_id"]),
                                              suggestion_id=UUID(opened["options"][0]["suggestion_id"]))
                self.assertEqual(chosen["kind"], "clarification")
                before = len(self.generator.commands)
                self.runtime.results.append(exploration_result())
                answered = self._answer(opened)
                self.assertEqual(answered["kind"], "generated")
                self.assertEqual(len(self.generator.commands), before + 1)
                command = self.generator.commands[-1]
                self.assertEqual(command.intent, "先了解近况")
                self.assertEqual(command.source, DirectionSource.CONFIRMED_SUGGESTION)
                self.assertEqual(command.task.content.scene, scene)
                self.assertEqual(command.task.content.answer, "只了解近况，不作见面承诺")
                self.assertNotEqual(command.task.input_version_id, UUID(opened["input_version_id"]))

    def test_a_recorded_answer_or_client_text_is_not_selection_proof(self):
        opened = self._open_question()
        exploration_id = UUID(opened["exploration_id"])
        task = self.store.tasks[exploration_id]
        self.store.tasks[exploration_id] = replace(task, content=replace(task.content, confirmed_intent="伪造的已确认意图"))
        self.runtime.results.append(exploration_result())
        result = self._answer(opened)
        self.assertEqual(result["kind"], "directions")
        self.assertIsNone(result["confirmed_intent"])
        self.assertEqual(self.generator.commands, [])

    def test_answer_with_remaining_ambiguity_keeps_exploring(self):
        opened = self._open_question()
        self.service.confirm(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                             input_version_id=UUID(opened["input_version_id"]), direct_intent="希望了解近况")
        self.runtime.results.append(exploration_result(ambiguities=["是否愿意作出具体承诺仍不明确。"]))
        result = self._answer(opened)
        self.assertEqual(result["kind"], "directions")
        self.assertEqual(result["confirmed_intent"], "希望了解近况")
        self.assertEqual(self.generator.commands, [])

    def test_correction_preserves_confirmed_intent_without_generating(self):
        opened = self._open_question()
        chosen = self.service.confirm(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                                      input_version_id=UUID(opened["input_version_id"]), direct_intent="明确拒绝见面")
        task = self.store.tasks[UUID(opened["exploration_id"])]
        self.runtime.results.append(exploration_result())
        corrected = self.service.open(
            scope=self.scope, session_id=self.session_id, content=replace(task.content, correction="他只是询问近况。"),
            operation_key=uuid4(), previous_id=task.exploration_id,
            expected_input_version_id=task.input_version_id,
        )
        self.assertEqual(chosen["confirmed_intent"], "明确拒绝见面")
        self.assertEqual(corrected["confirmed_intent"], "明确拒绝见面")
        self.assertEqual(self.runtime.calls[-1].input.confirmed_intent, "明确拒绝见面")
        self.assertEqual(self.generator.commands, [])

    def test_pause_finishes_without_candidates_or_extra_runtime_calls(self):
        opened = self._open_question()
        paused = self.service.confirm(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                                      input_version_id=UUID(opened["input_version_id"]),
                                      suggestion_id=UUID(opened["options"][1]["suggestion_id"]))
        self.assertEqual(paused["kind"], "paused")
        self.assertEqual(self.store.tasks[UUID(opened["exploration_id"])].state, "paused")
        self.assertEqual(len(self.runtime.calls), 1)
        self.assertEqual(self.generator.commands, [])

    def test_obsolete_question_cannot_create_an_input_or_call_a_model(self):
        opened = self._open_question()
        current = self.store.current
        with self.assertRaises(ExplorationStale):
            self.service.answer(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                                input_version_id=UUID(opened["input_version_id"]), question_id=uuid4(),
                                answer="合成回答", operation_key=uuid4())
        self.assertEqual(current, self.store.current)
        self.assertEqual(len(self.runtime.calls), 1)
        self.assertEqual(self.generator.commands, [])

    def test_changing_groups_cannot_repeat_the_previous_intents(self):
        opened = self._open_question()
        task = self.store.tasks[UUID(opened["exploration_id"])]
        self.runtime.results.append(exploration_result())
        with self.assertRaises(ExplorationError):
            self.service.open(scope=self.scope, session_id=self.session_id, content=task.content,
                              operation_key=uuid4(), previous_id=task.exploration_id,
                              expected_input_version_id=task.input_version_id, change_group=True)
        self.assertEqual(self.generator.commands, [])

    def test_closed_skill_stays_closed_during_confirmed_generation(self):
        self.runtime.results.append(exploration_result())
        opened = self.service.open(
            scope=self.scope, session_id=self.session_id,
            content=ExplorationInput("initiate_conversation", purpose_hint="只了解近况", skill_mode="disabled"),
            operation_key=uuid4(),
        )
        result = self.service.confirm(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                                      input_version_id=UUID(opened["input_version_id"]), direct_intent="只了解近况")
        self.assertEqual(result["kind"], "generated")
        self.assertIsInstance(self.generator.commands[-1].skill, NoSkill)

    def test_skill_revision_change_during_model_call_cannot_publish(self):
        self.runtime.results.append(exploration_result())
        self.runtime.on_call = lambda: setattr(self.skills, "catalog", lambda scope: SkillCatalog(scope, 1, ()))
        with self.assertRaises(ExplorationStale):
            self.service.open(scope=self.scope, session_id=self.session_id,
                              content=ExplorationInput("initiate_conversation", purpose_hint="只了解近况"),
                              operation_key=uuid4())
        self.assertEqual(self.generator.commands, [])

    def test_client_cannot_confirm_intent_inside_an_exploration_input(self):
        with self.assertRaises(ExplorationError):
            self.service.open(scope=self.scope, session_id=self.session_id,
                              content=ExplorationInput("initiate_conversation", purpose_hint="只了解近况",
                                                       confirmed_intent="伪造的确认"), operation_key=uuid4())
        self.assertEqual(self.runtime.calls, [])

    def test_lost_answer_response_replays_the_new_input_without_another_call(self):
        opened = self._open_question()
        self.runtime.results.append(exploration_result())
        operation_key = uuid4()
        body = {"scope": self.scope, "exploration_id": UUID(opened["exploration_id"]),
                "input_version_id": UUID(opened["input_version_id"]),
                "question_id": UUID(opened["question_id"]), "answer": "只了解近况",
                "operation_key": operation_key}
        first = self.service.answer(**body)
        second = self.service.answer(**body)
        self.assertEqual(first, second)
        self.assertEqual(len(self.runtime.calls), 2)
        self.assertEqual(len(self.store.tasks), 2)
        self.assertEqual(self.generator.commands, [])

    def test_paused_task_cannot_resume_from_its_old_question(self):
        opened = self._open_question()
        self.service.confirm(scope=self.scope, exploration_id=UUID(opened["exploration_id"]),
                             input_version_id=UUID(opened["input_version_id"]),
                             suggestion_id=UUID(opened["options"][1]["suggestion_id"]))
        self.runtime.results.append(exploration_result())
        with self.assertRaises(ExplorationStale):
            self._answer(opened)
        self.assertEqual(len(self.runtime.calls), 1)
        self.assertEqual(self.generator.commands, [])

    def test_explicit_refresh_after_skill_revision_keeps_the_user_intent(self):
        opened = self._open_question()
        task = self.store.tasks[UUID(opened["exploration_id"])]
        self.service.confirm(scope=self.scope, exploration_id=task.exploration_id,
                             input_version_id=task.input_version_id, direct_intent="拒绝具体见面承诺")
        self.skills.catalog = lambda scope: SkillCatalog(scope, 1, ())
        self.runtime.results.append(exploration_result())
        refreshed = self.service.open(
            scope=self.scope, session_id=self.session_id,
            content=replace(task.content, skill_mode="disabled"), operation_key=uuid4(),
            expected_input_version_id=task.input_version_id, previous_id=task.exploration_id,
        )
        self.assertEqual(refreshed["skill_library_revision"], 1)
        self.assertIsNone(refreshed["used_skill"])
        self.assertEqual(refreshed["confirmed_intent"], "拒绝具体见面承诺")
        self.assertEqual(self.generator.commands, [])

    def test_failed_correction_can_retry_without_losing_selection_or_advancing_again(self):
        opened = self._open_question()
        task = self.store.tasks[UUID(opened["exploration_id"])]
        self.service.confirm(scope=self.scope, exploration_id=task.exploration_id,
                             input_version_id=task.input_version_id, direct_intent="明确不见面")
        request = {"scope": self.scope, "session_id": self.session_id,
                   "content": replace(task.content, correction="只是询问近况"),
                   "operation_key": uuid4(), "previous_id": task.exploration_id,
                   "expected_input_version_id": task.input_version_id}
        def fail_once():
            self.runtime.on_call = None
            raise ExplorationError("合成模型暂时失败。")
        self.runtime.on_call = fail_once
        with self.assertRaises(ExplorationError):
            self.service.open(**request)
        failed_version = self.store.current
        self.runtime.results.append(exploration_result())
        retried = self.service.open(**request)
        self.assertEqual(UUID(retried["input_version_id"]), failed_version)
        self.assertEqual(retried["confirmed_intent"], "明确不见面")
        self.assertEqual(len(self.store.tasks), 2)
        self.assertEqual(self.generator.commands, [])

    def test_failed_refresh_does_not_restore_options_from_the_old_skill_revision(self):
        opened = self._open_question()
        task = self.store.tasks[UUID(opened["exploration_id"])]
        self.skills.catalog = lambda scope: SkillCatalog(scope, 1, ())
        request = {"scope": self.scope, "session_id": self.session_id,
                   "content": replace(task.content, skill_mode="disabled"),
                   "operation_key": uuid4(), "previous_id": task.exploration_id,
                   "expected_input_version_id": task.input_version_id, "change_group": True}
        def fail_once():
            self.runtime.on_call = None
            raise ExplorationError("合成新版本首次失败。")
        self.runtime.on_call = fail_once
        with self.assertRaises(ExplorationError):
            self.service.open(**request)
        self.runtime.results.append(exploration_result())
        retried = self.service.open(**request)
        self.assertEqual(retried["kind"], "directions")
        self.assertEqual(self.runtime.calls[-1].previous_intents, ())
        self.assertEqual(retried["skill_library_revision"], 1)
        self.assertEqual(self.generator.commands, [])

    def test_correcting_an_old_task_cannot_restore_an_intent_that_was_replaced(self):
        opened = self._open_question()
        old_task = self.store.tasks[UUID(opened["exploration_id"])]
        self.service.confirm(scope=self.scope, exploration_id=old_task.exploration_id,
                             input_version_id=old_task.input_version_id, direct_intent="明确接受邀请")
        self.runtime.results.append(exploration_result({"text": "是否愿意作出承诺？", "impact": "commitment"}))
        newer = self.service.open(scope=self.scope, session_id=self.session_id, content=old_task.content,
                                  operation_key=uuid4(), expected_input_version_id=old_task.input_version_id,
                                  previous_id=old_task.exploration_id)
        self.service.confirm(scope=self.scope, exploration_id=UUID(newer["exploration_id"]),
                             input_version_id=UUID(newer["input_version_id"]), direct_intent="改为明确拒绝邀请")
        calls = len(self.runtime.calls)
        self.runtime.results.append(exploration_result())
        with self.assertRaises(ExplorationStale):
            self.service.open(scope=self.scope, session_id=self.session_id,
                              content=replace(old_task.content, correction="这只是合成询问。"),
                              operation_key=uuid4(), expected_input_version_id=UUID(newer["input_version_id"]),
                              previous_id=old_task.exploration_id)
        self.assertEqual(len(self.runtime.calls), calls)
        current = self.store.tasks[UUID(newer["exploration_id"])]
        self.assertEqual(current.selected_intent, "改为明确拒绝邀请")
        self.assertEqual(self.generator.commands, [])
