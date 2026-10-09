"""任务 13 合成资料夹具；只创建本轮隔离库，可独立核验真实 HTTP。"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.application.memory_service import ManualMemoryEntry, MemoryService
from notalone.memory.models import AdoptionMethod, FactSubject, MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.scopes import ContactScope


ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "contact_database_fixture", Path(__file__).with_name("contact-database.py"),
)
assert spec is not None and spec.loader is not None
contact_database = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contact_database)


def create_database(*, empty_owner_memory: bool = False) -> dict[str, object]:
    """复用本轮随机建库与正式迁移，不操作已有库。"""
    data = contact_database.create_database("ready")
    try:
        database_url = data["database_url"]
        owner_id = UUID(data["owner_id"])
        a, b = map(UUID, data["contact_ids"])
        store = PostgresMemoryStore(database_url)
        owner_store = PostgresOwnerMemoryStore(database_url)
        service = MemoryService(contact_memory=store, owner_memory=owner_store)
        with psycopg.connect(database_url) as connection:
            source_id = connection.execute(
                "SELECT id FROM public.source_document WHERE owner_id = %s AND contact_id = %s",
                (owner_id, a),
            ).fetchone()[0]
            message_ids = [row[0] for row in connection.execute(
                "SELECT id FROM public.message WHERE owner_id = %s AND contact_id = %s ORDER BY id",
                (owner_id, a),
            )]
            connection.execute(
                "UPDATE public.message SET occurred_at = '2024-01-02T02:00:00Z' WHERE id = %s",
                (message_ids[0],),
            )
            connection.execute(
                "UPDATE public.message SET occurred_at = NULL WHERE id = %s",
                (message_ids[1],),
            )
            empty_contact_id = uuid4()
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, '空资料联系人')",
                (owner_id, empty_contact_id),
            )

        scope = ContactScope(owner_id, a)

        def candidate(text: str, sources: tuple[UUID, ...], subject=FactSubject.CONTACT, **kwargs):
            return store.create_candidate(MemoryCandidate(
                candidate_id=uuid4(), scope=scope, text=text,
                category=MemoryCategory.RELATIONSHIP_NOTE,
                source_ids=sources, subject=subject, **kwargs,
            ))

        automatic = candidate("甲喜欢合成茉莉茶。", (message_ids[0],))
        store.confirm(scope=scope, candidate_id=automatic.candidate_id)
        old = candidate("旧版关系备注。", (source_id, message_ids[0]))
        old_memory = store.confirm(scope=scope, candidate_id=old.candidate_id)
        corrected = store.correct(scope=scope, memory_id=old_memory.memory_id, text="甲的新版本关系备注。")
        for subject, text in (
            (FactSubject.SELF, "本人可能参加合成学习计划。"),
            (FactSubject.CONTACT, "甲可能参加合成旅行计划。"),
            (FactSubject.SHARED, "双方可能参加合成活动。"),
        ):
            candidate(text, tuple(message_ids), subject=subject, confidence=0.5,
                      risk_flags=("pragmatic:planned",))
        owner_candidate = None
        if not empty_owner_memory:
            owner_candidate = candidate("本人喜欢合成绿茶。", (message_ids[0],), subject=FactSubject.SELF)
            service.confirm_candidate(owner_id=owner_id, contact_id=a, candidate_id=owner_candidate.candidate_id)

        # 历史与未来状态只属于夹具条件；公开列表不得把它们显示为当前资料。
        for text, validity in (
            ("甲已过期的合成状态。", {"invalid_at": datetime(2020, 1, 1, tzinfo=timezone.utc)}),
            ("甲尚未生效的合成状态。", {"valid_at": datetime(2099, 1, 1, tzinfo=timezone.utc)}),
        ):
            item = candidate(text, (source_id,), **validity)
            store.confirm(scope=scope, candidate_id=item.candidate_id)
        other_scope = ContactScope(UUID(data["other_owner_id"]), UUID(data["other_contact_id"]))
        for selected_scope, text in (
            (ContactScope(owner_id, b), "乙喜欢合成乌龙茶。"),
            (other_scope, "另一用户的联系人资料。"),
        ):
            item = store.create_manual_candidate(MemoryCandidate(
                candidate_id=uuid4(), scope=selected_scope, text=text,
                category=MemoryCategory.PREFERENCE, source_ids=(selected_scope.contact_id,),
            ))
            store.confirm(scope=selected_scope, candidate_id=item.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        if not empty_owner_memory:
            service.add_manual_owner_memory(
                owner_id=owner_id,
                entry=ManualMemoryEntry(text="本人手动录入的合成资料。", category=MemoryCategory.COMMON_FACT),
            )
        service.add_manual_owner_memory(
            owner_id=other_scope.owner_id,
            entry=ManualMemoryEntry(text="另一用户的本人资料。", category=MemoryCategory.COMMON_FACT),
        )
        with psycopg.connect(database_url) as connection:
            for table in ("memory_candidate", "confirmed_memory", "owner_memory"):
                connection.execute(sql.SQL("UPDATE public.{} SET created_at = '2026-01-02T02:00:00Z'").format(sql.Identifier(table)))
        return {**data, "empty_contact_id": str(empty_contact_id),
                "direct_message_id": str(message_ids[0]), "source_document_id": str(source_id),
                "supersedes_memory_id": str(old_memory.memory_id), "corrected_memory_id": str(corrected.memory_id),
                "owner_candidate_id": str(owner_candidate.candidate_id) if owner_candidate else None}
    except BaseException:
        contact_database.drop_database(data["database_name"])
        raise


def check_http() -> None:
    """仅核对待用夹具数据及公开契约；不证明 UI、端到端或新增后端能力。"""
    import inspect
    assert Path(inspect.getfile(MemoryService)).resolve().is_relative_to(ROOT / "backend/src")
    data = create_database()
    child = None
    try:
        with tempfile.TemporaryDirectory(prefix="notalone-memory-http-") as directory:
            temp = Path(directory)
            info = temp / "backend.info"
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith(("NOTALONE_", "DEEPSEEK_"))}
            environment.update({
                "PYTHONPATH": str(ROOT / "backend/src"), "PYTHONNOUSERSITE": "1",
                "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_ENV_FILE": str(temp / "synthetic.env"),
                "NOTALONE_BACKEND_INFO": str(info), "NOTALONE_DATABASE_URL": data["database_url"],
                "NOTALONE_OWNER_ID": data["owner_id"], "NOTALONE_DEEPSEEK_API_KEY": "", "DEEPSEEK_API_KEY": "",
                "NOTALONE_DEEPSEEK_BASE_URL": "http://127.0.0.1:1",
                "NOTALONE_WECHAT_CLI": str(temp / "unavailable-cli"), "NOTALONE_SYNC_PROBE": str(temp / "unavailable-probe"),
            })
            child = subprocess.Popen([sys.executable, "-m", "notalone.server.command"], cwd=ROOT, env=environment,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            def request(path, body=None):
                fields = dict(line.split("=", 1) for line in info.read_text().strip().splitlines())
                req = Request("http://" + fields["address"] + path,
                              data=json.dumps(body).encode() if body is not None else None,
                              headers={"Authorization": "Bearer " + fields["token"], "Content-Type": "application/json"})
                with urlopen(req, timeout=5) as response:
                    assert response.status == 200
                    return json.load(response)

            deadline = time.monotonic() + 20
            while True:
                if child.poll() is not None:
                    raise RuntimeError("合成资料后端未启动。")
                try:
                    if request("/api/runtime/status")["state"] == "running":
                        break
                except (OSError, ValueError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("合成资料后端启动超时。") from None
                time.sleep(0.05)
            a, b = data["contact_ids"]
            memories = request(f"/api/contacts/{a}/memories")["memories"]
            assert {item["text"] for item in memories} == {"甲喜欢合成茉莉茶。", "甲的新版本关系备注。"}
            automatic = next(item for item in memories if item["adoption_method"] == "auto")
            timing = automatic["timing"]
            assert datetime.fromisoformat(timing["recorded_at"]) == datetime(2026, 1, 2, 2, tzinfo=timezone.utc)
            for field in ("source_started_at", "source_ended_at"):
                assert datetime.fromisoformat(timing[field]) == datetime(2024, 1, 2, 2, tzinfo=timezone.utc)
            assert timing["source_time_complete"] is True
            corrected = next(item for item in memories if item["adoption_method"] == "manual")
            assert corrected["supersedes_memory_id"] == data["supersedes_memory_id"]
            assert corrected["timing"]["source_time_complete"] is False
            owners = request("/api/memories/owner")["memories"]
            assert {item["text"] for item in owners} == {"本人喜欢合成绿茶。", "本人手动录入的合成资料。"}
            assert any(item["source_candidate_id"] == data["owner_candidate_id"] for item in owners)
            manual_owner = next(item for item in owners if item["text"] == "本人手动录入的合成资料。")
            assert manual_owner["timing"]["source_started_at"] is None
            assert manual_owner["timing"]["source_ended_at"] is None
            assert manual_owner["timing"]["source_time_complete"] is False
            pending = request(f"/api/contacts/{a}/memory-candidates")["candidates"]
            assert {item["subject"] for item in pending} == {"self", "contact", "shared"}
            assert all(item["status"] == "pending" and not item["timing"]["source_time_complete"] for item in pending)
            sources = request(f"/api/contacts/{a}/sources")["sources"]
            assert {item["source_id"] for item in sources} == {data["source_document_id"]}
            assert [item["text"] for item in request(f"/api/contacts/{b}/memories")["memories"]] == ["乙喜欢合成乌龙茶。"]
            assert request(f"/api/contacts/{data['other_contact_id']}/memories")["memories"] == []
            assert request(f"/api/contacts/{data['empty_contact_id']}/memories")["memories"] == []
            assert request(f"/api/contacts/{data['empty_contact_id']}/sources")["sources"] == []
            assert request("/api/runtime/shutdown", {})["state"] == "stopped"
            assert child.wait(timeout=10) == 0
    finally:
        try:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        finally:
            contact_database.drop_database(data["database_name"])
    print("合成夹具真实 HTTP 自检通过：当前有效/采纳方式/主体/时间/引用/隔离/空状态；自有后端与本轮库已清理，UI 未运行。")


if __name__ == "__main__":
    if os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone" or os.environ.get("NOTALONE_DISABLE_DOTENV") != "1":
        raise RuntimeError("资料夹具须激活 Conda NotAlone 并显式禁用默认 dotenv。")
    env_file = Path(os.environ.get("NOTALONE_ENV_FILE", ""))
    info_file = Path(os.environ.get("NOTALONE_BACKEND_INFO", ""))
    if not env_file.is_absolute() or not info_file.is_absolute() or env_file.name != "synthetic.env" or info_file.parent == Path.home() / ".notalone":
        raise RuntimeError("资料夹具须使用本轮独立 synthetic.env 与握手路径。")
    if sys.argv[1] == "create":
        arguments = sys.argv[2:]
        if arguments not in ([], ["empty-owner-memory"]):
            raise ValueError("未知资料夹具模式。")
        print(json.dumps(create_database(empty_owner_memory=bool(arguments))))
    elif sys.argv[1] == "drop":
        contact_database.drop_database(sys.argv[2])
    elif sys.argv[1] == "check-http":
        check_http()
    else:
        raise ValueError("未知合成资料夹具操作。")
