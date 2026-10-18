"""同一共同来源贯穿记忆、回复、偏好与待审核草稿的公开 HTTP 夹具。"""

import hashlib
import json
import re
from copy import deepcopy
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4
from langchain_core.messages import HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from tests.integration.server.core_business_flow_support import tool_response

import psycopg

from tests.integration.server import test_skill_learning as learning
from tests.integration.server import test_skill_review as review
from tests.integration.server.memory_skill_evolution_models import EvolutionMemoryModel


class DirectEvolutionMemoryModel(EvolutionMemoryModel):
    """合成模型按正式场景协议输出；核验、裁决与学习仍走原模型边界。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        requested = tuple(tool["function"]["name"] for tool in kwargs.get("tools", ()))
        if requested != ("DirectMemoryExtractionOutput",):
            return super()._generate(messages, stop, run_manager, **kwargs)
        self.wait_for_response()
        with self.call_lock:
            if self.started_calls >= self.model_call_limit:
                raise AssertionError("同源组合模型达到显式调用上限。")
            self.started_calls += 1
            self.seen_calls.append(messages)
            self.requested_tools.append(requested)
            self.record_model_payload(messages, deepcopy(kwargs))
        facts = []
        for message_id, occurred, sender, raw in re.findall(
            r"\[target\] \[message_id=([0-9a-f-]+)\] occurred_at=(\S+) sender=(contact|self): (.*)",
            str(messages[-1].content),
        ):
            kind = self.proposals.get(raw, {}).get("kind", "not_memory")
            if kind == "not_memory":
                continue
            temporary = kind == "momentary_state"
            subject = "联系人" if sender == "contact" else "用户"
            facts.append({
                "text": (f"截至{occurred[:10]}，" if temporary else "") + f"{subject}原话：“{raw}”",
                "category": "recent_state" if temporary else kind,
                "subject": sender, "topic": "other", "source_message_ids": [message_id],
                "confidence": 0.95, "risk_flags": [], "valid_at": occurred if temporary else None,
                "invalid_at": ((datetime.fromisoformat(occurred).replace(hour=0, minute=0, second=0)
                                + timedelta(days=1)).isoformat() if temporary else None),
                "speech_act": "assertion", "assertion_status": "asserted",
                "figurative_type": "literal", "alternatives": [],
                "interpretation_reason": "发送者直接陈述自己的状态或偏好。", "event": None,
            })
        return ChatResult(generations=[ChatGeneration(message=tool_response(
            "DirectMemoryExtractionOutput", {"scenes": [{"scene_name": "合成饮茶与近况", "memories": facts}]},
        ))])


class EvolutionHttpSupport:
    """仅准备合成资料；批准、停用与删除仍须明确公开命令。"""

    production_model_wiring = True
    dimension_release = None
    extraction_model_factory = DirectEvolutionMemoryModel
    reply_model_factory = review.SkillReviewModel
    _bind = learning.SkillLearningHttpTest._bind
    _configure = learning.SkillLearningHttpTest._configure
    _discussion = learning.SkillLearningHttpTest._discussion
    _wait_learning = learning.SkillLearningHttpTest._wait_learning
    _compare = review.SkillReviewHttpTest._compare
    _approve = review.SkillReviewHttpTest._approve
    _delete_source = learning.SkillLearningHttpTest._delete_source

    def setUp(self):
        super().setUp()
        self.contact_id, self.second_contact_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            for identifier, name in (
                (self.contact_id, "合成演进甲联系人"),
                (self.second_contact_id, "合成演进乙联系人"),
            ):
                connection.execute(
                    "INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,%s)",
                    (identifier, self.owner_id, name),
                )
        self._bind(self.contact_id)
        self._bind(self.second_contact_id)
        self.path = f"/api/contacts/{self.contact_id}/skill-learning"
        # 本夹具的暂停先释放，再收尾后端和其模型工厂补丁。
        self.addCleanup(self._release_response_gates)

    def _ok(self, path, body=None, *, method=None, backend=None):
        status, result = (backend or self.backend).request(path, body, method=method)
        self.assertEqual(status, 200, result)
        return result

    def _import_evolution_source(self, rows, *, when):
        rows = tuple(rows)
        # 单个 JSON 对象按 JSON 导入解析；两行才是本入口的 JSONL 资料。
        imported_rows = rows if len(rows) > 1 else rows + ((True, "好的，合成新资料已核对。"),)
        locator = f"synthetic-{self.contact_id}"
        source_path = Path(self.temporary.name) / f"evolution-{uuid4().hex}.jsonl"
        records = []
        for number, (from_me, text) in enumerate(imported_rows, 1):
            occurred = when + timedelta(seconds=number)
            records.append({
                "id": {"local_id": number, "server_id_str": uuid4().hex, "talker": locator},
                "create_time": int(occurred.timestamp()), "is_from_me": from_me, "kind": "text",
                "sender": "合成用户" if from_me else "合成演进甲联系人",
                "sender_wxid": f"wxid_synthetic_{self.owner_id}" if from_me else locator,
                "text": text, "time": occurred.strftime("%Y-%m-%d %H:%M:%S"),
                "time_iso": occurred.isoformat(),
            })
        source_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records), encoding="utf-8")
        preview = self._ok("/api/imports/preview", {
            "path": str(source_path), "contact_id": str(self.contact_id),
        })
        self.assertTrue(preview["valid"])
        imported = self._ok("/api/imports/commit", {
            "path": str(source_path), "contact_id": str(self.contact_id),
            "expected_content_sha256": preview["content_sha256"],
        })
        self._wait_finished(self.backend, str(self.contact_id))
        messages = self._get(self.backend, f"/api/contacts/{self.contact_id}/messages")["messages"]
        source = next(row for row in self._get(
            self.backend, f"/api/contacts/{self.contact_id}/sources",
        )["sources"] if row["file_name"] == source_path.name)
        return {**imported, "source": source,
                "messages": {text: next(item for item in messages if item["text"] == text) for _, text in rows}}

    def _automatic_memory(self, text, *, owner=False):
        path = "/api/memories/owner" if owner else f"/api/contacts/{self.contact_id}/memories"
        memories = self._get(self.backend, path)["memories"]
        matching = [memory for memory in memories if memory["text"] == text]
        self.assertEqual(len(matching), 1, memories)
        self.assertEqual(matching[0]["adoption_method"], "auto")
        return matching[0]

    def _candidate_text(self, text):
        candidates = self._get(self.backend, f"/api/contacts/{self.contact_id}/memory-candidates")["candidates"]
        selected = [candidate for candidate in candidates if candidate["text"] == text]
        self.assertEqual(len(selected), 1, candidates)
        return selected[0]

    def _confirm_candidate(self, candidate):
        return self._ok(
            f"/api/contacts/{self.contact_id}/memory-candidates/{candidate['candidate_id']}/confirm", {},
        )["memory"]

    def _evolution_session_reply(self, path, *, version_id=None, scene="核对安排", contact=None):
        body = {
            "contact_id": str(contact or self.contact_id), "idempotency_key": str(uuid4()),
            "scene": scene,
            "content": {"type": "rewrite_draft", "draft_text": "想聊合成温茶和合成热茶，先核对再回应。",
                        # 此组合验证长期偏好的实际使用与删除依赖，不设置覆盖偏好的本次要求。
                        "include_relationship_context": True},
        }
        if version_id is not None:
            body["skill_version_id"] = version_id
        reply = self._ok(path + "/replies", body)
        evidence_path = f"/api/contacts/{contact or self.contact_id}/replies/{reply['reply_request_id']}/evidence"
        evidence = self._get(self.backend, evidence_path)
        return reply, body, evidence_path, evidence

    def _wait_evolution_draft(self, material_id):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = self._get(self.backend, self.path)
            matching = [draft for draft in state["drafts"] if any(
                material["material_id"] == material_id for material in draft["private_evidence"]["materials"]
            )]
            if matching and state["task"]["status"] == "succeeded":
                self.assertEqual(len(matching), 1, state)
                return matching[0]
            if state["task"] and state["task"]["status"] == "failed":
                self.fail("组合材料学习失败：" + json.dumps(state, ensure_ascii=False))
            time.sleep(.02)
        self.fail("组合中的新材料未在有限步骤内形成对应草稿。")

    def _evolution_authority(self):
        """预览与人工保护的完整写入前后对照，不依赖后续 GET 补清。"""
        with psycopg.connect(self.database_url) as connection:
            return {table: connection.execute(
                f"SELECT to_jsonb(row) FROM public.{table} row "
                "WHERE owner_id=%s ORDER BY to_jsonb(row)::text", (self.owner_id,),
            ).fetchall() for table in (
                "memory_candidate", "confirmed_memory", "owner_memory", "memory_extraction_watermark",
            )}

    def prepare_evolution(self):
        """导入后沿正式提取与核验，再将共同来源推进待审核；不发布或删除。"""
        contact_raw, owner_raw = "我平时喜欢合成热茶。", "本人喜欢合成热茶。"
        history_raw, latent_raw = "今天我在加班。", "我刚到家。"
        self.extraction_model.proposals.update({
            contact_raw: {"kind": "preference"},
            owner_raw: {"kind": "preference"},
            history_raw: {"kind": "momentary_state"},
            latent_raw: {"kind": "not_memory"},
        })
        root = self._import_evolution_source(
            ((False, contact_raw), (True, owner_raw), (False, history_raw), (False, latent_raw)),
            when=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        original_contact = self._automatic_memory(f"联系人原话：“{contact_raw}”")
        original_owner = self._automatic_memory(f"用户原话：“{owner_raw}”", owner=True)
        historical = self._confirm_candidate(self._candidate_text(f"截至2025-01-01，联系人原话：“{history_raw}”"))
        self.assertEqual(historical["timing"]["current_status"], "historical")
        session = self._ok(f"/api/contacts/{self.contact_id}/assistant-session/default", {})
        session_path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        original_reply, original_body, original_evidence_path, original_evidence = self._evolution_session_reply(session_path)

        update_raw = "合成新依据：我现在喜欢合成温茶。"
        self.extraction_model.proposals[update_raw] = {"kind": "preference"}
        self.extraction_model.adjudication_action = "update"
        updated = self._import_evolution_source(((False, update_raw),), when=datetime(2026, 8, 2, tzinfo=timezone.utc))
        contact = self._automatic_memory(f"联系人原话：“{update_raw}”")
        self.assertEqual(contact["supersedes_memory_id"], original_contact["memory_id"])
        self.assertTrue(contact["version_evidence_source_current"])
        owner = self._ok(f"/api/memories/owner/{original_owner['memory_id']}/correct", {
            "text": "本人喜欢合成热茶，偏好慢慢交流。",
        })["memory"]
        historical_reply = self._get(self.backend, original_evidence_path)
        self.assertTrue(historical_reply["basis_changes"])

        target = root["messages"][contact_raw]["message_id"]
        preference_body = {
            "operation_key": str(uuid4()), "text": "平时先确认自己的边界，再组织表达。",
            "scope": {"contact_id": str(self.contact_id), "reply_mode": "rewrite_draft"},
            "origin": {"kind": "message", "id": target}, "confirm_long_term": True,
        }
        preference = self._ok(f"/api/expression-preferences?contact_id={self.contact_id}", preference_body)["preference"]
        reply, body, evidence_path, evidence = self._evolution_session_reply(session_path)
        candidate_reply = reply["candidates"][0]
        versions_path = session_path + f"/candidates/{candidate_reply['candidate_id']}/versions"
        edited = self._ok(versions_path, {
            "edit_key": str(uuid4()), "parent_version_id": candidate_reply["candidate_id"],
            "messages": [{"message_id": candidate_reply["messages"][0]["message_id"], "text": "合成用户编辑：先说明自己的边界，再核对饮茶安排。"}],
            "requirements": "合成明确纠正：先确认自己的意愿，不替对方作承诺。",
        })["versions"][-1]
        selection = self._ok(session_path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate_reply["candidate_id"],
            "version_id": edited["version_id"],
        })

        independent_owner = self._ok("/api/memories/manual-owner", {
            "text": "本人独立偏好合成纸质书。", "category": "preference",
        })["memory"]
        independent_contact = self._ok("/api/memories/manual-contact", {
            "contact_id": str(self.second_contact_id), "text": "乙联系人独立喜欢合成绘画。",
            "category": "preference", "topic": "other",
        })["memory"]
        package = Path(self.temporary.name) / "evolution-independent"
        package.mkdir()
        (package / "SKILL.md").write_text(
            "---\nname: evolution-independent\ndescription: 独立合成教学方法\n---\n\n先核对公开条件。\n", encoding="utf-8",
        )
        independent_skill = self._ok("/api/skills/import", {"package_path": str(package)})["skill_id"]
        _, material = self._discussion(correction="合成明确纠正：先核对意愿，再表达边界。", target=target)
        proposal = learning.synthetic_proposal()
        proposal["methods"] = [
            {"key": "clarify", "title": "合成排除方法甲", "instruction": "合成排除方法甲：直接替双方作承诺。", "replaces_method_ids": []},
            {"key": "listen", "title": "合成保留方法乙", "instruction": "合成保留方法乙：先询问用户自己的边界。", "replaces_method_ids": []},
        ]
        self.extraction_model.learning_proposals.append(proposal)
        self.assertEqual(self._configure()[0][0], 200)
        draft = self._wait_evolution_draft(material)
        state = {
            "contact_id": str(self.contact_id), "other_contact_id": str(self.second_contact_id),
            "source_id": root["source"]["source_id"], "update_source_id": updated["source"]["source_id"],
            "target_message_id": target, "latent_message_id": root["messages"][latent_raw]["message_id"],
            "contact_text": contact["text"], "owner_text": owner["text"],
            "contact_memory": contact, "owner_memory": owner,
            "original_contact_memory": original_contact, "original_owner_memory": original_owner,
            "historical_memory": historical, "session_id": session["session_id"], "session_path": session_path,
            "original_reply": original_reply, "original_reply_body": original_body,
            "original_evidence_path": original_evidence_path, "original_evidence": original_evidence,
            "reply": reply, "reply_body": body, "evidence_path": evidence_path, "evidence": evidence,
            "edited_version": edited, "versions_path": versions_path, "selection": selection,
            "preference": preference, "preference_body": preference_body,
            "draft_path": self.path + "/drafts/" + draft["draft_id"], "draft": draft, "material_id": material,
            "independent_owner_memory": independent_owner, "independent_contact_memory": independent_contact,
            "independent_skill_id": independent_skill,
        }
        self._assert_evolution_basis(state, reply, evidence)
        return state

    def _assert_evolution_basis(self, state, reply, evidence):
        by_id = {item["evidence_id"]: item for item in evidence["evidence"]}
        for key, kind, scope in (("contact_memory", "confirmed_memory", "contact"), ("owner_memory", "owner_memory", "owner")):
            memory = state[key]
            item = by_id[memory["memory_id"]]
            self.assertEqual((item["kind"], item["text"], item["cited"]), (kind, memory["text"], True))
            self.assertEqual(item["navigation"]["scope_kind"], scope)
            self.assertEqual(item["navigation"]["memory_revision"], memory["revision"])
        self.assertEqual(evidence["retrieval"]["retriever_version"], "lexical-v1")
        self.assertIn(state["preference"]["preference_id"], reply["context_receipt"]["expression_preference_ids"])
        self.assertNotIn(state["historical_memory"]["memory_id"], by_id)

    def _last_evolution_generation_messages(self):
        """实际Skill内容在生成轮核对；复核轮有独立协议与提示。"""
        for messages in reversed(self.reply_model.seen_calls):
            payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
            if payload.get('generation_stage') != 'candidate_fidelity_review':
                return messages
        self.fail('没有实际生成轮可以核对Skill执行视图。')

    def evolution_reply(self, state, version_id, scene="核对安排", other=False):
        contact = self.second_contact_id if other else self.contact_id
        path = state["session_path"]
        if other:
            session = self._ok(f"/api/contacts/{contact}/assistant-session/default", {})
            path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        reply, body, evidence_path, evidence = self._evolution_session_reply(
            path, version_id=version_id, scene=scene, contact=contact,
        )
        if other:
            identifiers = {item["evidence_id"] for item in evidence["evidence"]}
            self.assertNotIn(state["contact_memory"]["memory_id"], identifiers)
            self.assertNotIn(state["preference"]["preference_id"], reply["context_receipt"]["expression_preference_ids"])
        else:
            self._assert_evolution_basis(state, reply, evidence)
        self.assertIsNotNone(reply["used_skill"])
        self.assertEqual(reply["used_skill"]["version_id"], version_id)
        state.setdefault("dependent_replies", []).append({"reply": reply, "body": body, "path": path, "evidence_path": evidence_path})
        return reply

    def publish_evolution(self, state):
        compared, compare = self._compare(state["draft_path"], state["draft"], kind="owner")
        published, approve = self._approve(state["draft_path"], compared)
        state.update(published=published["published"], compared=compared,
                     compare_command=compare, approve_command=approve)
        state.setdefault("publications", []).append((state["draft"]["draft_id"], published["published"]["version_id"]))
        return published["published"]

    def stop_evolution_method(self, state):
        method = state["compared"]["sanitized_strategy"]["methods"][0]
        command = {
            "skill_id": state["published"]["skill_id"], "version_id": state["published"]["version_id"],
            "method_id": method["method_id"], "scope": {
                "kind": "scene", "contact_id": str(self.contact_id), "scene": "核对安排",
            }, "disabled": True, "expected_revision": 0, "operation_key": str(uuid4()),
        }
        result = self._ok(self.path + "/policies", command)
        self.assertEqual(self._ok(self.path + "/policies", command), result)
        state["policy_command"] = command
        return result

    def propose_evolution_update(self, state):
        """从同一真实任务的后续纠正学习更新，不用直接插入草稿。"""
        proposal = learning.synthetic_proposal(kind="update", targets=[state["published"]["skill_id"]])
        proposal["methods"] = [
            {**{key: method[key] for key in ("key", "title", "instruction")},
             "replaces_method_ids": [method["method_id"]]}
            for method in state["compared"]["sanitized_strategy"]["methods"]
        ]
        self.extraction_model.learning_proposals.append(proposal)
        _, material = self._discussion(correction="合成后续纠正：核对边界后仍须允许用户自己决定。",
                                       target=state["target_message_id"])
        self.assertEqual(self._configure()[0][0], 200)
        draft = self._wait_evolution_draft(material)
        self.assertEqual(self._configure(False)[0][0], 200)
        state.update(draft=draft, draft_path=self.path + "/drafts/" + draft["draft_id"])
        return draft

    @contextmanager
    def hold_evolution_provider(self, *, offset=1):
        """仅暂停真实模型边界，供HTTP并发改变来源或方法政策。"""
        entered, release = threading.Event(), threading.Event()
        target = self.reply_model.provider_calls + offset
        previous = self.reply_model.on_provider_enter

        def hold(call):
            if call == target:
                entered.set()
                if not release.wait(10):
                    raise TimeoutError("组合模型暂停未在时限内释放。")

        self.reply_model.on_provider_enter = hold
        try:
            yield entered, release
        finally:
            release.set()
            self.reply_model.on_provider_enter = previous

    def assert_evolution_deleted(self, state):
        """先证明删除事务擦除，再读公开目录；GET 不得替删除完成清理。"""
        request_ids = [UUID(state[key]["reply_request_id"]) for key in ("original_reply", "reply")]
        request_ids.extend(UUID(item["reply"]["reply_request_id"]) for item in state.get("dependent_replies", []))
        session_ids = {UUID(state["session_id"])} | {
            UUID(item["path"].rsplit("/", 1)[-1]) for item in state.get("dependent_replies", [])
        }
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                (self.owner_id, request_ids),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.assistant_session_turn WHERE owner_id=%s "
                "AND session_id=ANY(%s::uuid[]) AND (input_payload IS NOT NULL "
                "OR prepared_context IS NOT NULL OR cardinality(dependency_ids)>0)",
                (self.owner_id, list(session_ids)),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.assistant_session_input WHERE owner_id=%s "
                "AND session_id=ANY(%s::uuid[]) AND (content IS NOT NULL OR cardinality(dependency_ids)>0)",
                (self.owner_id, list(session_ids)),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.memory_extraction_trace_event event "
                "JOIN public.memory_extraction_trace trace USING(trace_id,owner_id,contact_id) "
                "WHERE trace.owner_id=%s AND trace.contact_id=%s", (self.owner_id, self.contact_id),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.assistant_candidate_version WHERE owner_id=%s AND id=%s",
                (self.owner_id, UUID(state["edited_version"]["version_id"])),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.assistant_candidate_selection WHERE owner_id=%s AND id=%s",
                (self.owner_id, UUID(state["selection"]["selection_id"])),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT status,text_content,origin_id,source_ids FROM public.expression_preference WHERE owner_id=%s AND id=%s",
                (self.owner_id, UUID(state["preference"]["preference_id"])),
            ).fetchone(), ("deleted", None, None, []))
            for table, predicate in (
                ("skill_draft", "strategy IS NOT NULL OR private_evidence IS NOT NULL OR cardinality(dependency_ids)>0"),
                ("skill_learning_batch", "outcome<>'invalidated' OR cardinality(dependency_ids)>0"),
                ("skill_learning_receipt", "digest IS NOT NULL"),
            ):
                self.assertEqual(connection.execute(
                    f"SELECT count(*) FROM public.{table} WHERE owner_id=%s AND contact_id=%s AND ({predicate})",
                    (self.owner_id, self.contact_id),
                ).fetchone()[0], 0, table)
        for draft_id, version_id in state.get("publications", []):
            review.SkillReviewHttpTest._assert_physical_review_erasure(self, draft_id, version_id)

        self.assertEqual(self._get(self.backend, self.path)["drafts"], [])
        self.assertEqual(self.backend.request(state["draft_path"])[0], 409)
        for key in ("original_evidence_path", "evidence_path"):
            self.assertEqual(self.backend.request(state[key])[0], 404)
        for item in state.get("dependent_replies", []):
            self.assertEqual(self.backend.request(item["evidence_path"])[0], 404)
            self.assertIn(self.backend.request(item["path"] + "/replies", item["body"])[0], (404, 409))
        owner = self._get(self.backend, "/api/memories/owner/overview")["overview"]
        self.assertEqual([item["memory"]["memory_id"] for item in owner["entries"]],
                         [state["independent_owner_memory"]["memory_id"]])
        contact = self._get(self.backend, f"/api/contacts/{self.contact_id}/relationship-overview")
        self.assertEqual(contact["overview"]["entries"], [])
        other = self._get(self.backend, f"/api/contacts/{self.second_contact_id}/relationship-overview")
        self.assertEqual([item["memory"]["memory_id"] for item in other["overview"]["entries"]],
                         [state["independent_contact_memory"]["memory_id"]])
        self.assertEqual([item["skill_id"] for item in self._get(self.backend, "/api/skills")["skills"]
                          if item["status"] == "active"],
                         [state["independent_skill_id"]])
