"""A16 公共桥接验收：实际 HTTP、生产迁移 PG，只替换合成模型。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

import psycopg

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

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        migrations = Path(__file__).resolve().parents[3] / "backend/database/migrations"
        expected = sorted(path.name for path in migrations.glob("*.sql"))
        with psycopg.connect(cls.database_url) as connection:
            recorded = [row[0] for row in connection.execute(
                "SELECT name FROM public.notalone_schema_migration ORDER BY name",
            ).fetchall()]
        assert len(expected) == 57 and expected == recorded
        env = dict(os.environ, NOTALONE_DISABLE_DOTENV="1", NOTALONE_DATABASE_URL=cls.database_url)
        repeated = subprocess.run(
            [sys.executable, "-m", "notalone.database_migrations", "--migrations", str(migrations)],
            env=env, capture_output=True, text=True, timeout=60,
        )
        assert repeated.returncode == 0 and json.loads(repeated.stdout)["applied"] == []
        print(json.dumps({"migration": {"count": 57, "repeat": 0,
            "first": recorded[0], "last": recorded[-1]}}), flush=True)


def main() -> None:
    fixture = OwnershipFixture()
    try:
        OwnershipFixture.setUpClass()
        fixture.setUp()
        contact_ids = [fixture.prepare_contact(fixture.owner_id, f"合成联系人{number}",
            "合成待回应消息：今晚会晚一点回复。") for number in (1, 2)]
        write_backend_info(address=fixture.backend.base_url.removeprefix("http://"), token=fixture.backend.token)
        print(json.dumps({"ready": {"database_url": fixture.database_url,
            "owner_id": str(fixture.owner_id), "contact_ids": contact_ids,
            "other_contact_id": "", "empty_contact_id": "", "migration_count": 57,
            "migration_repeat": 0}}), flush=True)
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
