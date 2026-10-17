"""预算页面使用真实生产装配和随机 PG，只改变合成模型的已声明容量。"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

import psycopg

from fixture_cleanup import bind_prepared_database, cleanup_fixture
from notalone.server.connection_info import write_backend_info
from tests.input_budget_support import SyntheticModelCounter, synthetic_budget_kwargs


spec = importlib.util.spec_from_file_location(
    "assistant_input_budget_page_rewrite", Path(__file__).with_name("rewrite-backend.py"),
)
rewrite = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rewrite
spec.loader.exec_module(rewrite)


class AssistantInputBudgetPageFixture(rewrite.DesktopRewriteFixture):
    """只复用原模型协议与预算守卫，不提供产品能力配置写入口。"""

    capacity = 100000

    def input_budget_configuration(self):
        configuration = synthetic_budget_kwargs(self.reply_model, capacity=self.capacity, output_reserve=100)
        if not hasattr(self, "measured_totals"):
            self.measured_totals = []
        # 只观察真实守卫调用的计量值；不改变测量结果或模型请求。
        totals = self.measured_totals

        class ObservedCounter(SyntheticModelCounter):
            def measure(self, request):
                measurement = super().measure(request)
                profile = configuration["input_budget_profile"]
                totals.append(measurement.input_tokens + profile.output_reserve_tokens + profile.safety_margin_tokens)
                return measurement

        configuration["input_token_counter"] = ObservedCounter(self.reply_model)
        return configuration


def main() -> None:
    AssistantInputBudgetPageFixture._prepared_database_name = bind_prepared_database()
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
            elif operation == "calibration":
                result = {"first_stage_total": fixture.measured_totals[0],
                          "maximum_stage_total": max(fixture.measured_totals)}
            elif operation == "metrics":
                result = {"model_calls": len(fixture.reply_model.seen_model_payloads),
                          **fixture.migration_receipt}
            elif operation == "large_history":
                contact_id = contacts[0]
                status, session = fixture.backend.request(f"/api/contacts/{contact_id}/assistant-session/default", {})
                if status != 200:
                    raise RuntimeError("合成完整历史的默认会话未建立。")
                base = f"/api/contacts/{contact_id}/assistant-sessions/{session['session_id']}"
                identifiers = []
                for letter in "甲乙丙丁":
                    status, saved = fixture.backend.request(base + "/inputs", {
                        "content": {"type": "purpose_exploration", "purpose_hint": letter * 100000},
                        **({"expected_input_version_id": identifiers[-1]} if identifiers else {}),
                    })
                    if status != 200:
                        raise RuntimeError("合成完整历史输入未通过公开HTTP保存。")
                    identifiers.append(saved["input_version_id"])
                status, saved = fixture.backend.request(base)
                wire_bytes = len(json.dumps(saved, ensure_ascii=False).encode("utf-8"))
                if status != 200 or wire_bytes <= 1048576:
                    raise RuntimeError("合成完整历史必须真实超过默认1MiB上限。")
                result = {"session_id": session["session_id"], "input_version_ids": identifiers,
                          "wire_bytes": wire_bytes, "characters_per_input": 100000}
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
