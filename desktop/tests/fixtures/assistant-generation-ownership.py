"""A16 公共桥接验收：实际 HTTP、生产迁移 PG，只替换合成模型。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import sys

from fixture_cleanup import bind_prepared_database, database_ownership_path

PREPARED_DATABASE_NAME = bind_prepared_database()

definitions = runpy.run_path(str(Path(__file__).with_name("rewrite-backend.py")))
DesktopRewriteModel = definitions["DesktopRewriteModel"]
DesktopRewriteFixture = definitions["DesktopRewriteFixture"]
cleanup_fixture = definitions["cleanup_fixture"]
write_backend_info = definitions["write_backend_info"]


class OwnershipModel(DesktopRewriteModel):
    actual_calls: int = 0

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.actual_calls += 1
        return super()._generate(messages, stop, run_manager, **kwargs)


class OwnershipFixture(DesktopRewriteFixture):
    reply_model_factory = OwnershipModel
    _prepared_database_name = PREPARED_DATABASE_NAME


def main() -> None:
    fixture = OwnershipFixture()
    OwnershipFixture._database_ownership_path = database_ownership_path()
    try:
        OwnershipFixture.setUpClass()
        fixture.setUp()
        contact_ids = [fixture.prepare_contact(fixture.owner_id, f"合成联系人{number}",
            "合成待回应消息：今晚会晚一点回复。") for number in (1, 2)]
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        print(json.dumps({"ready": {"database_url": fixture.database_url,
            "owner_id": str(fixture.owner_id), "contact_ids": contact_ids,
            "other_contact_id": "", "empty_contact_id": "",
            **fixture.migration_receipt}}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            result = {}
            if operation == "plan":
                fixture.reply_model.plans.append(command["plan"])
            elif operation == "hold":
                fixture.reply_model.entered.clear()
                fixture.reply_model.pause_next_response()
            elif operation == "release":
                fixture._release_response_gates()
            elif operation == "counts":
                result = {"actual_calls": fixture.reply_model.actual_calls,
                    "completed_calls": len(fixture.reply_model.seen_calls),
                    "entered": fixture.reply_model.entered.is_set()}
            elif operation == "revoke":
                binding = next(item for item in fixture.bindings.list_active_bindings(owner_id=fixture.owner_id)
                    if str(item.scope.contact_id) == command["contact_id"])
                fixture.bindings.revoke_binding(owner_id=fixture.owner_id,
                    contact_id=binding.scope.contact_id, binding_id=binding.binding_id)
            elif operation == "restart":
                fixture.backend.close()
                fixture.backend = fixture._backend(fixture.owner_id)
                write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
            elif operation == "stop":
                print(json.dumps({"id": command["id"], "result": result}), flush=True)
                break
            else:
                raise ValueError("未知归属夹具操作。")
            print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        print(json.dumps({"model_counts": {"actual": fixture.reply_model.actual_calls
            if hasattr(fixture, "reply_model") else 0}}), flush=True)
        cleanup_fixture(fixture)


if __name__ == "__main__":
    main()
