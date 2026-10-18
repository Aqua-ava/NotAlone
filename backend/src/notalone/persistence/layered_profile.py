"""长期背景短事务；实际主题输入与全部底层版本从统一集合冻结。"""

from dataclasses import dataclass
from datetime import timedelta
import hashlib
import json
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from notalone.memory.layered import LayeredMemoryConflict
from notalone.scopes import ContactScope, OwnerScope, organization_scope
from notalone.tasks.models import ClaimedBackgroundTaskStep


@dataclass(frozen=True, slots=True, repr=False)
class ProfileWork:
    id: UUID
    token: UUID
    scope: ContactScope | OwnerScope
    settings_generation: int
    organization_generation: int
    scenario_version_ids: tuple[UUID, ...]
    memories: tuple
    scenarios: tuple[dict, ...]
    manifest: list
    budget_batch_id: UUID
    claim: ClaimedBackgroundTaskStep
    correction_revision: int = 0
    corrections: tuple[dict, ...] = ()
    previous_profile: dict | None = None
    changed_scenario_ids: tuple[str, ...] = ()


class LayeredProfileStore:
    """复用同一Store的事务／输入复验；没有独立连接或范围锁。"""

    def profile_input_entries(self, connection, scope, allowed, input_rows):
        """正式L3与评测共同继承实际主题批次的完整底层清单。"""
        by_id = {item['memory_id']: item for row in input_rows for item in row['input_manifest']}
        entries = tuple(entry for entry in allowed if str(entry.memory.memory_id) in by_id)
        manifest = self._manifest(connection, scope, entries)
        if {item['memory_id']: item for item in manifest} != by_id:
            raise LayeredMemoryConflict('主题的底层实际版本已失效。')
        return entries, manifest

    @staticmethod
    def profile_row(connection, scope, version_id):
        return connection.execute("SELECT v.*,b.scenario_version_ids,b.input_manifest,b.dependency_ids FROM "
            "public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id "
            "WHERE v.id=%s AND v.owner_id=%s AND v.contact_id IS NOT DISTINCT FROM %s",
            (version_id,scope.owner_id,scope.contact_id)).fetchone()

    @staticmethod
    def profile_document(row):
        if not row or row["withdrawn"]:
            return None
        return {"version_id": str(row["id"]), "system_generated": True,
                "updated_at": row["created_at"].isoformat(), "entries": row["entries"]}

    def prepare_profile(self, scope, budget, contract, *, lease_seconds, claim):
        with self.transaction(scope) as (connection,state,overview):
            self._assert_claim(connection,claim)
            job = connection.execute("SELECT * FROM public.layered_memory_job WHERE task_id=%s AND owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                (claim.task_id,scope.owner_id,scope.contact_id)).fetchone()
            if not job or job['state']!='active' or job['settings_generation']!=state['settings_generation'] or not job['profile_required']:
                raise LayeredMemoryConflict("长期背景所属工作已变化。")
            if not state["enabled"] or state["status"] not in {"ready", "failed", "updating", "paused"}:
                return None
            generation, rows = self.generation_rows(connection,scope,state["organization_generation"])
            if not generation or not rows:
                return None
            ids = tuple(row["id"] for row in rows)
            allowed = self.unprotected(connection, scope, self.eligible(overview))
            allowed_ids = {str(entry.memory.memory_id) for entry in allowed}
            # 冻结集合仍绑定全部当前版本；实际语义输入只读取可证明独立的主题。
            input_rows = [row for row in rows if all(ref['memory_id'] in allowed_ids
                for paragraph in row['paragraphs'] for ref in paragraph['references'])]
            if not input_rows:
                connection.execute("UPDATE public.layered_memory_job SET profile_status='not_required' WHERE task_id=%s", (claim.task_id,))
                return None
            # 全部实际读入L2批次的底层版本和隐藏依赖都继承，不能从直接引用反推。
            entries, manifest = self.profile_input_entries(connection, scope, allowed, input_rows)
            memories = tuple(self._input(entry) for entry in entries)
            scenarios = tuple(self._document(row) for row in input_rows)
            corrections = self.correction_context(connection, scope)
            prior = connection.execute("SELECT v.*,b.input_manifest,b.scenario_version_ids,b.correction_input,b.input_payload "
                "FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id "
                "WHERE v.owner_id=%s AND v.contact_id IS NOT DISTINCT FROM %s AND NOT v.withdrawn "
                "AND b.status='succeeded' AND b.settings_generation=%s ORDER BY v.created_at DESC LIMIT 1",
                (scope.owner_id, scope.contact_id, state['settings_generation'])).fetchone()
            current_manifest = {item['memory_id']: item for item in manifest}
            # 旧画像也属于模型实际输入；完整递归依据失效时不能回流其正文。
            if prior and (corrections or prior['correction_input'] or any(
                    current_manifest.get(item['memory_id']) != item for item in prior['input_manifest'])):
                prior = None
            previous_profile = self.profile_document(prior)
            old_ids = set(prior['scenario_version_ids']) if prior else set()
            changed_ids = tuple(str(identifier) for identifier in ids if identifier not in old_ids)
            if prior and set(ids) == old_ids and prior['input_payload'].get('contract') == contract:
                if generation['profile_version_id'] != prior['id']:
                    self.publish_generation_in_transaction(connection, scope,
                        expected_generation=state['organization_generation'], scenario_version_ids=ids,
                        profile_version_id=prior['id'])
                connection.execute("UPDATE public.layered_memory_job SET profile_status='succeeded' WHERE task_id=%s", (claim.task_id,))
                connection.execute("UPDATE public.layered_memory_state SET status='ready',error_code=NULL "
                    "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id, scope.contact_id))
                return None
            payload = {"contract": contract, "previous_profile": previous_profile, "changed_scenario_ids": changed_ids, "scenarios": list(scenarios), "memories": [item.to_payload() for item in memories], 'corrections': corrections}
            if len(json.dumps(payload,ensure_ascii=False)) > budget.max_characters:
                connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code='profile_input_budget_exceeded' "
                    "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id,scope.contact_id))
                return None
            key = hashlib.sha256(json.dumps({"versions": sorted(str(id) for id in ids),
                "settings": state["settings_generation"],"task":str(claim.task_id),"revision":job["revision"],"contract": contract,"budget": budget.to_payload()},
                sort_keys=True).encode()).hexdigest()
            previous = connection.execute("SELECT * FROM public.layered_profile_batch WHERE owner_id=%s "
                "AND contact_id IS NOT DISTINCT FROM %s AND work_key=%s", (scope.owner_id,scope.contact_id,key)).fetchone()
            now = self._clock()
            if previous and previous["status"] in {"succeeded", "withdrawn"}:
                connection.execute("UPDATE public.layered_memory_job SET profile_status='succeeded' WHERE task_id=%s",(claim.task_id,))
                return None
            # 实际L2依赖可跨历史批次；本次调用只扣当前明确授权job的累计额度。
            budget_batch_id = max(rows,key=lambda row: row["organization_generation"])["batch_id"]
            call_budget = job
            if call_budget["model_calls_used"] >= call_budget["model_call_limit"]:
                if previous:
                    connection.execute("UPDATE public.layered_profile_batch SET status='failed',error_code='model_call_budget_exhausted' WHERE id=%s",
                        (previous["id"],))
                connection.execute("UPDATE public.layered_memory_state SET status='paused',error_code='model_call_budget_exhausted' "
                    "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id,scope.contact_id))
                return None
            if (previous and previous["status"] == "running" and previous["attempt_count"] >= 2
                    and previous["lease_expires_at"] <= now):
                connection.execute("UPDATE public.layered_profile_batch SET status='failed',error_code='profile_retry_exhausted' WHERE id=%s",
                    (previous["id"],))
                connection.execute("UPDATE public.layered_memory_state SET status='failed',error_code='profile_retry_exhausted' "
                    "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (scope.owner_id,scope.contact_id))
                return None
            if previous:
                if (previous["status"] in {"succeeded", "withdrawn"} or previous["attempt_count"] >= 2
                        or previous["status"] == "running" and previous["lease_expires_at"] > now
                        or previous["status"] == "failed" and previous["error_code"] not in {"model_call_timeout", "model_call_failed"}):
                    return None
            if connection.execute("SELECT 1 FROM public.layered_profile_batch WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s "
                    "AND status='running' AND lease_expires_at>%s AND work_key<>%s",
                    (scope.owner_id,scope.contact_id,now,key)).fetchone():
                return None
            dependencies = sorted({id for row in input_rows for id in row["dependency_ids"]})
            dependencies = sorted(set(dependencies) | self.correction_dependency_ids(connection, scope))
            token, id = uuid4(), previous["id"] if previous else uuid4()
            if previous:
                connection.execute("UPDATE public.layered_profile_batch SET work_token=%s,status='running',attempt_count=attempt_count+1,"
                    "lease_expires_at=%s,organization_generation=%s,input_manifest=%s,input_payload=%s,output_payload=NULL,error_code=NULL "
                    "WHERE id=%s", (token,now+timedelta(seconds=lease_seconds),state["organization_generation"],
                    Jsonb(manifest),Jsonb(payload),id))
            else:
                connection.execute("INSERT INTO public.layered_profile_batch(id,owner_id,contact_id,settings_generation,"
                    "organization_generation,work_key,work_token,budget_batch_id,task_id,status,lease_expires_at,scenario_version_ids,input_manifest,"
                    "input_payload,dependency_ids,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'running',%s,%s,%s,%s,%s,%s)",
                    (id,scope.owner_id,scope.contact_id,state["settings_generation"],state["organization_generation"],key,token,budget_batch_id,claim.task_id,
                    now+timedelta(seconds=lease_seconds),list(ids),Jsonb(manifest),Jsonb(payload),dependencies,now))
            connection.execute("UPDATE public.layered_memory_state SET status='updating',error_code=NULL WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                (scope.owner_id,scope.contact_id))
            connection.execute('UPDATE public.layered_profile_batch SET correction_input=%s WHERE id=%s', (Jsonb(corrections), id))
            return ProfileWork(id,token,scope,state["settings_generation"],state["organization_generation"],ids,memories,scenarios,manifest,budget_batch_id,claim,state['correction_revision'],corrections,previous_profile,changed_ids)

    def _check_profile(self, connection, state, overview, work):
        self._assert_claim(connection,work.claim)
        batch = connection.execute("SELECT * FROM public.layered_profile_batch WHERE id=%s AND owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
            (work.id,work.scope.owner_id,work.scope.contact_id)).fetchone()
        generation, rows = self.generation_rows(connection,work.scope,state["organization_generation"])
        current = {item["memory_id"]: item for item in self._manifest(connection,work.scope,self.eligible(overview))}
        if (not state["enabled"] or state["settings_generation"] != work.settings_generation
                or state['correction_revision'] != work.correction_revision
                or state["organization_generation"] != work.organization_generation
                or not generation or {r["id"] for r in rows} != set(work.scenario_version_ids)
                or not batch or batch["status"] != "running" or batch["work_token"] != work.token
                or batch["budget_batch_id"] != work.budget_batch_id or batch["task_id"] != work.claim.task_id
                or batch["lease_expires_at"] <= self._clock()
                or any(current.get(item["memory_id"]) != item for item in work.manifest)):
            raise LayeredMemoryConflict("长期背景的范围、完整主题集合或实际输入已变化。")

    def check_profile(self, work):
        with self.transaction(work.scope) as (connection,state,overview):
            self._check_profile(connection,state,overview,work)

    def record_profile_proposal(self, work, proposal):
        with self.transaction(work.scope) as (connection,state,overview):
            self._check_profile(connection,state,overview,work)
            connection.execute("UPDATE public.layered_profile_batch SET output_payload=%s WHERE id=%s", (Jsonb(proposal),work.id))

    def publish_profile(self, work, proposal, *, qualification_guard=None):
        with self.transaction(work.scope) as (connection,state,overview):
            self._check_profile(connection,state,overview,work)
            if qualification_guard is not None:
                qualification_guard(connection)
            id = uuid4()
            connection.execute("INSERT INTO public.layered_profile_version(id,owner_id,contact_id,batch_id,schema_version,entries,created_at) "
                "VALUES(%s,%s,%s,%s,2,%s,%s)", (id,work.scope.owner_id,work.scope.contact_id,work.id,Jsonb(proposal["entries"]),self._clock()))
            self.publish_generation_in_transaction(connection,work.scope,expected_generation=work.organization_generation,
                scenario_version_ids=work.scenario_version_ids,profile_version_id=id)
            connection.execute("UPDATE public.layered_profile_batch SET status='succeeded' WHERE id=%s", (work.id,))
            connection.execute("UPDATE public.layered_memory_job SET profile_status='succeeded' WHERE task_id=%s",(work.claim.task_id,))
            connection.execute("UPDATE public.layered_memory_state SET status='ready',error_code=NULL,updated_at=%s "
                "WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s", (self._clock(),work.scope.owner_id,work.scope.contact_id))

    def fail_profile(self, work, code):
        with self.transaction(work.scope) as (connection,state,overview):
            try:
                self._check_profile(connection,state,overview,work)
            except LayeredMemoryConflict:
                return
            connection.execute("UPDATE public.layered_profile_batch SET status='failed',error_code=%s WHERE id=%s", (code,work.id))
            connection.execute("UPDATE public.layered_memory_job SET profile_status='failed' WHERE task_id=%s",(work.claim.task_id,))
            connection.execute("UPDATE public.layered_memory_state SET status=%s,error_code=%s WHERE owner_id=%s AND contact_id IS NOT DISTINCT FROM %s",
                ("paused" if code == "model_call_budget_exhausted" else "failed",code,work.scope.owner_id,work.scope.contact_id))

    def withdraw_profile(self, scope, expected_settings, expected_generation, version_id):
        with self.transaction(scope) as (connection,state,overview):
            if state["settings_generation"] != expected_settings:
                raise LayeredMemoryConflict("范围设置已变化。")
            profile = self.profile_row(connection,scope,version_id)
            if not profile:
                raise LayeredMemoryConflict("长期背景已失效。")
            generation, rows = self.generation_rows(connection,scope,state["organization_generation"])
            if (profile["withdrawn"] and state["organization_generation"] == expected_generation + 1
                    and generation and generation["profile_version_id"] is None):
                return
            if (state["organization_generation"] != expected_generation or not generation
                    or generation["profile_version_id"] != version_id):
                raise LayeredMemoryConflict("长期背景版本已变化。")
            from notalone.persistence.reply_cleanup import delete_source_replies
            delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
                removed_ids={version_id}, revoke_running_scope=False)
            connection.execute("UPDATE public.layered_profile_version SET withdrawn=true WHERE id=%s", (version_id,))
            connection.execute("UPDATE public.layered_profile_batch SET status='withdrawn' WHERE id=%s", (profile["batch_id"],))
            self.publish_generation_in_transaction(connection,scope,expected_generation=expected_generation,
                scenario_version_ids=[r["id"] for r in rows])
