"""一次持锁概览中的依赖批读；只沿已登记身份读取，不跨概览保留。"""

from collections.abc import Callable
from uuid import UUID


class OverviewDependencyRead:
    def __init__(self, connection, *, owner_id: UUID, contact_id: UUID | None,
                 rows: list[dict], digest: Callable[[object], str]) -> None:
        self.connection = connection
        self.owner_id = owner_id
        self.contact_id = contact_id
        self.digest = digest
        self._candidates: dict[UUID, dict | None] = {}
        self._sources: dict[UUID, dict | None] = {}
        self._context: dict[str, dict[UUID, dict | None]] = {
            "confirmed_memory": {}, "owner_memory": {},
        }
        self._read_candidates({row["source_candidate_id"] for row in rows
                               if row["source_candidate_id"] is not None})

    def _read_candidates(self, identifiers: set[UUID]) -> None:
        missing = identifiers - self._candidates.keys()
        if not missing:
            return
        rows = self.connection.execute(
            "SELECT id,correction_evidence,dimension_evidence,subject FROM public.memory_candidate "
            "WHERE owner_id=%s AND (%s::uuid IS NULL OR contact_id=%s) AND id=ANY(%s::uuid[])",
            (self.owner_id, self.contact_id, self.contact_id, sorted(missing)),
        ).fetchall()
        self._candidates.update((identifier, None) for identifier in missing)
        self._candidates.update((row["id"], row) for row in rows)

    def candidate(self, identifier: UUID | None) -> dict | None:
        if identifier is None:
            return None
        self._read_candidates({identifier})
        return self._candidates[identifier]

    def sources(self, identifiers: set[str]) -> list[dict]:
        keys = {UUID(identifier) for identifier in identifiers}
        missing = keys - self._sources.keys()
        if missing:
            rows = self.connection.execute(
                "SELECT id,status,source_type,content_sha256 FROM public.source_document "
                "WHERE owner_id=%s AND id=ANY(%s::uuid[]) ORDER BY id",
                (self.owner_id, sorted(missing)),
            ).fetchall()
            self._sources.update((identifier, None) for identifier in missing)
            self._sources.update((row["id"], row) for row in rows)
        return [self._sources[key] for key in sorted(keys) if self._sources[key] is not None]

    def context_records(self, identifiers: set[str], *, exclude: UUID) -> list[dict]:
        """大 JSON 的摘要只计算一次；每项仍只返回它实际登记的依赖。"""
        keys = {UUID(identifier) for identifier in identifiers} - {exclude}
        result = []
        for kind, table in (("contact_memory", "confirmed_memory"), ("owner_memory", "owner_memory")):
            cache = self._context[table]
            missing = keys - cache.keys()
            if missing:
                rows = self.connection.execute(
                    "SELECT id,revision,status,text_content,category,topic,source_ids,source_candidate_id,"
                    "adoption_method,valid_at,invalid_at,supersedes_memory_id,event,version_evidence "
                    f"FROM public.{table} WHERE owner_id=%s AND id=ANY(%s::uuid[]) ORDER BY id",
                    (self.owner_id, sorted(missing)),
                ).fetchall()
                cache.update((identifier, None) for identifier in missing)
                cache.update((row["id"], {"record_kind": kind, "memory_id": str(row["id"]),
                    "revision": row["revision"], "status": row["status"],
                    "record_sha256": self.digest(row)}) for row in rows)
            result.extend(cache[key] for key in sorted(keys) if cache[key] is not None)
        return result
