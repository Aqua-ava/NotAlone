"""联系人主题资料的短事务边界；模型调用不占数据库事务。"""

from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
from uuid import UUID, uuid4, uuid5

import psycopg
from psycopg.rows import dict_row, tuple_row
from psycopg.types.json import Jsonb

from notalone.memory.layered import (
    LayeredMemoryConflict, OrganizationBudgetExhausted, OrganizationInput, LayeredMemorySnapshot, ScenarioDirectoryEntry,
)
from notalone.memory.models import ConfirmedMemoryStatus
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.layered_coverage import current_job, cancel_jobs, enqueue_coverage
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from notalone.scopes import ContactScope, OwnerScope, organization_scope
from notalone.tasks.models import ClaimedBackgroundTaskStep
from notalone.persistence.layered_profile import LayeredProfileStore, ProfileWork
from notalone.persistence.layered_corrections import LayeredCorrectionStore


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), default=str).encode()).hexdigest()


@dataclass(frozen=True, slots=True, repr=False)
class OrganizationWork:
    id: UUID
    scope: ContactScope | OwnerScope
    settings_generation: int
    memories: tuple[OrganizationInput, ...]
    manifest: list
    claim: ClaimedBackgroundTaskStep
    scenarios: tuple[dict, ...] = ()
    organization_generation: int = 0
    correction_revision: int = 0
    corrections: tuple[dict, ...] = ()


class PostgresLayeredMemoryStore(LayeredProfileStore, LayeredCorrectionStore):
    def __init__(self, database_url: str, *, clock=None):
        self._database_url = database_url
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._overview = PostgresRelationshipOverviewStore(database_url, clock=self._clock)

    def require_synthetic_database(self):
        with psycopg.connect(self._database_url) as connection:
            if not connection.info.dbname.endswith("_test"):
                raise ValueError("受控整理只允许显式隔离测试库。")

    @contextmanager
    def transaction(self, scope: ContactScope | OwnerScope):
        with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
            if scope.contact_id is not None:
                lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
            lock_owner_scope(connection, owner_id=scope.owner_id)
            overview = (self._overview.read_owner_in_transaction(connection, scope.owner_id, organization=True)
                if isinstance(scope, OwnerScope) else self._overview.read_contact_in_transaction(connection, scope))
            connection.execute("INSERT INTO public.layered_memory_state(owner_id,contact_id) VALUES(%s,%s) "
                               "ON CONFLICT DO NOTHING", (scope.owner_id, scope.contact_id))
            state = connection.execute("SELECT * FROM public.layered_memory_state "
                                       "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s FOR UPDATE",
                                       (scope.owner_id, scope.contact_id)).fetchone()
            entries = self.eligible(overview)
            current = {item["memory_id"]: item for item in self._manifest(connection, scope, entries)}
            batches = connection.execute("SELECT id,input_manifest FROM public.layered_memory_batch "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id,scope.contact_id)).fetchall()
            erased = False
            for batch in batches:
                if any(current.get(item["memory_id"]) != item for item in batch["input_manifest"]):
                    from notalone.persistence.reply_layered_cleanup import erase_layered_reply_dependencies
                    erase_layered_reply_dependencies(connection, scope,
                        [UUID(item["memory_id"]) for item in batch["input_manifest"]])
                    connection.execute("DELETE FROM public.layered_memory_batch WHERE id=%s", (batch["id"],))
                    erased = True
            for job in current_job(connection,scope):
                if job['state']!='invalidated' and any(current.get(item['memory_id'])!=item for item in job['target_manifest']):
                    connection.execute("UPDATE public.background_task SET status='cancelled' WHERE id=%s",(job['task_id'],))
                    connection.execute("UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,"
                        "lease_generation=lease_generation+1 WHERE task_id=%s",(job['task_id'],))
                    connection.execute("UPDATE public.layered_memory_job SET state='invalidated',target_manifest='[]',dependency_ids='{}',"
                        "revision=revision+1,pending_receipt=false,receipt_batch_id=NULL,receipt_lease_generation=NULL WHERE task_id=%s",(job['task_id'],))
                    erased=True
            if erased:
                connection.execute("UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' "
                    "ELSE 'disabled' END "
                    "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id,scope.contact_id))
                state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                                           (scope.owner_id,scope.contact_id)).fetchone()
            boundary = min((value for entry in overview.entries
                for value in (entry.memory.valid_at, entry.memory.invalid_at)
                if value is not None and value > self._clock()), default=None)
            if boundary != state['next_boundary_at']:
                expired = state['next_boundary_at'] is not None and state['next_boundary_at'] <= self._clock()
                connection.execute("UPDATE public.layered_memory_state SET next_boundary_at=%s,"
                    "dirty_revision=dirty_revision+%s,next_due_at=CASE WHEN %s THEN now() ELSE next_due_at END "
                    "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (boundary, int(expired), expired, scope.owner_id, scope.contact_id))
                state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                                           (scope.owner_id, scope.contact_id)).fetchone()
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
            "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND scope_kind=%s",
            (scope.owner_id, scope.contact_id, "owner" if isinstance(scope, OwnerScope) else "contact")).fetchone()["manifest"]
        by_id = {str(entry.memory.memory_id): entry for entry in entries}
        return [{**item, "organization_timing_sha256": _digest(by_id[item["memory_id"]].memory.timing.to_payload())}
                for item in manifest["memories"] if item["memory_id"] in by_id]

    def read(self, scope, *, mapping_cursor=None):
        with self.transaction(scope) as (connection, state, overview):
            manifest, rows = self.generation_rows(connection,scope,state['organization_generation'])
            offset = 0
            if mapping_cursor is not None:
                import re
                if not isinstance(mapping_cursor, str) or re.fullmatch(r'[0-9]{1,18}:[0-9]{1,10}', mapping_cursor) is None:
                    raise ValueError('映射分页游标无效。')
                generation, offset = map(int, mapping_cursor.split(':'))
                if generation != state['organization_generation']:
                    raise LayeredMemoryConflict('主题集合已变化，请重新读取首屏。')
            mappings, more = self._mappings(connection, scope, rows, offset)
            state['scenario_mappings'] = mappings
            state['mapping_cursor'] = mapping_cursor
            state['mapping_next_cursor'] = f"{state['organization_generation']}:{offset+100}" if more else None
            jobs=current_job(connection,scope)
            job=next((row for row in jobs if row['settings_generation']==state['settings_generation']),None)
            profile = None
            if manifest and manifest['profile_version_id'] and state['status'] in {'ready','paused','disabled'}:
                profile = self.profile_document(self.profile_row(connection,scope,manifest['profile_version_id']))
            state['profile'] = profile
            state['feedback'] = [{"id": str(row['id']), "target_kind": row['target_kind'],
                "version_id": str(row['version_id']) if row['version_id'] else None, "item_index": row['item_index'],
                "reason": row['reason'], "state": row['state']} for row in self.feedback_rows(connection, scope)]
            state['protected_count'] = len(self.eligible(overview)) - len(self.unprotected(connection, scope, self.eligible(overview)))
            return state, self.eligible(overview), [self._document(row) for row in rows], job

    @staticmethod
    def _mappings(connection, scope, current, offset):
        # 传输边界按完整(source版本→当前target版本)分页；同一拆分的分支不会静默截掉。
        rows = connection.execute("WITH RECURSIVE lineage AS ("
            "SELECT source_scenario_id,source_version_id,target_version_id FROM public.scenario_document_mapping "
            "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s UNION "
            "SELECT l.source_scenario_id,l.source_version_id,m.target_version_id FROM lineage l "
            "JOIN public.scenario_document_mapping m ON m.source_version_id=l.target_version_id "
            "AND m.owner_id=%s AND m.contact_id IS NOT DISTINCT FROM %s) "
            "SELECT DISTINCT l.source_scenario_id,l.source_version_id,v.scenario_id,v.id AS target_version_id "
            "FROM lineage l JOIN public.scenario_document_version v ON v.id=l.target_version_id "
            "WHERE v.id=ANY(%s::uuid[]) ORDER BY l.source_version_id,v.id OFFSET %s LIMIT 101",
            (scope.owner_id,scope.contact_id,scope.owner_id,scope.contact_id,[row['id'] for row in current],offset)).fetchall()
        grouped = {}
        for row in rows[:100]:
            version = str(row['source_version_id'])
            item = grouped.setdefault(version, {'source_scenario_id': str(row['source_scenario_id']),
                'source_version_id': version, 'targets': []})
            item['targets'].append({'scenario_id': str(row['scenario_id']), 'version_id': str(row['target_version_id'])})
        return list(grouped.values()), len(rows) > 100

    @staticmethod
    def _document(row):
        return {"scenario_id": str(row["scenario_id"]), "version_id": str(row["id"]),
                "title": row["title"], "hint": row["hint"], "system_generated": True,
                "updated_at": row["created_at"].isoformat(), "paragraphs": row["paragraphs"]}

    def withdraw_scenario(self, scope, settings_generation, organization_generation, scenario_version_id):
        with self.transaction(scope) as (connection, state, _):
            _, rows = self.generation_rows(connection, scope, state['organization_generation'])
            if (state['settings_generation'] != settings_generation
                    or state['organization_generation'] != organization_generation
                    or scenario_version_id not in {row['id'] for row in rows}):
                raise LayeredMemoryConflict('主题版本或设置已变化。')
            from notalone.persistence.reply_cleanup import delete_source_replies
            profiles = connection.execute(
                "SELECT v.id FROM public.layered_profile_version v "
                "JOIN public.layered_profile_batch b ON b.id=v.batch_id "
                "WHERE b.owner_id=%s AND b.contact_id IS NOT DISTINCT FROM %s "
                "AND %s=ANY(b.scenario_version_ids)",
                (scope.owner_id, scope.contact_id, scenario_version_id)).fetchall()
            delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
                removed_ids={scenario_version_id, *(row['id'] for row in profiles)}, revoke_running_scope=False)
            cancel_jobs(connection, scope)
            # 原级联同时撤下依赖画像及旧冻结集合；不启用任何旧版。
            connection.execute('DELETE FROM public.scenario_document_version WHERE id=%s', (scenario_version_id,))

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
            # 删除整理结果清除实际使用副本；停用保留合法历史回看。
            from notalone.persistence.reply_cleanup import delete_source_replies
            version_rows = connection.execute(
                "SELECT id FROM public.scenario_document_version WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s "
                "UNION SELECT id FROM public.layered_profile_version WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                (scope.owner_id, scope.contact_id, scope.owner_id, scope.contact_id)).fetchall()
            if action == "delete" and version_rows:
                delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
                    removed_ids={row["id"] for row in version_rows}, revoke_running_scope=False)
            cancel_jobs(connection,scope,erase=action=='delete')
            if action=='delete':
                connection.execute("DELETE FROM public.layered_memory_generation WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                                   (scope.owner_id,scope.contact_id))
            enabled = action == "enable"
            connection.execute("DELETE FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s "
                "AND (%s OR status='running')", (scope.owner_id,scope.contact_id,action=='delete'))
            if action == "delete":
                connection.execute("DELETE FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                                   (scope.owner_id, scope.contact_id))
            else:
                # 停用清除未完成工作；合法已发布正文可继续人工查看。
                connection.execute("DELETE FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s "
                                   "AND status='running'", (scope.owner_id, scope.contact_id))
            connection.execute("UPDATE public.layered_memory_state SET enabled=%s, "
                "settings_generation=settings_generation+1,status=%s,error_code=NULL,last_action=%s,"
                "covered_count=CASE WHEN %s THEN 0 ELSE covered_count END,"
                "updated_at=CASE WHEN %s THEN NULL ELSE updated_at END,"
                "organization_generation=organization_generation+CASE WHEN %s THEN 1 ELSE 0 END "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (enabled, "stale" if enabled and quality_available
                    else "blocked" if enabled else "disabled", action, action == "delete", action == "delete",
                    action == "delete", scope.owner_id, scope.contact_id))

    def enqueue(self, scope, budget, contract, *, action='refresh', revision=None, profile_required=False):
        with self.transaction(scope) as (connection,state,overview):
            if not state['enabled']:
                raise LayeredMemoryConflict('本联系人尚未开启整理。')
            entries=self.unprotected(connection, scope, self.eligible(overview))
            manifest=self._manifest(connection,scope,entries)
            dependencies={entry.memory.memory_id for entry in entries}
            dependencies.update(identifier for entry in entries for identifier in entry.dependency_ids)
            dependencies.update(self.correction_dependency_ids(connection, scope))
            task_id, execute = enqueue_coverage(connection,scope,state,manifest,dependencies,contract,budget,
                action=action,revision=revision,profile_required=profile_required)
            self._revoke_previous_profile(connection, scope, state, task_id, execute)
            return task_id, execute

    def start_change_feed(self, owner_id, callback):
        from notalone.persistence.layered_change_feed import LayeredChangeFeed
        return LayeredChangeFeed(self._database_url, owner_id, callback)

    def _revoke_previous_profile(self, connection, scope, state, task_id, execute):
        generation, rows = self.generation_rows(connection,scope,state['organization_generation'])
        job = connection.execute("SELECT pending_receipt FROM public.layered_memory_job WHERE task_id=%s",(task_id,)).fetchone()
        if execute and generation and generation['profile_version_id']:
            profile_task = connection.execute("SELECT b.task_id FROM public.layered_profile_version v "
                "JOIN public.layered_profile_batch b ON b.id=v.batch_id WHERE v.id=%s",
                (generation['profile_version_id'],)).fetchone()
            # 新目标、重开或下一批开始即撤下受影响画像；仅补成功回执时保持原集合。
            if not job['pending_receipt'] or not profile_task or profile_task['task_id']!=task_id:
                self.publish_generation_in_transaction(connection,scope,
                    expected_generation=state['organization_generation'],scenario_version_ids=[row['id'] for row in rows])

    def maintenance_due(self, owner_id):
        with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
            rows = connection.execute("SELECT contact_id,next_due_at,next_boundary_at,maintenance_allowed,"
                "dirty_revision,consumed_revision FROM public.layered_memory_state "
                "WHERE owner_id=%s AND enabled AND (next_boundary_at IS NOT NULL OR "
                "maintenance_allowed AND dirty_revision>consumed_revision AND next_due_at IS NOT NULL)",
                (owner_id,)).fetchall()
        now, wall_now = self._clock(), datetime.now(timezone.utc)
        due, delays = [], []
        for row in rows:
            deadlines = []
            if row['next_boundary_at'] is not None:
                deadlines.append((row['next_boundary_at']-now).total_seconds())
            if row['maintenance_allowed'] and row['next_due_at'] is not None:
                deadlines.append((row['next_due_at']-wall_now).total_seconds())
            if min(deadlines, default=3600) <= 0:
                due.append(organization_scope(owner_id, row['contact_id']))
            else:
                delays.extend(deadlines)
        return tuple(due), max(0.01, min(delays, default=3600.0))

    def enqueue_maintenance(self, scope, budget, contract, *, profile_required=False):
        with self.transaction(scope) as (connection, state, overview):
            if (not state['enabled'] or not state['maintenance_allowed']
                    or state['dirty_revision'] <= state['consumed_revision']):
                return None
            if any(job['state'] == 'active' and job['settings_generation'] == state['settings_generation']
                   for job in current_job(connection, scope)):
                return None
            entries = self.unprotected(connection, scope, self.eligible(overview))
            manifest = self._manifest(connection, scope, entries)
            dependencies = {entry.memory.memory_id for entry in entries}
            dependencies.update(identifier for entry in entries for identifier in entry.dependency_ids)
            dependencies.update(self.correction_dependency_ids(connection, scope))
            task_id, execute = enqueue_coverage(connection, scope, state, manifest, dependencies,
                contract, budget, action='refresh', revision=None, profile_required=profile_required)
            self._revoke_previous_profile(connection, scope, state, task_id, execute)
            connection.execute("UPDATE public.layered_memory_job SET target_dirty_revision=%s WHERE task_id=%s",
                               (state['dirty_revision'], task_id))
            connection.execute("UPDATE public.layered_memory_state SET next_due_at=NULL WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                               (scope.owner_id, scope.contact_id))
            return task_id if execute else None

    def pending_scopes(self, owner_id):
        with psycopg.connect(self._database_url) as connection:
            rows=connection.execute("SELECT DISTINCT j.contact_id FROM public.layered_memory_job j "
                "JOIN public.layered_memory_state s ON s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id "
                "WHERE j.owner_id=%s AND j.state='active' AND s.enabled AND j.settings_generation=s.settings_generation",
                (owner_id,)).fetchall()
            return tuple(organization_scope(owner_id,row[0]) for row in rows)

    def pending(self, scope, contract=None):
        with self.transaction(scope) as (connection,state,_):
            if not state['enabled']:
                return None
            if contract is not None and not connection.execute(
                    "SELECT 1 FROM public.layered_memory_job WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s "
                    "AND settings_generation=%s AND state='active' AND contract=%s",
                    (scope.owner_id,scope.contact_id,state['settings_generation'],contract)).fetchone():
                return None
            # 到达最后一次租约尝试后，已经独立核验且发布的精确批次只补回执。
            connection.execute("UPDATE public.background_task_step step SET status='pending',attempt_count=0,worker_id=NULL,"
                "lease_expires_at=NULL,lease_generation=lease_generation+1 FROM public.layered_memory_job j "
                "LEFT JOIN public.layered_memory_batch b ON b.id=j.receipt_batch_id AND b.task_id=j.task_id "
                "WHERE step.task_id=j.task_id AND j.owner_id=%s AND j.contact_id IS NOT DISTINCT FROM %s AND j.state='active' "
                "AND j.pending_receipt AND ((b.status='succeeded' AND b.settings_generation=j.settings_generation) OR (j.profile_required AND j.receipt_batch_id IS NULL)) "
                "AND (step.status IN ('failed','retryable') OR step.status='running' AND step.lease_expires_at<=now())",
                (scope.owner_id,scope.contact_id))
            connection.execute("UPDATE public.background_task t SET status='queued',last_error_code=NULL,finished_at=NULL "
                "FROM public.layered_memory_job j WHERE t.id=j.task_id AND j.owner_id=%s AND j.contact_id IS NOT DISTINCT FROM %s "
                "AND j.state='active' AND j.pending_receipt AND EXISTS(SELECT 1 FROM public.background_task_step s "
                "WHERE s.task_id=t.id AND s.status='pending')",(scope.owner_id,scope.contact_id))
            # 领取路径可能已把最后一次失联租约判失败；无发布证明时不能留在updating。
            connection.execute("UPDATE public.layered_memory_job j SET state='failed' FROM public.background_task t "
                "WHERE t.id=j.task_id AND j.owner_id=%s AND j.contact_id IS NOT DISTINCT FROM %s AND j.settings_generation=%s "
                "AND j.state='active' AND NOT j.pending_receipt AND t.status='failed'",
                (scope.owner_id,scope.contact_id,state['settings_generation']))
            connection.execute("UPDATE public.layered_memory_state s SET status='failed',error_code=COALESCE(t.last_error_code,s.error_code) "
                "FROM public.layered_memory_job j JOIN public.background_task t ON t.id=j.task_id "
                "WHERE s.owner_id=j.owner_id AND s.contact_id IS NOT DISTINCT FROM j.contact_id AND s.settings_generation=j.settings_generation "
                "AND j.owner_id=%s AND j.contact_id IS NOT DISTINCT FROM %s AND j.state='failed' AND t.status='failed' AND s.enabled",
                (scope.owner_id,scope.contact_id))
            row=connection.execute("SELECT task_id FROM public.layered_memory_job WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s "
                "AND settings_generation=%s AND state='active' AND (%s::text IS NULL OR contract=%s) LIMIT 1",
                (scope.owner_id,scope.contact_id,state['settings_generation'],contract,contract)).fetchone()
            return row['task_id'] if row else None

    def prepare(self, scope, budget, contract, claim, *, with_scenarios=False):
        from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
        with self.transaction(scope) as (connection, state, overview):
            with connection.cursor(row_factory=tuple_row) as cursor:
                PostgresBackgroundTaskRepository._assert_valid_claim(cursor,claim)
            job=connection.execute("SELECT * FROM public.layered_memory_job WHERE task_id=%s FOR UPDATE",(claim.task_id,)).fetchone()
            if not job or job['contract']!=contract or job['state']!='active':
                raise LayeredMemoryConflict('覆盖工作或执行合同已变化。')
            current={item['memory_id']:item for item in self._manifest(connection,scope,self.eligible(overview))}
            if any(current.get(item['memory_id'])!=item for item in job['target_manifest']):
                raise LayeredMemoryConflict('覆盖目标的实际资料已变化。')
            if job['pending_receipt']:
                if job['target_manifest'] and not (job['profile_required'] and job['receipt_batch_id'] is None) and not connection.execute("SELECT 1 FROM public.layered_memory_batch WHERE id=%s "
                    "AND task_id=%s AND settings_generation=%s AND status='succeeded'",
                    (job['receipt_batch_id'],claim.task_id,job['settings_generation'])).fetchone():
                    raise LayeredMemoryConflict('缺少实际已发布的批次回执。')
                return None
            # 同一步重领只恢复未提交的批次；租约本身仍由任务仓储校验。
            connection.execute("DELETE FROM public.layered_memory_batch WHERE task_id=%s AND status<>'succeeded'",(claim.task_id,))
            covered={item['memory_id'] for batch in connection.execute(
                "SELECT b.input_manifest FROM public.layered_memory_generation g JOIN public.scenario_document_version v "
                "ON v.id=ANY(g.scenario_version_ids) AND v.owner_id=g.owner_id AND v.contact_id IS NOT DISTINCT FROM g.contact_id "
                "JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE g.owner_id=%s AND g.contact_id IS NOT DISTINCT FROM %s "
                "AND g.organization_generation=%s",(scope.owner_id,scope.contact_id,state['organization_generation'])).fetchall()
                for item in batch['input_manifest']}
            target={item['memory_id'] for item in job['target_manifest']}
            entries=tuple(entry for entry in self.unprotected(connection, scope, self.eligible(overview)) if str(entry.memory.memory_id) in target-covered)
            selected=[]
            corrections = self.correction_context(connection, scope)
            for entry in entries[:budget.max_memories]:
                payload={'memories': [self._input(item).to_payload() for item in selected]+[self._input(entry).to_payload()],
                         'corrections': corrections}
                if len(json.dumps(payload,ensure_ascii=False))>budget.max_characters:
                    break
                selected.append(entry)
            if not selected:
                if entries:
                    connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code='input_budget_exceeded' "
                        "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",(scope.owner_id,scope.contact_id))
                else:
                    connection.execute("UPDATE public.layered_memory_job SET pending_receipt=true WHERE task_id=%s",(claim.task_id,))
                return None
            contexts, inherited = [], []
            if with_scenarios:
                eligible = self.unprotected(connection, scope, self.eligible(overview))
                for previous in self.generation_rows(connection, scope, state['organization_generation'])[1][:budget.max_scenarios]:
                    prior = connection.execute("SELECT input_manifest,dependency_ids FROM public.layered_memory_batch WHERE id=%s",
                                               (previous['batch_id'],)).fetchone()
                    prior_ids = {item['memory_id'] for item in prior['input_manifest']}
                    combined_ids = {str(entry.memory.memory_id) for entry in selected} | prior_ids
                    combined = [entry for entry in eligible if str(entry.memory.memory_id) in combined_ids]
                    document = self._document(previous)
                    payload = {'memories': [self._input(item).to_payload() for item in combined],
                               'scenarios': contexts + [document], 'corrections': corrections}
                    if len(combined) > budget.max_memories or len(json.dumps(payload, ensure_ascii=False)) > budget.max_characters:
                        continue
                    selected = combined
                    contexts.append(document)
                    inherited.extend(prior['dependency_ids'])
            entries=tuple(selected)
            manifest=self._manifest(connection,scope,entries)
            memories=tuple(self._input(entry) for entry in entries)
            dependencies={entry.memory.memory_id for entry in entries}
            dependencies.update(identifier for entry in entries for identifier in entry.dependency_ids)
            dependencies.update(inherited)
            dependencies.update(self.correction_dependency_ids(connection, scope))
            id=uuid4()
            key=_digest({'job':str(claim.task_id),'inputs':manifest})
            connection.execute("INSERT INTO public.layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,"
                "input_manifest,input_payload,dependency_ids,created_at,task_id) VALUES(%s,%s,%s,%s,%s,'running',%s,%s,%s,%s,%s)",
                (id,scope.owner_id,scope.contact_id,state['settings_generation'],key,Jsonb(manifest),
                 Jsonb([item.to_payload() for item in memories]),sorted(dependencies),self._clock(),claim.task_id))
            connection.execute("UPDATE public.layered_memory_batch SET scenario_input=%s,reused_version_ids=%s WHERE id=%s",
                               (Jsonb(contexts), [UUID(item['version_id']) for item in contexts], id))
            connection.execute('UPDATE public.layered_memory_batch SET correction_input=%s WHERE id=%s', (Jsonb(corrections), id))
            connection.execute("UPDATE public.layered_memory_state SET status='updating',error_code=NULL WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                               (scope.owner_id,scope.contact_id))
            return OrganizationWork(id,scope,state['settings_generation'],memories,manifest,claim,
                                    tuple(contexts),state['organization_generation'],state['correction_revision'],corrections)

    def generation_rows(self, connection, scope, generation):
        manifest = connection.execute("SELECT * FROM public.layered_memory_generation WHERE owner_id=%s "
            "AND contact_id IS NOT DISTINCT FROM %s AND organization_generation=%s", (scope.owner_id,scope.contact_id,generation)).fetchone()
        if not manifest:
            return None, []
        rows = connection.execute("SELECT version.*,batch.input_manifest,batch.dependency_ids FROM "
            "public.scenario_document_version version JOIN public.layered_memory_batch batch ON batch.id=version.batch_id "
            "WHERE version.owner_id=%s AND version.contact_id IS NOT DISTINCT FROM %s AND version.id=ANY(%s) ORDER BY version.scenario_id",
            (scope.owner_id,scope.contact_id,manifest["scenario_version_ids"])).fetchall()
        return manifest, rows

    def publish_generation_in_transaction(self, connection, scope, *, expected_generation, scenario_version_ids, profile_version_id=None):
        """caller已持范围锁；从真实版本推导完整依赖并原子推进唯一集合。"""
        state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
            (scope.owner_id,scope.contact_id)).fetchone()
        if not state or state["organization_generation"] != expected_generation:
            raise LayeredMemoryConflict("一致集合世代已变化。")
        ids = list(scenario_version_ids)
        rows = connection.execute("SELECT v.*,b.input_manifest,b.dependency_ids FROM public.scenario_document_version v "
            "JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE v.owner_id=%s AND v.contact_id IS NOT DISTINCT FROM %s AND v.id=ANY(%s)",
            (scope.owner_id,scope.contact_id,ids)).fetchall()
        if (not ids or len(set(ids)) != len(ids) or len(rows) != len(ids)
                or len({r["scenario_id"] for r in rows}) != len(rows)):
            raise LayeredMemoryConflict("一致集合的主题版本无效。")
        overview = (self._overview.read_owner_in_transaction(connection, scope.owner_id, organization=True)
                if isinstance(scope, OwnerScope) else self._overview.read_contact_in_transaction(connection, scope))
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
            connection.execute("DELETE FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND status='running'",
                (scope.owner_id,scope.contact_id))
        connection.execute("INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,"
            "schema_version,scenario_version_ids,profile_version_id,dependency_ids,created_at) VALUES(%s,%s,%s,2,%s,%s,%s,%s)",
            (scope.owner_id,scope.contact_id,generation,ids,profile_version_id,sorted(dependencies),self._clock()))
        changed = connection.execute("UPDATE public.layered_memory_state SET organization_generation=%s "
            "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND organization_generation=%s AND enabled=%s",
            (generation,scope.owner_id,scope.contact_id,expected_generation,state["enabled"]))
        if changed.rowcount != 1:
            raise LayeredMemoryConflict("一致集合在发布前已变化。")
        return generation

    @staticmethod
    def _input(entry):
        memory = entry.memory
        return OrganizationInput(memory.memory_id,memory.revision,memory.text,entry.provenance_kind,
            memory.timing.to_payload(),memory.event.to_payload(current=True) if memory.event else None,
            memory.category.value,memory.valid_at.isoformat() if memory.valid_at else None,
            memory.invalid_at.isoformat() if memory.invalid_at else None)

    @staticmethod
    def _assert_claim(connection, claim):
        if claim is not None:
            from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
            try:
                with connection.cursor(row_factory=tuple_row) as cursor:
                    PostgresBackgroundTaskRepository._assert_valid_claim(cursor,claim)
            except Exception as error:
                from notalone.persistence.background_tasks import BackgroundTaskPersistenceError
                if isinstance(error,BackgroundTaskPersistenceError):
                    raise LayeredMemoryConflict('整理任务租约已变化。') from None
                raise

    def _check(self, connection, state, overview, work):
        self._assert_claim(connection,work.claim)
        if work.scenarios and state['organization_generation'] != work.organization_generation:
            raise LayeredMemoryConflict('实际读取的旧主题集合已变化。')
        if not state["enabled"] or state["settings_generation"] != work.settings_generation:
            raise LayeredMemoryConflict("整理设置已变化。")
        if state['correction_revision'] != work.correction_revision:
            raise LayeredMemoryConflict('整理反馈已变化。')
        batch = connection.execute("SELECT 1 FROM public.layered_memory_batch WHERE id=%s AND owner_id=%s "
            "AND contact_id IS NOT DISTINCT FROM %s AND status='running'", (work.id,work.scope.owner_id,work.scope.contact_id)).fetchone()
        ids = {item.memory_id for item in work.memories}
        entries = tuple(entry for entry in self.unprotected(connection, work.scope, self.eligible(overview)) if entry.memory.memory_id in ids)
        if not batch or self._manifest(connection, work.scope, entries) != work.manifest:
            raise LayeredMemoryConflict("整理实际输入已变化。")

    def check(self, work):
        with self.transaction(work.scope) as (connection, state, overview):
            self._check(connection, state, overview, work)

    def reserve_model_call(self, work):
        """同一租约下两层共享job累计额度；批次重建与guard复验不产生免费额度。"""
        with self.transaction(work.scope) as (connection,state,overview):
            if isinstance(work, ProfileWork):
                self._check_profile(connection,state,overview,work)
            else:
                self._check(connection,state,overview,work)
            row = connection.execute("UPDATE public.layered_memory_job SET model_calls_used=model_calls_used+1 "
                "WHERE task_id=%s AND owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND state='active' "
                "AND model_calls_used<model_call_limit RETURNING task_id",
                (work.claim.task_id,work.scope.owner_id,work.scope.contact_id)).fetchone()
            if row is None:
                raise OrganizationBudgetExhausted()

    def record_proposal(self, work, proposal):
        with self.transaction(work.scope) as (connection, state, overview):
            self._check(connection, state, overview, work)
            connection.execute("UPDATE public.layered_memory_batch SET output_payload=%s WHERE id=%s",
                               (Jsonb(proposal), work.id))

    def publish(self, work, proposal, budget):
        with self.transaction(work.scope) as (connection, state, overview):
            # 最终 writer 在同一锁和同一连接上复验全部输入；不另开概览连接。
            self._check(connection, state, overview, work)
            generation, now = state['organization_generation']+1,self._clock()
            _,old=self.generation_rows(connection,work.scope,state['organization_generation'])
            versions={row['scenario_id']:row['id'] for row in old}
            by_id={row['scenario_id']:row for row in old}
            replaced_ids = {version for scenario in proposal['scenarios'] for version in scenario.get('replaces', [])}
            for previous in old:
                if str(previous['id']) in replaced_ids:
                    versions.pop(previous['scenario_id'], None)
            proposed_ids = set()
            for scenario in proposal['scenarios']:
                replaced = scenario.get('replaces', [])
                scenario_id = UUID(scenario['scenario_id']) if scenario.get('scenario_id') else uuid5(
                    (work.scope.contact_id or work.scope.owner_id),str(work.scope.owner_id)+':'+scenario['topic_key'])
                if scenario_id in proposed_ids:
                    raise LayeredMemoryConflict('同批主题身份重复。')
                proposed_ids.add(scenario_id)
                if replaced and scenario_id in by_id and str(by_id[scenario_id]['id']) not in replaced:
                    raise LayeredMemoryConflict('主题归组不能覆盖未列为替换目标的旧主题。')
                if scenario_id not in by_id and connection.execute(
                    'SELECT 1 FROM public.scenario_document_version WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND scenario_id=%s',
                    (work.scope.owner_id, work.scope.contact_id, scenario_id)).fetchone():
                    raise LayeredMemoryConflict('不能将退休主题身份赋给另一主题。')
                paragraphs=list(scenario['paragraphs'])
                if scenario_id in by_id and not replaced:
                    combined=by_id[scenario_id]['paragraphs']+paragraphs
                    characters=len(scenario['title'])+len(scenario['hint'])+sum(len(item['text']) for item in combined)
                    if len(combined)>budget.max_paragraphs or characters>budget.max_characters:
                        # 每份主题保持有界；超限后以稳定续篇保留原主题及完整段落。
                        scenario_id=uuid5(scenario_id,'continuation:'+str(work.claim.task_id)+':'+str(work.id))
                if scenario_id in by_id and not replaced:
                    previous=by_id[scenario_id]
                    # 不把旧正文再送模型；合法、已核验的完整段落按原样续接，保留两批完整删除依赖。
                    paragraphs=previous['paragraphs']+paragraphs
                    prior=connection.execute("SELECT input_manifest,dependency_ids FROM public.layered_memory_batch WHERE id=%s",
                                             (previous['batch_id'],)).fetchone()
                    connection.execute("UPDATE public.layered_memory_batch SET input_manifest=input_manifest||%s,"
                        "dependency_ids=ARRAY(SELECT DISTINCT unnest(dependency_ids||%s::uuid[])),reused_version_ids=reused_version_ids||%s::uuid[] WHERE id=%s",
                        (Jsonb(prior['input_manifest']),prior['dependency_ids'],[previous['id']],work.id))
                version=uuid4()
                connection.execute("INSERT INTO public.scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,"
                    "organization_generation,schema_version,title,hint,paragraphs,created_at) VALUES(%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s)",
                    (version,work.scope.owner_id,work.scope.contact_id,scenario_id,work.id,generation,scenario['title'],scenario['hint'],Jsonb(paragraphs),now))
                versions[scenario_id]=version
                for previous in old:
                    if str(previous['id']) in replaced or previous['scenario_id'] == scenario_id:
                        connection.execute("INSERT INTO public.scenario_document_mapping(owner_id,contact_id,source_scenario_id,"
                            "source_version_id,target_scenario_id,target_version_id,batch_id) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                            (work.scope.owner_id,work.scope.contact_id,previous['scenario_id'],previous['id'],scenario_id,version,work.id))
            self.publish_generation_in_transaction(connection,work.scope,expected_generation=state['organization_generation'],scenario_version_ids=list(versions.values()))
            connection.execute("UPDATE public.layered_memory_batch SET status='succeeded' WHERE id=%s",(work.id,))
            covered=connection.execute("SELECT count(DISTINCT item->>'memory_id') AS count FROM public.layered_memory_batch b,"
                "jsonb_array_elements(b.input_manifest) item WHERE b.id IN (SELECT batch_id FROM public.scenario_document_version "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s AND id=ANY(%s::uuid[]))",
                (work.scope.owner_id,work.scope.contact_id,list(versions.values()))).fetchone()['count']
            connection.execute("UPDATE public.layered_memory_job SET pending_receipt=true,profile_status=CASE WHEN profile_required THEN 'pending' ELSE 'not_required' END,batch_number=batch_number+1,receipt_batch_id=%s,receipt_lease_generation=%s WHERE task_id=%s",(work.id,work.claim.lease_generation,work.claim.task_id,))
            connection.execute("UPDATE public.layered_memory_state SET status='ready',covered_count=%s,updated_at=%s,error_code=NULL "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",(covered,now,work.scope.owner_id,work.scope.contact_id))

    def fail(self, work, code):
        with self.transaction(work.scope) as (connection, state, overview):
            try:
                self._check(connection, state, overview, work)
            except LayeredMemoryConflict:
                return
            connection.execute("UPDATE public.layered_memory_batch SET status='failed',error_code=%s WHERE id=%s",
                               (code, work.id))
            connection.execute("UPDATE public.layered_memory_state SET status=%s,error_code=%s "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", ('paused' if code=='model_budget_exhausted' else 'failed',code,work.scope.owner_id,work.scope.contact_id))

    def worker_failed(self, claim):
        scope=organization_scope(claim.owner_id,claim.contact_id)
        with self.transaction(scope) as (connection,state,_):
            row=connection.execute("SELECT t.status,t.last_error_code,s.lease_generation FROM public.background_task t "
                "JOIN public.background_task_step s ON s.task_id=t.id WHERE t.id=%s AND s.id=%s",
                (claim.task_id,claim.step_id)).fetchone()
            if not row or row['status']!='failed' or row['lease_generation']!=claim.lease_generation:
                return
            updated=connection.execute("UPDATE public.layered_memory_job SET state='failed' WHERE task_id=%s "
                "AND state='active' AND settings_generation=%s",(claim.task_id,state['settings_generation'])).rowcount
            if updated and state['enabled']:
                connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code=%s WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                    (row['last_error_code'],scope.owner_id,scope.contact_id))

    def capture(self, scope):
        with self.transaction(scope) as (connection, state, _):
            if not state["enabled"] or state["status"] not in {"ready","paused","failed","updating","stale"}:
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
        overview = (self._overview.read_owner_in_transaction(connection, scope.owner_id, organization=True)
                if isinstance(scope, OwnerScope) else self._overview.read_contact_in_transaction(connection, scope))
        state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                                   (scope.owner_id,scope.contact_id)).fetchone()
        if (not state or not state["enabled"] or state["status"] not in {"ready","paused","failed","updating","stale"}
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
                "AND owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (allowed.version_id,snapshot.scope.owner_id,
                                                     snapshot.scope.contact_id)).fetchone()
            document = self._document(row)
            return {**document, "paragraphs": document["paragraphs"][range[0]:range[1]],
                    "paragraph_range": list(range), "organization_generation": snapshot.organization_generation}
