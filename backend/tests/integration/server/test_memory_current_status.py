"""当前核实状态经真实 HTTP 与独立随机 PostgreSQL 的用户行为。"""

import unittest
import time
from datetime import datetime, timezone
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.memory import FactSubject, MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope
from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel
from tests.integration.server.core_business_flow_support import ScriptedCoreModel, tool_response
from langchain_core.messages import ToolMessage


class TemporalControlledModel(ExplorationControlledModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.plans and "search" in self.plans[0]:
            self.responses.append(tool_response("conversation_search", {
                "query": self.plans.pop(0)["search"], "top_k": 2,
            }))
            return ScriptedCoreModel._generate(self, messages, stop, run_manager, **kwargs)
        return super()._generate(messages, stop, run_manager, **kwargs)


class MemoryCurrentStatusHttpTest(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = TemporalControlledModel

    def _delete_source_and_wait(self, path):
        status, deleted = self.backend.request(path, method="DELETE")
        self.assertEqual(status, 202, deleted)
        deadline = time.monotonic() + 5
        while deleted["status"] != "succeeded" and time.monotonic() < deadline:
            time.sleep(0.02)
            status, deleted = self.backend.request(path, method="DELETE")
            self.assertEqual(status, 202, deleted)
        self.assertEqual(deleted["status"], "succeeded")

    def _source(self, contact, text, occurred_at):
        source, message = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""INSERT INTO public.source_document
                (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES (%s,%s,%s,'wechat_jsonl','synthetic-timing.jsonl',%s,1)""",
                (source, self.owner_id, contact, uuid4().hex * 2))
            connection.execute("""INSERT INTO public.message
                (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
                VALUES (%s,%s,%s,'contact','text',%s,%s)""",
                (message, self.owner_id, contact, text, occurred_at))
            connection.execute("""INSERT INTO public.message_source_ref
                (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'source_document',%s,'synthetic:1',%s)""",
                (message, self.owner_id, contact, source, Jsonb({
                    "time_iso": occurred_at.isoformat() if occurred_at else None,
                })))
        return source, message

    def _confirm(self, contact, text, category, sources, *, valid_at=None, invalid_at=None,
                 subject=FactSubject.CONTACT):
        candidate = PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=ContactScope(self.owner_id, UUID(contact)),
            text=text, category=MemoryCategory(category), source_ids=tuple(sources),
            valid_at=valid_at, invalid_at=invalid_at,
            subject=subject,
        ))
        status, result = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        self.assertEqual(status, 200, result)
        return result["memory"]

    def test_expired_history_is_visible_for_contact_and_owner_but_excluded_from_reply(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        when = datetime.fromisoformat("2025-01-01T00:00:00+08:00")
        end = datetime.fromisoformat("2025-02-01T00:00:00+08:00")
        _, message = self._source(contact, "合成历史：这个月在加班。", when)
        for subject, path in (
            (FactSubject.CONTACT, f"/api/contacts/{contact}/memories"),
            (FactSubject.SELF, "/api/memories/owner"),
        ):
            with self.subTest(subject=subject):
                memory = self._confirm(contact, "合成历史：这个月在加班。", "recent_state", (message,),
                                       valid_at=when, invalid_at=end, subject=subject)
                status, listed = self.backend.request(path)
                self.assertEqual(status, 200, listed)
                self.assertEqual([item["memory_id"] for item in listed["memories"]], [memory["memory_id"]])
                self.assertEqual(listed["memories"][0]["timing"]["current_status"], "historical")
        self.reply_model.plans.append({"text": "最近忙吗？", "basis": "只询问当前情况，不沿用过期近况。"})
        status, reply = self.backend.request("/api/reply/generate", {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "合成近况：最近加班忙吗？"},
        })
        self.assertEqual(status, 200, reply)
        self.assertFalse(any(item["kind"] in {"confirmed_memory", "owner_memory"}
                             for item in self.reply_model.payloads[-1]["evidence"]))

    def test_explicit_source_interval_is_verified_only_inside_its_local_half_open_bounds(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        start = datetime.fromisoformat("2026-10-01T00:00:00+08:00")
        end = datetime.fromisoformat("2026-11-01T00:00:00+08:00")
        _, message = self._source(contact, "合成近况：这个月在加班。", start)
        with patch("notalone.memory.current_status._utc_now", return_value=start):
            memory = self._confirm(contact, "合成近况：这个月在加班。", "recent_state", (message,),
                                   valid_at=start, invalid_at=end)
            self.assertEqual(memory["timing"]["current_status"], "current_verified")
            self.assertIn("来源", memory["timing"]["current_status_reason"])
            self.assertIn("区间", memory["timing"]["current_status_reason"])
        with patch("notalone.memory.current_status._utc_now", return_value=end):
            status, listed = self.backend.request(f"/api/contacts/{contact}/memories")
            self.assertEqual(status, 200, listed)
            self.assertEqual(listed["memories"][0]["timing"]["current_status"], "historical")

    def test_narrow_time_qualifiers_do_not_certify_a_whole_day_week_or_month(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        source_time = datetime.fromisoformat("2026-10-14T08:00:00+08:00")
        day_end = datetime.fromisoformat("2026-10-15T00:00:00+08:00")
        month_start = datetime.fromisoformat("2026-10-01T00:00:00+08:00")
        month_end = datetime.fromisoformat("2026-11-01T00:00:00+08:00")
        week_start = datetime.fromisoformat("2026-10-12T00:00:00+08:00")
        week_end = datetime.fromisoformat("2026-10-19T00:00:00+08:00")
        with patch("notalone.memory.current_status._utc_now",
                   return_value=datetime.fromisoformat("2026-10-14T10:00:00+08:00")):
            for text, start, end, expected in (
                ("今天只在晚上加班。", source_time, day_end, "current_unverified"),
                ("本月下旬在加班。", month_start, month_end, "current_unverified"),
                ("本周仅周末在加班。", week_start, week_end, "current_unverified"),
                ("今天08:00到09:00在加班。", source_time, day_end, "current_unverified"),
                ("今天后半天在加班。", source_time, day_end, "current_unverified"),
                ("本月后半月在加班。", month_start, month_end, "current_unverified"),
                ("本月月底在加班。", month_start, month_end, "current_unverified"),
                ("今天午饭后加班。", source_time, day_end, "current_unverified"),
                ("这个月有时会加班。", month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00仅晚上加班。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00至2026-11-01T00:00:00+08:00加班，去年曾失业。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00至2026-11-01T00:00:00+08:00加班，当时担任某职。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00这段时间，明天在加班。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00这段时间，明日在加班。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00这段时间，下周在加班。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00这段时间，今天在加班。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00这段时间，2026-10-15加班。",
                 month_start, month_end, "current_unverified"),
                ("从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00这段时间，2026年10月15日加班。",
                 month_start, month_end, "current_unverified"),
                ("今天在加班。", source_time, day_end, "current_verified"),
                ("本周在加班。", week_start, week_end, "current_verified"),
                ("从2026-10-14T08:00:00+08:00到2026-10-14T12:00:00+08:00在加班。",
                 source_time, source_time.replace(hour=12), "current_verified"),
            ):
                with self.subTest(text=text):
                    _, message = self._source(contact, text, source_time)
                    memory = self._confirm(contact, text, "recent_state", (message,), valid_at=start, invalid_at=end)
                    self.assertEqual(memory["timing"]["current_status"], expected)

    def test_unrelated_or_invalid_source_dates_do_not_verify_current_and_do_not_age_a_stable_preference(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        start = datetime.fromisoformat("2026-10-01T00:00:00+08:00")
        end = datetime.fromisoformat("2026-11-01T00:00:00+08:00")
        for original in (
            "合成记录：2026-10-01T00:00:00+08:00参加活动，2026-11-01T00:00:00+08:00另有计划。",
            "合成记录：从2026-13-01T00:00:00+08:00到2026-11-01T00:00:00+08:00加班。",
        ):
            with self.subTest(original=original):
                _, message = self._source(contact, original, start)
                memory = self._confirm(contact, original, "recent_state", (message,),
                                       valid_at=start, invalid_at=end)
                self.assertEqual(memory["timing"]["current_status"], "current_unverified")
        _, message = self._source(contact, "今天吃完饭，我一直喜欢咖啡。", start)
        preference = self._confirm(contact, "对方一直喜欢咖啡。", "preference", (message,))
        self.assertEqual(preference["timing"]["current_status"], "stable")

    def test_second_time_scope_is_unverified_for_absolute_and_relative_declarations(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        source_time = datetime.fromisoformat("2026-10-14T08:00:00+08:00")
        month_start = source_time.replace(day=1, hour=0)
        month_end = month_start.replace(month=11)
        week_start = source_time.replace(day=12, hour=0)
        week_end = week_start.replace(day=19)
        day_end = source_time.replace(day=15, hour=0)
        absolute = "从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00这段时间，"
        with patch("notalone.memory.current_status._utc_now", return_value=source_time.replace(hour=10)):
            for text, start, end in (
                (absolute + "前天在加班。", month_start, month_end),
                (absolute + "前日在加班。", month_start, month_end),
                (absolute + "上个星期在加班。", month_start, month_end),
                (absolute + "上月在加班。", month_start, month_end),
                ("2026-10-20加班（这是本月的安排）。", month_start, month_end),
                ("前天加班（这是本月的安排）。", month_start, month_end),
                ("下周加班（这是本月的安排）。", month_start, month_end),
                ("2026-10-20加班（这是本周的安排）。", week_start, week_end),
                ("上个星期加班（这是本周的安排）。", week_start, week_end),
                ("下个月加班（这是本周的安排）。", week_start, week_end),
                ("前天加班（这是今天的安排）。", source_time, day_end),
                ("明日加班（这是今天的安排）。", source_time, day_end),
            ):
                with self.subTest(text=text):
                    _, message = self._source(contact, text, source_time)
                    memory = self._confirm(contact, text, "recent_state", (message,), valid_at=start, invalid_at=end)
                    self.assertEqual(memory["timing"]["current_status"], "current_unverified")
        # 唯一的未来日声明仍可按原话当地时间核对，不能连自身cue一起拒绝。
        future_start = source_time.replace(day=15, hour=0)
        future_end = future_start.replace(day=16)
        _, message = self._source(contact, "明天在加班。", source_time)
        with patch("notalone.memory.current_status._utc_now", return_value=source_time.replace(hour=10)):
            memory = self._confirm(contact, "明天在加班。", "recent_state", (message,),
                                   valid_at=future_start, invalid_at=future_end)
            self.assertEqual(memory["timing"]["current_status"], "current_unverified")
        with patch("notalone.memory.current_status._utc_now", return_value=future_start.replace(hour=10)):
            future = self._confirm(contact, "明天在加班。", "recent_state", (message,),
                                   valid_at=future_start, invalid_at=future_end)
            self.assertEqual(future["timing"]["current_status"], "current_verified")

    def test_unknown_dates_keep_stable_facts_and_preferences_but_not_dynamic_facts(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        for level, category, text, expected in (
            ("contact", "common_fact", "合成稳定事实：对方出生于春天。", "stable"),
            ("owner", "preference", "合成明确偏好：我不喜欢甜食。", "stable"),
            ("contact", "common_fact", "合成工作状态：对方在科技园工作。", "current_unverified"),
            ("contact", "common_fact", "合成资产状态：对方有一套房产。", "current_unverified"),
            ("contact", "common_fact", "合成住址状态：对方住在台北。", "current_unverified"),
        ):
            with self.subTest(level=level, text=text):
                body = {"text": text, "category": category}
                if level == "contact":
                    body["contact_id"] = contact
                status, added = self.backend.request(f"/api/memories/manual-{level}", body)
                self.assertEqual(status, 200, added)
                path = f"/api/contacts/{contact}/memories" if level == "contact" else "/api/memories/owner"
                status, listed = self.backend.request(path)
                self.assertEqual(status, 200, listed)
                item = next(item for item in listed["memories"] if item["text"] == text)
                self.assertIsNone(item["timing"]["source_started_at"])
                self.assertFalse(item["timing"]["source_time_complete"])
                self.assertEqual(item["timing"]["current_status"], expected)
        self.assertEqual(self.other_backend.request("/api/memories/owner")[1]["memories"], [])
        self.assertEqual(self.other_backend.request(f"/api/contacts/{contact}/memories")[1]["memories"], [])

    def test_negative_preferences_remain_stable_while_temporary_preferences_and_unfinished_facts_do_not(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        cited_id = None
        for level, category, text, expected in (
            ("contact", "preference", "对方对甜食没有兴趣。", "stable"),
            ("contact", "preference", "对方一直喜欢没有糖的咖啡。", "stable"),
            ("contact", "taboo", "对方对被催促没有好感。", "stable"),
            ("contact", "taboo", "对方不接受没有提前商量的安排。", "stable"),
            ("owner", "preference", "本人对甜食没有兴趣。", "stable"),
            ("owner", "taboo", "本人对被催促没有好感。", "stable"),
            ("contact", "preference", "对方只喜欢咖啡。", "stable"),
            ("contact", "preference", "对方只喜欢没有糖的咖啡。", "stable"),
            ("contact", "preference", "对方准备从咖啡改喝茶。", "current_unverified"),
            ("contact", "taboo", "对方准备不再接受临时安排。", "current_unverified"),
            ("owner", "preference", "本人准备从咖啡改喝茶。", "current_unverified"),
            ("owner", "taboo", "本人准备不再接受临时安排。", "current_unverified"),
            ("contact", "preference", "对方暂时对甜食没有兴趣。", "current_unverified"),
            ("contact", "preference", "对方明年喜欢咖啡。", "current_unverified"),
            ("contact", "preference", "对方未来喜欢咖啡。", "current_unverified"),
            ("contact", "preference", "对方以后喜欢咖啡。", "current_unverified"),
            ("contact", "preference", "对方前天喜欢喝茶。", "current_unverified"),
            ("contact", "taboo", "对方前天不接受临时安排。", "current_unverified"),
            ("contact", "preference", "对方上月喜欢喝茶。", "current_unverified"),
            ("contact", "taboo", "对方上月不接受临时安排。", "current_unverified"),
            ("contact", "preference", "2026-10-20喜欢喝茶。", "current_unverified"),
            ("contact", "taboo", "2026年10月不接受临时安排。", "current_unverified"),
            ("contact", "taboo", "对方本周不接受没有商量的安排。", "current_unverified"),
            ("contact", "common_fact", "对方没有取得博士学位。", "current_unverified"),
            ("contact", "preference", "从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00喜欢喝茶。", "current_unverified"),
            ("contact", "taboo", "从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00不接受临时安排。", "current_unverified"),
            *(("contact", category, f"对方{cue}{stance}", "current_unverified")
              for category, stance in (("preference", "喜欢喝茶。"), ("taboo", "不接受临时安排。"))
              for cue in ("今日", "今天", "这个月", "本月", "本周", "这周", "明天", "明日")),
        ):
            with self.subTest(level=level, text=text):
                body = {"text": text, "category": category}
                if level == "contact":
                    body["contact_id"] = contact
                status, added = self.backend.request(f"/api/memories/manual-{level}", body)
                self.assertEqual(status, 200, added)
                path = f"/api/contacts/{contact}/memories" if level == "contact" else "/api/memories/owner"
                status, listed = self.backend.request(path)
                self.assertEqual(status, 200, listed)
                item = next(item for item in listed["memories"] if item["memory_id"] == added["memory"]["memory_id"])
                if text == "对方一直喜欢没有糖的咖啡。":
                    cited_id = item["memory_id"]
                self.assertIsNone(item["timing"]["source_started_at"])
                self.assertEqual(item["timing"]["current_status"], expected)
        self.reply_model.plans.append({"text": "来杯没有糖的咖啡吗？", "basis": "按明确偏好询问。", "citation_ids": [cited_id]})
        status, reply = self.backend.request("/api/reply/generate", {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "对方一直喜欢没有糖的咖啡，问要不要喝？",
                        "include_relationship_context": True},
        })
        self.assertEqual(status, 200, reply)
        status, saved = self.backend.request(f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")
        self.assertEqual(status, 200, saved)
        cited = next(item for item in saved["evidence"] if item["evidence_id"] == cited_id)
        self.assertTrue(cited["cited"])
        self.assertEqual(cited["timing"]["current_status"], "stable")

    def test_unproven_common_facts_stay_unverified_in_listing_and_actual_reply_evidence(self):
        for text in ("对方在合成公司当总裁。", "对方是建筑师。", "对方体重70公斤。", "对方处于观望中。"):
            with self.subTest(text=text):
                contact, _, _ = self.prepare_contact(self.owner_id, history=False)
                _, message = self._source(contact, text, datetime(2024, 1, 1, tzinfo=timezone.utc))
                memory = self._confirm(contact, text, "common_fact", (message,))
                status, listed = self.backend.request(f"/api/contacts/{contact}/memories")
                self.assertEqual(status, 200, listed)
                actual = listed["memories"][0]
                self.assertEqual(actual["timing"]["current_status"], "current_unverified")
                self.assertIn("持续", actual["timing"]["current_status_reason"])
                self.assertIsNone(actual["invalid_at"])
                self.reply_model.plans.append({"text": "最近情况怎么样？", "basis": "旧资料不证明当前状态。",
                                               "citation_ids": [memory["memory_id"]]})
                status, reply = self.backend.request("/api/reply/generate", {
                    "contact_id": contact, "idempotency_key": str(uuid4()),
                    "content": {"type": "rewrite_draft", "draft_text": f"想询问{text}现在是否还成立。",
                                "include_relationship_context": True},
                })
                self.assertIn(memory["memory_id"], [item["evidence_id"]
                                                    for item in self.reply_model.payloads[-1]["evidence"]])
                self.assertEqual(status, 200, reply)
                status, snapshot = self.backend.request(
                    f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")
                self.assertEqual(status, 200, snapshot)
                cited = next(item for item in snapshot["evidence"] if item["evidence_id"] == memory["memory_id"])
                self.assertTrue(cited["cited"])
                self.assertEqual(cited["timing"]["current_status"], "current_unverified")

    def test_old_open_ended_state_is_visible_but_current_is_unverified(self):
        contact, _, _ = self.prepare_contact(self.owner_id)
        status, messages = self.backend.request(f"/api/contacts/{contact}/messages")
        self.assertEqual(status, 200, messages)
        old = next(item for item in messages["messages"] if "去年" in item["text"])
        candidate = PostgresMemoryStore(self.database_url).create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(), scope=ContactScope(self.owner_id, UUID(contact)),
                text="合成旧近况：去年住在台北。", category=MemoryCategory.RECENT_STATE,
                source_ids=(UUID(old["message_id"]),),
            )
        )
        status, result = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{candidate.candidate_id}/confirm", {},
        )
        self.assertEqual(status, 200, result)
        status, listed = self.backend.request(f"/api/contacts/{contact}/memories")
        self.assertEqual(status, 200, listed)
        memory = listed["memories"][0]
        self.assertEqual(memory["text"], "合成旧近况：去年住在台北。")
        self.assertIsNone(memory["invalid_at"])
        self.assertEqual(datetime.fromisoformat(memory["timing"]["source_started_at"]),
                         datetime(2025, 1, 1, tzinfo=timezone.utc))
        self.assertIsNotNone(memory["timing"]["recorded_at"])
        self.assertEqual(memory["timing"]["current_status"], "current_unverified")
        self.assertIn("当前", memory["timing"]["current_status_reason"])

    def test_reply_uses_old_state_as_unverified_history_and_keeps_its_actual_cited_snapshot(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        when = datetime.fromisoformat("2024-01-01T08:00:00+08:00")
        source, message = self._source(contact, "合成旧近况：最近在加班。", when)
        memory = self._confirm(contact, "合成旧近况：最近在加班。", "recent_state", (message,))
        self.reply_model.plans.append({
            "text": "你最近忙吗？", "basis": "这只是历史近况，先询问当前情况。",
            "citation_ids": [memory["memory_id"]],
        })
        body = {"contact_id": contact, "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "最近加班忙吗？",
                            "include_relationship_context": True}}
        status, reply = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, reply)
        actual = next(item for item in self.reply_model.payloads[-1]["evidence"]
                      if item["evidence_id"] == memory["memory_id"])
        self.assertEqual(actual["timing"]["current_status"], "current_unverified")
        self.assertIn("当前未核实", actual["selection_reason"])
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        status, snapshot = self._backend(self.owner_id).request(path)
        self.assertEqual(status, 200, snapshot)
        saved = next(item for item in snapshot["evidence"] if item["evidence_id"] == memory["memory_id"])
        self.assertTrue(saved["cited"])
        self.assertEqual(saved["timing"], actual["timing"])
        self.assertEqual(datetime.fromisoformat(saved["timing"]["source_started_at"]), when)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, reply))
        self.assertEqual(len(self.reply_model.payloads), 1)
        self._delete_source_and_wait(f"/api/contacts/{contact}/sources/{source}")
        self.assertEqual(self.backend.request(path)[0], 404)
        self.assertEqual(self.backend.request("/api/reply/generate", body),
                         (409, {"error": "reply_input_invalidated"}))
        self.reply_model.plans.append({"text": "你最近忙吗？", "basis": "已删资料不作为依据。"})
        status, retried = self.backend.request("/api/reply/generate", {**body, "idempotency_key": str(uuid4())})
        self.assertEqual(status, 200, retried)
        self.assertNotEqual(retried["reply_request_id"], reply["reply_request_id"])
        self.assertFalse(any(item["evidence_id"] == memory["memory_id"]
                             for item in self.reply_model.payloads[-1]["evidence"]))

    def test_direction_exploration_transmits_and_restores_current_status_with_source_times(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        when = datetime.fromisoformat("2024-01-01T08:00:00+08:00")
        source, message = self._source(contact, "合成旧近况：最近在加班。", when)
        memory = self._confirm(contact, "合成旧近况：最近在加班。", "recent_state", (message,))
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/explorations"
        body = {"operation_key": str(uuid4()), "content": {
            "type": "purpose_exploration", "purpose_hint": "想询问最近加班的情况。", "skill_mode": "disabled",
        }}
        self.reply_model.plans.append({"explore": {}})
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        material = next(item for item in result["evidence"] if item["evidence_id"] == memory["memory_id"])
        self.assertEqual(material["timing"]["current_status"], "current_unverified")
        self.assertEqual(datetime.fromisoformat(material["timing"]["source_started_at"]), when)
        self.assertEqual(material["timing"], next(item for item in self.reply_model.payloads[-1]["evidence"]
                                                 if item["evidence_id"] == memory["memory_id"])["timing"])
        self.assertEqual(self._backend(self.owner_id).request(path, body), (200, result))
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")[0], 202)
        self.assertEqual(self._backend(self.owner_id).request(path + "/" + result["exploration_id"])[0], 409)

    def test_incomplete_source_times_or_unsupported_end_cannot_verify_a_temporary_state(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        start = datetime.fromisoformat("2026-10-01T00:00:00+08:00")
        end = datetime.fromisoformat("2026-11-01T00:00:00+08:00")
        _, known = self._source(contact, "合成近况：这个月在加班。", start)
        _, unknown = self._source(contact, "合成近况：这个月在加班。", None)
        memory = self._confirm(contact, "合成近况：这个月在加班。", "recent_state", (known, unknown),
                               valid_at=start, invalid_at=end)
        self.assertFalse(memory["timing"]["source_time_complete"])
        self.assertEqual(memory["timing"]["current_status"], "current_unverified")
        invented_end = self._confirm(contact, "合成近况：这个月在加班。", "recent_state", (known,),
                                    valid_at=start, invalid_at=end.replace(month=12))
        self.assertEqual(invented_end["timing"]["current_status"], "current_unverified")

    def test_source_deletion_before_or_during_generation_cannot_restore_unverified_content(self):
        for before in (True, False):
            with self.subTest(before=before):
                contact, _, _ = self.prepare_contact(self.owner_id, history=False)
                source, message = self._source(contact, "合成待删近况：最近在加班。",
                                               datetime(2024, 1, 1, tzinfo=timezone.utc))
                memory = self._confirm(contact, "合成待删近况：最近在加班。", "recent_state", (message,))
                body = {"contact_id": contact, "idempotency_key": str(uuid4()),
                        "content": {"type": "rewrite_draft", "draft_text": "最近加班忙吗？",
                                    "include_relationship_context": True}}
                deletion = f"/api/contacts/{contact}/sources/{source}"
                if before:
                    self._delete_source_and_wait(deletion)
                    self.reply_model.plans.append({"text": "最近忙吗？", "basis": "没有可用的旧近况。"})
                    status, reply = self._backend(self.owner_id).request("/api/reply/generate", body)
                    self.assertEqual(status, 200, reply)
                    self.assertFalse(any(item["evidence_id"] == memory["memory_id"]
                                         for item in self.reply_model.payloads[-1]["evidence"]))
                else:
                    self.reply_model.entered.clear()
                    gate = self.reply_model.pause_next_response()
                    self.reply_model.plans.append({"text": "基于待删资料的合成迟到结果。", "basis": "合成迟到。",
                                                   "citation_ids": [memory["memory_id"]]})
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        running = pool.submit(self.backend.request, "/api/reply/generate", body)
                        try:
                            self.assertTrue(self.reply_model.entered.wait(5))
                            self.assertEqual(self.backend.request(deletion, method="DELETE")[0], 202)
                        finally:
                            gate.set()
                        status, result = running.result(timeout=10)
                    self.assertEqual(status, 500, result)
                    self.assertNotIn("迟到结果", str(result))
                self.assertEqual(self._backend(self.owner_id).request(f"/api/contacts/{contact}/memories")[1]["memories"], [])
                self.assertEqual(self.backend.request(deletion, method="DELETE")[0], 202)

    def test_current_input_change_rejects_a_late_exploration_without_reviving_its_snapshot(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        _, message = self._source(contact, "合成旧近况：最近在加班。",
                                  datetime(2024, 1, 1, tzinfo=timezone.utc))
        self._confirm(contact, "合成旧近况：最近在加班。", "recent_state", (message,))
        _, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        self.reply_model.entered.clear()
        gate = self.reply_model.pause_next_response()
        self.reply_model.plans.append({"explore": {}})
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/explorations", {
                "operation_key": str(uuid4()), "content": {
                    "type": "purpose_exploration", "purpose_hint": "想询问最近加班。", "skill_mode": "disabled",
                },
            })
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, current = self.backend.request(path + "/inputs", {
                    "content": {"type": "purpose_exploration", "purpose_hint": "无关的新输入。"},
                })
                self.assertEqual(status, 200, current)
            finally:
                gate.set()
            self.assertEqual(running.result(timeout=10)[0], 409)
        saved = self._backend(self.owner_id).request(path)[1]
        self.assertEqual(saved["current_input_version_id"], current["input_version_id"])
        self.assertEqual(saved["turns"], [])

    def test_legacy_reply_snapshot_keeps_unknown_status_even_when_current_memory_is_stable(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        status, added = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "合成偏好：一直喜欢咖啡。", "category": "preference",
        })
        self.assertEqual(status, 200, added)
        memory_id = added["memory"]["memory_id"]
        self.reply_model.plans.append({"text": "想喝咖啡吗？", "basis": "仅询问意愿。", "citation_ids": [memory_id]})
        status, reply = self.backend.request("/api/reply/generate", {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "想喝咖啡吗？", "include_relationship_context": True},
        })
        self.assertEqual(status, 200, reply)
        # 仅安排既存旧版快照的缺字段条件；通过公开读取验证，禁止倒填当前来源。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""UPDATE public.reply_request
                SET context_snapshot=jsonb_set(context_snapshot,'{evidence}',(
                    SELECT jsonb_agg(jsonb_set(entry,'{timing}',
                        (entry->'timing') - 'current_status' - 'current_status_reason'))
                    FROM jsonb_array_elements(context_snapshot->'evidence') AS entry))
                WHERE id=%s AND owner_id=%s AND contact_id=%s""",
                (reply["reply_request_id"], self.owner_id, contact))
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        status, snapshot = self._backend(self.owner_id).request(path)
        self.assertEqual(status, 200, snapshot)
        old = next(item for item in snapshot["evidence"] if item["evidence_id"] == memory_id)
        self.assertEqual(old["timing"]["current_status"], "current_unverified")
        current = self.backend.request(f"/api/contacts/{contact}/memories")[1]["memories"][0]
        self.assertEqual(current["timing"]["current_status"], "stable")

    def test_legacy_exploration_requires_new_understanding_and_deletion_erases_both_saved_snapshots(self):
        from dataclasses import asdict
        from hashlib import sha256
        import json
        from notalone.persistence.retrieval import PostgresRetrieval

        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        original_text = "合成旧探索近况：最近在加班。"
        source, message = self._source(contact, original_text,
                                       datetime(2024, 1, 1, tzinfo=timezone.utc))
        memory = self._confirm(contact, original_text, "recent_state", (message,))
        scope = ContactScope(self.owner_id, UUID(contact))
        _, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/explorations"
        body = {"operation_key": str(uuid4()), "content": {
            "type": "purpose_exploration", "purpose_hint": "想了解当前近况。", "skill_mode": "disabled",
        }}
        self.reply_model.plans.append({"explore": {}})
        status, first = self.backend.request(path, body)
        self.assertEqual(status, 200, first)

        # 只安排旧版已保存的六字段快照及四字段时间指纹，不替换公开读取或删除行为。
        retrieved = PostgresRetrieval(self.database_url).search_confirmed_memories(
            scope=scope, memory_ids=(UUID(memory["memory_id"]),), limit=1,
        )[0]
        previous = asdict(retrieved)
        previous["timing"].pop("current_status")
        previous["timing"].pop("current_status_reason")
        fields = ("scope", "text", "source_ids", "status", "valid_at", "invalid_at",
                  "revision", "adoption_method", "category", "topic", "timing")
        previous_fingerprint = sha256(json.dumps(
            {key: previous[key] for key in fields}, ensure_ascii=False, sort_keys=True, default=str,
        ).encode()).hexdigest()
        with psycopg.connect(self.database_url) as connection:
            snapshots = connection.execute(
                "SELECT snapshots FROM public.reply_exploration WHERE id=%s AND owner_id=%s AND contact_id=%s",
                (first["exploration_id"], self.owner_id, contact),
            ).fetchone()[0]
            for item in snapshots:
                for field in ("timing", "valid_at", "invalid_at"):
                    item.pop(field)
                if item["evidence_id"] == memory["memory_id"]:
                    item["fingerprint"] = previous_fingerprint
            connection.execute(
                "UPDATE public.reply_exploration SET snapshots=%s WHERE id=%s AND owner_id=%s AND contact_id=%s",
                (Jsonb(snapshots), first["exploration_id"], self.owner_id, contact),
            )
        for status, rejected in (self._backend(self.owner_id).request(path + "/" + first["exploration_id"]),
                                 self._backend(self.owner_id).request(path, body)):
            self.assertEqual(status, 409, rejected)
            self.assertNotIn(original_text, json.dumps(rejected, ensure_ascii=False))
        self.assertEqual(len(self.reply_model.payloads), 1)

        self.reply_model.plans.append({"explore": {}})
        status, fresh = self.backend.request(path, {**body, "operation_key": str(uuid4())})
        self.assertEqual(status, 200, fresh)
        self.assertNotEqual(fresh["exploration_id"], first["exploration_id"])
        self.assertEqual(next(item for item in fresh["evidence"] if item["evidence_id"] == memory["memory_id"])
                         ["timing"]["current_status"], "current_unverified")
        self._delete_source_and_wait(f"/api/contacts/{contact}/sources/{source}")
        for identity in (first["exploration_id"], fresh["exploration_id"]):
            status, rejected = self._backend(self.owner_id).request(path + "/" + identity)
            self.assertEqual(status, 409, rejected)
            self.assertNotIn(original_text, json.dumps(rejected, ensure_ascii=False))
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute(
                "SELECT state,input_payload,result_payload,snapshots,intent_snapshots,selected_intent,source_ids "
                "FROM public.reply_exploration WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s)",
                (self.owner_id, contact, [UUID(first["exploration_id"]), UUID(fresh["exploration_id"])]),
            ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows, [("redacted", None, None, [], [], None, [])] * 2)
        self.assertNotIn(original_text, json.dumps(rows, ensure_ascii=False, default=str))

    def test_bounded_history_tool_keeps_old_source_time_and_does_not_claim_current_state(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        when = datetime(2024, 1, 1, tzinfo=timezone.utc)
        _, message = self._source(contact, "合成历史原话：最近在加班。", when)
        self.reply_model.plans.extend([
            {"search": "加班"},
            {"text": "最近忙吗？", "basis": "只有历史原话，先询问现在。", "citation_ids": [str(message)]},
        ])
        status, reply = self.backend.request("/api/reply/generate", {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "想询问现在是否忙。", "include_relationship_context": True},
        })
        self.assertEqual(status, 200, reply)
        returned = next(item for item in self.reply_model.seen_calls[-1]
                        if isinstance(item, ToolMessage) and item.name == "conversation_search")
        payload = __import__("json").loads(returned.content)
        self.assertEqual(payload["evidence_type"], "raw_message_evidence")
        self.assertTrue(payload["not_found_is_not_evidence"])
        original = payload["messages"][0]
        self.assertEqual(original["timing"]["current_status"], "current_unverified")
        self.assertEqual(datetime.fromisoformat(original["timing"]["source_started_at"]), when)
        status, snapshot = self.backend.request(
            f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence")
        self.assertEqual(status, 200, snapshot)
        self.assertEqual(next(item for item in snapshot["evidence"] if item["evidence_id"] == str(message))["timing"],
                         original["timing"])

    def test_other_claims_interval_in_same_source_cannot_certify_an_unbounded_dynamic_fact(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        start = datetime.fromisoformat("2026-10-01T00:00:00+08:00")
        end = datetime.fromisoformat("2026-11-01T00:00:00+08:00")
        _, message = self._source(contact, "从2026-10-01T00:00:00+08:00到2026-11-01T00:00:00+08:00参加课程；我住在台北。", start)
        memory = self._confirm(contact, "对方住在台北。", "common_fact", (message,), valid_at=start, invalid_at=end)
        self.assertEqual(memory["timing"]["current_status"], "current_unverified")

    def test_professional_identity_is_unverified_but_completed_education_keeps_stable_with_unknown_dates(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        for text, expected in (
            ("合成职业身份：对方是一名工程师。", "current_unverified"),
            ("合成职业身份：对方的职业是研究员。", "current_unverified"),
            ("合成学历经历：对方去年毕业于一所合成大学。", "stable"),
            ("合成出生事实：对方出生于春天。", "stable"),
            ("合成不可逆经历：双方去年初次相识。", "stable"),
            ("合成未完成计划：对方即将毕业于一所合成大学。", "current_unverified"),
        ):
            with self.subTest(text=text):
                status, added = self.backend.request("/api/memories/manual-contact", {
                    "contact_id": contact, "text": text, "category": "common_fact",
                })
                self.assertEqual(status, 200, added)
                self.assertIsNone(added["memory"]["timing"]["source_started_at"])
                self.assertEqual(added["memory"]["timing"]["current_status"], expected)

    def test_completed_stable_facts_without_dates_are_distinct_from_unfinished_or_future_claims(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        for category, text, expected in (
            ("common_fact", "对方拥有博士学位。", "stable"),
            ("common_fact", "对方已取得博士学位。", "stable"),
            ("common_fact", "对方出生地为合成城市。", "stable"),
            ("common_fact", "对方出生于合成市。", "stable"),
            ("common_fact", "对方出生于2020年。", "stable"),
            ("common_fact", "对方出生于2099年。", "current_unverified"),
            ("preference", "对方一直喜欢咖啡。", "stable"),
            ("taboo", "对方不喜欢被催促。", "stable"),
            ("common_fact", "对方尚未毕业于合成大学。", "current_unverified"),
            ("common_fact", "对方还没取得博士学位。", "current_unverified"),
            ("common_fact", "对方准备获得专业资格。", "current_unverified"),
            ("common_fact", "对方明年毕业于合成大学。", "current_unverified"),
            ("common_fact", "双方明天首次见面。", "current_unverified"),
            ("common_fact", "对方下周毕业于合成大学。", "current_unverified"),
            ("common_fact", "对方下个月取得博士学位。", "current_unverified"),
            ("common_fact", "孩子后天出生于合成城市。", "current_unverified"),
            ("common_fact", "对方将于下个季度获得专业资格。", "current_unverified"),
            ("common_fact", "对方已取得博士学位，但还没获得专业资格。", "current_unverified"),
            ("common_fact", "对方出生于春天，是建筑师。", "current_unverified"),
            ("common_fact", "对方是拥有博士学位的建筑师。", "current_unverified"),
            ("common_fact", "对方是一名出生于春天的演员。", "current_unverified"),
            ("common_fact", "对方出生于合成市而体重70公斤。", "current_unverified"),
            ("common_fact", "对方取得学位而现在在减肥。", "current_unverified"),
            ("common_fact", "对方出生于合成市并担任建筑师。", "current_unverified"),
        ):
            with self.subTest(text=text):
                status, added = self.backend.request("/api/memories/manual-contact", {
                    "contact_id": contact, "text": text, "category": category,
                })
                self.assertEqual(status, 200, added)
                timing = added["memory"]["timing"]
                self.assertIsNone(timing["source_started_at"])
                self.assertEqual(timing["current_status"], expected)


if __name__ == "__main__":
    unittest.main()
