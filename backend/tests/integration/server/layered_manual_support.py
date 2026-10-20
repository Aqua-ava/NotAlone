"""显式命令回归只手动调度整理；自动维护回归仍走正式启动路径。"""

from contextlib import nullcontext
from unittest.mock import patch

from notalone.server.app import create_app


def create_controlled_layered_app(*, automatic_maintenance, layered_memory, **kwargs):
    # 仅隔离后台通知启动，命令、Worker、期限、互斥与数据库均使用正式实现。
    # 同库的多个手动回归后端不能各自抢跑维护；自动维护用例显式开启。
    context = (nullcontext() if automatic_maintenance else
               patch.object(layered_memory, "start_maintenance"))
    with context:
        return create_app(layered_memory=layered_memory, **kwargs)
