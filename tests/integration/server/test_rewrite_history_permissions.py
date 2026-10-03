"""通过真实 HTTP 验证草稿润色的请求权限，不读取业务资料或调用外部模型。"""

from __future__ import annotations

import json
import unittest
from copy import deepcopy
from typing import Any
from uuid import UUID, uuid4

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture,
    ScriptedCoreModel,
    tool_response,
)


class HistoryProbingModel(ScriptedCoreModel):
    """主动试探历史工具，仅引用真实工具返回的依据或当前草稿。"""

    def _generate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager: Any = None, **kwargs: Any,
    ) -> Any:
        index = len(self.seen_calls)
        if index < len(self.responses):
            response = self.responses[index]
            if (isinstance(response, AIMessage) and response.tool_calls
                    and response.tool_calls[0]["name"] == "ReplyRuntimeOutput"):
                payload = deepcopy(response.tool_calls[0]["args"])
                for message in messages:
                    if not isinstance(message, ToolMessage) or message.name not in (
                        "conversation_search", "conversation_query",
                    ):
                        continue
                    try:
                        result = json.loads(message.content)
                    except (TypeError, ValueError):
                        continue
                    if result.get("status") == "ok" and result.get("messages"):
                        payload["candidates"][0]["citation_ids"].append(
                            result["messages"][0]["evidence_id"],
                        )
                        break
                self.responses[index] = tool_response("ReplyRuntimeOutput", payload)
        return super()._generate(messages, stop, run_manager, **kwargs)


class RewriteHistoryPermissionHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    reply_model_factory = HistoryProbingModel

    def _output(self, citation_ids: list[str] | None = None) -> AIMessage:
        return tool_response("ReplyRuntimeOutput", {
            "candidates": [{
                "text": "我们找个时间再聊。", "basis": "依据本次可用材料保留草稿原意。",
                "citation_ids": citation_ids or [str(self.draft_evidence_id)],
                "risk_notes": [],
            }],
            "used_skill_version_id": None,
        })

    def _rewrite(
        self, imported: dict[str, Any], **extra: Any,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        body = {
            "contact_id": imported["contact_id"], "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "我们找个时间再聊。"},
        }
        body.update(extra)
        status, reply = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, reply)
        evidence = self._get(self.backend, self._evidence_path(imported, reply))["evidence"]
        return reply, evidence

    def test_plain_rewrite_cannot_read_history_even_when_model_calls_tools(self) -> None:
        current = self._import(self.backend, "权限A", "权限茉莉茶")
        other_contact = self._import(self.backend, "权限B", "权限乌龙茶")
        other_owner = self._import(self.other_backend, "权限另一用户", "权限大红袍")
        history_texts = [
            message["text"] for imported in (current, other_contact, other_owner)
            for message in imported["messages"]
        ]
        for path, extra, text in (
            ("/api/memories/manual-contact", {"contact_id": current["contact_id"]},
             "权限关系记忆：联系人习惯找个时间再聊。"),
            ("/api/memories/manual-owner", {}, "权限本人记忆：我习惯找个时间再聊。"),
        ):
            status, memory = self.backend.request(path, {
                "text": text, "category": "preference", **extra,
            })
            self.assertEqual(status, 200, memory)
            history_texts.append(text)
        binding = next(
            item for item in self.bindings.list_active_bindings(owner_id=self.owner_id)
            if item.scope.contact_id == UUID(current["contact_id"])
        )

        for tool_name, args in (
            ("conversation_search", {"query": "核心验收", "top_k": 8}),
            ("conversation_query", {"session_id": str(binding.binding_id),
                                    "before": 2, "after": 2}),
        ):
            with self.subTest(tool=tool_name):
                start = len(self.reply_model.seen_calls)
                self.reply_model.responses.extend([tool_response(tool_name, args), self._output()])
                reply, evidence = self._rewrite(current)
                self.assertEqual([item["kind"] for item in evidence], ["user_draft"])
                self.assertEqual(reply["candidates"][0]["citation_ids"],
                                 [str(self.draft_evidence_id)])
                self.assertEqual(set(self.reply_model.bound_tool_names),
                                 {"read_file", "ReplyRuntimeOutput"})
                calls = self.reply_model.seen_calls[start:]
                self.assertTrue(any(
                    call.tool_calls and call.tool_calls[0]["name"] == tool_name
                    for messages in calls for call in messages
                    if isinstance(call, AIMessage)
                ))
                for messages in calls:
                    outbound = "\n".join(str(message.content) for message in messages)
                    for text in history_texts:
                        self.assertNotIn(text, outbound)

    def test_authorized_rewrite_can_cite_only_current_scope_history(self) -> None:
        current = self._import(self.backend, "授权A", "授权茉莉茶")
        other_contact = self._import(self.backend, "授权B", "授权乌龙茶")
        other_owner = self._import(self.other_backend, "授权另一用户", "授权大红袍")
        memory_ids = []
        foreign_ids = {
            message["message_id"] for imported in (other_contact, other_owner)
            for message in imported["messages"]
        }
        foreign_texts = [
            message["text"] for imported in (other_contact, other_owner)
            for message in imported["messages"]
            if message["text"] != "好的，我记下了。"
        ]
        for backend, path, extra, text, in_scope in (
            (self.backend, "/api/memories/manual-contact",
             {"contact_id": current["contact_id"]},
             "授权关系记忆：联系人喜欢授权茉莉茶。", True),
            (self.backend, "/api/memories/manual-owner", {},
             "授权本人记忆：我喜欢授权茉莉茶。", True),
            (self.backend, "/api/memories/manual-contact",
             {"contact_id": other_contact["contact_id"]},
             "授权另一联系人记忆：联系人也喜欢授权茉莉茶。", False),
            (self.other_backend, "/api/memories/manual-owner", {},
             "授权另一用户记忆：我也喜欢授权茉莉茶。", False),
        ):
            status, payload = backend.request(path, {
                "text": text, "category": "preference", **extra,
            })
            self.assertEqual(status, 200, payload)
            if in_scope:
                memory_ids.append(payload["memory"]["memory_id"])
            else:
                foreign_ids.add(payload["memory"]["memory_id"])
                foreign_texts.append(text)
        binding = next(
            item for item in self.bindings.list_active_bindings(owner_id=self.owner_id)
            if item.scope.contact_id == UUID(current["contact_id"])
        )
        for tool_name, args in (
            ("conversation_search", {"query": "核心验收", "top_k": 8}),
            ("conversation_query", {"session_id": str(binding.binding_id),
                                    "before": 2, "after": 2}),
        ):
            with self.subTest(tool=tool_name):
                start = len(self.reply_model.seen_calls)
                self.reply_model.responses.extend([
                    tool_response(tool_name, args),
                    self._output([str(self.draft_evidence_id), *memory_ids]),
                ])
                reply, evidence = self._rewrite(current, content={
                    "type": "rewrite_draft", "draft_text": "我们聊聊授权茉莉茶。",
                    "include_relationship_context": True,
                })
                self.assertEqual({item["kind"] for item in evidence},
                                 {"user_draft", "message", "confirmed_memory", "owner_memory"})
                self.assertTrue(foreign_ids.isdisjoint(
                    item["evidence_id"] for item in evidence
                ))
                cited = {item["evidence_id"] for item in evidence if item["cited"]}
                self.assertEqual(cited, set(reply["candidates"][0]["citation_ids"]))
                self.assertTrue(set(memory_ids) <= cited)
                self.assertTrue(any(item["kind"] == "message" and item["cited"]
                                    for item in evidence))
                self.assertEqual(set(self.reply_model.bound_tool_names),
                                 {"read_file", "conversation_search", "conversation_query",
                                  "ReplyRuntimeOutput"})
                calls = self.reply_model.seen_calls[start:]
                results = [
                    json.loads(message.content) for messages in calls for message in messages
                    if isinstance(message, ToolMessage) and message.name == tool_name
                ]
                self.assertTrue(results)
                self.assertTrue(all(result["status"] == "ok" for result in results))
                for result in results:
                    self.assertTrue({row["message_id"] for row in result["messages"]}
                                    <= {row["message_id"] for row in current["messages"]})
                for messages in calls:
                    outbound = "\n".join(str(message.content) for message in messages)
                    for text in foreign_texts:
                        self.assertNotIn(text, outbound)

    def test_plain_rewrite_keeps_user_selected_candidate_continuation(self) -> None:
        current = self._import(self.backend, "继续A", "继续茉莉茶")
        self.reply_model.responses.append(self._output())
        initial, _ = self._rewrite(current)
        candidate = initial["candidates"][0]
        self.reply_model.responses.extend([
            tool_response("conversation_search", {"query": "核心验收", "top_k": 8}),
            self._output([str(self.draft_evidence_id), candidate["candidate_id"]]),
        ])
        reply, evidence = self._rewrite(
            current, continued_from_candidate_id=candidate["candidate_id"],
        )
        self.assertEqual({item["kind"] for item in evidence},
                         {"user_draft", "continued_candidate"})
        continuation = next(item for item in evidence if item["kind"] == "continued_candidate")
        self.assertEqual(continuation["evidence_id"], candidate["candidate_id"])
        self.assertEqual(continuation["text"], candidate["text"])
        self.assertTrue(continuation["cited"])
        self.assertIn(candidate["candidate_id"], reply["candidates"][0]["citation_ids"])
        self.assertEqual(set(self.reply_model.bound_tool_names),
                         {"read_file", "ReplyRuntimeOutput"})

    def test_plain_rewrite_rejects_citation_to_unavailable_history(self) -> None:
        current = self._import(self.backend, "引用A", "引用茉莉茶")
        self.reply_model.responses.append(self._output([
            str(self.draft_evidence_id), current["fact_message"]["message_id"],
        ]))
        status, reply = self.backend.request("/api/reply/generate", {
            "contact_id": current["contact_id"], "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "我们找个时间再聊。"},
        })
        self.assertEqual((status, reply), (500, {"error": "reply_generation_failed"}))
        for messages in self.reply_model.seen_calls:
            outbound = "\n".join(str(message.content) for message in messages)
            for message in current["messages"]:
                self.assertNotIn(message["text"], outbound)


if __name__ == "__main__":
    unittest.main()
