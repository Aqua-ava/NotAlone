"""PostgreSQL 提取水位存储。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg

from notalone.memory_extraction.models import ExtractionFailureKind
from notalone.memory_extraction.recovery import (
    ExtractionFailureState,
    FailureRange,
)
from notalone.scopes import ContactScope


class WatermarkPersistenceError(RuntimeError):
    """不暴露 SQL 或连接信息的水位持久化错误。"""


class PostgresWatermarkStore:
    """按联系人保存提取水位与失败恢复状态；断点重跑从水位之后继续。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def get(self, scope: ContactScope) -> UUID | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT last_message_id
                    FROM public.memory_extraction_watermark
                    WHERE owner_id = %s AND contact_id = %s
                    """,
                    (scope.owner_id, scope.contact_id),
                ).fetchone()
        except Exception as error:
            raise WatermarkPersistenceError("提取水位读取失败。") from error
        return row[0] if row else None

    def set(self, scope: ContactScope, last_message_id: UUID) -> None:
        """成功推进水位，同时清除正在计数的失败区间。"""

        if not isinstance(last_message_id, UUID):
            raise WatermarkPersistenceError("水位必须指向消息 ID。")
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO public.memory_extraction_watermark (
                        owner_id, contact_id, last_message_id
                    ) VALUES (%s, %s, %s)
                    ON CONFLICT (owner_id, contact_id)
                    DO UPDATE SET
                        last_message_id = EXCLUDED.last_message_id,
                        failure_count = 0,
                        failure_code = NULL,
                        failed_from_id = NULL,
                        failed_to_id = NULL,
                        updated_at = now()
                    """,
                    (scope.owner_id, scope.contact_id, last_message_id),
                )
                connection.commit()
        except Exception as error:
            raise WatermarkPersistenceError("提取水位写入失败。") from error

    def get_failure(self, scope: ContactScope) -> ExtractionFailureState | None:
        """返回正在计数的失败区间；没有计数时返回 None。"""

        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT failure_count, failure_code,
                           failed_from_id, failed_to_id
                    FROM public.memory_extraction_watermark
                    WHERE owner_id = %s AND contact_id = %s
                    """,
                    (scope.owner_id, scope.contact_id),
                ).fetchone()
        except Exception as error:
            raise WatermarkPersistenceError("提取失败状态读取失败。") from error
        if row is None or not row[0]:
            return None
        if not row[1] or row[2] is None or row[3] is None:
            raise WatermarkPersistenceError("提取失败状态结构无效。")
        try:
            code = ExtractionFailureKind(row[1])
        except ValueError:
            raise WatermarkPersistenceError("提取失败分类无效。") from None
        return ExtractionFailureState(
            count=int(row[0]),
            failure_range=FailureRange(
                from_message_id=row[2],
                to_message_id=row[3],
                code=code,
            ),
        )

    def save_failure(
        self,
        scope: ContactScope,
        state: ExtractionFailureState,
    ) -> None:
        """保存正在计数的失败区间，不推进水位。"""

        if not isinstance(state, ExtractionFailureState):
            raise WatermarkPersistenceError("失败状态结构无效。")
        failure_range = state.failure_range
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO public.memory_extraction_watermark (
                        owner_id, contact_id, last_message_id,
                        failure_count, failure_code,
                        failed_from_id, failed_to_id
                    ) VALUES (%s, %s, NULL, %s, %s, %s, %s)
                    ON CONFLICT (owner_id, contact_id)
                    DO UPDATE SET
                        failure_count = EXCLUDED.failure_count,
                        failure_code = EXCLUDED.failure_code,
                        failed_from_id = EXCLUDED.failed_from_id,
                        failed_to_id = EXCLUDED.failed_to_id,
                        updated_at = now()
                    """,
                    (
                        scope.owner_id,
                        scope.contact_id,
                        state.count,
                        failure_range.code.value,
                        failure_range.from_message_id,
                        failure_range.to_message_id,
                    ),
                )
                connection.commit()
        except Exception as error:
            raise WatermarkPersistenceError("提取失败状态写入失败。") from error

    def mark_skipped(
        self,
        scope: ContactScope,
        failure_range: FailureRange,
    ) -> None:
        """跳过失败区间：推进水位、清除计数并保留最近一次跳过记录。"""

        if not isinstance(failure_range, FailureRange):
            raise WatermarkPersistenceError("跳过区间结构无效。")
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO public.memory_extraction_watermark (
                        owner_id, contact_id, last_message_id,
                        failure_count, last_skipped_from_id,
                        last_skipped_to_id, last_skipped_code,
                        last_skipped_at
                    ) VALUES (%s, %s, %s, 0, %s, %s, %s, now())
                    ON CONFLICT (owner_id, contact_id)
                    DO UPDATE SET
                        last_message_id = EXCLUDED.last_message_id,
                        failure_count = 0,
                        failure_code = NULL,
                        failed_from_id = NULL,
                        failed_to_id = NULL,
                        last_skipped_from_id = EXCLUDED.last_skipped_from_id,
                        last_skipped_to_id = EXCLUDED.last_skipped_to_id,
                        last_skipped_code = EXCLUDED.last_skipped_code,
                        last_skipped_at = now(),
                        updated_at = now()
                    """,
                    (
                        scope.owner_id,
                        scope.contact_id,
                        failure_range.to_message_id,
                        failure_range.from_message_id,
                        failure_range.to_message_id,
                        failure_range.code.value,
                    ),
                )
                connection.commit()
        except Exception as error:
            raise WatermarkPersistenceError("提取跳过记录写入失败。") from error

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._database_url)
