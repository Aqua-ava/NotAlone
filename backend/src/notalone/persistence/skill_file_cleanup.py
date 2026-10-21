"""业务删除提交后清理 Skill 文件；事务回滚不会提前擦除合法版本。"""

from contextlib import contextmanager
from collections.abc import Iterator
from uuid import UUID
from typing import Any

import psycopg

from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.skill_files import (
    SkillFileError, cleanup_pending_files, cleanup_unreferenced_snapshots,
)


def _has_pending_files(connection: Any, owner_id: UUID) -> bool:
    relation = connection.execute("SELECT to_regclass('public.reply_skill_file_cleanup') AS relation").fetchone()
    if relation is None or (relation['relation'] if isinstance(relation, dict) else relation[0]) is None:
        return False
    return connection.execute(
        "SELECT 1 FROM public.reply_skill_file_cleanup WHERE "
        "split_part(relative_path,'/',1)=%s OR "
        "(split_part(relative_path,'/',1) IN ('.versions','.staging') AND split_part(relative_path,'/',2)=%s) LIMIT 1",
        (str(owner_id), str(owner_id)),
    ).fetchone() is not None


@contextmanager
def cleanup_skill_files_after_commit(database_url: str, owner_id: UUID) -> Iterator[None]:
    """放在业务事务外层；失败保留已提交删除资格和清理清单供重试。"""
    yield
    with psycopg.connect(database_url) as connection:
        if connection.execute("SELECT to_regclass('public.reply_skill_file_cleanup')").fetchone()[0] is None:
            return
        lock_owner_scope(connection, owner_id=owner_id)
        cleanup_unreferenced_snapshots(connection, owner_id=owner_id)
        cleanup_pending_files(connection, owner_id=owner_id)
        if _has_pending_files(connection, owner_id):
            raise SkillFileError('Skill 文件删除尚未完成，可重试清理。')


@contextmanager
def skill_cleanup_transaction(
    database_url: str, owner_id: UUID, connection_context: Any, *, shared_transaction: bool = False,
) -> Iterator[Any]:
    """共享连接只登记清单；真正拥有提交边界的调用者完成文件清理。"""
    with connection_context as connection:
        yield connection
        pending = not shared_transaction and _has_pending_files(connection, owner_id)
    if pending:
        with cleanup_skill_files_after_commit(database_url, owner_id):
            pass
