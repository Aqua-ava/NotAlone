"""035 接管使用的只读结构、来源与内容核验；不返回私人行。"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any

import psycopg
from psycopg import sql

from notalone.database_migrations import MigrationError
from notalone.persistence.message_sources import valid_source_ref_exists_sql


_CATALOG_QUERIES = {
    "relations": """
        SELECT c.relname, c.relkind, c.relpersistence, c.relrowsecurity,
            c.relforcerowsecurity, c.relreplident, c.reloptions, c.relispartition,
            pg_get_expr(c.relpartbound, c.oid), c.relacl::text,
            pg_get_userbyid(c.relowner), c.relhasrules,
            (SELECT amname FROM pg_am WHERE oid = c.relam),
            (SELECT spcname FROM pg_tablespace WHERE oid = c.reltablespace)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f','c')
        ORDER BY c.relname
    """,
    "columns": """
        SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
            a.attnotnull, a.attidentity, a.attgenerated,
            pg_get_expr(d.adbin, d.adrelid), co.collname, a.attacl::text
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        LEFT JOIN pg_collation co ON co.oid = a.attcollation
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','c')
            AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum
    """,
    "constraints": """
        SELECT c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid, true),
            k.convalidated, k.condeferrable, k.condeferred, k.connoinherit
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' ORDER BY c.relname, k.conname
    """,
    "indexes": """
        SELECT c.relname, t.relname, pg_get_indexdef(i.indexrelid),
            i.indisvalid, i.indisready, i.indislive, i.indisreplident, i.indisclustered
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' ORDER BY c.relname
    """,
    "triggers": """
        SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname
    """,
    "rules": """
        SELECT c.relname, r.rulename, r.ev_enabled, pg_get_ruledef(r.oid, true)
        FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' ORDER BY c.relname, r.rulename
    """,
    "inheritance": """
        SELECT child.relname, n.nspname, parent.relname, i.inhseqno
        FROM pg_inherits i JOIN pg_class child ON child.oid = i.inhrelid
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = parent.relnamespace
        WHERE child.relnamespace = 'public'::regnamespace ORDER BY child.relname, i.inhseqno
    """,
    "functions": """
        SELECT p.proname, pg_get_function_identity_arguments(p.oid),
            p.prokind, CASE WHEN p.prokind = 'a' THEN NULL ELSE pg_get_functiondef(p.oid) END
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
    """,
    "policies": """
        SELECT c.relname, p.polname, p.polpermissive, p.polcmd, p.polroles::text,
            pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' ORDER BY c.relname, p.polname
    """,
    "schemas": """
        SELECT nspname, nspacl::text, pg_get_userbyid(nspowner) FROM pg_namespace
        WHERE nspname <> 'information_schema' AND left(nspname, 3) <> 'pg_'
        ORDER BY nspname
    """,
    "extensions": "SELECT extname, extversion FROM pg_extension ORDER BY extname",
    "default_privileges": """
        SELECT pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype, d.defaclacl::text
        FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
        ORDER BY pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype
    """,
    "publications": "SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate FROM pg_publication ORDER BY pubname",
    "subscriptions": """
        SELECT subname, subenabled, subpublications FROM pg_subscription
        WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY subname
    """,
    "foreign_servers": "SELECT count(*) FROM pg_foreign_server",
    "extra_objects": """
        SELECT i.type, i.schema, i.identity FROM pg_depend d
        CROSS JOIN LATERAL pg_identify_object(d.classid, d.objid, d.objsubid) i
        WHERE d.refclassid = 'pg_namespace'::regclass
            AND d.refobjid = 'public'::regnamespace AND d.deptype = 'n'
            AND d.classid NOT IN ('pg_class'::regclass, 'pg_proc'::regclass,
                'pg_constraint'::regclass, 'pg_type'::regclass)
        ORDER BY i.type, i.identity
    """,
    "types": """
        SELECT t.typname, t.typtype, format_type(t.typbasetype, t.typtypmod)
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0
        ORDER BY t.typname
    """,
    "event_triggers": "SELECT evtname, evtevent, evtenabled FROM pg_event_trigger ORDER BY evtname",
    "large_objects": "SELECT count(*) FROM pg_largeobject_metadata",
}


@dataclass(frozen=True, slots=True)
class AuditResult:
    schema_digest: str
    repair_required: bool
    table_count: int
    violation_counts: dict[str, int]


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()


def schema_catalog(connection: psycopg.Connection[Any]) -> dict[str, list[tuple[Any, ...]]]:
    return {name: connection.execute(query).fetchall()
            for name, query in _CATALOG_QUERIES.items()}


def check_legacy_catalog(
    actual: dict[str, list[tuple[Any, ...]]],
    expected: dict[str, list[tuple[Any, ...]]],
) -> bool:
    repaired = {key: list(rows) for key, rows in actual.items()}
    repair_required = False
    for index, row in enumerate(repaired["constraints"]):
        if row[:2] == ("source_document", "source_document_source_type_check"):
            if row[3] == "CHECK (source_type = 'wechat_jsonl'::text)":
                reference = next(item for item in expected["constraints"] if item[:2] == row[:2])
                # 仅替换已审计的旧定义；验证/延迟属性也必须完全相同。
                repaired["constraints"][index] = (*row[:3], reference[3], *row[4:])
                repair_required = True
    if repaired != expected:
        raise MigrationError("legacy_schema_mismatch：结构不满足受控 035 契约，未接管。")
    return repair_required


def source_violations(connection: psycopg.Connection[Any]) -> dict[str, int]:
    queries = {
        "message_without_source": f"""
            SELECT count(*) FROM public.message m WHERE NOT {valid_source_ref_exists_sql('m')}
        """,
        "document_ref_scope": """
            SELECT count(*) FROM public.message_source_ref r WHERE r.source_document_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.source_document s WHERE s.id = r.source_document_id
                AND s.owner_id = r.owner_id AND s.contact_id = r.contact_id)
        """,
        "observation_ref_scope": """
            SELECT count(*) FROM public.message_source_ref r WHERE r.observation_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.local_wechat_observation s WHERE s.id = r.observation_id
                AND s.owner_id = r.owner_id AND s.contact_id = r.contact_id)
        """,
        "orphan_watermark": """
            SELECT count(*) FROM public.memory_extraction_watermark w WHERE NOT EXISTS (
                SELECT 1 FROM public.contact c WHERE c.owner_id = w.owner_id AND c.id = w.contact_id)
        """,
        "observation_counts": """
            SELECT count(*) FROM public.local_wechat_observation
            WHERE event_count < record_count OR non_text_count < 0 OR non_text_count > event_count
        """,
    }
    for table in ("local_wechat_observation", "wechat_observation_cursor"):
        queries[f"{table}_binding_scope"] = f"""
            SELECT count(*) FROM public.{table} s WHERE NOT EXISTS (
                SELECT 1 FROM public.conversation_binding b WHERE b.id = s.binding_id
                    AND b.owner_id = s.owner_id AND b.contact_id = s.contact_id
                    AND b.conversation_locator = s.conversation_locator)
        """
    for table, status in (("memory_candidate", "IN ('pending', 'confirmed')"),
                          ("confirmed_memory", "= 'active'"), ("owner_memory", "= 'active'")):
        contact_scope = "" if table == "owner_memory" else "AND s.contact_id = m.contact_id"
        message_scope = "" if table == "owner_memory" else "AND s.contact_id = m.contact_id"
        queries[f"{table}_sources"] = f"""
            SELECT count(*) FROM public.{table} m CROSS JOIN LATERAL unnest(m.source_ids) source_id
            WHERE m.status {status} AND NOT (
                EXISTS (SELECT 1 FROM public.source_document s WHERE s.id = source_id
                    AND s.owner_id = m.owner_id {contact_scope} AND s.status = 'active')
                OR EXISTS (SELECT 1 FROM public.local_wechat_observation s WHERE s.id = source_id
                    AND s.owner_id = m.owner_id {contact_scope})
                OR EXISTS (SELECT 1 FROM public.message s WHERE s.id = source_id
                    AND s.owner_id = m.owner_id {message_scope} AND {valid_source_ref_exists_sql('s')})
            )
        """
    return {code: connection.execute(query).fetchone()[0] for code, query in queries.items()}


def audit_connection(
    connection: psycopg.Connection[Any], expected: dict[str, list[tuple[Any, ...]]],
) -> AuditResult:
    actual = schema_catalog(connection)
    repair_required = check_legacy_catalog(actual, expected)
    violations = source_violations(connection)
    if any(violations.values()):
        # 只保留分类计数；驱动异常、私人 UUID 或行内容不进入错误信息。
        codes = ",".join(f"{code}={count}" for code, count in violations.items() if count)
        raise MigrationError(f"legacy_data_invalid：来源或隔离契约异常（{codes}），未接管。")
    return AuditResult(digest(actual), repair_required, len(actual["relations"]), violations)


def business_digest(
    connection: psycopg.Connection[Any], tables: tuple[str, ...],
) -> str:
    """完整行仅在本机内存中流式处理；不记录或返回行内容。"""

    connection.execute("SET LOCAL TIME ZONE 'UTC'")
    result = hashlib.sha256()
    for table in tables:
        result.update(table.encode("utf-8") + b"\0")
        query = sql.SQL(
            'SELECT to_jsonb(t)::text FROM public.{} t ORDER BY to_jsonb(t)::text COLLATE "C"'
        ).format(sql.Identifier(table))
        with connection.cursor(name=f"digest_{table}") as cursor:
            cursor.execute(query)
            for (row,) in cursor:
                content = row.encode("utf-8")
                result.update(len(content).to_bytes(8, "big"))
                result.update(content)
    return result.hexdigest()
