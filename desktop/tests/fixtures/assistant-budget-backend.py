"""预算公开操作的真实 HTTP/PG 夹具；只替换已声明协议的合成模型。"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import psycopg

from fixture_cleanup import cleanup_fixture
from notalone.application.model_priority import ModelPriorityControl
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend


spec = importlib.util.spec_from_file_location(
    "assistant_budget_rewrite_fixture", Path(__file__).with_name("rewrite-backend.py"),
)
rewrite = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rewrite
spec.loader.exec_module(rewrite)


class AssistantBudgetFixture(rewrite.DesktopRewriteFixture):
    """预算配置只存在于测试进程，产品 HTTP 无模型能力写入口。"""

    capacity = 100000
    unknown = False

    def __init__(self) -> None:
        super().__init__()
        self.decisions = []

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        with psycopg.connect(cls.database_url) as connection:
            recorded = [row[0] for row in connection.execute(
                "SELECT name FROM public.notalone_schema_migration ORDER BY name",
            ).fetchall()]
        root = Path(__file__).resolve().parents[3]
        expected = sorted(path.name for path in (root / "backend/database/migrations").glob("*.sql"))
        if recorded != expected or len(recorded) != 55 or not recorded[-1].startswith("055_"):
            raise RuntimeError("本轮预算夹具必须只应用正式001–055迁移。")
        repeated = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations",
             str(root / "backend/database/migrations")],
            cwd=root / "backend", capture_output=True, text=True, timeout=60,
            env=dict(os.environ, NOTALONE_DATABASE_URL=cls.database_url),
        )
        if repeated.returncode or json.loads(repeated.stdout)["applied"] != []:
            raise RuntimeError("本轮预算迁移重复执行必须为0。")

    def _backend(self, owner_id):
        priority = ModelPriorityControl()
        configuration = synthetic_budget_kwargs(self.reply_model, capacity=self.capacity, output_reserve=100)
        if self.unknown:
            configuration["input_budget_profile"] = replace(
                configuration["input_budget_profile"], context_window_tokens=None,
                output_reserve_tokens=None, measurement_kind=None, measurement_id=None,
            )
            configuration["input_token_counter"] = None
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.reply_model):
            service = build_reply_service(
                database_url=self.database_url, owner_id=owner_id, model_priority=priority,
                on_input_budget=self.decisions.append, **configuration,
            )
        backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-budget-public-{owner_id}", reply_service=service,
            runtime_shutdown=priority.stop,
        ), owner_id)
        self.addCleanup(backend.close)
        return backend


def main() -> None:
    fixture = AssistantBudgetFixture()
    AssistantBudgetFixture._database_ownership_path = Path(os.environ['NOTALONE_ENV_FILE']).parent / 'database-ownership.json'
    try:
        fixture.setUpClass()
        fixture.setUp()
        history = ("甲的私密合成历史：" + "本轮工具预算检查的完整合成资料。" * 80
                   if os.environ.get("NOTALONE_BUDGET_TOOL_HISTORY") == "1" else "甲的合成历史。")
        contacts = [fixture.prepare_contact(fixture.owner_id, "预算合成联系人甲", history),
                    fixture.prepare_contact(fixture.owner_id, "预算合成联系人乙", "乙的合成历史。")]
        foreign_contact = fixture.prepare_contact(fixture.other_owner_id, "另一合成用户", "另一用户的合成历史。")
        def connection():
            return {"port": int(fixture.backend.base_url.rsplit(":", 1)[1]), "token": fixture.backend.token}
        print(json.dumps({"ready": {**connection(), "contact_ids": contacts,
                                    "foreign_contact_id": foreign_contact,
                                    "migration_count": 55, "migration_repeat": 0}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
                result = {}
            elif operation == "configure":
                capacity = command.get("capacity", 100000)
                if type(capacity) is not int or capacity < 101 or capacity > 100000:
                    raise ValueError("合成配置范围无效。")
                fixture.capacity = capacity
                fixture.unknown = command.get("unknown", False) is True
                fixture.reply_model.plans.clear()
                fixture.backend.close()
                fixture.backend = fixture._backend(fixture.owner_id)
                result = connection()
            elif operation == "metrics":
                result = {"model_calls": len(fixture.reply_model.seen_model_payloads),
                          "decisions": [decision.to_payload() for decision in fixture.decisions]}
            elif operation == "hold":
                fixture.reply_model.pause_next_response()
                result = {}
            elif operation == "release":
                fixture._release_response_gates()
                result = {}
            elif operation == "stop":
                print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                break
            else:
                raise ValueError("未知预算夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        cleanup_fixture(fixture)


if __name__ == "__main__":
    main()
