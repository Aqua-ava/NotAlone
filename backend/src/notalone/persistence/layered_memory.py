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
from notalone.scopes import ContactScope
from notalone.tasks.models import ClaimedBackgroundTaskStep


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
    claim: ClaimedBackgroundTaskStep


class PostgresLayeredMemoryStore:
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

    def read(self, scope):
        with self.transaction(scope) as (connection, state, overview):
            rows = []
            rows = self.generation_rows(connection,scope,state['organization_generation'])
            jobs=current_job(connection,scope)
            job=next((row for row in jobs if row['settings_generation']==state['settings_generation']),None)
            return state, self.eligible(overview), [self._document(row) for row in rows], job

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
            cancel_jobs(connection,scope,erase=action=='delete')
            if action=='delete':
                connection.execute("DELETE FROM public.layered_memory_generation WHERE owner_id=%s AND contact_id=%s",
                                   (scope.owner_id,scope.contact_id))
            enabled = action == "enable"
            if action == "delete":
                connection.execute("DELETE FROM public.layered_memory_batch WHERE owner_id=%s AND contact_id=%s",
                                   (scope.owner_id, scope.contact_id))
            else:
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

    def enqueue(self, scope, budget, contract, *, action='refresh', revision=None):
        with self.transaction(scope) as (connection,state,overview):
            if not state['enabled']:
                raise LayeredMemoryConflict('本联系人尚未开启整理。')
            entries=self.eligible(overview)
            manifest=self._manifest(connection,scope,entries)
            dependencies={entry.memory.memory_id for entry in entries}
            dependencies.update(identifier for entry in entries for identifier in entry.dependency_ids)
            return enqueue_coverage(connection,scope,state,manifest,dependencies,contract,budget,action=action,revision=revision)

    def pending_scopes(self, owner_id):
        with psycopg.connect(self._database_url) as connection:
            rows=connection.execute("SELECT DISTINCT j.contact_id FROM public.layered_memory_job j "
                "JOIN public.layered_memory_state s ON s.owner_id=j.owner_id AND s.contact_id=j.contact_id "
                "WHERE j.owner_id=%s AND j.state='active' AND s.enabled AND j.settings_generation=s.settings_generation",
                (owner_id,)).fetchall()
            return tuple(ContactScope(owner_id,row[0]) for row in rows)

    def pending(self, scope):
        with self.transaction(scope) as (connection,state,_):
            if not state['enabled']:
                return None
            # 到达最后一次租约尝试后，已经独立核验且发布的精确批次只补回执。
            connection.execute("UPDATE public.background_task_step step SET status='pending',attempt_count=0,worker_id=NULL,"
                "lease_expires_at=NULL,lease_generation=lease_generation+1 FROM public.layered_memory_job j "
                "JOIN public.layered_memory_batch b ON b.id=j.receipt_batch_id AND b.task_id=j.task_id "
                "WHERE step.task_id=j.task_id AND j.owner_id=%s AND j.contact_id=%s AND j.state='active' "
                "AND j.pending_receipt AND b.status='succeeded' AND b.settings_generation=j.settings_generation "
                "AND (step.status IN ('failed','retryable') OR step.status='running' AND step.lease_expires_at<=now())",
                (scope.owner_id,scope.contact_id))
            connection.execute("UPDATE public.background_task t SET status='queued',last_error_code=NULL,finished_at=NULL "
                "FROM public.layered_memory_job j WHERE t.id=j.task_id AND j.owner_id=%s AND j.contact_id=%s "
                "AND j.state='active' AND j.pending_receipt AND EXISTS(SELECT 1 FROM public.background_task_step s "
                "WHERE s.task_id=t.id AND s.status='pending')",(scope.owner_id,scope.contact_id))
            # 领取路径可能已把最后一次失联租约判失败；无发布证明时不能留在updating。
            connection.execute("UPDATE public.layered_memory_job j SET state='failed' FROM public.background_task t "
                "WHERE t.id=j.task_id AND j.owner_id=%s AND j.contact_id=%s AND j.settings_generation=%s "
                "AND j.state='active' AND NOT j.pending_receipt AND t.status='failed'",
                (scope.owner_id,scope.contact_id,state['settings_generation']))
            connection.execute("UPDATE public.layered_memory_state s SET status='failed',error_code=COALESCE(t.last_error_code,s.error_code) "
                "FROM public.layered_memory_job j JOIN public.background_task t ON t.id=j.task_id "
                "WHERE s.owner_id=j.owner_id AND s.contact_id=j.contact_id AND s.settings_generation=j.settings_generation "
                "AND j.owner_id=%s AND j.contact_id=%s AND j.state='failed' AND t.status='failed' AND s.enabled",
                (scope.owner_id,scope.contact_id))
            row=connection.execute("SELECT task_id FROM public.layered_memory_job WHERE owner_id=%s AND contact_id=%s "
                "AND settings_generation=%s AND state='active' LIMIT 1",
                (scope.owner_id,scope.contact_id,state['settings_generation'])).fetchone()
            return row['task_id'] if row else None

    def prepare(self, scope, budget, contract, claim):
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
                if job['target_manifest'] and not connection.execute("SELECT 1 FROM public.layered_memory_batch WHERE id=%s "
                    "AND task_id=%s AND settings_generation=%s AND status='succeeded'",
                    (job['receipt_batch_id'],claim.task_id,job['settings_generation'])).fetchone():
                    raise LayeredMemoryConflict('缺少实际已发布的批次回执。')
                return None
            # 同一步重领只恢复未提交的批次；租约本身仍由任务仓储校验。
            connection.execute("DELETE FROM public.layered_memory_batch WHERE task_id=%s AND status<>'succeeded'",(claim.task_id,))
            covered={item['memory_id'] for batch in connection.execute(
                "SELECT b.input_manifest FROM public.layered_memory_generation g JOIN public.scenario_document_version v "
                "ON v.id=ANY(g.scenario_version_ids) AND v.owner_id=g.owner_id AND v.contact_id=g.contact_id "
                "JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE g.owner_id=%s AND g.contact_id=%s "
                "AND g.organization_generation=%s",(scope.owner_id,scope.contact_id,state['organization_generation'])).fetchall()
                for item in batch['input_manifest']}
            target={item['memory_id'] for item in job['target_manifest']}
            entries=tuple(entry for entry in self.eligible(overview) if str(entry.memory.memory_id) in target-covered)
            selected=[]
            for entry in entries[:budget.max_memories]:
                payload=[self._input(item).to_payload() for item in selected]+[self._input(entry).to_payload()]
                if len(json.dumps(payload,ensure_ascii=False))>budget.max_characters:
                    break
                selected.append(entry)
            if not selected:
                if entries:
                    connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code='input_budget_exceeded' "
                        "WHERE owner_id=%s AND contact_id=%s",(scope.owner_id,scope.contact_id))
                else:
                    connection.execute("UPDATE public.layered_memory_job SET pending_receipt=true WHERE task_id=%s",(claim.task_id,))
                return None
            entries=tuple(selected)
            manifest=self._manifest(connection,scope,entries)
            memories=tuple(self._input(entry) for entry in entries)
            dependencies={entry.memory.memory_id for entry in entries}
            dependencies.update(identifier for entry in entries for identifier in entry.dependency_ids)
            id=uuid4()
            key=_digest({'job':str(claim.task_id),'inputs':manifest})
            connection.execute("INSERT INTO public.layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,"
                "input_manifest,input_payload,dependency_ids,created_at,task_id) VALUES(%s,%s,%s,%s,%s,'running',%s,%s,%s,%s,%s)",
                (id,scope.owner_id,scope.contact_id,state['settings_generation'],key,Jsonb(manifest),
                 Jsonb([item.to_payload() for item in memories]),sorted(dependencies),self._clock(),claim.task_id))
            connection.execute("UPDATE public.layered_memory_state SET status='updating',error_code=NULL WHERE owner_id=%s AND contact_id=%s",
                               (scope.owner_id,scope.contact_id))
            return OrganizationWork(id,scope,state['settings_generation'],memories,manifest,claim)

    @staticmethod
    def generation_rows(connection,scope,generation):
        return connection.execute("SELECT v.* FROM public.scenario_document_version v JOIN public.layered_memory_generation g "
            "ON v.id=ANY(g.scenario_version_ids) AND v.owner_id=g.owner_id AND v.contact_id=g.contact_id "
            "WHERE g.owner_id=%s AND g.contact_id=%s AND g.organization_generation=%s ORDER BY v.scenario_id",
            (scope.owner_id,scope.contact_id,generation)).fetchall()

    def publish_generation_in_transaction(self, connection, scope, *, expected_generation, scenario_version_ids, profile_version_id=None):
        ids=list(scenario_version_ids)
        if len(ids)!=len(set(ids)) or profile_version_id is not None:
            raise LayeredMemoryConflict('整理集合包含重复版本或尚未支持的画像。')
        overview=self._overview.read_contact_in_transaction(connection,scope)
        current={item['memory_id']:item for item in self._manifest(connection,scope,self.eligible(overview))}
        rows=connection.execute("SELECT v.id,v.scenario_id,b.input_manifest,b.dependency_ids FROM public.scenario_document_version v "
            "JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE v.owner_id=%s AND v.contact_id=%s AND v.id=ANY(%s::uuid[])",
            (scope.owner_id,scope.contact_id,ids)).fetchall()
        if (len(rows)!=len(ids) or len({row['scenario_id'] for row in rows})!=len(rows)
                or any(current.get(item['memory_id'])!=item for row in rows for item in row['input_manifest'])):
            raise LayeredMemoryConflict('整理集合包含失效或跨范围版本。')
        dependencies=sorted({id for row in rows for id in row['dependency_ids']})
        generation=connection.execute("UPDATE public.layered_memory_state SET organization_generation=organization_generation+1 "
            "WHERE owner_id=%s AND contact_id=%s AND enabled AND organization_generation=%s RETURNING organization_generation",
            (scope.owner_id,scope.contact_id,expected_generation)).fetchone()
        if generation is None:
            raise LayeredMemoryConflict('整理版本集合已变化。')
        generation=generation['organization_generation']
        connection.execute("INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,"
            "scenario_version_ids,profile_version_id,dependency_ids) VALUES(%s,%s,%s,2,%s,%s,%s)",
            (scope.owner_id,scope.contact_id,generation,ids,profile_version_id,dependencies))
        return generation

    @staticmethod
    def _input(entry):
        memory = entry.memory
        return OrganizationInput(memory.memory_id,memory.revision,memory.text,entry.provenance_kind,
            memory.timing.to_payload(),memory.event.to_payload(current=True) if memory.event else None,
            memory.category.value,memory.valid_at.isoformat() if memory.valid_at else None,
            memory.invalid_at.isoformat() if memory.invalid_at else None)

    def _check(self, connection, state, overview, work):
        if work.claim is not None:
            from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
            try:
                with connection.cursor(row_factory=tuple_row) as cursor:
                    PostgresBackgroundTaskRepository._assert_valid_claim(cursor,work.claim)
            except Exception as error:
                from notalone.persistence.background_tasks import BackgroundTaskPersistenceError
                if isinstance(error,BackgroundTaskPersistenceError):
                    raise LayeredMemoryConflict('整理任务租约已变化。') from None
                raise
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

    def charge(self, work):
        with self.transaction(work.scope) as (connection,state,overview):
            self._check(connection,state,overview,work)
            row=connection.execute("UPDATE public.layered_memory_job SET model_calls_used=model_calls_used+1 "
                "WHERE task_id=%s AND model_calls_used<model_call_limit RETURNING model_calls_used",(work.claim.task_id,)).fetchone()
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
            old=self.generation_rows(connection,work.scope,state['organization_generation'])
            versions={row['scenario_id']:row['id'] for row in old}
            by_id={row['scenario_id']:row for row in old}
            for scenario in proposal['scenarios']:
                scenario_id=uuid5(work.scope.contact_id,str(work.scope.owner_id)+':'+scenario['topic_key'])
                paragraphs=list(scenario['paragraphs'])
                if scenario_id in by_id:
                    combined=by_id[scenario_id]['paragraphs']+paragraphs
                    characters=len(scenario['title'])+len(scenario['hint'])+sum(len(item['text']) for item in combined)
                    if len(combined)>budget.max_paragraphs or characters>budget.max_characters:
                        # 每份主题保持有界；超限后以稳定续篇保留原主题及完整段落。
                        scenario_id=uuid5(scenario_id,'continuation:'+str(work.claim.task_id)+':'+str(work.id))
                if scenario_id in by_id:
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
            self.publish_generation_in_transaction(connection,work.scope,expected_generation=state['organization_generation'],scenario_version_ids=list(versions.values()))
            connection.execute("UPDATE public.layered_memory_batch SET status='succeeded' WHERE id=%s",(work.id,))
            covered=connection.execute("SELECT count(DISTINCT item->>'memory_id') AS count FROM public.layered_memory_batch b,"
                "jsonb_array_elements(b.input_manifest) item WHERE b.id IN (SELECT batch_id FROM public.scenario_document_version "
                "WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[]))",
                (work.scope.owner_id,work.scope.contact_id,list(versions.values()))).fetchone()['count']
            connection.execute("UPDATE public.layered_memory_job SET pending_receipt=true,batch_number=batch_number+1,receipt_batch_id=%s,receipt_lease_generation=%s WHERE task_id=%s",(work.id,work.claim.lease_generation,work.claim.task_id,))
            connection.execute("UPDATE public.layered_memory_state SET status='ready',covered_count=%s,updated_at=%s,error_code=NULL "
                "WHERE owner_id=%s AND contact_id=%s",(covered,now,work.scope.owner_id,work.scope.contact_id))

    def fail(self, work, code):
        with self.transaction(work.scope) as (connection, state, overview):
            try:
                self._check(connection, state, overview, work)
            except LayeredMemoryConflict:
                return
            connection.execute("UPDATE public.layered_memory_batch SET status='failed',error_code=%s WHERE id=%s",
                               (code, work.id))
            connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code=%s "
                "WHERE owner_id=%s AND contact_id=%s", (code,work.scope.owner_id,work.scope.contact_id))

    def worker_failed(self, claim):
        scope=ContactScope(claim.owner_id,claim.contact_id)
        with self.transaction(scope) as (connection,state,_):
            row=connection.execute("SELECT t.status,t.last_error_code,s.lease_generation FROM public.background_task t "
                "JOIN public.background_task_step s ON s.task_id=t.id WHERE t.id=%s AND s.id=%s",
                (claim.task_id,claim.step_id)).fetchone()
            if not row or row['status']!='failed' or row['lease_generation']!=claim.lease_generation:
                return
            updated=connection.execute("UPDATE public.layered_memory_job SET state='failed' WHERE task_id=%s "
                "AND state='active' AND settings_generation=%s",(claim.task_id,state['settings_generation'])).rowcount
            if updated and state['enabled']:
                connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code=%s WHERE owner_id=%s AND contact_id=%s",
                    (row['last_error_code'],scope.owner_id,scope.contact_id))

    def capture(self, scope):
        with self.transaction(scope) as (connection, state, _):
            if not state["enabled"] or state["status"] not in {"ready","paused","failed","updating","stale"}:
                return None
            rows=self.generation_rows(connection,scope,state['organization_generation'])
            if not rows:
                return None
            dependencies=connection.execute("SELECT DISTINCT unnest(b.dependency_ids) AS id FROM public.layered_memory_batch b "
                "JOIN public.scenario_document_version v ON v.batch_id=b.id WHERE v.id=ANY(%s::uuid[]) ORDER BY id",([row['id'] for row in rows],)).fetchall()
            return LayeredMemorySnapshot(2,scope,state['settings_generation'],state['organization_generation'],
                tuple(ScenarioDirectoryEntry(row['scenario_id'],row['id'],row['title'],row['hint'],len(row['paragraphs'])) for row in rows),
                tuple(row['id'] for row in dependencies))

    def validate_in_transaction(self, connection, snapshot):
        """调用方须已持 contact→owner 锁；最终 writer 复用该连接，不再申请范围锁。"""
        if not isinstance(snapshot, LayeredMemorySnapshot) or snapshot.schema_version != 2:
            return False
        scope = snapshot.scope
        overview = self._overview.read_contact_in_transaction(connection, scope)
        state = connection.execute("SELECT * FROM public.layered_memory_state WHERE owner_id=%s AND contact_id=%s",
                                   (scope.owner_id,scope.contact_id)).fetchone()
        if (not state or not state["enabled"] or state["status"] not in {"ready","paused","failed","updating","stale"}
                or state["settings_generation"] != snapshot.settings_generation
                or state["organization_generation"] != snapshot.organization_generation):
            return False
        rows = connection.execute("SELECT version.id,version.scenario_id,batch.input_manifest,batch.dependency_ids "
            "FROM public.scenario_document_version version JOIN public.layered_memory_batch batch ON batch.id=version.batch_id "
            "JOIN public.layered_memory_generation g ON version.id=ANY(g.scenario_version_ids) AND version.owner_id=g.owner_id AND version.contact_id=g.contact_id "
            "WHERE g.owner_id=%s AND g.contact_id=%s AND g.organization_generation=%s",
            (scope.owner_id,scope.contact_id,snapshot.organization_generation)).fetchall()
        expected = {(item.scenario_id,item.version_id) for item in snapshot.scenarios}
        actual = {(row["scenario_id"],row["id"]) for row in rows}
        current = {item["memory_id"]: item for item in self._manifest(connection,scope,self.eligible(overview))}
        return (expected == actual and bool(actual)
                and set(snapshot.dependency_ids) == {id for row in rows for id in row["dependency_ids"]}
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
