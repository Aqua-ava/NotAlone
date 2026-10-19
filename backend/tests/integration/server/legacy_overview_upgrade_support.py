"""冻结 062/063 数据库中的人工更正夹具；升级后仍走当前公开接口。"""

from datetime import datetime, timezone
import json
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from notalone.persistence.memory_correction import candidate_from_row, record_decision
from notalone.scopes import ContactScope


UPGRADE_TAIL = (
    '063_relationship_overview_projection.sql',
    '064_owner_memory_revision.sql',
    '065_expression_preferences.sql',
    '066_skill_learning_drafts.sql',
    '067_memory_upgrade_batches.sql',
    '068_skill_review_publication.sql',
    '069_skill_history_operations.sql',
    '070_skill_scope_policies.sql',
    '071_bounded_runtime_evidence.sql',
    '072_scoped_media_lifecycle.sql',
    '073_layered_scenario_documents.sql',
    '074_layered_memory_coverage.sql',
    '075_layered_profile_generation.sql',
    '076_layered_memory_maintenance.sql',
    '077_owner_layered_scope.sql',
    '078_layered_memory_corrections.sql',
    '079_organization_quality.sql',
    '080_memory_merge_parents.sql',
    '081_memory_retirement_reason.sql',
    '082_memory_full_source_lifecycle.sql',
    '083_default_memory_maintenance.sql',
    '084_memory_retirement_audit.sql',
    '085_retired_layered_fact_receipts.sql',
    '086_merge_parent_deletion_cleanup.sql',
    '087_extraction_trace_merge_operation.sql',
    '088_cli_opaque_cursor_order.sql',
    '089_style_sample_generation_dependencies.sql',
)


def seed_legacy_correction(fixture, original, text, *, owner=False):
    """只构造旧版本已存在的列；真实捕获原消息证明并记录人工决定，不模拟新 HTTP。"""
    table = 'owner_memory' if owner else 'confirmed_memory'
    with psycopg.connect(fixture.database_url, row_factory=dict_row) as connection:
        previous = connection.execute(sql.SQL('SELECT * FROM public.{} WHERE owner_id=%s AND id=%s')
            .format(sql.Identifier(table)), (fixture.owner_id, UUID(original['memory_id']))).fetchone()
        assert previous is not None and 'retirement_reason' not in previous
        replacement = {**previous, 'id': uuid4(), 'text_content': text, 'status': 'active',
            'adoption_method': 'manual', 'revision': previous['revision'] + 1,
            'source_candidate_id': None, 'supersedes_memory_id': previous['id'],
            'created_at': datetime.now(timezone.utc), 'updated_at': datetime.now(timezone.utc),
            'version_evidence': None}
        connection.execute(sql.SQL('INSERT INTO public.{} SELECT * FROM json_populate_record(NULL::public.{}, %s::json)')
            .format(sql.Identifier(table), sql.Identifier(table)), (json.dumps(replacement, default=str),))
        connection.execute(sql.SQL("UPDATE public.{} SET status='invalidated',revision=%s,updated_at=now() WHERE owner_id=%s AND id=%s")
            .format(sql.Identifier(table)), (replacement['revision'], fixture.owner_id, previous['id']))
        row = connection.execute('SELECT * FROM public.memory_candidate WHERE owner_id=%s AND id=%s',
            (fixture.owner_id, previous['source_candidate_id'])).fetchone()
        record_decision(connection, owner_id=fixture.owner_id,
            scope=None if owner else ContactScope(fixture.owner_id, previous['contact_id']),
            record_kind='owner_memory' if owner else 'contact_memory', record_id=previous['id'],
            rejected_text=previous['text_content'], source_ids=tuple(previous['source_ids']),
            corrected_text=text, replacement_memory_id=replacement['id'], candidate=candidate_from_row(row))
    return {'memory': {'memory_id': str(replacement['id']), 'revision': replacement['revision']}}


def upgraded_record(table, record):
    """新增列只有迁移声明的默认值，旧字段及未知证明必须逐字保持。"""
    if table == 'memory_candidate':
        return {**record, 'source_dependency_mode': 'any', 'requires_all_sources': False}
    if table in {'owner_memory', 'confirmed_memory'}:
        return {**record, 'source_dependency_mode': 'any', 'merge_parent_ids': [],
                'retirement_reason': 'unknown', 'retired_at': None, 'requires_all_sources': False}
    return record
