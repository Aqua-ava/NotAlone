"""联系人主题资料的短事务边界；模型调用不占数据库事务。"""

from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
from uuid import UUID, uuid4, uuid5

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.memory.layered import (
    LayeredMemoryConflict, OrganizationInput, LayeredMemorySnapshot, ScenarioDirectoryEntry, OrganizationBudgetExhausted,
)
from notalone.memory.models import ConfirmedMemoryStatus
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.scopes import ContactScope
from notalone.persistence.layered_profile import LayeredProfileStore, ProfileWork


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), default=str).encode()).hexdigest()


@dataclass(frozen=True, slots=True, repr=False)
class OrganizationWork:
    id: UUID
    scope: ContactScope
    settings_generation: int
    memories: tuple[OrganizationInput, ...]
    manifest: list

    @property
    def call_budget_id(self) -> UUID:
        return self.id


class PostgresLayeredMemoryStore(LayeredProfileStore):
    def __init__(self, database_url: str, *, clock=None):
        self._database_url = database_url
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._overview = PostgresRelationshipOverviewStore(database_url, clock=self._clock)

    def require_synthetic_database(self):
        with psycopg.connect(self._database_url) as connection:
            if not connection.info.dbname.endswith("_test"):
                raise ValueError("受控整理只允许显式隔离测试库。")

    @contextmanager
    def transaction(self, scope: ContactScope):
        with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
            lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            overview = self._overview.read_contact_in_transaction(connection, scope)
            connection.execute("INSERT INTO public.layered_memory_state(owner_id,contact_id) VALUES(%s,%s) "
                               "ON CONFLICT DO NOTHING", (scope.owner_id, scope.contact_id))
            state = connection.execute("SELECT * FROM public.layered_memory_state "
                                       "WHERE owner_id=%s AND contact_id=%s FOR UPDATE",
                                       (scope.owner_id, scope.contact_id)).fetchone()
            entries = self.eligible(overview)
            current = {item["memory_id"]: item for item in self._manifest(connection, scope, entries)}
            batches = connection.execute("SELECT id,input_manifest FROM public.layered_memory_batch "
                "WHERE owner_id=%s AND contact_id=%s", (scope.owner_id,scope.contact_id)).fetchall()
            erased = False
            for batch in batches:
                if any(current.get(item["memory_id"]) != item for item in batch["input_manifest"]):
                    connection.execute("DELETE FROM public.layered_memory_batch WHERE id=%s", (batch["id"],))
                    erased = True
            if erased:
                connection.execute("UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' "
                    "ELSE 'disabled' END, covered_count=0,organization_generation=organization_generation+1 "
                    "WHERE owner_id=%s AND contact_id=%s", (scope.owner_id,scope.contact_id))
                state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id=%s",
                                           (scope.owner_id,scope.contact_id)).fetchone()
            yield connection, state, overview

    def eligible(self, overview):
        now = self._clock()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("整理时钟必须带时区。")
        entries = []
        for entry in overview.entries:
            memory = entry.memory
            if (entry.provenance_kind not in {"manual_entry", "source_supported"}
                    or memory.status is not ConfirmedMemoryStatus.ACTIVE or not entry.is_latest
                    or memory.valid_at is not None and memory.valid_at > now):
                continue
            if memory.invalid_at is not None and memory.invalid_at <= now:
                timing = replace(memory.timing, current_status="historical", current_status_reason=
                    "已离开资料声明的适用区间；仅作历史，不证明计划已发生或当前状态。")
                memory = replace(memory, timing=timing)
            entries.append(replace(entry, memory=memory))
        return tuple(entries)

    @staticmethod
    def _manifest(connection, scope, entries):
        manifest = connection.execute("SELECT manifest FROM public.relationship_overview_projection "
            "WHERE owner_id=%s AND contact_id=%s AND scope_kind='contact'",
            (scope.owner_id, scope.contact_id)).fetchone()["manifest"]
        by_id = {str(entry.memory.memory_id): entry for entry in entries}
        return [{**item, "organization_timing_sha256": _digest(by_id[item["memory_id"]].memory.timing.to_payload())}
                for item in manifest["memories"] if item["memory_id"] in by_id]

    def generation_rows(self, connection, scope, generation):
        manifest = connection.execute("SELECT * FROM public.layered_memory_generation WHERE owner_id=%s "
            "AND contact_id=%s AND organization_generation=%s", (scope.owner_id,scope.contact_id,generation)).fetchone()
        if not manifest:
            return None, []
        rows = connection.execute("SELECT version.*,batch.input_manifest,batch.dependency_ids FROM "
            "public.scenario_document_version version JOIN public.layered_memory_batch batch ON batch.id=version.batch_id "
            "WHERE version.owner_id=%s AND version.contact_id=%s AND version.id=ANY(%s) ORDER BY version.scenario_id",
            (scope.owner_id,scope.contact_id,manifest["scenario_version_ids"])).fetchall()
        return manifest, rows

    def publish_generation_in_transaction(self, connection, scope, *, expected_generation, scenario_version_ids, profile_version_id=None):
        """caller已持范围锁；从真实版本推导完整依赖并原子推进唯一集合。"""
        state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id=%s",
            (scope.owner_id,scope.contact_id)).fetchone()
        if not state or state["organization_generation"] != expected_generation:
            raise LayeredMemoryConflict("一致集合世代已变化。")
        ids = list(scenario_version_ids)
        rows = connection.execute("SELECT v.*,b.input_manifest,b.dependency_ids FROM public.scenario_document_version v "
            "JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE v.owner_id=%s AND v.contact_id=%s AND v.id=ANY(%s)",
            (scope.owner_id,scope.contact_id,ids)).fetchall()
        if (not ids or len(set(ids)) != len(ids) or len(rows) != len(ids)
                or len({r["scenario_id"] for r in rows}) != len(rows)):
            raise LayeredMemoryConflict("一致集合的主题版本无效。")
        overview = self._overview.read_contact_in_transaction(connection, scope)
        current = {item["memory_id"]: item for item in self._manifest(connection,scope,self.eligible(overview))}
        if any(current.get(item["memory_id"]) != item for row in rows for item in row["input_manifest"]):
            raise LayeredMemoryConflict("一致集合的底层版本失效。")
        dependencies = {identifier for row in rows for identifier in row["dependency_ids"]}
        if profile_version_id is not None:
            profile = self.profile_row(connection, scope, profile_version_id)
            if (not profile or profile["withdrawn"] or set(profile["scenario_version_ids"]) != set(ids)
                    or any(current.get(item["memory_id"]) != item for item in profile["input_manifest"])):
                raise LayeredMemoryConflict("长期背景不属于当前完整主题集合。")
            dependencies.update(profile["dependency_ids"])
        generation = state["organization_generation"] + 1
        if profile_version_id is None:
            # L2集合推进后，旧集合上的未完成画像不得阻塞新工作或保留可迟到输出。
            connection.execute("DELETE FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id=%s AND status='running'",
                (scope.owner_id,scope.contact_id))
        connection.execute("INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,"
            "schema_version,scenario_version_ids,profile_version_id,dependency_ids,created_at) VALUES(%s,%s,%s,2,%s,%s,%s,%s)",
            (scope.owner_id,scope.contact_id,generation,ids,profile_version_id,sorted(dependencies),self._clock()))
        changed = connection.execute("UPDATE public.layered_memory_state SET organization_generation=%s "
            "WHERE owner_id=%s AND contact_id=%s AND organization_generation=%s AND enabled=%s",
            (generation,scope.owner_id,scope.contact_id,expected_generation,state["enabled"]))
        if changed.rowcount != 1:
            raise LayeredMemoryConflict("一致集合在发布前已变化。")
        return generation

    def read(self, scope):
        with self.transaction(scope) as (connection, state, overview):
            rows, profile = [], None
            if state["status"] in {"ready", "disabled"}:
                manifest, rows = self.generation_rows(connection, scope, state["organization_generation"])
                if manifest and manifest["profile_version_id"]:
                    profile = self.profile_document(self.profile_row(connection,scope,manifest["profile_version_id"]))
            state["call_budget"] = connection.execute("SELECT model_call_limit,model_calls_used FROM public.layered_memory_batch "
                "WHERE id=%s AND owner_id=%s AND contact_id=%s",
                (state["call_budget_batch_id"],scope.owner_id,scope.contact_id)).fetchone()
            return state, self.eligible(overview), [self._document(row) for row in rows], profile

    @staticmethod
    def _document(row):
        return {"scenario_id": str(row["scenario_id"]), "version_id": str(row["id"]),
                "title": row["title"], "hint": row["hint"], "system_generated": True,
                "updated_at": row["created_at"].isoformat(), "paragraphs": row["paragraphs"]}

    def command(self, scope, action, expected_generation, *, quality_available):
        with self.transaction(scope) as (connection, state, _):
            if state["settings_generation"] != expected_generation:
                if (action in {"enable", "disable", "delete"} and state["last_action"] == action
                        and state["settings_generation"] == expected_generation + 1):
                    return
                raise LayeredMemoryConflict("范围设置已变化。")
            if action == "refresh":
                if not state["enabled"]:
                    raise LayeredMemoryConflict("本联系人尚未开启整理。")
                return
            enabled = action == "enable"
            if action == "delete":
                connection.execute("DELETE FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id=%s",
                                   (scope.owner_id,scope.contact_id))
                connection.execute("DELETE FROM public.layered_memory_generation WHERE owner_id=%s AND contact_id=%s",
                                   (scope.owner_id,scope.contact_id))
                connection.execute("DELETE FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id=%s",
                                   (scope.owner_id, scope.contact_id))
            else:
                connection.execute("DELETE FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id=%s "
                                   "AND status='running'", (scope.owner_id,scope.contact_id))
                # 停用清除未完成工作；合法已发布正文可继续人工查看。
                connection.execute("DELETE FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id=%s "
                                   "AND status='running'", (scope.owner_id, scope.contact_id))
            connection.execute("UPDATE public.layered_memory_state SET enabled=%s, "
                "settings_generation=settings_generation+1,status=%s,error_code=NULL,last_action=%s,"
                "covered_count=CASE WHEN %s THEN 0 ELSE covered_count END,"
                "updated_at=CASE WHEN %s THEN NULL ELSE updated_at END,"
                "organization_generation=organization_generation+CASE WHEN %s THEN 1 ELSE 0 END "
                "WHERE owner_id=%s AND contact_id=%s", (enabled, "stale" if enabled and quality_available
                    else "blocked" if enabled else "disabled", action, action == "delete", action == "delete",
                    action == "delete", scope.owner_id, scope.contact_id))

    def prepare(self, scope, budget, contract):
        with self.transaction(scope) as (connection, state, overview):
            if not state["enabled"]:
                return None
            entries = self.eligible(overview)[:budget.max_memories]
            if not entries:
                connection.execute("UPDATE public.layered_memory_state SET status='empty',covered_count=0,"
                    "error_code=NULL WHERE owner_id=%s AND contact_id=%s", (scope.owner_id, scope.contact_id))
                return None
            selected = []
            for entry in entries:
                candidate = self._input(entry)
                payload = [self._input(item).to_payload() for item in selected] + [candidate.to_payload()]
                if len(json.dumps(payload, ensure_ascii=False)) > budget.max_characters:
                    break
                selected.append(entry)
            entries = tuple(selected)
            if not entries:
                connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code='input_budget_exceeded',"
                    "covered_count=0 WHERE owner_id=%s AND contact_id=%s", (scope.owner_id,scope.contact_id))
                return None
            manifest = self._manifest(connection, scope, entries)
            key = _digest({"inputs": manifest, "settings_generation": state["settings_generation"],
                           "contract": contract, "budget": budget.to_payload()})
            previous = connection.execute("SELECT status FROM public.layered_memory_batch WHERE "
                "owner_id=%s AND contact_id=%s AND work_key=%s", (scope.owner_id, scope.contact_id, key)).fetchone()
            if previous:
                return None
            if connection.execute("SELECT 1 FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id=%s "
                                  "AND status='running'", (scope.owner_id, scope.contact_id)).fetchone():
                return None
            memories = tuple(self._input(entry) for entry in entries)
            dependencies = {entry.memory.memory_id for entry in entries}
            dependencies.update(identifier for entry in entries for identifier in entry.dependency_ids)
            id = uuid4()
            connection.execute("INSERT INTO public.layered_memory_batch(id,owner_id,contact_id,settings_generation,"
                "work_key,status,input_manifest,input_payload,dependency_ids,created_at,model_call_limit,model_calls_used) "
                "VALUES(%s,%s,%s,%s,%s,'running',%s,%s,%s,%s,%s,0)", (id,scope.owner_id,scope.contact_id,
                state["settings_generation"],key,Jsonb(manifest),Jsonb([item.to_payload() for item in memories]),
                sorted(dependencies),self._clock(),budget.max_model_calls))
            connection.execute("UPDATE public.layered_memory_state SET call_budget_batch_id=%s,status='updating',error_code=NULL "
                "WHERE owner_id=%s AND contact_id=%s", (id,scope.owner_id, scope.contact_id))
            return OrganizationWork(id, scope, state["settings_generation"], memories, manifest)

    @staticmethod
    def _input(entry):
        memory = entry.memory
        return OrganizationInput(memory.memory_id,memory.revision,memory.text,entry.provenance_kind,
            memory.timing.to_payload(),memory.event.to_payload(current=True) if memory.event else None,
            memory.category.value,memory.valid_at.isoformat() if memory.valid_at else None,
            memory.invalid_at.isoformat() if memory.invalid_at else None)

    def _check(self, connection, state, overview, work):
        if not state["enabled"] or state["settings_generation"] != work.settings_generation:
            raise LayeredMemoryConflict("整理设置已变化。")
        batch = connection.execute("SELECT 1 FROM public.layered_memory_batch WHERE id=%s AND owner_id=%s "
            "AND contact_id=%s AND status='running'", (work.id,work.scope.owner_id,work.scope.contact_id)).fetchone()
        ids = {item.memory_id for item in work.memories}
        entries = tuple(entry for entry in self.eligible(overview) if entry.memory.memory_id in ids)
        if not batch or self._manifest(connection, work.scope, entries) != work.manifest:
            raise LayeredMemoryConflict("整理实际输入已变化。")

    def check(self, work):
        with self.transaction(work.scope) as (connection, state, overview):
            self._check(connection, state, overview, work)

    def reserve_model_call(self, work):
        """取得实际调用许可后仅预留一次；提交后中断也不退还，防止恢复免费重发。"""
        with self.transaction(work.scope) as (connection,state,overview):
            if isinstance(work, ProfileWork):
                self._check_profile(connection,state,overview,work)
            else:
                self._check(connection,state,overview,work)
            reserved = connection.execute("UPDATE public.layered_memory_batch SET model_calls_used=model_calls_used+1 "
                "WHERE id=%s AND owner_id=%s AND contact_id=%s AND model_calls_used<model_call_limit RETURNING id",
                (work.call_budget_id,work.scope.owner_id,work.scope.contact_id)).fetchone()
            if reserved is None:
                raise OrganizationBudgetExhausted("本批模型调用预算已耗尽。")

    def record_proposal(self, work, proposal):
        with self.transaction(work.scope) as (connection, state, overview):
            self._check(connection, state, overview, work)
            connection.execute("UPDATE public.layered_memory_batch SET output_payload=%s WHERE id=%s",
                               (Jsonb(proposal), work.id))

    def publish(self, work, proposal):
        with self.transaction(work.scope) as (connection, state, overview):
            # 最终 writer 在同一锁和同一连接上复验全部输入；不另开概览连接。
            self._check(connection, state, overview, work)
            generation, now = state["organization_generation"] + 1, self._clock()
            version_ids = []
            for scenario in proposal["scenarios"]:
                version_id = uuid4()
                version_ids.append(version_id)
                scenario_id = uuid5(work.scope.contact_id, str(work.scope.owner_id) + ":" + scenario["topic_key"])
                connection.execute("INSERT INTO public.scenario_document_version(id,owner_id,contact_id,scenario_id,"
                    "batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s)", (version_id,work.scope.owner_id,
                    work.scope.contact_id,scenario_id,work.id,generation,scenario["title"],scenario["hint"],
                    Jsonb(scenario["paragraphs"]),now))
            generation = self.publish_generation_in_transaction(connection,work.scope,
                expected_generation=state["organization_generation"],scenario_version_ids=version_ids)
            connection.execute("UPDATE public.layered_memory_batch SET status='succeeded' WHERE id=%s", (work.id,))
            connection.execute("UPDATE public.layered_memory_state SET status='ready',organization_generation=%s,"
                "covered_count=%s,updated_at=%s,error_code=NULL WHERE owner_id=%s AND contact_id=%s",
                (generation,len(work.memories),now,work.scope.owner_id,work.scope.contact_id))

    def fail(self, work, code):
        with self.transaction(work.scope) as (connection, state, overview):
            try:
                self._check(connection, state, overview, work)
            except LayeredMemoryConflict:
                return
            connection.execute("UPDATE public.layered_memory_batch SET status='failed',error_code=%s WHERE id=%s",
                               (code, work.id))
            connection.execute("UPDATE public.layered_memory_state SET status=%s,error_code=%s "
                "WHERE owner_id=%s AND contact_id=%s", ("paused" if code == "model_call_budget_exhausted" else "failed",
                code,work.scope.owner_id,work.scope.contact_id))

    def capture(self, scope):
        with self.transaction(scope) as (connection, state, _):
            if not state["enabled"] or state["status"] != "ready":
                return None
            manifest, rows = self.generation_rows(connection,scope,state["organization_generation"])
            if not manifest or not rows:
                return None
            profile = self.profile_row(connection,scope,manifest["profile_version_id"]) if manifest["profile_version_id"] else None
            return LayeredMemorySnapshot(2,scope,state["settings_generation"],state["organization_generation"],
                tuple(ScenarioDirectoryEntry(row["scenario_id"],row["id"],row["title"],row["hint"],
                      len(row["paragraphs"])) for row in rows), tuple(manifest["dependency_ids"]),
                manifest["profile_version_id"], tuple(profile["entries"]) if profile else ())

    def validate_in_transaction(self, connection, snapshot):
        """最终writer复用已持范围锁的连接；拒绝旧schema，不给旧快照补签。"""
        if not isinstance(snapshot, LayeredMemorySnapshot) or snapshot.schema_version != 2:
            return False
        scope = snapshot.scope
        overview = self._overview.read_contact_in_transaction(connection, scope)
        state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id=%s",
                                   (scope.owner_id,scope.contact_id)).fetchone()
        if (not state or not state["enabled"] or state["status"] != "ready"
                or state["settings_generation"] != snapshot.settings_generation
                or state["organization_generation"] != snapshot.organization_generation):
            return False
        manifest, rows = self.generation_rows(connection,scope,snapshot.organization_generation)
        if not manifest:
            return False
        expected = {(item.scenario_id,item.version_id,item.title,item.hint,item.paragraph_count) for item in snapshot.scenarios}
        actual = {(row["scenario_id"],row["id"],row["title"],row["hint"],len(row["paragraphs"])) for row in rows}
        current = {item["memory_id"]: item for item in self._manifest(connection,scope,self.eligible(overview))}
        profile = self.profile_row(connection,scope,manifest["profile_version_id"]) if manifest["profile_version_id"] else None
        dependencies = {identifier for row in rows for identifier in row["dependency_ids"]}
        if profile:
            if (profile["withdrawn"] or set(profile["scenario_version_ids"]) != {r["id"] for r in rows}
                    or any(current.get(item["memory_id"]) != item for item in profile["input_manifest"])):
                return False
            dependencies.update(profile["dependency_ids"])
        return (expected == actual and bool(actual)
                and manifest["profile_version_id"] == snapshot.profile_version_id
                and snapshot.profile_entries == (tuple(profile["entries"]) if profile else ())
                and set(snapshot.dependency_ids) == set(manifest["dependency_ids"]) == dependencies
                and all(current.get(item["memory_id"]) == item for row in rows for item in row["input_manifest"]))

    def validate(self, snapshot):
        if not isinstance(snapshot, LayeredMemorySnapshot):
            return False
        try:
            with self.transaction(snapshot.scope) as (connection, _, __):
                return self.validate_in_transaction(connection, snapshot)
        except (LookupError, PermissionError):
            return False

    def read_scenario(self, snapshot, id, range):
        if (not isinstance(snapshot, LayeredMemorySnapshot) or not isinstance(id, UUID)
                or not isinstance(range, tuple) or len(range) != 2
                or any(type(value) is not int for value in range)
                or range[0] < 0 or range[1] <= range[0]):
            raise ValueError("主题段落范围无效。")
        allowed = next((item for item in snapshot.scenarios if item.scenario_id == id), None)
        if allowed is None or range[1] > allowed.paragraph_count:
            raise PermissionError("主题或段落不在冻结目录内。")
        with self.transaction(snapshot.scope) as (connection, _, __):
            if not self.validate_in_transaction(connection,snapshot):
                raise LayeredMemoryConflict("主题资料快照已失效。")
            row = connection.execute("SELECT * FROM public.scenario_document_version WHERE id=%s "
                "AND owner_id=%s AND contact_id=%s", (allowed.version_id,snapshot.scope.owner_id,
                                                     snapshot.scope.contact_id)).fetchone()
            document = self._document(row)
            return {**document, "paragraphs": document["paragraphs"][range[0]:range[1]],
                    "paragraph_range": list(range), "organization_generation": snapshot.organization_generation}
