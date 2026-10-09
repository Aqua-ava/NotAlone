"""合成资料的外部索引生命周期；与业务删除入口隔离。"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

from notalone.experiments.hindsight_adapter import HindsightRetrieval
from notalone.experiments.hindsight_client import (
    HindsightFailure,
    HindsightHttpClient,
    HindsightHttpFailure,
    bank_id_for,
    document_id_for,
)
from notalone.experiments.hindsight_lifecycle_db import LifecycleDatabase
from notalone.experiments.hindsight_runtime import DEFAULT_RUNTIME, start, stop
from notalone.memory import (
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.retrieval import InMemoryRetrieval
from notalone.scopes import ContactScope, VerifiedConversationScope


@dataclass(slots=True)
class SyntheticMemoryStore(InMemoryMemoryStore):
    """明确的合成权威快照，用于来源/revision/时间边界实验。

    普通修正/删除继续使用原有公开方法；快照替换不证明业务来源删除接线。
    """

    snapshots: dict[UUID, ConfirmedMemory] = field(default_factory=dict)

    def set_snapshot(self, memory: ConfirmedMemory) -> None:
        self.snapshots[memory.memory_id] = memory

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        original = super(SyntheticMemoryStore, self).list_confirmed(scope)
        merged = {memory.memory_id: memory for memory in original}
        merged.update(
            {
                key: value
                for key, value in self.snapshots.items()
                if value.scope == scope
            }
        )
        return tuple(memory for memory in merged.values() if memory.is_retrievable())


def memory_item(memory: ConfirmedMemory) -> dict[str, object]:
    return {
        "content": memory.text,
        "document_id": document_id_for(memory.memory_id),
        "timestamp": "unset",
        "update_mode": "replace",
        "metadata": {
            "local_memory_id": str(memory.memory_id),
            "owner_id": str(memory.scope.owner_id),
            "contact_id": str(memory.scope.contact_id),
            "layer": "confirmed_memory",
            "revision": str(memory.revision),
            "source_ids": ",".join(str(source) for source in memory.source_ids),
        },
    }


def sync_memory(
    *,
    client: HindsightHttpClient,
    scope: ContactScope,
    memory_id: UUID,
    memory: ConfirmedMemory | None,
) -> dict[str, object]:
    """先遵循本地支持规则；无当前支持才清除整个外部 document。"""

    if memory is not None and (memory.scope != scope or memory.memory_id != memory_id):
        raise ValueError("索引写入的本地身份与范围不一致。")
    started = time.perf_counter()
    if memory is None or not memory.is_retrievable() or not memory.source_ids:
        result = client.delete_document(
            bank_id=bank_id_for(scope), document_id=document_id_for(memory_id)
        )
        return {
            **result,
            "experiment_elapsed_ms": (time.perf_counter() - started) * 1000,
        }
    result = client.retain(bank_id=bank_id_for(scope), items=[memory_item(memory)])
    if result.get("success") is not True or result.get("async") is not False:
        raise HindsightFailure("同步 retain 未获明确完成响应。")
    return {**result, "experiment_elapsed_ms": (time.perf_counter() - started) * 1000}


def _add(
    store: SyntheticMemoryStore,
    scope: ContactScope,
    text: str,
    sources: tuple[UUID, ...],
) -> ConfirmedMemory:
    candidate = MemoryCandidate(
        uuid4(), scope, text, MemoryCategory.PREFERENCE, sources
    )
    store.create_candidate(candidate)
    return store.confirm(scope=scope, candidate_id=candidate.candidate_id)


def _context(
    store: SyntheticMemoryStore,
    scope: ContactScope,
    client: HindsightHttpClient,
    query: str,
) -> dict[str, Any]:
    binding = uuid4()
    adapter = HindsightRetrieval(
        local=InMemoryRetrieval(memory_store=store), client=client, tau=0.003
    )
    builder = RetrievalReplyContext(retrieval=adapter, skill_library_revision=0)
    context = builder.build(
        command=GenerateReply(
            uuid4(),
            scope,
            binding,
            RewriteDraft(query, include_relationship_context=True),
        ),
        verified_scope=VerifiedConversationScope(
            scope.owner_id, scope.contact_id, binding
        ),
    )
    builder.validate_current(context)
    if adapter.last_attempt.status != "success":
        raise HindsightFailure(
            "真实生命周期 Context 检索失败：" + adapter.last_attempt.error
        )
    return {
        "selected": [
            {
                "id": str(item.evidence_id),
                "text": item.text,
                "source_ids": [str(source) for source in item.source_ids],
                "revision": item.revision,
            }
            for item in context.evidence
            if item.kind == "confirmed_memory"
        ],
        "attempt": asdict(adapter.last_attempt),
    }


def _ids(context: dict[str, Any]) -> set[str]:
    selected = context["selected"]
    assert isinstance(selected, list)
    return {item["id"] for item in selected}


def _document_api(
    client: HindsightHttpClient, bank: str, document_id: str
) -> dict[str, dict[str, object]]:
    path = client.bank_path(bank) + "/documents/" + quote(document_id, safe="")
    result: dict[str, dict[str, object]] = {}
    for name, suffix in (("document", ""), ("chunks", "/chunks?limit=1000&offset=0")):
        try:
            result[name] = {
                "http_status": 200,
                "body": client.request("GET", path + suffix),
            }
        except HindsightHttpFailure as exc:
            if exc.status != 404:
                raise
            result[name] = {"http_status": 404}
    return result


def _units(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    units = snapshot["units"]
    assert isinstance(units, list)
    return units


def _empty_document(snapshot: dict[str, object]) -> bool:
    return all(
        snapshot[name] == [] for name in ("documents", "chunks", "units", "archive")
    )


def run_lifecycle(*, runtime: Path) -> dict[str, Any]:
    """每次只创建和管理本轮三个随机合成 bank；串行独占外部服务。"""

    scope = ContactScope(uuid4(), uuid4())
    other_contact = ContactScope(scope.owner_id, uuid4())
    other_owner = ContactScope(uuid4(), scope.contact_id)
    scopes = (scope, other_contact, other_owner)
    banks = frozenset(bank_id_for(item) for item in scopes)
    client = HindsightHttpClient(
        base_url="http://127.0.0.1:18888",
        log_path=runtime / "service.log",
        allowed_bank_ids=banks,
    )
    database = LifecycleDatabase(banks)
    store = SyntheticMemoryStore()
    sources = (uuid4(), uuid4())
    target = _add(store, scope, "合成乳糖限制：对方乳糖不耐受。", sources)
    control = _add(store, scope, "合成控制记忆：对方喜欢周末爬山。", (uuid4(),))
    foreign_contact = replace(target, scope=other_contact)
    foreign_owner = replace(target, scope=other_owner)
    cases: list[dict[str, object]] = []
    result: dict[str, Any] = {
        "kind": "synthetic_lifecycle_only",
        "status": "running",
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "banks_allowlist": sorted(banks),
        "scope": {"owner_id": str(scope.owner_id), "contact_id": str(scope.contact_id)},
        "tau_B": 0.003,
        "tau_status": "临时接入阈值，不用于收益验收",
        "fixtures": [
            memory_item(memory)
            for memory in (target, control, foreign_contact, foreign_owner)
        ],
        "cases": cases,
        "limitations": [
            "只证明活动 SQL/向量列/服务可检索副本的清除，不证明 MVCC、WAL、索引死元组、备份或介质物理擦除。",
            "来源/revision 更新由声明的合成权威快照模拟；未连接业务来源删除任务。实际 correct/delete 使用现有内存公开方法。",
            "重排故障与竞态使用外部边界替身，真实生命周期结果不是泛化召回收益。",
        ],
    }

    def check(name: str, passed: bool, evidence: object) -> None:
        cases.append({"name": name, "passed": passed, "evidence": evidence})
        if not passed:
            raise HindsightFailure("生命周期验收失败：" + name)

    def raw(bank: str, query: str) -> dict[str, Any]:
        return asdict(client.recall(bank_id=bank, query=query))

    def contains(raw_result: dict[str, Any], memory: ConfirmedMemory) -> bool:
        return any(
            hit["metadata"].get("local_memory_id") == str(memory.memory_id)
            for hit in raw_result["hits"]
        )

    try:
        result["initial_health"] = client.request("GET", "/health")
        result["database_environment"] = database.environment()
        for bank in sorted(banks):
            config = client.create_bank(bank)
            initial = client.request(
                "GET", client.bank_path(bank) + "/memories/list?limit=1"
            )
            mental = client.request("GET", client.bank_path(bank) + "/mental-models")
            resolved = config.get("config")
            check(
                "新 bank 空且禁止归纳 " + bank,
                isinstance(resolved, dict)
                and resolved.get("retain_extraction_mode") == "chunks"
                and resolved.get("enable_auto_consolidation") is False
                and initial.get("total") == 0
                and mental.get("items") == [],
                {"config": config, "initial": initial, "mental_models": mental},
            )
            empty_recall = raw(bank, "新建空 bank 合成查询")
            check(
                "同次完成诊断证明真实空结果 " + bank,
                not empty_recall["hits"],
                empty_recall,
            )
        initial_retain = []
        for memory in (target, control, foreign_contact, foreign_owner):
            response = sync_memory(
                client=client,
                scope=memory.scope,
                memory_id=memory.memory_id,
                memory=memory,
            )
            initial_retain.append(
                {
                    "bank_id": bank_id_for(memory.scope),
                    "memory_id": str(memory.memory_id),
                    "response": response,
                }
            )
        result["initial_retain"] = initial_retain
        bank = bank_id_for(scope)
        document = document_id_for(target.memory_id)
        control_document = document_id_for(control.memory_id)
        controls = {
            (bank, control_document): database.document(bank, control_document),
            (bank_id_for(other_contact), document): database.document(
                bank_id_for(other_contact), document
            ),
            (bank_id_for(other_owner), document): database.document(
                bank_id_for(other_owner), document
            ),
        }
        before = database.document(bank, document)
        old_ids = tuple(str(unit["id"]) for unit in _units(before))
        initial_raw = raw(bank, target.text)
        initial_context = _context(store, scope, client, target.text)
        check(
            "删除前原始召回和 Context 均有正例",
            contains(initial_raw, target)
            and str(target.memory_id) in _ids(initial_context)
            and all(
                unit["has_embedding"] and unit["dimensions"] == 512
                for unit in _units(before)
            )
            and bool(old_ids),
            {"database": before, "recall": initial_raw, "context": initial_context},
        )
        for foreign in (foreign_contact, foreign_owner):
            recall = raw(bank_id_for(foreign.scope), target.text)
            check(
                "独立范围有同正文同 document 正例 " + bank_id_for(foreign.scope),
                contains(recall, foreign),
                recall,
            )
        repeated_retain = sync_memory(
            client=client, scope=scope, memory_id=target.memory_id, memory=target
        )
        check(
            "相同 retain 重试不增文档或单元",
            database.document(bank, document) == before,
            {
                "response": repeated_retain,
                "database": database.document(bank, document),
            },
        )

        # 一条记忆有两个支持来源，删除一个来源后仍有效。
        remaining = replace(target, source_ids=(sources[1],), revision=2)
        store.set_snapshot(remaining)
        update_response = sync_memory(
            client=client, scope=scope, memory_id=target.memory_id, memory=remaining
        )
        metadata_only = database.document(bank, document)
        metadata_context = _context(store, scope, client, target.text)
        check(
            "多来源删除一个后保留资料并刷新全部 metadata",
            bool(_units(metadata_only))
            and all(
                unit["metadata"].get("revision") == "2"
                and unit["metadata"].get("source_ids") == str(sources[1])
                for unit in _units(metadata_only)
            )
            and str(target.memory_id) in _ids(metadata_context),
            {
                "response": update_response,
                "database": metadata_only,
                "context": metadata_context,
                "unit_ids_preserved": old_ids
                == tuple(str(unit["id"]) for unit in _units(metadata_only)),
            },
        )
        changed = replace(
            remaining, text="合成乳糖更新：对方现在选择无糖豆奶。", revision=3
        )
        store.set_snapshot(changed)
        content_response = sync_memory(
            client=client, scope=scope, memory_id=target.memory_id, memory=changed
        )
        content_snapshot = database.document(bank, document)
        changed_context = _context(store, scope, client, changed.text)
        old_ids += tuple(str(unit["id"]) for unit in _units(content_snapshot))
        check(
            "同 document changed chunk 刷新正文和 revision",
            bool(_units(content_snapshot))
            and all(
                unit["metadata"].get("revision") == "3"
                and target.text not in str(unit["text"])
                for unit in _units(content_snapshot)
            )
            and str(target.memory_id) in _ids(changed_context),
            {
                "response": content_response,
                "database": content_snapshot,
                "context": changed_context,
            },
        )
        repeated_update = sync_memory(
            client=client, scope=scope, memory_id=target.memory_id, memory=changed
        )
        check(
            "更新重试幂等",
            database.document(bank, document) == content_snapshot,
            {
                "response": repeated_update,
                "database": database.document(bank, document),
            },
        )

        # 所有 retain 均为同步完成且没有后台生产者；最后来源消失才删除 document。
        operations = database.operations(bank)
        check(
            "同步 retain 完成且无未终结 retain 生产者",
            all(
                "retain" not in item["operation_type"].casefold()
                or item["status"] in ("completed", "cancelled")
                for item in operations
            ),
            {
                "operations": operations,
                "mode": "同步、串行且本轮是唯一生产者；runtime worker=false",
            },
        )
        store.set_snapshot(
            replace(changed, status=ConfirmedMemoryStatus.DELETED, revision=4)
        )
        deleted = sync_memory(
            client=client, scope=scope, memory_id=target.memory_id, memory=None
        )
        repeated = sync_memory(
            client=client, scope=scope, memory_id=target.memory_id, memory=None
        )
        api = _document_api(client, bank, document)
        absent = database.document(bank, document)
        absent_ids = database.absent_ids(bank, old_ids)
        check(
            "最后来源删除后 API/SQL/向量单元/archive 清除且可重试",
            deleted.get("success") is True
            and repeated.get("http_status") == 404
            and all(value["http_status"] == 404 for value in api.values())
            and _empty_document(absent)
            and all(value == [] for value in absent_ids.values()),
            {
                "delete": deleted,
                "retry": repeated,
                "api": api,
                "database": absent,
                "old_unit_ids": absent_ids,
            },
        )
        for attempt in range(2):
            recall = raw(bank, target.text)
            context = _context(store, scope, client, control.text)
            check(
                "同实例缓存再次查询无已删资料 " + str(attempt),
                not contains(recall, target)
                and str(target.memory_id) not in _ids(context)
                and str(control.memory_id) in _ids(context),
                {
                    "recall": recall,
                    "context": context,
                    "list": client.request(
                        "GET", client.bank_path(bank) + "/memories/list?limit=100"
                    ),
                },
            )
        check(
            "文档删除不影响同 bank 及其他 owner/contact 控制组",
            all(
                database.document(control_bank, control_doc) == snapshot
                for (control_bank, control_doc), snapshot in controls.items()
            ),
            {
                control_bank
                + "/"
                + control_doc: database.document(control_bank, control_doc)
                for control_bank, control_doc in controls
            },
        )

        single = _add(store, scope, "合成单来源：对方周四练瑜伽。", (uuid4(),))
        sync_memory(
            client=client, scope=scope, memory_id=single.memory_id, memory=single
        )
        single_before = _context(store, scope, client, single.text)
        store.delete(scope=scope, memory_id=single.memory_id)
        stale_single = _context(store, scope, client, single.text)
        single_delete = sync_memory(
            client=client, scope=scope, memory_id=single.memory_id, memory=None
        )
        check(
            "单来源整条删除：先本地拒绝再外部清除",
            str(single.memory_id) in _ids(single_before)
            and str(single.memory_id) not in _ids(stale_single)
            and _empty_document(
                database.document(bank, document_id_for(single.memory_id))
            ),
            {
                "before": single_before,
                "stale_external": stale_single,
                "delete": single_delete,
            },
        )

        original = _add(store, scope, "合成修正前：对方周日打羽毛球。", (uuid4(),))
        sync_memory(
            client=client, scope=scope, memory_id=original.memory_id, memory=original
        )
        corrected = store.correct(
            scope=scope,
            memory_id=original.memory_id,
            text="合成修正后：对方周日改练游泳。",
        )
        stale_correct = _context(store, scope, client, original.text)
        sync_memory(
            client=client, scope=scope, memory_id=original.memory_id, memory=None
        )
        sync_memory(
            client=client, scope=scope, memory_id=corrected.memory_id, memory=corrected
        )
        corrected_context = _context(store, scope, client, corrected.text)
        check(
            "真实 correct 生成新本地 ID 且旧外部命中无效",
            corrected.memory_id != original.memory_id
            and str(original.memory_id) not in _ids(stale_correct)
            and str(corrected.memory_id) in _ids(corrected_context)
            and _empty_document(
                database.document(bank, document_id_for(original.memory_id))
            ),
            {
                "old_id": str(original.memory_id),
                "new_id": str(corrected.memory_id),
                "stale_context": stale_correct,
                "current_context": corrected_context,
            },
        )
        rebuilt_before = database.document(bank, document_id_for(corrected.memory_id))
        client.delete_document(
            bank_id=bank, document_id=document_id_for(corrected.memory_id)
        )
        rebuild_response = sync_memory(
            client=client, scope=scope, memory_id=corrected.memory_id, memory=corrected
        )
        rebuilt = database.document(bank, document_id_for(corrected.memory_id))
        sync_memory(
            client=client, scope=scope, memory_id=corrected.memory_id, memory=corrected
        )
        rebuilt_context = _context(store, scope, client, corrected.text)
        check(
            "删除后重建及重建重试仍只有当前副本",
            len(rebuilt["documents"]) == len(rebuilt_before["documents"]) == 1
            and len(_units(rebuilt)) == len(_units(rebuilt_before))
            and rebuilt == database.document(bank, document_id_for(corrected.memory_id))
            and str(corrected.memory_id) in _ids(rebuilt_context),
            {
                "response": rebuild_response,
                "database": rebuilt,
                "context": rebuilt_context,
            },
        )

        previous_pid = (runtime / "service.pid").read_text().strip()
        restart_started = time.perf_counter()
        stop(runtime)
        start(runtime)
        deadline = time.monotonic() + 45
        while True:
            try:
                health = client.request("GET", "/health")
                break
            except HindsightFailure:
                if time.monotonic() >= deadline:
                    raise HindsightFailure("重启后健康前提未满足。")
                time.sleep(0.25)
        restart_to_health_ms = (time.perf_counter() - restart_started) * 1000
        after_restart = raw(bank, target.text)
        restart_context = _context(store, scope, client, control.text)
        check(
            "重启同一持久库后已删资料仍不可检索且控制正例存在",
            not contains(after_restart, target)
            and _empty_document(database.document(bank, document))
            and str(control.memory_id) in _ids(restart_context)
            and all(
                database.document(control_bank, control_doc) == snapshot
                for (control_bank, control_doc), snapshot in controls.items()
            ),
            {
                "previous_pid": previous_pid,
                "new_pid": (runtime / "service.pid").read_text().strip(),
                "health": health,
                "restart_to_health_ms": restart_to_health_ms,
                "api": _document_api(client, bank, document),
                "recall": after_restart,
                "context": restart_context,
            },
        )
        bank_before = database.bank(bank)
        delete_bank = client.delete_bank(bank)
        try:
            client.request("GET", client.bank_path(bank) + "/export")
            bank_api_status = 200
        except HindsightHttpFailure as exc:
            if exc.status != 404:
                raise
            bank_api_status = 404
        bank_after = database.bank(
            bank, previous_internal_id=bank_before["internal_id"]
        )
        check(
            "联系人 bank 清除所有活动表与作用域向量索引",
            delete_bank.get("success") is True
            and bank_api_status == 404
            and all(count == 0 for count in bank_after["counts"].values())
            and bank_after["indexes"] == [],
            {
                "before": bank_before,
                "delete": delete_bank,
                "after": bank_after,
                "bank_export_http_status": bank_api_status,
            },
        )
        foreign_evidence = {}
        for foreign in (foreign_contact, foreign_owner):
            foreign_bank = bank_id_for(foreign.scope)
            foreign_recall = raw(foreign_bank, target.text)
            foreign_evidence[foreign_bank] = {
                "database": database.document(foreign_bank, document),
                "recall": foreign_recall,
            }
            check(
                "bank 删除不影响外范围正例 " + foreign_bank,
                contains(foreign_recall, foreign)
                and database.document(foreign_bank, document)
                == controls[(foreign_bank, document)],
                foreign_evidence[foreign_bank],
            )
        for foreign in (foreign_contact, foreign_owner):
            foreign_bank = bank_id_for(foreign.scope)
            foreign_before = database.bank(foreign_bank)
            client.delete_bank(foreign_bank)
            foreign_after = database.bank(
                foreign_bank, previous_internal_id=foreign_before["internal_id"]
            )
            check(
                "清理 allowlist 控制 bank " + foreign_bank,
                all(count == 0 for count in foreign_after["counts"].values())
                and foreign_after["indexes"] == [],
                foreign_after,
            )
        result["final_health"] = client.request("GET", "/health")
        api_pid = (runtime / "service.pid").read_text().strip()
        result["resource_observation"] = {
            "timing": "本轮运行后单点观测，不是整轮峰值",
            "api_ps_pid_cpu_percent_rss_kib_elapsed": subprocess.check_output(
                ["ps", "-p", api_pid, "-o", "pid=,%cpu=,rss=,etime="], text=True
            ).strip(),
            "database_model_disk_kib": subprocess.check_output(
                ["du", "-sk", str(runtime / "database"), str(runtime / "models")],
                text=True,
            ).strip(),
        }
        result["status"] = "passed"
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="只用新建合成资料验证真实 Hindsight 生命周期。"
    )
    parser.add_argument("--runtime-dir", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    development_runs = []
    if args.output.exists():
        previous = json.loads(args.output.read_text())
        development_runs = previous.get("development_runs", [])
        if previous.get("status") == "failed":
            development_runs.append(
                {
                    "status": previous["status"],
                    "error": previous.get("error"),
                    "cases": previous["cases"],
                    "banks_allowlist": previous["banks_allowlist"],
                }
            )
    result = run_lifecycle(runtime=args.runtime_dir)
    result["development_runs"] = development_runs
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n"
    )
    print(
        json.dumps(
            {
                "status": result["status"],
                "cases": len(result["cases"]),
                "error": result.get("error"),
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    if result["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
