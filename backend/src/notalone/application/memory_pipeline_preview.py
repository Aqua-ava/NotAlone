"""隔离 PostgreSQL 上的正式记忆管线预览；不另写提取或整理算法。"""

from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

import psycopg

from notalone.ingest.import_command import import_file
from notalone.ingest.models import ImportConfirmationRequest
from notalone.ingest.preview import build_preview
from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
from notalone.persistence.contact_memory_index import PostgresContactMemoryIndexRepository
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.scopes import ContactScope, OwnerScope
from notalone.tasks.command import run_worker
from notalone.tasks.organization_dispatch import EmbeddedOrganizationDispatcher
from notalone.tasks.worker import BackgroundTaskWorker


class MemoryPipelinePreview:
    """仅把生产 Worker 的存储目标换成显式隔离库；水位和恢复仍由生产实现负责。"""

    def __init__(self, database_url, *, expected_database, extraction_runner, layered_service, max_input_records=20, max_total_records=40):
        with psycopg.connect(database_url) as connection:
            if (connection.info.dbname != expected_database or not expected_database.endswith('_test')):
                raise ValueError('记忆预览只允许明确命名的隔离测试库。')
        if not isinstance(max_input_records, int) or not isinstance(max_total_records, int) or not 0 < max_input_records <= max_total_records:
            raise ValueError("预览范围须是明确正整数记录数。")
        self.max_input_records = max_input_records
        self.max_total_records = max_total_records
        self.database_url = database_url
        self.layered = layered_service
        self.repository = PostgresBackgroundTaskRepository(database_url)
        self.memory = PostgresMemoryStore(database_url)
        self.owner_memory = PostgresOwnerMemoryStore(database_url)
        self.worker = BackgroundTaskWorker(repository=self.repository, extraction_runner=extraction_runner,
            index_repository=PostgresContactMemoryIndexRepository(database_url), organization_runner=self.layered)
        self.layered.attach_dispatcher(EmbeddedOrganizationDispatcher(database_url))

    def submit(self, *, path, owner_id, selection, initialize_owner=False):
        """正式来源导入负责身份、幂等与任务生成；记录上限在装配时明确。"""
        path = Path(path)
        preview = build_preview(path)
        if preview.record_count > self.max_input_records:
            raise ValueError('本次输入超过明确授权的预览记录数。')
        result = import_file(path=path, owner_id=owner_id, initialize_owner=initialize_owner,
            initialize_first_owner_identity=initialize_owner,
            expected_content_sha256=preview.content_sha256,
            confirmation=ImportConfirmationRequest(selection), repository=PostgresIngestRepository(self.database_url))
        return {'scope': ContactScope(result.owner_id or owner_id, result.contact_id), 'task_id': result.task_id,
                'source_id': result.source_document_id, 'outcome': result.outcome}

    def execute(self, *, scope, task_id, retry_failed=False):
        """执行或恢复指定任务；成功步骤、水位和失败范围均从隔离库读取。"""
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute('SELECT count(*) FROM public.message WHERE owner_id=%s AND contact_id=%s',
                                       (scope.owner_id, scope.contact_id)).fetchone()[0]
        if count > self.max_total_records:
            raise ValueError('累计资料超过明确授权的预览记录数。')
        task = self.repository.get_task(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task_id)
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            result = run_worker(worker=self.worker, lock_connection=connection,
                owner_id=scope.owner_id, contact_id=scope.contact_id, worker_id=uuid4(), task_id=task_id,
                retry_repository=self.repository if retry_failed and task.status.value == 'failed' else None)
        task = self.repository.get_task(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task_id)
        if task.status.value != 'succeeded':
            return {'execution': asdict(result), **self.read(scope)}
        for target in (scope, OwnerScope(scope.owner_id)):
            state = self.layered.read(target)
            if retry_failed and state['enabled'] and state['work_id'] and state['status'] in {'failed', 'paused'}:
                self.layered.command(target, 'continue', state['settings_generation'], state['work_revision'])
            else:
                self.layered.command(target, 'refresh' if state['enabled'] else 'enable', state['settings_generation'])
        return {'execution': asdict(result), **self.read(scope)}

    def close(self):
        self.layered.stop()

    def read(self, scope):
        """导出当前状态，不拼接历史批次；候选与采纳明确分开。"""
        return {'preview_only': True, 'publication_scope': 'isolated_database',
            'l1': {'contact': [asdict(item) for item in self.memory.list_confirmed(scope)],
                   'owner': [asdict(item) for item in self.owner_memory.list_active(scope.owner_id)],
                   'pending': [asdict(item) for item in self.memory.list_pending_candidates(scope)]},
            'contact': self.layered.read(scope), 'owner': self.layered.read(OwnerScope(scope.owner_id))}


def build_memory_pipeline_preview(database_url, *, expected_database, max_input_records=20, max_total_records=40):
    """实际 DeepSeek 预览沿用生产装配；所有 HTTP 请求仍扣已有问题总账。"""
    import os
    from notalone.experiments.problem_budget import ProblemBudget, ProblemStopped
    from notalone.application.organization_runtime import build_layered_memory_service
    from notalone.tasks.worker import PostgresMemoryExtractionRunner
    path, round_id = os.environ.get('NOTALONE_PROBLEM_BUDGET'), os.environ.get('NOTALONE_PROBLEM_ROUND')
    if not path or not round_id:
        raise ProblemStopped('真实预览必须绑定已有累计预算和当前轮次。')
    budget = ProblemBudget(path)
    with budget.connection() as connection:
        budget.check(connection)
        if not connection.execute('SELECT 1 FROM rounds WHERE id=? AND outcome IS NULL', (round_id,)).fetchone():
            raise ProblemStopped('预览轮次尚未开启。')
    # 在创建模型和服务前拒绝非隔离目标。
    with psycopg.connect(database_url) as connection:
        if connection.info.dbname != expected_database or not expected_database.endswith('_test'):
            raise ValueError('记忆预览只允许明确命名的隔离测试库。')
    return MemoryPipelinePreview(database_url, expected_database=expected_database,
        max_input_records=max_input_records, max_total_records=max_total_records,
        extraction_runner=PostgresMemoryExtractionRunner(database_url),
        layered_service=build_layered_memory_service(database_url))
