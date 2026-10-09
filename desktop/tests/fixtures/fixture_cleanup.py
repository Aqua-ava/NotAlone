"""完成自有夹具清理后核验结果，错误不能被 unittest 回调吞掉。"""

from __future__ import annotations

import json
import re
import unittest

import psycopg


def cleanup_fixture(fixture: unittest.TestCase) -> None:
    fixture_class = type(fixture)
    instance_ok = fixture.doCleanups()
    fixture_class.doClassCleanups()
    class_ok = not fixture_class.tearDown_exceptions
    database_name = getattr(fixture_class, "database_name", None)
    database_remaining = None
    if isinstance(database_name, str) and re.fullmatch(
        r"notalone_core_flow_[0-9a-f]{32}_test", database_name
    ):
        try:
            with psycopg.connect("host=/tmp dbname=postgres", connect_timeout=3) as admin:
                database_remaining = admin.execute(
                    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)",
                    (database_name,),
                ).fetchone()[0]
        except psycopg.Error:
            pass
    print(json.dumps({"cleanup": {
        "instance_ok": instance_ok, "class_ok": class_ok,
        "database_remaining": database_remaining,
    }}), flush=True)
    if not instance_ok or not class_ok or database_remaining is not False:
        raise RuntimeError("本轮合成夹具收尾或数据库清理未确认。")
