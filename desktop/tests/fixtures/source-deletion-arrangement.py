"""仅在本轮精确测试库安排已完成删除之后的持久验证失败投影。"""

import re
import sys
from uuid import UUID

import psycopg


def fail_final_verification(database_name: str, owner_id: UUID, contact_id: UUID, task_id: UUID) -> None:
    if re.fullmatch(r"notalone_contact_session_[0-9a-f]{32}_test", database_name) is None:
        raise ValueError("只能安排本轮随机测试库。")
    with psycopg.connect(f"host=/tmp dbname={database_name}") as connection:
        task = connection.execute(
            "SELECT task.status, source.status FROM public.background_task task "
            "JOIN public.source_document source ON source.id=task.source_document_id "
            "AND source.owner_id=task.owner_id AND source.contact_id=task.contact_id "
            "WHERE task.owner_id=%s AND task.contact_id=%s AND task.id=%s AND task.task_type='delete' FOR UPDATE",
            (owner_id, contact_id, task_id),
        ).fetchone()
        if task != ("succeeded", "deleted"):
            raise ValueError("须先由真实删除完成本轮原任务。")
        steps = connection.execute(
            "SELECT step_name, status FROM public.background_task_step WHERE task_id=%s ORDER BY step_order",
            (task_id,),
        ).fetchall()
        if steps != [(name, "succeeded") for name in (
            "mark_deleted", "delete_derived", "delete_index", "clear_cache", "verify_not_retrievable",
        )]:
            raise ValueError("本轮真实删除步骤尚未全部完成。")
        connection.execute(
            "UPDATE public.background_task SET status='failed', current_step='verify_not_retrievable', "
            "last_error_code='source_delete_failed' WHERE id=%s", (task_id,),
        )
        connection.execute(
            "UPDATE public.background_task_step SET status='failed', last_error_code='source_delete_failed' "
            "WHERE task_id=%s AND step_name='verify_not_retrievable'", (task_id,),
        )


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise ValueError("仅接受精确库名与本轮范围、原任务标识。")
    fail_final_verification(sys.argv[1], UUID(sys.argv[2]), UUID(sys.argv[3]), UUID(sys.argv[4]))
