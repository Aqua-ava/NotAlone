"""导入 HTTP 检查共用的隔离启动与本轮数据库残留核验。"""

import os
from pathlib import Path
import tempfile
import unittest

import psycopg

from import_backend import DesktopImportFixture


def run_import_http_suite(
    suite: unittest.TestSuite,
    fixture_class: type[DesktopImportFixture],
    *,
    directory_prefix: str,
) -> None:
    # 套件与目录前缀由调用者选择；App 夹具仍由统一门禁准备。
    with tempfile.TemporaryDirectory(prefix=directory_prefix) as directory:
        current = Path(directory)
        os.environ.update({
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_ENV_FILE": str(current / "synthetic.env"),
            "NOTALONE_BACKEND_INFO": str(current / "backend.info"),
            "NOTALONE_DATABASE_URL": "", "NOTALONE_OWNER_ID": "",
            "NOTALONE_DEEPSEEK_API_KEY": "", "DEEPSEEK_API_KEY": "",
            "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false",
            "NOTALONE_DEEPSEEK_BASE_URL": "http://127.0.0.1:1",
            "NOTALONE_WECHAT_CLI": str(current / "unavailable-cli"),
            "NOTALONE_SYNC_PROBE": str(current / "unavailable-probe"),
        })
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        with psycopg.connect("host=/tmp dbname=postgres") as admin:
            remaining = admin.execute(
                "SELECT count(*) FROM pg_database WHERE datname = %s",
                (fixture_class.database_name,),
            ).fetchone()[0]
        print(f"本轮隔离数据库残留：{remaining}", flush=True)
        if not result.wasSuccessful() or remaining:
            raise SystemExit(1)
