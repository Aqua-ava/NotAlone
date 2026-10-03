"""仅对独立合成实验库执行只读存储核查。"""

from __future__ import annotations

from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from notalone.experiments.hindsight_runtime import DB_URL


class LifecycleDatabase:
    def __init__(self, allowed_banks: frozenset[str]) -> None:
        self.allowed_banks = allowed_banks

    def _read(
        self, query: Any, parameters: tuple[object, ...] = ()
    ) -> list[dict[str, Any]]:
        with psycopg.connect(
            DB_URL, row_factory=dict_row, options="-c default_transaction_read_only=on"
        ) as connection:
            if (
                connection.info.host != "127.0.0.1"
                or connection.info.port != 18543
                or connection.info.dbname != "postgres"
            ):
                raise ValueError("生命周期核查只能连接固定独立实验库。")
            return connection.execute(query, parameters).fetchall()

    def _check(self, bank_id: str) -> None:
        if bank_id not in self.allowed_banks:
            raise ValueError("SQL bank 不在本轮实验 allowlist 中。")

    def environment(self) -> dict[str, object]:
        return {
            "identity": self._read(
                "SELECT current_database() AS database, current_schema() AS schema, version() AS version"
            ),
            "migrations": self._read("SELECT version_num FROM public.alembic_version"),
            "foreign_keys": self._read(
                "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint "
                "WHERE contype='f' AND conrelid IN (to_regclass('public.chunks'),to_regclass('public.memory_units'),to_regclass('public.invalidated_memory_units'))"
            ),
        }

    def document(self, bank_id: str, document_id: str) -> dict[str, Any]:
        self._check(bank_id)
        parameters = (bank_id, document_id)
        return {
            "documents": self._read(
                "SELECT id, bank_id, original_text, content_hash, retain_params FROM public.documents WHERE bank_id=%s AND id=%s",
                parameters,
            ),
            "chunks": self._read(
                "SELECT chunk_id, chunk_index, chunk_text FROM public.chunks WHERE bank_id=%s AND document_id=%s ORDER BY chunk_index",
                parameters,
            ),
            "units": self._read(
                "SELECT id, chunk_id, text, metadata, embedding IS NOT NULL AS has_embedding, vector_dims(embedding) AS dimensions FROM public.memory_units WHERE bank_id=%s AND document_id=%s ORDER BY id",
                parameters,
            ),
            "archive": self._read(
                "SELECT id, text, metadata FROM public.invalidated_memory_units WHERE bank_id=%s AND document_id=%s",
                parameters,
            ),
        }

    def absent_ids(self, bank_id: str, unit_ids: tuple[str, ...]) -> dict[str, object]:
        self._check(bank_id)
        return {
            table: self._read(
                sql.SQL(
                    "SELECT id FROM public.{} WHERE bank_id=%s AND id=ANY(%s::uuid[])"
                ).format(sql.Identifier(table)),
                (bank_id, list(unit_ids)),
            )
            for table in ("memory_units", "invalidated_memory_units")
        }

    def operations(self, bank_id: str) -> list[dict[str, Any]]:
        self._check(bank_id)
        return self._read(
            "SELECT operation_id,operation_type,status FROM public.async_operations WHERE bank_id=%s ORDER BY operation_id",
            (bank_id,),
        )

    def bank(
        self, bank_id: str, *, previous_internal_id: str | None = None
    ) -> dict[str, Any]:
        self._check(bank_id)
        profile = self._read(
            "SELECT bank_id, internal_id FROM public.banks WHERE bank_id=%s", (bank_id,)
        )
        internal_id = (
            str(profile[0]["internal_id"]) if profile else previous_internal_id
        )
        counts = {
            table: self._read(
                sql.SQL(
                    "SELECT count(*) AS count FROM public.{} WHERE bank_id=%s"
                ).format(sql.Identifier(table)),
                (bank_id,),
            )[0]["count"]
            for table in (
                "banks",
                "documents",
                "chunks",
                "memory_units",
                "invalidated_memory_units",
                "entities",
                "observation_history",
                "mental_models",
                "attachments",
                "async_operations",
            )
        }
        indexes = (
            []
            if internal_id is None
            else self._read(
                "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='memory_units' AND indexname LIKE %s ORDER BY indexname",
                ("%" + internal_id.replace("-", "")[:16] + "%",),
            )
        )
        return {
            "profile": profile,
            "internal_id": internal_id,
            "counts": counts,
            "indexes": indexes,
        }
