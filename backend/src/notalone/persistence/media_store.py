"""媒体的具体导入来源授权与持久化生命周期。"""

from contextlib import contextmanager
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Iterator
from uuid import UUID, uuid4

import psycopg

from notalone.media.cache import ManagedMediaCache
from notalone.media.models import MediaAuthorization, MediaBudgets, MediaError, SourceOption
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.scopes import ContactScope
from notalone.wechat_media.locator import MediaLocation


class PostgresMediaStore:
    def __init__(self, database_url: str, clock: Callable[[], datetime]) -> None:
        self.database_url = database_url
        self.clock = clock

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        connection = psycopg.connect(self.database_url)
        try:
            with connection:
                yield connection
        finally:
            # psycopg 3.3.4 提交异常发生在 __exit__ 关闭连接之前。
            connection.close()

    def authorize(
        self, connection: psycopg.Connection, scope: ContactScope,
        message_id: UUID, target: str, source_ref_id: UUID | None = None,
    ) -> tuple[MediaAuthorization | None, tuple[SourceOption, ...]]:
        message = connection.execute(
            "SELECT message_type FROM public.message "
            "WHERE owner_id=%s AND contact_id=%s AND id=%s",
            (scope.owner_id, scope.contact_id, message_id),
        ).fetchone()
        if message is None:
            raise MediaError("message_unavailable")
        if message[0] not in ("image", "video", "voice") or (
            target != "original" and message[0] != target
        ):
            raise MediaError("unsupported_target")
        refs = connection.execute("""
            SELECT ref.id, ref.source_document_id,
                   own.external_id, ci.external_id, metadata.external_local_id,
                   metadata.external_server_id, metadata.source_create_time,
                   own.id, own.verified_at, ci.id, ci.verified_at, confirmation.id,
                   metadata.external_talker
            FROM public.message_source_ref AS ref
            JOIN public.source_document AS source ON source.id=ref.source_document_id
              AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id
            JOIN public.import_confirmation AS confirmation
              ON confirmation.source_document_id=source.id
              AND confirmation.owner_id=ref.owner_id AND confirmation.contact_id=ref.contact_id
            JOIN public.channel_identity AS ci ON ci.id=confirmation.channel_identity_id
              AND ci.owner_id=confirmation.owner_id AND ci.contact_id=confirmation.contact_id
              AND ci.channel='wechat' AND ci.status='active'
            JOIN public.owner_channel_identity AS own ON own.owner_id=confirmation.owner_id
              AND own.channel='wechat' AND own.status='active'
            JOIN public.wechat_message_metadata AS metadata
              ON metadata.owner_id=confirmation.owner_id
              AND metadata.contact_id=confirmation.contact_id AND metadata.message_id=ref.message_id
              AND metadata.external_talker=ci.external_id
            WHERE ref.owner_id=%s AND ref.contact_id=%s AND ref.message_id=%s
              AND ref.source_kind='source_document' AND source.status='active'
            ORDER BY ref.id
        """, (scope.owner_id, scope.contact_id, message_id)).fetchall()
        options = tuple(SourceOption(row[0]) for row in refs)
        if source_ref_id is None and len(refs) > 1:
            return None, options
        selected = [row for row in refs if source_ref_id is None or row[0] == source_ref_id]
        if len(selected) != 1:
            raise MediaError("source_unavailable")
        ref_id, document_id = selected[0][:2]
        row = selected[0][2:]
        generation = hashlib.sha256(repr(row).encode()).hexdigest()
        return MediaAuthorization(
            scope, message_id, ref_id, document_id, message[0],
            row[0], row[1], row[2], row[3], row[4], generation,
        ), ()

    @staticmethod
    def lock(connection: psycopg.Connection, scope: ContactScope) -> None:
        lock_contact_scope(connection, owner_id=scope.owner_id, contact_id=scope.contact_id)
        lock_owner_scope(connection, owner_id=scope.owner_id)

    @staticmethod
    def row(cursor):
        row = cursor.fetchone()
        return dict(zip((column.name for column in cursor.description), row)) if row else None

    def checked(self, connection: psycopg.Connection, row: dict[str, Any]) -> MediaAuthorization:
        auth, _ = self.authorize(
            connection, ContactScope(row["owner_id"], row["contact_id"]),
            row["message_id"], row["target"], row["source_ref_id"],
        )
        if auth is None or auth.generation != row["authorization_generation"]:
            raise MediaError("source_unavailable")
        return auth

    @staticmethod
    def invalidate(connection: psycopg.Connection, row: dict[str, Any]) -> None:
        connection.execute(
            "INSERT INTO public.media_request_tombstone "
            "(owner_id,contact_id,request_key_hash) VALUES (%s,%s,%s) "
            "ON CONFLICT DO NOTHING",
            (row["owner_id"], row["contact_id"], row["request_key_hash"]),
        )
        connection.execute(
            "UPDATE public.media_attempt SET status='cleanup_pending' WHERE resource_id=%s",
            (row["resource_id"],),
        )

    def recover(
        self, scope: ContactScope, resource_id: UUID | None = None,
    ) -> None:
        """显式请求先持久废止过期代次，再清理本范围已登记的自有残留。"""
        with self.connection() as connection:
            self.lock(connection, scope)
            cursor = connection.execute("""
                SELECT * FROM public.media_attempt
                WHERE owner_id=%s AND contact_id=%s
                  AND (%s::uuid IS NULL OR resource_id=%s) FOR UPDATE
            """, (scope.owner_id, scope.contact_id, resource_id, resource_id))
            columns = [column.name for column in cursor.description or ()]
            rows = cursor.fetchall()
            now = self.clock()
            for values in rows:
                row = dict(zip(columns, values))
                invalid = False
                try:
                    self.checked(connection, row)
                except MediaError:
                    invalid = True
                if invalid:
                    connection.execute(
                        "INSERT INTO public.media_request_tombstone "
                        "(owner_id,contact_id,request_key_hash) VALUES (%s,%s,%s) "
                        "ON CONFLICT DO NOTHING",
                        (scope.owner_id, scope.contact_id, row["request_key_hash"]),
                    )
                if invalid or (
                    row["status"] == "preparing" and row["lease_expires_at"] <= now
                ):
                    connection.execute(
                        "UPDATE public.media_attempt SET status='cleanup_pending' WHERE resource_id=%s",
                        (row["resource_id"],),
                    )
        try:
            with self.connection() as connection:
                self.lock(connection, scope)
                cursor = connection.execute("""
                    SELECT * FROM public.media_attempt
                    WHERE owner_id=%s AND contact_id=%s AND status='cleanup_pending'
                      AND (%s::uuid IS NULL OR resource_id=%s)
                    FOR UPDATE
                """, (scope.owner_id, scope.contact_id, resource_id, resource_id))
                columns = [column.name for column in cursor.description or ()]
                for values in cursor.fetchall():
                    row = dict(zip(columns, values))
                    ManagedMediaCache(row["cache_root"]).cleanup(row)
                    tombstoned = connection.execute(
                        "SELECT 1 FROM public.media_request_tombstone "
                        "WHERE owner_id=%s AND contact_id=%s AND request_key_hash=%s",
                        (scope.owner_id, scope.contact_id, row["request_key_hash"]),
                    ).fetchone()
                    if tombstoned:
                        connection.execute(
                            "DELETE FROM public.media_attempt WHERE resource_id=%s",
                            (row["resource_id"],),
                        )
                    else:
                        connection.execute("""
                            UPDATE public.media_attempt SET status='failed', artifacts='[]'::jsonb
                            WHERE resource_id=%s AND attempt_id=%s
                        """, (row["resource_id"], row["attempt_id"]))
        except (OSError, MediaError):
            # 清理事务回滚不会撤回已提交的 cleanup_pending，也不丢失文件归属。
            raise MediaError("cleanup_pending") from None

    def claim(
        self, scope: ContactScope, message_id: UUID, target: str, request_key: str,
        source_ref_id: UUID | None, variant: str | None, root: Path,
        budgets: MediaBudgets,
    ):
        key_hash = hashlib.sha256(request_key.encode()).hexdigest()
        input_hash = hashlib.sha256(json.dumps([
            str(message_id), target, str(source_ref_id), variant, "media-v1",
        ]).encode()).hexdigest()
        with self.connection() as connection:
            self.lock(connection, scope)
            if connection.execute(
                "SELECT 1 FROM public.media_request_tombstone "
                "WHERE owner_id=%s AND contact_id=%s AND request_key_hash=%s",
                (scope.owner_id, scope.contact_id, key_hash),
            ).fetchone():
                raise MediaError("attempt_invalidated")
            old = self.row(connection.execute("""
                SELECT * FROM public.media_attempt
                WHERE owner_id=%s AND contact_id=%s AND request_key_hash=%s FOR UPDATE
            """, (scope.owner_id, scope.contact_id, key_hash)))
            if old:
                if old["input_hash"] != input_hash:
                    raise MediaError("request_conflict")
                try:
                    existing_auth = self.checked(connection, old)
                except MediaError as error:
                    invalid = error
                    self.invalidate(connection, old)
                else:
                    now = self.clock()
                    if old["status"] == "ready" or (
                        old["status"] == "preparing" and old["lease_expires_at"] > now
                    ):
                        return old, existing_auth, ()
                    self.check_capacity(connection, scope, budgets, now)
                    ManagedMediaCache(old["cache_root"]).cleanup(old)
                    row = self.row(connection.execute("""
                        UPDATE public.media_attempt
                        SET attempt_id=%s, cache_root=%s, status='preparing', error_code=NULL,
                            artifacts='[]'::jsonb, lease_expires_at=%s
                        WHERE resource_id=%s RETURNING *
                    """, (
                        uuid4(), str(root),
                        self.clock() + timedelta(seconds=budgets.max_runtime_seconds),
                        old["resource_id"],
                    )))
                    row["claimed"] = True
                    return row, existing_auth, ()
            else:
                auth, options = self.authorize(connection, scope, message_id, target, source_ref_id)
                if auth is None:
                    return None, None, options
                now = self.clock()
                self.check_capacity(connection, scope, budgets, now)
                row = self.row(connection.execute("""
                    INSERT INTO public.media_attempt (
                        resource_id, owner_id, contact_id, message_id, source_ref_id,
                        source_document_id, request_key_hash, input_hash, target, variant,
                        authorization_generation, attempt_id, cache_root, status, lease_expires_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'preparing',%s) RETURNING *
                """, (
                    uuid4(), scope.owner_id, scope.contact_id, message_id, auth.source_ref_id,
                    auth.source_document_id, key_hash, input_hash, target, variant,
                    auth.generation, uuid4(), str(root),
                    now + timedelta(seconds=budgets.max_runtime_seconds),
                )))
                row["claimed"] = True
                return row, auth, ()
        self.recover(scope, old["resource_id"])
        raise invalid

    @staticmethod
    def check_capacity(connection, scope, budgets, now) -> None:
        count = connection.execute(
            "SELECT count(*) FROM public.media_attempt WHERE owner_id=%s "
            "AND contact_id=%s AND status='preparing' AND lease_expires_at>%s",
            (scope.owner_id, scope.contact_id, now),
        ).fetchone()[0]
        if count >= budgets.max_concurrent_per_scope:
            raise MediaError("scope_busy")

    def require_attempt(self, connection, row) -> None:
        current = self.row(connection.execute(
            "SELECT * FROM public.media_attempt WHERE resource_id=%s FOR UPDATE",
            (row["resource_id"],),
        ))
        if (
            current is None or current["attempt_id"] != row["attempt_id"]
            or current["status"] != "preparing"
            or current["lease_expires_at"] <= self.clock()
        ):
            raise MediaError("attempt_invalidated")
        self.checked(connection, current)

    def bind_location(self, row: dict[str, Any], location: MediaLocation) -> None:
        fingerprint = hashlib.sha256(json.dumps([
            location.dataset_id, location.message_shard, location.message_table,
            location.message_row, location.resource_shard, location.resource_table,
            location.resource_row, location.association_version, location.variant,
        ]).encode()).hexdigest()
        with self.connection() as connection:
            self.lock(connection, ContactScope(row["owner_id"], row["contact_id"]))
            self.require_attempt(connection, row)
            current_row = connection.execute(
                "SELECT locator_hash FROM public.media_attempt WHERE resource_id=%s",
                (row["resource_id"],),
            ).fetchone()
            if current_row is None:
                raise MediaError("attempt_invalidated")
            current = current_row[0]
            if current is not None and current != fingerprint:
                raise MediaError("association_ambiguous")
            connection.execute(
                "UPDATE public.media_attempt SET variant=%s,locator_hash=%s WHERE resource_id=%s",
                (location.variant, fingerprint, row["resource_id"]),
            )

    @contextmanager
    def staging(
        self, row: dict[str, Any], cache: ManagedMediaCache,
    ) -> Iterator[int]:
        manager = None
        try:
            with self.connection() as connection:
                self.lock(connection, ContactScope(row["owner_id"], row["contact_id"]))
                self.require_attempt(connection, row)
                manager = cache.staging(row)
                fd = manager.__enter__()
            # Reader 与转换不持有数据库事务；只保留已创建目录的句柄。
            yield fd
        finally:
            if manager is not None:
                manager.__exit__(None, None, None)

    def publish(self, row, cache, fd, artifacts, variant) -> None:
        with self.connection() as connection:
            self.lock(connection, ContactScope(row["owner_id"], row["contact_id"]))
            self.require_attempt(connection, row)
            for artifact in artifacts:
                cache.publish(fd, UUID(artifact["artifact_id"]))
            # rename/fsync 也可能耗尽租约；ready 前再次核验持锁后的当前时间。
            self.require_attempt(connection, row)
            connection.execute("""
                UPDATE public.media_attempt SET status='ready', artifacts=%s::jsonb, variant=%s
                WHERE resource_id=%s AND attempt_id=%s
            """, (json.dumps(artifacts), variant, row["resource_id"], row["attempt_id"]))

    def fail(self, row: dict[str, Any], code: str) -> bool:
        invalid_authorization = code in {"source_unavailable", "scope_mismatch", "message_unavailable"}
        with self.connection() as connection:
            self.lock(connection, ContactScope(row["owner_id"], row["contact_id"]))
            changed = connection.execute(
                "UPDATE public.media_attempt SET status='cleanup_pending',error_code=%s "
                "WHERE resource_id=%s AND attempt_id=%s",
                (code, row["resource_id"], row["attempt_id"]),
            ).rowcount
            if changed and invalid_authorization:
                # 发布前已观察到授权失效；恢复旧身份也不能重放这次请求。
                connection.execute(
                    "INSERT INTO public.media_request_tombstone "
                    "(owner_id,contact_id,request_key_hash) VALUES (%s,%s,%s) "
                    "ON CONFLICT DO NOTHING",
                    (row["owner_id"], row["contact_id"], row["request_key_hash"]),
                )
        ManagedMediaCache(row["cache_root"]).cleanup(row)
        if not changed:
            return False
        with self.connection() as connection:
            if invalid_authorization:
                connection.execute(
                    "DELETE FROM public.media_attempt WHERE resource_id=%s AND attempt_id=%s",
                    (row["resource_id"], row["attempt_id"]),
                )
            else:
                connection.execute(
                    "UPDATE public.media_attempt SET status='failed',artifacts='[]'::jsonb "
                    "WHERE resource_id=%s AND attempt_id=%s",
                    (row["resource_id"], row["attempt_id"]),
                )
        return bool(changed)

    def read(self, scope: ContactScope, resource_id: UUID, artifact_id: UUID) -> bytes:
        with self.connection() as connection:
            self.lock(connection, scope)
            row = self.row(connection.execute(
                "SELECT * FROM public.media_attempt "
                "WHERE owner_id=%s AND contact_id=%s AND resource_id=%s FOR UPDATE",
                (scope.owner_id, scope.contact_id, resource_id),
            ))
            if row is None or row["status"] != "ready":
                raise MediaError("resource_unavailable")
            try:
                self.checked(connection, row)
            except MediaError as error:
                invalid = error
                self.invalidate(connection, row)
            else:
                artifact = next((
                    item for item in row["artifacts"] if item["artifact_id"] == str(artifact_id)
                ), None)
                if artifact is None:
                    raise MediaError("resource_unavailable")
                data = ManagedMediaCache(row["cache_root"]).read(row, artifact)
                if (
                    len(data) != artifact["size"]
                    or hashlib.sha256(data).hexdigest() != artifact["sha256"]
                ):
                    raise MediaError("resource_missing")
                return data
        # 授权拒绝先提交 tombstone/pending，再清文件或对外抛错，避免回滚废止。
        self.recover(scope, resource_id)
        raise invalid


def erase_source_media(
    connection: psycopg.Connection, *, scope: ContactScope, source_document_id: UUID,
) -> None:
    """调用者已持有 contact→owner→source 锁；清文件成功后才删除清单。"""
    rows = connection.execute(
        "SELECT * FROM public.media_attempt WHERE owner_id=%s "
        "AND contact_id=%s AND source_document_id=%s FOR UPDATE",
        (scope.owner_id, scope.contact_id, source_document_id),
    )
    columns = [column.name for column in rows.description or ()]
    for values in rows.fetchall():
        row = dict(zip(columns, values))
        ManagedMediaCache(row["cache_root"]).cleanup(row)
        connection.execute(
            "INSERT INTO public.media_request_tombstone (owner_id,contact_id,request_key_hash) "
            "VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
            (row["owner_id"], row["contact_id"], row["request_key_hash"]),
        )
    connection.execute(
        "DELETE FROM public.media_attempt WHERE owner_id=%s AND contact_id=%s "
        "AND source_document_id=%s",
        (scope.owner_id, scope.contact_id, source_document_id),
    )


def verify_source_media_deleted(
    connection: psycopg.Connection, *, scope: ContactScope, source_document_id: UUID,
) -> None:
    if connection.execute(
        "SELECT 1 FROM public.media_attempt WHERE owner_id=%s AND contact_id=%s "
        "AND source_document_id=%s LIMIT 1",
        (scope.owner_id, scope.contact_id, source_document_id),
    ).fetchone():
        raise MediaError("cleanup_pending")
