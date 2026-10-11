"""预算页面使用真实生产装配和随机 PG，只改变合成模型的已声明容量。"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import psycopg

from fixture_cleanup import cleanup_fixture
from notalone.server.connection_info import write_backend_info
from tests.input_budget_support import synthetic_budget_kwargs


spec = importlib.util.spec_from_file_location(
    "assistant_input_budget_page_rewrite", Path(__file__).with_name("rewrite-backend.py"),
)
rewrite = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rewrite
spec.loader.exec_module(rewrite)


class AssistantInputBudgetPageFixture(rewrite.DesktopRewriteFixture):
    """只复用原模型协议与预算守卫，不提供产品能力配置写入口。"""

    capacity = 100000
    migration_count = 0
    migration_repeat = None

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        root = Path(__file__).resolve().parents[3]
        expected = sorted(path.name for path in (root / "backend/database/migrations").glob("*.sql"))
        with psycopg.connect(cls.database_url) as connection:
            recorded = [row[0] for row in connection.execute(
                "SELECT name FROM public.notalone_schema_migration ORDER BY name",
            ).fetchall()]
        if recorded != expected or len(recorded) != 55 or not recorded[-1].startswith("055_"):
            raise RuntimeError("预算页面必须只应用正式001–055迁移。")
        repeated = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations",
             str(root / "backend/database/migrations")],
            cwd=root / "backend", capture_output=True, text=True, timeout=60,
            env=dict(os.environ, NOTALONE_DATABASE_URL=cls.database_url),
        )
        if repeated.returncode or json.loads(repeated.stdout)["applied"] != []:
            raise RuntimeError("预算页面迁移重复执行必须为0。")
        cls.migration_count, cls.migration_repeat = 55, 0

    def input_budget_configuration(self):
        return synthetic_budget_kwargs(self.reply_model, capacity=self.capacity, output_reserve=100)


def main() -> None:
    fixture = AssistantInputBudgetPageFixture()
    AssistantInputBudgetPageFixture._database_ownership_path = (
        Path(os.environ["NOTALONE_ENV_FILE"]).parent / "database-ownership.json"
    )
    try:
        fixture.setUpClass()
        fixture.setUp()
        contacts = [
            fixture.prepare_contact(fixture.owner_id, "合成联系人甲", "甲的私密合成历史：今晚我会晚一点回复你。"),
            fixture.prepare_contact(fixture.owner_id, "合成联系人乙", "乙的私密合成历史：今晚我会晚一点回复你。"),
        ]
        foreign = fixture.prepare_contact(
            fixture.other_owner_id, "另一用户的联系人", "另一用户的私密合成历史：今晚我会晚一点回复你。",
        )
        empty = uuid4()
        with psycopg.connect(fixture.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s,%s,%s)",
                (fixture.owner_id, empty, "无消息的合成联系人"),
            )
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        print(json.dumps({"ready": {
            "database_url": fixture.database_url, "owner_id": str(fixture.owner_id),
            "contact_ids": contacts, "other_contact_id": foreign, "empty_contact_id": str(empty),
        }}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
                result = {}
            elif operation == "configure":
                capacity = command["capacity"]
                if type(capacity) is not int or not 101 <= capacity <= 100000:
                    raise ValueError("合成预算容量无效。")
                fixture.capacity = capacity
                fixture.reply_model.plans.clear()
                fixture.backend.close()
                fixture.backend = fixture._backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
                result = {}
            elif operation == "metrics":
                result = {"model_calls": len(fixture.reply_model.seen_model_payloads),
                          "migration_count": fixture.migration_count, "migration_repeat": fixture.migration_repeat}
            elif operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            else:
                raise ValueError("未知预算页面夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        cleanup_fixture(fixture)


if __name__ == "__main__":
    main()
