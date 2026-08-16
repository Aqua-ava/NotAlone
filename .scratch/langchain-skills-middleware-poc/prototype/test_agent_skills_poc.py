from __future__ import annotations

import unittest
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatResult
from langchain_core.runnables import Runnable
from pydantic import Field

from agent_skills_poc import (
    ContactScope,
    InMemorySkillPort,
    ReplyAgentFactory,
    ReplyRequest,
    ReplyRuntimeContext,
    SKILL_SOURCE,
    ScopedSkillsBackend,
    SkillLoadBudget,
    SkillVersion,
    read_skill_file,
    thread_namespace_id,
)


class ToolCallingFakeModel(FakeMessagesListChatModel):
    bound_tool_names: list[str] = Field(default_factory=list)
    seen_message_batches: list[list[BaseMessage]] = Field(default_factory=list)
    seen_system_prompts: list[str] = Field(default_factory=list)

    def bind_tools(
        self,
        tools: Sequence[Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        del tool_choice, kwargs
        self.bound_tool_names = [
            getattr(bound_tool, "name", getattr(bound_tool, "__name__", ""))
            for bound_tool in tools
        ]
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.seen_message_batches.append(list(messages))
        for message in messages:
            if isinstance(message, SystemMessage):
                self.seen_system_prompts.append(str(message.content))
        return super()._generate(messages, stop, run_manager, **kwargs)


class SkillsMiddlewarePocTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope_a_v1 = ContactScope("owner-a", "contact-a", 1)
        self.scope_a_v2 = ContactScope("owner-a", "contact-a", 2)
        self.scope_b_v1 = ContactScope("owner-a", "contact-b", 1)

        self.warm = SkillVersion(
            scope=self.scope_a_v1,
            name="warm-reply",
            version_id="warm-v1",
            description="温和回应并确认对方时间",
            content=(
                "---\n"
                "name: warm-reply\n"
                "description: 温和回应并确认对方时间\n"
                "allowed-tools: shell send_message\n"
                "---\n"
                "先回应对方，再给出一个明确时间。\n"
            ),
        )
        self.direct = SkillVersion(
            scope=self.scope_a_v1,
            name="direct-reply",
            version_id="direct-v1",
            description="直接给出简短结论",
            content="---\nname: direct-reply\ndescription: 直接给出简短结论\n---\n直接回复。\n",
        )
        self.disabled = SkillVersion(
            scope=self.scope_a_v1,
            name="disabled-reply",
            version_id="disabled-v1",
            description="已停用策略",
            content="---\nname: disabled-reply\ndescription: 已停用策略\n---\n不要使用。\n",
            enabled=False,
        )
        self.clear = SkillVersion(
            scope=self.scope_a_v2,
            name="clear-reply",
            version_id="clear-v2",
            description="修订后的清晰回复策略",
            content="---\nname: clear-reply\ndescription: 修订后的清晰回复策略\n---\n清晰回复。\n",
        )
        self.private_b = SkillVersion(
            scope=self.scope_b_v1,
            name="private-b-reply",
            version_id="private-b-v1",
            description="只属于联系人 B 的策略",
            content="---\nname: private-b-reply\ndescription: 只属于联系人 B 的策略\n---\n联系人 B 专用。\n",
        )
        self.port = InMemorySkillPort(
            [self.warm, self.direct, self.disabled, self.clear, self.private_b]
        )
        self.models: dict[ContactScope, ToolCallingFakeModel] = {}

    def _factory(
        self,
        selections: dict[ContactScope, SkillVersion | Sequence[SkillVersion]],
        model_sleep: float | None = None,
    ) -> ReplyAgentFactory:
        def model_factory(scope: ContactScope) -> ToolCallingFakeModel:
            selection = selections[scope]
            selected_runs = (
                [selection, selection]
                if isinstance(selection, SkillVersion)
                else list(selection)
            )
            responses: list[AIMessage] = []
            for run_number, selected in enumerate(selected_runs, start=1):
                responses.extend(
                    [
                        AIMessage(
                            id=f"model-read-{run_number}",
                            content="",
                            tool_calls=[
                                {
                                    "name": "read_file",
                                    "args": {
                                        "file_path": selected.path,
                                        "offset": 0,
                                        "limit": 1000,
                                    },
                                    "id": f"read-skill-{run_number}",
                                }
                            ],
                        ),
                        AIMessage(
                            id=f"model-candidate-{run_number}",
                            content="",
                            tool_calls=[
                                {
                                    "name": "ReplyCandidate",
                                    "args": {
                                        "candidate_text": "可以，明天晚上七点见。",
                                        "basis": ["对方提出明天见面"],
                                        "skill_name": selected.name,
                                        "skill_version": selected.version_id,
                                    },
                                    "id": f"return-candidate-{run_number}",
                                },
                            ],
                        ),
                    ]
                )
            model = ToolCallingFakeModel(responses=responses, sleep=model_sleep)
            self.models[scope] = model
            return model

        return ReplyAgentFactory(self.port, model_factory)

    def test_end_to_end_progressive_load_returns_structured_candidate(self) -> None:
        factory = self._factory({self.scope_a_v1: self.warm})

        result = factory.invoke(
            ReplyRequest(
                scope=self.scope_a_v1,
                conversation_id="window-1",
                user_text="对方说：明天见。请给我候选回复。",
            )
        )

        self.assertEqual(result.candidate.candidate_text, "可以，明天晚上七点见。")
        self.assertEqual(result.candidate.skill_version, "warm-v1")
        read_messages = [
            message
            for message in result.messages
            if isinstance(message, ToolMessage) and message.name == "read_file"
        ]
        self.assertEqual(len(read_messages), 1)
        self.assertIn("先回应对方", str(read_messages[0].content))

    def test_catalog_and_registered_tools_do_not_expand_skill_permissions(self) -> None:
        factory = self._factory({self.scope_a_v1: self.warm})
        factory.invoke(
            ReplyRequest(self.scope_a_v1, "window-1", "生成一条候选回复")
        )

        model = self.models[self.scope_a_v1]
        self.assertEqual(set(model.bound_tool_names), {"read_file", "ReplyCandidate"})
        prompt = model.seen_system_prompts[-1]
        self.assertIn("warm-reply", prompt)
        self.assertIn("direct-reply", prompt)
        self.assertNotIn("private-b-reply", prompt)
        self.assertNotIn("disabled-reply", prompt)
        self.assertNotIn("allowed-tools", prompt)
        self.assertNotIn("shell", model.bound_tool_names)
        self.assertNotIn("send_message", model.bound_tool_names)

    def test_read_file_rejects_traversal_scope_leak_and_second_skill(self) -> None:
        context = ReplyRuntimeContext(self.scope_a_v1, SkillLoadBudget())
        content = read_skill_file(
            self.port,
            self.scope_a_v1,
            context,
            self.warm.path,
        )
        self.assertIn("先回应对方", content)

        with self.assertRaisesRegex(PermissionError, "最多读取一个"):
            read_skill_file(
                self.port,
                self.scope_a_v1,
                context,
                self.direct.path,
            )
        for denied_path in (
            f"{self.warm.path}/../secrets.txt",
            self.private_b.path,
            self.disabled.path,
        ):
            with self.subTest(path=denied_path):
                with self.assertRaises(PermissionError):
                    read_skill_file(
                        self.port,
                        self.scope_a_v1,
                        ReplyRuntimeContext(self.scope_a_v1, SkillLoadBudget()),
                        denied_path,
                    )

        class LeakySkillPort:
            def list_enabled(
                self,
                scope: ContactScope,
            ) -> Sequence[SkillVersion]:
                del scope
                return [self.private_b]

            def load_enabled(
                self,
                scope: ContactScope,
                file_path: str,
            ) -> SkillVersion:
                del scope, file_path
                return self.private_b

        leaky_port = LeakySkillPort()
        leaky_port.private_b = self.private_b
        self.assertEqual(
            ScopedSkillsBackend(leaky_port, self.scope_a_v1).ls(SKILL_SOURCE).error,
            "permission_denied",
        )
        with self.assertRaisesRegex(PermissionError, "范围之外"):
            read_skill_file(
                leaky_port,
                self.scope_a_v1,
                ReplyRuntimeContext(self.scope_a_v1, SkillLoadBudget()),
                self.warm.path,
            )

    def test_same_thread_keeps_candidate_but_not_previous_skill_body(self) -> None:
        factory = self._factory({self.scope_a_v1: [self.warm, self.direct]})
        first = factory.invoke(ReplyRequest(self.scope_a_v1, "window-1", "第一轮"))
        second = factory.invoke(ReplyRequest(self.scope_a_v1, "window-1", "改直接一点"))

        second_contents = "\n".join(str(message.content) for message in second.messages)
        self.assertEqual(first.thread_namespace_id, second.thread_namespace_id)
        self.assertIn("上一轮未发送候选", second_contents)
        self.assertIn("直接回复", second_contents)
        self.assertNotIn("先回应对方", second_contents)
        self.assertNotIn("allowed-tools", second_contents)
        self.assertEqual(self.port.list_calls[self.scope_a_v1], 2)

    def test_revision_changes_agent_cache_and_thread_namespace(self) -> None:
        factory = self._factory(
            {self.scope_a_v1: self.warm, self.scope_a_v2: self.clear}
        )
        request_v1 = ReplyRequest(self.scope_a_v1, "window-1", "第一轮")
        first = factory.invoke(request_v1)
        revised = factory.invoke(
            ReplyRequest(self.scope_a_v2, "window-1", "目录修订后的新一轮")
        )

        self.assertEqual(self.port.list_calls[self.scope_a_v1], 1)
        self.assertEqual(self.port.list_calls[self.scope_a_v2], 1)
        self.assertNotEqual(first.thread_namespace_id, revised.thread_namespace_id)
        self.assertEqual(
            revised.thread_namespace_id,
            thread_namespace_id("window-1", self.scope_a_v2),
        )
        self.assertEqual(
            factory.cached_scopes,
            frozenset({self.scope_a_v1, self.scope_a_v2}),
        )
        revised_prompt = self.models[self.scope_a_v2].seen_system_prompts[-1]
        self.assertIn("clear-reply", revised_prompt)
        self.assertNotIn("warm-reply", revised_prompt)

    def test_same_thread_concurrent_calls_are_serialized(self) -> None:
        factory = self._factory(
            {self.scope_a_v1: [self.warm, self.direct]},
            model_sleep=0.01,
        )

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    factory.invoke,
                    ReplyRequest(self.scope_a_v1, "window-1", user_text),
                )
                for user_text in ("第一条并发请求", "第二条并发请求")
            ]
        results = [future.result() for future in futures]

        self.assertEqual(
            {result.candidate.skill_name for result in results},
            {"warm-reply", "direct-reply"},
        )
        self.assertEqual(
            {result.thread_namespace_id for result in results},
            {thread_namespace_id("window-1", self.scope_a_v1)},
        )


if __name__ == "__main__":
    unittest.main()
