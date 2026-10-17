"""固定公开15窗的正式来源适配；只操作本次标记的本机隔离库。"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.database_migrations import migrate
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
from notalone.ingest.normalizer import normalize_document
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.scopes import ContactScope
from notalone.tasks.models import ExtractionRuntimeMode
from notalone.tasks.extraction_runtime import runtime_config_for_mode
from notalone.wechat_cli import LocalWechatCli
from notalone.wechat_cli.normalizer import normalize_cli_events

from .cli_support import load_contact_messages
from .evaluation_formal_task import _task_window
from .evaluation_bounded_cases import BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_INPUTS, BOUNDED_RUNTIME_PLAN
from .evaluation_records import _json_value, _redact, canonical_sha256
from .evaluation_reference import bounded_window_projection
from .models import ExtractionWindow
from .source_proof import bounded_source_occurred_at


_RECEIPT = "bounded-sources-receipt.json"
_OWNERSHIP = "bounded-sources-database.json"
_MAX_BYTES = 8 * 1024 * 1024


class BoundedSourcesError(RuntimeError):
    """不回显来源正文、连接信息或底层驱动错误。"""


@dataclass(frozen=True, slots=True)
class BoundedSources:
    database_url: str
    windows: tuple[ExtractionWindow, ...]
    task_ids: tuple[UUID, ...]
    owner_id: UUID
    receipt_path: Path


def _connection_info(name: str) -> str:
    # 明确本机socket、用户和空凭据文件；不从项目环境或配置取得业务连接。
    return make_conninfo(host="/tmp", port=5432, dbname=name,
        user=pwd.getpwuid(os.getuid()).pw_name, passfile="/dev/null",
        password="bounded-local-peer-only", sslmode="disable", connect_timeout=5)


def _directory(path: Path, identity: dict | None = None) -> int:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    value = os.fstat(descriptor)
    actual = {"device": value.st_dev, "inode": value.st_ino}
    if (not stat.S_ISDIR(value.st_mode) or stat.S_IMODE(value.st_mode) != 0o700
            or value.st_uid != os.getuid() or identity is not None and identity != actual):
        os.close(descriptor)
        raise BoundedSourcesError("bounded_sources_directory_invalid")
    return descriptor


def _publish(directory: int, name: str, value: Any) -> None:
    content = json.dumps(_json_value(value), ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.fsync(directory)


def _read(directory: int, name: str) -> dict:
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    with os.fdopen(descriptor, "rb") as handle:
        value = os.fstat(handle.fileno())
        if (not stat.S_ISREG(value.st_mode) or stat.S_IMODE(value.st_mode) != 0o600
                or value.st_uid != os.getuid() or value.st_nlink != 1 or value.st_size > _MAX_BYTES):
            raise BoundedSourcesError("bounded_sources_receipt_file_invalid")
        parsed = json.loads(handle.read(_MAX_BYTES + 1))
    if type(parsed) is not dict:
        raise BoundedSourcesError("bounded_sources_receipt_file_invalid")
    return parsed


def _marker(database: dict) -> str:
    return json.dumps({"kind": BOUNDED_RUNTIME_PLAN, "nonce": database["nonce"]}, sort_keys=True)


def _check_database(connection: psycopg.Connection, database: dict, *, marker: bool = True) -> None:
    if (type(database) is not dict or set(database) != {"name", "oid", "datdba", "nonce", "owner_uid"}
            or type(database["name"]) is not str
            or re.fullmatch(r"notalone_b15_[0-9a-f]{32}_test", database["name"]) is None
            or type(database["owner_uid"]) is not int or database["owner_uid"] != os.getuid()
            or type(database["oid"]) is not int or type(database["datdba"]) is not int
            or type(database["nonce"]) is not str or re.fullmatch(r"[0-9a-f]{32}", database["nonce"]) is None):
        raise BoundedSourcesError("bounded_sources_ownership_invalid")
    row = connection.execute(
        "SELECT oid,datdba,shobj_description(oid,'pg_database') FROM pg_database WHERE datname=%s",
        (database["name"],),
    ).fetchone()
    if row is None or row[:2] != (database["oid"], database["datdba"]) or marker and row[2] != _marker(database):
        raise BoundedSourcesError("bounded_sources_ownership_changed")


def _receipt(receipt: dict) -> tuple[dict, Path]:
    if (type(receipt) is not dict or type(receipt.get("format_version")) is not int or receipt.get("format_version") != 1
            or receipt.get("execution_plan") != BOUNDED_RUNTIME_PLAN
            or receipt.get("status") != "prepared" or type(receipt.get("receipt_path")) is not str):
        raise BoundedSourcesError("bounded_sources_receipt_invalid")
    path = Path(receipt["receipt_path"])
    if not path.is_absolute() or path.name != _RECEIPT:
        raise BoundedSourcesError("bounded_sources_receipt_invalid")
    directory = _directory(path.parent, receipt.get("directory_identity"))
    try:
        saved = _read(directory, _RECEIPT)
        ownership = _read(directory, _OWNERSHIP)
        if (canonical_sha256(saved) != canonical_sha256(receipt) or canonical_sha256(ownership) != canonical_sha256({
                "database": receipt.get("database"), "directory_identity": receipt.get("directory_identity"),
        })):
            raise BoundedSourcesError("bounded_sources_receipt_changed")
    finally:
        os.close(directory)
    with psycopg.connect(_connection_info("postgres"), autocommit=True) as connection:
        _check_database(connection, receipt["database"])
    return saved, path


def _live_window(database_url: str, scope: ContactScope, position: int) -> ExtractionWindow:
    messages = tuple(replace(message, occurred_at=bounded_source_occurred_at(message))
                     for message in load_contact_messages(scope, database_url))
    expected = ExtractionWindow(scope.owner_id, scope.contact_id, messages,
                               target_message_ids=tuple(message.message_id for message in messages))
    actual = _task_window(database_url, expected, BOUNDED_RUNTIME_CASES[position])
    projected = {"messages": list(BOUNDED_RUNTIME_INPUTS[position]["messages"]),
                 "target_indices": list(BOUNDED_RUNTIME_INPUTS[position]["target_indices"])}
    if bounded_window_projection(actual) != projected or any(
            not message.source_snapshots or any(source.get("processing_status") != "recorded"
                for source in message.source_snapshots) for message in actual.messages):
        raise BoundedSourcesError("bounded_sources_window_invalid")
    return actual


def _source_records(item: dict, owner_external: str, contact_external: str) -> list[dict]:
    records = []
    for index, message in enumerate(item["messages"]):
        at = datetime.fromisoformat(message["occurred_at"])
        own = message["sender"] == "self"
        records.append({
            "id": {"local_id": index + 1, "server_id_str": f"bounded-{index + 1}", "talker": contact_external},
            "create_time": int(at.timestamp()), "is_from_me": own, "kind": "text",
            "sender": "合成用户" if own else "合成联系人",
            "sender_wxid": owner_external if own else contact_external,
            "text": message["text"], "time": at.strftime("%Y-%m-%d %H:%M:%S"), "time_iso": at.isoformat(),
        })
    return records


def _prepare_case(database_url: str, owner: UUID, directory: Path, descriptor: int,
                  position: int) -> dict:
    item = BOUNDED_RUNTIME_INPUTS[position]
    contact = uuid4()
    scope = ContactScope(owner, contact)
    owner_external, contact_external = "wxid_bounded_owner_" + owner.hex, "wxid_bounded_contact_" + contact.hex
    with psycopg.connect(database_url) as connection:
        connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,%s)",
                           (owner, contact, "公开合成" + item["id"]))
    records = _source_records(item, owner_external, contact_external)
    binding_id = None
    repository = PostgresBackgroundTaskRepository(database_url)
    if item["source_route"] == "jsonl":
        filename = item["id"] + ".jsonl"
        content = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records).encode("utf-8")
        file = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(file, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.fsync(descriptor)
        document = normalize_document(read_jsonl(directory / filename))
        imported = PostgresIngestRepository(database_url).import_document(
            owner_id=owner, document=document,
            confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=contact)),
        )
        task_id, source_id = imported.task_id, imported.source_document_id
    else:
        binding = PostgresConversationBindingRepository(database_url).create_binding(
            owner_id=owner, contact_id=contact, channel="wechat", account_scope="bounded15-public-synthetic",
            conversation_locator=contact_external,
        )
        binding_id = binding.binding_id
        events = [{"type": "message", "cursor": f"bounded-cursor-{index + 1}", "message": record}
                  for index, record in enumerate(records)]
        external = subprocess.CompletedProcess(("synthetic-external-stdout",), 0,
            stdout="\n".join(json.dumps(event, ensure_ascii=False) for event in events), stderr="")
        tail = LocalWechatCli(runner=lambda command: external).tail(contact_external)
        if tail.last_local_id is None or tail.cursor is None:
            raise BoundedSourcesError("bounded_sources_observation_cursor_missing")
        processing: list = []
        messages = normalize_cli_events(tail.events, processing_receipts=processing)
        observed = PostgresObservationStore(database_url).record_batch_with_messages(
            owner_id=owner, contact_id=contact, binding_id=binding_id, mode=ObservationMode.CLI_BACKGROUND,
            cli_version="bounded15-synthetic-stdout", conversation_locator=contact_external,
            last_local_id=tail.last_local_id, last_cursor=tail.cursor, record_count=len(messages),
            event_count=tail.event_count, non_text_count=tail.non_text_count,
            messages=messages, processing_records=tuple(processing),
        )
        source_id = observed.observation.observation_id
        with psycopg.connect(database_url) as connection:
            task_id = repository.create_observation_task(connection, owner_id=owner, contact_id=contact,
                                                        message_count=len(messages))
    config = repository.configure_extraction_runtime(owner_id=owner, contact_id=contact,
        task_id=task_id, config=runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1))
    window = _live_window(database_url, scope, position)
    return _json_value({
        "case_id": item["id"], "position": position, "case_name": item["case_name"],
        "source_route": item["source_route"], "owner_id": owner, "contact_id": contact,
        "task_id": task_id, "runtime_config": config.to_payload(), "source_ids": [source_id],
        "binding_id": binding_id, "window": window, "window_sha256": canonical_sha256(window),
    })


def prepare_bounded_sources(directory: Path) -> dict:
    """只创建一次新的自有库及15正式来源；不领取任务或创建模型预算。"""
    directory = directory.absolute()
    descriptor = _directory(directory)
    database = None
    marker_set = False
    creation_attempted = False
    intent = None
    try:
        info = os.fstat(descriptor)
        identity = {"device": info.st_dev, "inode": info.st_ino}
        name, nonce = f"notalone_b15_{uuid4().hex}_test", uuid4().hex
        intent = {"name": name, "nonce": nonce, "directory_identity": identity}
        _publish(descriptor, "bounded-sources-intent.json", intent)
        with psycopg.connect(_connection_info("postgres"), autocommit=True) as admin:
            creation_attempted = True
            admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
            row = admin.execute("SELECT oid,datdba FROM pg_database WHERE datname=%s", (name,)).fetchone()
            if row is None:
                raise BoundedSourcesError("bounded_sources_database_identity_unknown")
            database = {"name": name, "oid": row[0], "datdba": row[1], "nonce": nonce, "owner_uid": os.getuid()}
            _publish(descriptor, _OWNERSHIP, {"database": database, "directory_identity": identity})
            admin.execute(sql.SQL("COMMENT ON DATABASE {} IS {}").format(sql.Identifier(name), sql.Literal(_marker(database))))
            marker_set = True
            admin.execute(sql.SQL("ALTER DATABASE {} SET timezone TO 'UTC'").format(sql.Identifier(name)))
        database_url = _connection_info(name)
        migrations = Path(__file__).resolve().parents[3] / "database/migrations"
        if len(tuple(migrations.glob("*.sql"))) != 72:
            raise BoundedSourcesError("bounded_sources_migration_set_changed")
        applied = migrate(database_url, migrations)
        owner = uuid4()
        with psycopg.connect(database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'公开合成评测用户')", (owner,))
            connection.execute("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES(%s,'wechat',%s,'公开合成用户')",
                               (owner, "wxid_bounded_owner_" + owner.hex))
        cases = [_prepare_case(database_url, owner, directory, descriptor, position) for position in range(15)]
        receipt = {
            "format_version": 1, "execution_plan": BOUNDED_RUNTIME_PLAN, "status": "prepared",
            "receipt_path": str(directory / _RECEIPT), "directory_identity": identity, "database": database,
            "owner_id": str(owner), "migrations": list(applied), "cases": cases,
            "bounded_inputs_sha256": canonical_sha256([{"messages": item["messages"], "target_indices": item["target_indices"]}
                                                      for item in BOUNDED_RUNTIME_INPUTS]),
            "windows_sha256": canonical_sha256([item["window"] for item in cases]),
        }
        _publish(descriptor, _RECEIPT, receipt)
        return receipt
    except Exception:
        # CREATE的返回也可能中断；没有取到OID时只保留原件，不能声称未创建或误删。
        status = ("creation_identity_unresolved" if creation_attempted else "not_created")
        if database is not None:
            status = "ownership_preserved"
        if database is not None:
            try:
                with psycopg.connect(_connection_info("postgres"), autocommit=True) as admin:
                    _check_database(admin, database, marker=marker_set)
                    admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(database["name"])))
                    if admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s", (database["name"],)).fetchone() == (0,):
                        status = "dropped_residual_zero"
            except Exception:
                status = "ownership_preserved"
        _publish(descriptor, "bounded-sources-prepare-failed.json", {"status": status, "database": database, "intent": intent})
        raise BoundedSourcesError("bounded_sources_prepare_failed") from None
    finally:
        os.close(descriptor)


def load_bounded_sources(receipt: dict) -> BoundedSources:
    """按原件和DB身份重读正式loader；不从保存JSON恢复来源信用。"""
    saved, path = _receipt(receipt)
    database_url = _connection_info(saved["database"]["name"])
    owner = UUID(saved["owner_id"])
    windows = []
    tasks = []
    if len(saved["cases"]) != 15:
        raise BoundedSourcesError("bounded_sources_case_set_changed")
    repository = PostgresBackgroundTaskRepository(database_url)
    for position, item in enumerate(saved["cases"]):
        scope = ContactScope(owner, UUID(item["contact_id"]))
        task_id = UUID(item["task_id"])
        task = repository.get_task(owner_id=owner, contact_id=scope.contact_id, task_id=task_id)
        window = _live_window(database_url, scope, position)
        source_ids = {str(source["source_id"]) for message in window.messages for source in message.source_snapshots}
        if (item["case_id"] != BOUNDED_RUNTIME_INPUTS[position]["id"] or item["position"] != position
                or item["owner_id"] != str(owner) or item["source_route"] != BOUNDED_RUNTIME_INPUTS[position]["source_route"]
                or task.extraction_runtime_config is None or task.extraction_runtime_config.to_payload() != item["runtime_config"]
                or source_ids != set(item["source_ids"]) or _json_value(window) != item["window"]
                or canonical_sha256(window) != item["window_sha256"]):
            raise BoundedSourcesError("bounded_sources_snapshot_changed")
        windows.append(window)
        tasks.append(task_id)
    if canonical_sha256(windows) != saved["windows_sha256"]:
        raise BoundedSourcesError("bounded_sources_snapshot_changed")
    return BoundedSources(database_url, tuple(windows), tuple(tasks), owner, path)


def _archive_snapshot(saved: dict, database_url: str) -> dict:
    from notalone.application.memory_service import MemoryService
    from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
    from notalone.server.app import create_app
    from notalone.server.testing import InProcessClient

    owner = UUID(saved["owner_id"])
    client = InProcessClient(create_app(database_url=database_url, owner_id=owner, token="bounded-source-local-archive",
        memory_service=MemoryService(contact_memory=PostgresMemoryStore(database_url),
                                     owner_memory=PostgresOwnerMemoryStore(database_url))))
    headers = {"Authorization": "Bearer bounded-source-local-archive"}
    traces = PostgresExtractionTraceStore(database_url)
    repository = PostgresBackgroundTaskRepository(database_url)
    cases = []
    for item in saved["cases"]:
        scope = ContactScope(owner, UUID(item["contact_id"]))
        task = repository.get_task(owner_id=owner, contact_id=scope.contact_id, task_id=UUID(item["task_id"]))
        path = f"/api/contacts/{scope.contact_id}/memory-candidates"
        response = client.get(path, headers=headers)
        if response.status_code != 200:
            raise BoundedSourcesError("bounded_sources_archive_api_failed")
        batches = traces.list_batches(scope, limit=500)
        if len(batches) == 500:
            raise BoundedSourcesError("bounded_sources_archive_trace_limit")
        cases.append({"case_id": item["case_id"], "task": _json_value(task),
                      "memory_api": {"path": path, "status_code": response.status_code, "body": response.json()},
                      "traces": [traces.get_batch(scope, batch["trace_id"]) for batch in batches]})
    response = client.get("/api/memories/owner", headers=headers)
    if response.status_code != 200:
        raise BoundedSourcesError("bounded_sources_archive_api_failed")
    return {"cases": cases, "owner_memory_api": {"status_code": response.status_code, "body": response.json()}}


def _residual_counts(saved: dict, database_url: str) -> dict[str, int]:
    owner = UUID(saved["owner_id"])
    counts = {}
    tables = ("message", "message_source_ref", "local_wechat_observation", "memory_candidate", "confirmed_memory",
              "owner_memory", "reply_request", "reply_context_evidence", "reply_candidate")
    with psycopg.connect(database_url) as connection:
        for table in tables:
            counts[table] = _count(connection, sql.SQL("SELECT count(*) FROM public.{} WHERE owner_id=%s").format(
                sql.Identifier(table)), (owner,))
        for table, predicate in (("source_document", "status<>'deleted'"),
                ("source_processing_record", "payload IS NOT NULL"),
                ("memory_extraction_trace_event", "payload IS NOT NULL")):
            counts[table] = _count(connection, sql.SQL("SELECT count(*) FROM public.{} WHERE owner_id=%s AND " + predicate).format(
                sql.Identifier(table)), (owner,))
    counts["loader_messages"] = sum(len(load_contact_messages(ContactScope(owner, UUID(item["contact_id"])), database_url))
                                    for item in saved["cases"])
    return counts


def _count(connection: psycopg.Connection, query: sql.SQL | sql.Composed | str, parameters: tuple) -> int:
    row = connection.execute(query, parameters).fetchone()
    if row is None or type(row[0]) is not int:
        raise BoundedSourcesError("bounded_sources_count_invalid")
    return row[0]


def cleanup_bounded_sources(receipt: dict, *, archive_directory: Path) -> dict:
    """先归档、正式来源删除并核残留，再删除精确自有库；不强停连接。"""
    saved, _ = _receipt(receipt)
    archive_directory = archive_directory.absolute()
    descriptor = _directory(archive_directory)
    try:
        database_url = _connection_info(saved["database"]["name"])
        snapshot = _archive_snapshot(saved, database_url)
        safe, removed = _redact(_json_value(snapshot))
        archive = {"format_version": 1, "execution_plan": BOUNDED_RUNTIME_PLAN,
                   "source_receipt_sha256": canonical_sha256(saved), "original_snapshot_sha256": canonical_sha256(snapshot),
                   "snapshot": safe, "removed_paths": removed}
        filename = "bounded-sources-archive.json"
        _publish(descriptor, filename, archive)
        for item in saved["cases"]:
            scope = ContactScope(UUID(item["owner_id"]), UUID(item["contact_id"]))
            for source in item["source_ids"]:
                if item["source_route"] == "jsonl":
                    deletion = PostgresSourceDeletionRepository(database_url)
                    deletion.delete_source(owner_id=scope.owner_id, contact_id=scope.contact_id, source_document_id=UUID(source))
                    deletion.verify_deleted(owner_id=scope.owner_id, contact_id=scope.contact_id, source_document_id=UUID(source))
                else:
                    PostgresObservationStore(database_url).delete_observation(
                        owner_id=scope.owner_id, contact_id=scope.contact_id, observation_id=UUID(source))
        counts = _residual_counts(saved, database_url)
        if any(counts.values()):
            _publish(descriptor, "bounded-sources-cleanup-failed.json", {"status": "residual_unresolved", "residual_counts": counts})
            raise BoundedSourcesError("bounded_sources_cleanup_residual")
        with psycopg.connect(_connection_info("postgres"), autocommit=True) as admin:
            _check_database(admin, saved["database"])
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(saved["database"]["name"])))
            residual = _count(admin, "SELECT count(*) FROM pg_database WHERE datname=%s", (saved["database"]["name"],))
            if residual != 0:
                raise BoundedSourcesError("bounded_sources_drop_unresolved")
        close = {"format_version": 1, "execution_plan": BOUNDED_RUNTIME_PLAN, "status": "closed",
                 "source_receipt_sha256": canonical_sha256(saved), "database": saved["database"],
                 "archive_path": str(archive_directory / filename), "archive_sha256": canonical_sha256(archive),
                 "residual_counts": counts, "database_residual": residual}
        _publish(descriptor, "bounded-sources-close.json", close)
        return close
    finally:
        os.close(descriptor)


def _lifecycle_archive(descriptor: int, directory: Path, name: str, snapshot: dict) -> dict:
    safe, removed = _redact(_json_value(snapshot))
    archived = {"original_snapshot_sha256": canonical_sha256(snapshot), "snapshot": safe, "removed_paths": removed}
    _publish(descriptor, name, archived)
    return {"path": str(directory / name), "sha256": canonical_sha256(archived)}


def verify_bounded_lifecycle(receipt: dict, *, archive_directory: Path) -> dict:
    """仅验本场P01/P06/P02实际代表；全15质量及交付准入由调用方先核。"""
    from notalone.application.memory_service import MemoryService
    from notalone.memory import FactSubject, MemoryCandidateStatus, SourceDependencyMode
    from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence
    from notalone.persistence.memory_store import PostgresMemoryStore
    from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
    from notalone.server.app import create_app
    from notalone.server.testing import InProcessClient
    from psycopg.rows import dict_row

    saved, _ = _receipt(receipt)
    archive_directory = archive_directory.absolute()
    descriptor = _directory(archive_directory)
    database_url = _connection_info(saved["database"]["name"])
    owner = UUID(saved["owner_id"])
    store, owner_store = PostgresMemoryStore(database_url), PostgresOwnerMemoryStore(database_url)
    client = InProcessClient(create_app(database_url=database_url, owner_id=owner, token="bounded-lifecycle-local",
        memory_service=MemoryService(contact_memory=store, owner_memory=owner_store)))
    headers = {"Authorization": "Bearer bounded-lifecycle-local"}
    result: dict[str, Any] = {
        "execution_plan": BOUNDED_RUNTIME_PLAN, "source_receipt_sha256": canonical_sha256(saved),
        "status": "unrun", "reason_code": "representative_not_unique", "representatives": [], "checks": [],
        "quality_certified": False,
    }
    try:
        before = _archive_snapshot(saved, database_url)
        result["before_archive"] = _lifecycle_archive(descriptor, archive_directory, "bounded-lifecycle-before.json", before)
        selected = []
        untouched = {}
        for identifier, subject, rule in (("P01", FactSubject.CONTACT, "BR_AUTHOR_ARRIVAL_V1"),
                ("P06", FactSubject.SELF, "BR_REQUEST_V1"), ("P02", FactSubject.CONTACT, "BR_KIN_LEND_V1")):
            item, = [item for item in saved["cases"] if item["case_id"] == identifier]
            scope = ContactScope(owner, UUID(item["contact_id"]))
            pending = store.list_pending_candidates(scope)
            qualified = []
            for candidate in pending:
                evidence = candidate.dimension_evidence
                if (candidate.subject is subject and candidate.source_dependency_mode is SourceDependencyMode.ALL
                        and evidence is not None and evidence.version == 4 and evidence.semantic_basis is not None
                        and evidence.semantic_basis.to_payload()["version"] == 3
                        and evidence.semantic_basis.to_payload()["rules"] == [{"rule_id": rule, "rule_version": 1}]):
                    qualified.append(candidate)
            if len(qualified) != 1:
                result["reason_code"] = "representative_evidence_missing" if pending and not qualified else "representative_not_unique"
                result["unrun_case_id"] = identifier
                break
            candidate, = qualified
            evidence = candidate.dimension_evidence
            with psycopg.connect(database_url, row_factory=dict_row) as connection:
                current = bind_stored_dimension_evidence(connection, candidate, lock_sources=True)
            if evidence is None or current is None or not current.source_bound or current.to_payload() != evidence.to_payload():
                result.update(status="fail", reason_code="representative_source_rebind_failed")
                break
            selected.append((identifier, scope, candidate))
            untouched[identifier] = {str(item.candidate_id): item for item in pending
                                    if item.candidate_id != candidate.candidate_id}
        if len(selected) == 3:
            for identifier, scope, candidate in selected:
                assert candidate.dimension_evidence is not None
                result["representatives"].append({"case_id": identifier, "candidate_id": str(candidate.candidate_id),
                    "source_message_ids": [str(value) for value in candidate.source_ids],
                    "evidence_sha256": canonical_sha256(candidate.dimension_evidence.to_payload())})
                result["checks"].append({"operation": "current_source_rebind", "case_id": identifier, "status": "passed"})
            try:
                for identifier, scope, candidate in selected[:2]:
                    path = f"/api/contacts/{scope.contact_id}/memory-candidates/{candidate.candidate_id}/confirm"
                    response = client.request("POST", path, headers=headers)
                    confirmation = response.json()
                    if (response.status_code != 200 or type(confirmation) is not dict
                            or type(confirmation.get("memory")) is not dict):
                        raise BoundedSourcesError("bounded_lifecycle_confirm_failed")
                    memory = confirmation["memory"]
                    sources = [str(value) for value in candidate.source_ids]
                    if (memory["source_ids"] != sources or memory["source_dependency_mode"] != "all"
                            or memory["adoption_method"] != "manual" or memory["revision"] != 1
                            or (memory.get("level") == "owner") != (identifier == "P06")):
                        raise BoundedSourcesError("bounded_lifecycle_confirm_inheritance_failed")
                    result["checks"].append({"operation": "manual_owner_confirm" if identifier == "P06" else "manual_contact_confirm",
                        "case_id": identifier, "status": "passed", "path": path, "api": confirmation})
                    corrected_text = candidate.text + "（人工复核的公开合成记录）"
                    path = (f"/api/memories/owner/{memory['memory_id']}/correct" if identifier == "P06"
                            else f"/api/contacts/{scope.contact_id}/memories/{memory['memory_id']}/correct")
                    response = client.request("POST", path, headers=headers,
                                              body=json.dumps({"text": corrected_text}, ensure_ascii=False).encode())
                    correction = response.json()
                    if (response.status_code != 200 or type(correction) is not dict
                            or type(correction.get("memory")) is not dict):
                        raise BoundedSourcesError("bounded_lifecycle_correct_failed")
                    corrected = correction["memory"]
                    if (corrected["source_ids"] != sources or corrected["source_dependency_mode"] != "all"
                            or corrected["adoption_method"] != "manual" or corrected["revision"] != 2
                            or corrected["text"] != corrected_text or corrected["supersedes_memory_id"] != memory["memory_id"]
                            or "dimension_evidence" in corrected or "dimension_evidence_source_current" in corrected):
                        raise BoundedSourcesError("bounded_lifecycle_correct_inheritance_failed")
                    result["checks"].append({"operation": "owner_revision_inherits_sources" if identifier == "P06" else "contact_revision_inherits_sources",
                        "case_id": identifier, "status": "passed", "path": path, "api": correction,
                        "proof_credit": "none_manual_revision"})
                identifier, scope, candidate = selected[2]
                path = f"/api/contacts/{scope.contact_id}/memory-candidates/{candidate.candidate_id}/discard"
                response = client.request("POST", path, headers=headers)
                if response.status_code != 200:
                    raise BoundedSourcesError("bounded_lifecycle_discard_failed")
                rejected = store.get_candidate(scope=scope, candidate_id=candidate.candidate_id)
                with psycopg.connect(database_url, row_factory=dict_row) as connection:
                    rows = connection.execute("SELECT id,status,source_dependency_mode,source_ids FROM public.confirmed_memory "
                        "WHERE owner_id=%s AND contact_id=%s AND source_candidate_id=%s",
                        (owner, scope.contact_id, candidate.candidate_id)).fetchall()
                if (rejected.status is not MemoryCandidateStatus.REJECTED or rejected.dimension_evidence is not None
                        or rejected.source_dependency_mode is not SourceDependencyMode.ALL or rejected.source_ids != candidate.source_ids
                        or candidate.text not in store.deleted_texts(scope)
                        or candidate.candidate_id in {item.candidate_id for item in store.list_pending_candidates(scope)}
                        or len(rows) != 1 or rows[0]["status"] != "deleted"
                        or rows[0]["source_dependency_mode"] != "all" or rows[0]["source_ids"] != list(candidate.source_ids)):
                    raise BoundedSourcesError("bounded_lifecycle_fingerprint_failed")
                result["checks"].append({"operation": "rejection_fingerprint_lookup", "case_id": identifier,
                    "status": "passed", "path": path, "api": response.json(), "fingerprint": _json_value(rows[0]),
                    "verification": "实际deleted_texts命中且被拒ID不再pending；未重新调用模型"})
                preserved, guarded = {}, {}
                for identifier, scope, candidate in selected:
                    preserved[identifier], guarded[identifier] = 0, 0
                    for pending_id, original in untouched[identifier].items():
                        remaining = store.get_candidate(scope=scope, candidate_id=UUID(pending_id))
                        if canonical_sha256(remaining) == canonical_sha256(original):
                            preserved[identifier] += 1
                            continue
                        # 同窗口人工拒绝后，现行更正门可保守撤下旧候选；不把此状态变化伪报为仍待确认。
                        guarded_original = replace(remaining, status=original.status,
                            failure_reason=original.failure_reason, correction_review=original.correction_review)
                        if (remaining.status is not MemoryCandidateStatus.INVALIDATED
                                or remaining.failure_reason != "correction:old_evidence"
                                or canonical_sha256(guarded_original) != canonical_sha256(original)):
                            raise BoundedSourcesError("bounded_lifecycle_other_pending_changed")
                        guarded[identifier] += 1
                result["preserved_other_pending"] = preserved
                result["guarded_other_candidates"] = guarded
                result.update(status="passed", reason_code="representative_lifecycle_verified")
            except Exception as error:
                result.update(status="fail", reason_code="representative_lifecycle_failed", failure_kind=type(error).__name__)
        result["after_archive"] = _lifecycle_archive(descriptor, archive_directory, "bounded-lifecycle-after.json",
                                                       _archive_snapshot(saved, database_url))
        _publish(descriptor, "bounded-lifecycle-result.json", result)
        return result
    finally:
        os.close(descriptor)
