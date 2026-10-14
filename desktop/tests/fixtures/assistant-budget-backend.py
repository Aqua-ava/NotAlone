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
from uuid import UUID

import psycopg
from psycopg import sql

from fixture_cleanup import cleanup_fixture
from notalone.application.model_priority import ModelPriorityControl
from notalone.application.skill_service import SkillService
from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.reply.input_budget import TokenMeasurementKind
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.input_budget_support import SyntheticModelCounter, synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend


spec = importlib.util.spec_from_file_location(
    "assistant_budget_rewrite_fixture", Path(__file__).with_name("rewrite-backend.py"),
)
rewrite = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rewrite
spec.loader.exec_module(rewrite)


class SyntheticEstimateCounter(SyntheticModelCounter):
    """复用完整合成协议，只把显式测试配置标成带余量的估算。"""

    def measure(self, request):
        return replace(super().measure(request), kind=TokenMeasurementKind.APPROXIMATE,
                       measurement_id="synthetic-json-estimate-v1")


class AssistantBudgetFixture(rewrite.DesktopRewriteFixture):
    """预算配置只存在于测试进程，产品 HTTP 无模型能力写入口。"""

    capacity = 100000
    unknown = False
    approximate = False
    safety_margin = 0

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
        if recorded != expected or len(recorded) != 58 or not recorded[-1].startswith("058_"):
            raise RuntimeError("本轮预算夹具必须只应用正式001–058迁移。")
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
        if self.approximate:
            configuration["input_budget_profile"] = replace(
                configuration["input_budget_profile"], measurement_kind=TokenMeasurementKind.APPROXIMATE,
                measurement_id="synthetic-json-estimate-v1", safety_margin_tokens=self.safety_margin,
            )
            configuration["input_token_counter"] = SyntheticEstimateCounter(self.reply_model)
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
            skill_service=SkillService(management=PostgresSkillLibrary(self.database_url)),
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
                                    "migration_count": 58, "migration_repeat": 0}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
                result = {}
            elif operation == "strategy_skills":
                result = fixture.prepare_strategy_skills(contacts, foreign_contact)
            elif operation == "delete_contact":
                with psycopg.connect(fixture.database_url) as connection_db:
                    connection_db.execute("DELETE FROM public.contact WHERE owner_id=%s AND id=%s",
                                          (fixture.owner_id, UUID(command["contact_id"])))
                result = {}
            elif operation == "revoke":
                binding = next(item for item in fixture.bindings.list_active_bindings(owner_id=fixture.owner_id)
                               if str(item.scope.contact_id) == command["contact_id"])
                fixture.bindings.revoke_binding(owner_id=fixture.owner_id,
                                               contact_id=binding.scope.contact_id, binding_id=binding.binding_id)
                result = {}
            elif operation == "older_messages":
                fixture.add_older_messages(command["contact_id"])
                result = {"added": True}
            elif operation == "same_names":
                with psycopg.connect(fixture.database_url) as connection_db:
                    connection_db.execute(
                        "UPDATE public.contact SET display_name=%s WHERE owner_id=%s AND id=ANY(%s)",
                        ("同名合成联系人", fixture.owner_id, [UUID(value) for value in contacts]),
                    )
                result = {}
            elif operation == "configure":
                capacity = command.get("capacity", 100000)
                if type(capacity) is not int or capacity < 101 or capacity > 100000:
                    raise ValueError("合成配置范围无效。")
                approximate = command.get("approximate", False) is True
                margin = command.get("safety_margin", 200 if approximate else 0)
                if type(margin) is not int or margin < 0 or margin + 100 >= capacity or approximate and margin == 0:
                    raise ValueError("合成估算余量范围无效。")
                fixture.capacity = capacity
                fixture.unknown = command.get("unknown", False) is True
                fixture.approximate = approximate
                fixture.safety_margin = margin
                fixture.reply_model.plans.clear()
                fixture.backend.close()
                fixture.backend = fixture._backend(fixture.owner_id)
                result = connection()
            elif operation == "metrics":
                result = {"model_calls": len(fixture.reply_model.seen_model_payloads),
                          "model_entered": fixture.reply_model.entered.is_set(),
                          "payloads": fixture.reply_model.payloads,
                          "decisions": [decision.to_payload() for decision in fixture.decisions]}
            elif operation == "invalidate_exploration":
                contact = str(UUID(command["contact_id"]))
                if contact not in contacts:
                    raise ValueError("只允许本夹具已确认联系人。")
                # 仅设置原无正文屏障输入，不读取内部键或业务输出作为断言。
                with psycopg.connect(fixture.database_url) as database:
                    inserted = database.execute(
                        "INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) "
                        "SELECT owner_id,contact_id,request_key FROM public.reply_exploration "
                        "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                        (fixture.owner_id, UUID(contact), UUID(command["task_id"])),
                    )
                    if inserted.rowcount != 1:
                        raise ValueError("合成探索输入身份未确认。")
                result = {}
            elif operation == "invalidate_next_exploration":
                contact = str(UUID(command["contact_id"]))
                if contact not in contacts:
                    raise ValueError("只允许本夹具已确认联系人。")
                # 新应答task尚未存在；只为实际公开operation设置本隔离库的合成输入。
                with psycopg.connect(fixture.database_url) as database:
                    database.execute(sql.SQL("""CREATE FUNCTION synthetic_answer_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN
                            IF NEW.owner_id = {} AND NEW.contact_id = {} AND NEW.operation_key = {} THEN
                                INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key)
                                VALUES(NEW.owner_id,NEW.contact_id,NEW.request_key);
                            END IF;
                            RETURN NEW;
                        END $$""").format(sql.Literal(fixture.owner_id), sql.Literal(UUID(contact)),
                                            sql.Literal(UUID(command["operation_key"]))))
                    database.execute("CREATE TRIGGER synthetic_answer_barrier AFTER INSERT ON public.reply_exploration "
                                     "FOR EACH ROW EXECUTE FUNCTION synthetic_answer_barrier()")
                result = {}
            elif operation == "model-wire-inputs":
                result = fixture.reply_model.seen_model_payloads
            elif operation == "model-inputs":
                result = fixture.reply_model.payloads
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
