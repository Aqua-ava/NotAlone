"""记忆管理 API 的进程内契约测试（fake 记忆服务）。

钉住记忆管理端点的 JSON 结构、鉴权与失败关闭语义。真实持久化由
test_postgres_memory_store 与 memory_service 单测覆盖。
"""

from __future__ import annotations

import json
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.application.memory_service import MemoryService
from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    FactSubject,
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.memory.timing import MemoryTiming
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
OTHER_CONTACT_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")


def _scope(contact_id: UUID = CONTACT_ID) -> ContactScope:
    return ContactScope(owner_id=OWNER_ID, contact_id=contact_id)


def _memory(contact_id: UUID = CONTACT_ID) -> ConfirmedMemory:
    return ConfirmedMemory(
        memory_id=uuid4(),
        scope=_scope(contact_id),
        text="对方喜欢提前约时间。",
        category=MemoryCategory.PREFERENCE,
        topic=MemoryTopic.OTHER,
        source_ids=(contact_id,),
        source_candidate_id=None,
        adoption_method=AdoptionMethod.MANUAL,
        status=ConfirmedMemoryStatus.ACTIVE,
    )


def _candidate(contact_id: UUID = CONTACT_ID, **overrides) -> MemoryCandidate:
    values = {
        "candidate_id": uuid4(),
        "scope": _scope(contact_id),
        "text": "对方喜欢提前约时间。",
        "category": MemoryCategory.PREFERENCE,
        "topic": MemoryTopic.OTHER,
        "source_ids": (contact_id,),
        "alternatives": ("也可能只是近期安排",),
        "interpretation_reason": "消息表达的是稳定偏好。",
    }
    values.update(overrides)
    return MemoryCandidate(**values)


class FakeContactMemory:
    """记录调用并返回合成结果的记忆端口 fake。"""

    def __init__(self) -> None:
        self.memories: list[ConfirmedMemory] = []
        self.pending: list[MemoryCandidate] = []
        self.confirm_calls: list[UUID] = []
        self.discard_calls: list[UUID] = []
        self.correct_calls: list[tuple[UUID, str, MemoryCategory | None]] = []
        self.delete_calls: list[UUID] = []

    def create_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        return candidate

    def create_manual_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        return candidate

    def list_pending_candidates(self, scope: ContactScope) -> tuple[MemoryCandidate, ...]:
        return tuple(
            candidate
            for candidate in self.pending
            if candidate.scope == scope
        )

    def get_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        return next(
            candidate
            for candidate in self.pending
            if candidate.scope == scope and candidate.candidate_id == candidate_id
        )

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        return tuple(
            memory
            for memory in self.memories
            if memory.scope == scope and memory.status is ConfirmedMemoryStatus.ACTIVE
        )

    def confirm(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        adoption_method: AdoptionMethod = AdoptionMethod.AUTO,
    ) -> ConfirmedMemory:
        self.confirm_calls.append(candidate_id)
        return _memory(scope.contact_id)

    def reject_candidate(self, *, scope: ContactScope, candidate_id: UUID) -> MemoryCandidate:
        return MemoryCandidate(
            candidate_id=candidate_id,
            scope=scope,
            text="已丢弃",
            category=MemoryCategory.PREFERENCE,
            topic=MemoryTopic.OTHER,
            source_ids=(scope.contact_id,),
        )

    def discard_candidate_with_fingerprint(self, *, scope: ContactScope, candidate_id: UUID) -> MemoryCandidate:
        self.discard_calls.append(candidate_id)
        return self.reject_candidate(
            scope=scope, candidate_id=candidate_id
        )

    def correct(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
    ) -> ConfirmedMemory:
        self.correct_calls.append((memory_id, text, category))
        return _memory(scope.contact_id)

    def delete(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        self.delete_calls.append(memory_id)
        return _memory(scope.contact_id)


class FakeOwnerMemory:
    def __init__(self) -> None:
        self.memories: list[OwnerMemory] = []
        self.delete_calls: list[UUID] = []

    def create(self, memory: OwnerMemory) -> OwnerMemory:
        self.memories.append(memory)
        return memory

    def confirm_candidate(
        self,
        *,
        candidate: MemoryCandidate,
        adoption_method: AdoptionMethod = AdoptionMethod.MANUAL,
    ) -> OwnerMemory:
        memory = OwnerMemory(
            memory_id=uuid4(),
            owner_id=candidate.scope.owner_id,
            text=candidate.text,
            category=candidate.category,
            topic=candidate.topic,
            source_ids=candidate.source_ids,
            source_candidate_id=candidate.candidate_id,
            adoption_method=adoption_method,
            status=ConfirmedMemoryStatus.ACTIVE,
        )
        self.memories.append(memory)
        return memory

    def list_active(self, owner_id: UUID) -> tuple[OwnerMemory, ...]:
        return tuple(
            memory
            for memory in self.memories
            if memory.owner_id == owner_id and memory.status is ConfirmedMemoryStatus.ACTIVE
        )

    def delete(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        self.delete_calls.append(memory_id)
        return OwnerMemory(
            memory_id=memory_id,
            owner_id=owner_id,
            text="已删除",
            category=MemoryCategory.PREFERENCE,
            topic=MemoryTopic.OTHER,
            source_ids=(owner_id,),
            adoption_method=AdoptionMethod.AUTO,
            status=ConfirmedMemoryStatus.DELETED,
        )


class FailingContactMemory(FakeContactMemory):
    """模拟持久化层故障，验证 HTTP 层不会直接断开连接。"""

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        raise RuntimeError("synthetic persistence detail")


def _build_service() -> tuple[MemoryService, FakeContactMemory, FakeOwnerMemory]:
    contact = FakeContactMemory()
    owner = FakeOwnerMemory()
    service = MemoryService(contact_memory=contact, owner_memory=owner)
    return service, contact, owner


class MemoryApiContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service, self.contact, self.owner = _build_service()
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            memory_service=self.service,
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    # ------------------------------------------------------------------
    # 鉴权与范围
    # ------------------------------------------------------------------

    def test_memory_endpoints_require_token(self) -> None:
        response = self.client.get(f"/api/contacts/{CONTACT_ID}/memories")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})

    # ------------------------------------------------------------------
    # 列表
    # ------------------------------------------------------------------

    def test_lists_contact_memories_with_text(self) -> None:
        memory = _memory()
        self.contact.memories.append(memory)

        response = self.client.get(
            f"/api/contacts/{CONTACT_ID}/memories",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["memories"]), 1)
        item = payload["memories"][0]
        self.assertEqual(item["memory_id"], str(memory.memory_id))
        self.assertEqual(item["text"], "对方喜欢提前约时间。")
        self.assertEqual(item["category"], "preference")
        self.assertEqual(item["adoption_method"], "manual")
        self.assertEqual(item["status"], "active")

    def test_legacy_memory_lists_explicitly_unknown_time(self) -> None:
        self.contact.memories.append(_memory())
        response = self.client.get(
            f"/api/contacts/{CONTACT_ID}/memories", headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["memories"][0]["timing"], {
            "recorded_at": None,
            "source_started_at": None,
            "source_ended_at": None,
            "source_time_complete": False,
        })

    def test_all_memory_levels_expose_source_and_save_times_separately(self) -> None:
        timing = MemoryTiming(
            recorded_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
            source_started_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
            source_ended_at=datetime(2026, 9, 2, tzinfo=timezone.utc),
            source_time_complete=False,
        )
        self.contact.memories.append(replace(_memory(), timing=timing))
        self.contact.pending.append(MemoryCandidate(
            candidate_id=uuid4(), scope=_scope(), text="合成多日期候选",
            category=MemoryCategory.COMMON_FACT, source_ids=(CONTACT_ID,), timing=timing,
        ))
        self.owner.memories.append(OwnerMemory(
            memory_id=uuid4(), owner_id=OWNER_ID, text="合成本人历史事实",
            category=MemoryCategory.COMMON_FACT, topic=MemoryTopic.OTHER,
            source_ids=(OWNER_ID,), adoption_method=AdoptionMethod.AUTO,
            status=ConfirmedMemoryStatus.ACTIVE, timing=timing,
        ))
        for path, list_key in (
            (f"/api/contacts/{CONTACT_ID}/memories", "memories"),
            (f"/api/contacts/{CONTACT_ID}/memory-candidates", "candidates"),
            ("/api/memories/owner", "memories"),
        ):
            with self.subTest(path=path):
                response = self.client.get(path, headers=self.headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()[list_key][0]["timing"], {
                    "recorded_at": "2026-10-02T00:00:00+00:00",
                    "source_started_at": "2026-09-01T00:00:00+00:00",
                    "source_ended_at": "2026-09-02T00:00:00+00:00",
                    "source_time_complete": False,
                })
                self.assertIsNone(response.json()[list_key][0]["valid_at"])
                self.assertIsNone(response.json()[list_key][0]["invalid_at"])

    def test_lists_pending_candidates(self) -> None:
        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=_scope(),
            text="待确认的关系记忆候选",
            category=MemoryCategory.RECENT_STATE,
            topic=MemoryTopic.OTHER,
            source_ids=(CONTACT_ID,),
        )
        self.contact.pending.append(candidate)

        response = self.client.get(
            f"/api/contacts/{CONTACT_ID}/memory-candidates",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["candidates"]), 1)
        item = payload["candidates"][0]
        self.assertEqual(item["candidate_id"], str(candidate.candidate_id))
        self.assertEqual(item["text"], "待确认的关系记忆候选")
        self.assertEqual(item["category"], "recent_state")
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["subject"], "contact")

    def test_pending_candidate_exposes_interpretation_details_without_empty_shells(self) -> None:
        explained = _candidate()
        plain = _candidate(
            alternatives=(),
            interpretation_reason="",
        )
        self.contact.pending.extend((explained, plain))

        response = self.client.get(
            f"/api/contacts/{CONTACT_ID}/memory-candidates",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        by_id = {
            item["candidate_id"]: item
            for item in response.json()["candidates"]
        }
        explained_payload = by_id[str(explained.candidate_id)]
        self.assertEqual(explained_payload["alternatives"], ["也可能只是近期安排"])
        self.assertEqual(explained_payload["interpretation_reason"], "消息表达的是稳定偏好。")
        plain_payload = by_id[str(plain.candidate_id)]
        self.assertNotIn("alternatives", plain_payload)
        self.assertNotIn("interpretation_reason", plain_payload)

    def test_lists_owner_memories(self) -> None:
        memory = OwnerMemory(
            memory_id=uuid4(),
            owner_id=OWNER_ID,
            text="我偏好早起。",
            category=MemoryCategory.PREFERENCE,
            topic=MemoryTopic.OTHER,
            source_ids=(OWNER_ID,),
            adoption_method=AdoptionMethod.MANUAL,
            status=ConfirmedMemoryStatus.ACTIVE,
        )
        self.owner.memories.append(memory)

        response = self.client.get(
            "/api/memories/owner",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["memories"]), 1)
        item = payload["memories"][0]
        self.assertEqual(item["memory_id"], str(memory.memory_id))
        self.assertEqual(item["text"], "我偏好早起。")
        self.assertEqual(item["level"], "owner")

    # ------------------------------------------------------------------
    # pending 候选处理
    # ------------------------------------------------------------------

    def test_confirms_pending_candidate(self) -> None:
        candidate_id = uuid4()
        self.contact.pending.append(
            MemoryCandidate(
                candidate_id=candidate_id,
                scope=_scope(),
                text="待确认联系人记忆",
                category=MemoryCategory.PREFERENCE,
                source_ids=(CONTACT_ID,),
            )
        )

        response = self.client.request(
            "POST",
            f"/api/contacts/{CONTACT_ID}/memory-candidates/{candidate_id}/confirm",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["memory"]["adoption_method"], "manual"
        )
        self.assertEqual(len(self.contact.confirm_calls), 1)
        self.assertEqual(self.contact.confirm_calls[0], candidate_id)

    def test_confirms_pending_self_candidate_as_owner_memory(self) -> None:
        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=_scope(),
            text="我最近在减肥",
            category=MemoryCategory.RECENT_STATE,
            topic=MemoryTopic.HEALTH,
            subject=FactSubject.SELF,
            source_ids=(CONTACT_ID,),
            confidence=0.3,
        )
        self.contact.pending.append(candidate)

        response = self.client.request(
            "POST",
            f"/api/contacts/{CONTACT_ID}/memory-candidates/"
            f"{candidate.candidate_id}/confirm",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        memory = response.json()["memory"]
        self.assertEqual(memory["level"], "owner")
        self.assertEqual(memory["text"], candidate.text)
        self.assertEqual(
            memory["source_candidate_id"],
            str(candidate.candidate_id),
        )
        self.assertEqual(self.contact.confirm_calls, [])

    def test_discards_pending_candidate(self) -> None:
        candidate_id = uuid4()

        response = self.client.request(
            "POST",
            f"/api/contacts/{CONTACT_ID}/memory-candidates/{candidate_id}/discard",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["candidate_id"], str(candidate_id))
        self.assertEqual(self.contact.discard_calls, [candidate_id])

    def test_pending_confirmation_rejects_invalid_candidate_id(self) -> None:
        response = self.client.request(
            "POST",
            "/api/contacts/not-a-uuid/memory-candidates/x/confirm",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "memory_request_invalid"})

    # ------------------------------------------------------------------
    # 手动录入
    # ------------------------------------------------------------------

    def test_manual_contact_entry(self) -> None:
        body = json.dumps(
            {
                "contact_id": str(CONTACT_ID),
                "text": "对方喜欢雨天散步。",
                "category": "preference",
                "topic": "other",
            }
        ).encode("utf-8")

        response = self.client.request(
            "POST",
            "/api/memories/manual-contact",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["memory"]["text"], "对方喜欢提前约时间。")
        self.assertEqual(payload["memory"]["adoption_method"], "manual")
        self.assertEqual(len(self.contact.confirm_calls), 1)

    def test_manual_owner_entry(self) -> None:
        body = json.dumps(
            {
                "text": "我倾向晚间散步。",
                "category": "preference",
                "topic": "other",
            }
        ).encode("utf-8")

        response = self.client.request(
            "POST",
            "/api/memories/manual-owner",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["memory"]["level"], "owner")
        self.assertEqual(len(self.owner.memories), 1)
        self.assertEqual(self.owner.memories[0].text, "我倾向晚间散步。")
        self.assertEqual(
            self.owner.memories[0].adoption_method,
            AdoptionMethod.MANUAL,
        )

    def test_manual_entry_rejects_invalid_body(self) -> None:
        for body in (
            b"not-json",
            b"{}",
            json.dumps({"text": "", "category": "preference"}).encode("utf-8"),
            json.dumps(
                {"text": "有效文本", "category": "no-such-category"}
            ).encode("utf-8"),
        ):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/memories/manual-owner",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(),
                    {"error": "memory_request_invalid"},
                )

    # ------------------------------------------------------------------
    # 修正与删除
    # ------------------------------------------------------------------

    def test_corrects_memory(self) -> None:
        memory_id = uuid4()
        body = json.dumps(
            {"text": "修正后的记忆文本", "category": "common_fact"}
        ).encode("utf-8")

        response = self.client.request(
            "POST",
            f"/api/contacts/{CONTACT_ID}/memories/{memory_id}/correct",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.contact.correct_calls,
            [(memory_id, "修正后的记忆文本", MemoryCategory.COMMON_FACT)],
        )

    def test_deletes_contact_memory(self) -> None:
        memory_id = uuid4()

        response = self.client.request(
            "POST",
            f"/api/contacts/{CONTACT_ID}/memories/{memory_id}/delete",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.contact.delete_calls, [memory_id])

    def test_deletes_owner_memory(self) -> None:
        memory_id = uuid4()

        response = self.client.request(
            "POST",
            f"/api/memories/owner/{memory_id}/delete",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.owner.delete_calls, [memory_id])

    # ------------------------------------------------------------------
    # 服务不可用
    # ------------------------------------------------------------------

    def test_memory_unavailable_without_service(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)

        response = client.get(
            f"/api/contacts/{CONTACT_ID}/memories",
            headers={"Authorization": "Bearer test-token"},
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "memory_unavailable"})

    def test_memory_operation_failure_returns_stable_error(self) -> None:
        service = MemoryService(
            contact_memory=FailingContactMemory(),
            owner_memory=FakeOwnerMemory(),
        )
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            memory_service=service,
        )
        client = InProcessClient(app)

        response = client.get(
            f"/api/contacts/{CONTACT_ID}/memories",
            headers={"Authorization": "Bearer test-token"},
        )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            response.json(), {"error": "memory_operation_failed"}
        )


if __name__ == "__main__":
    unittest.main()
