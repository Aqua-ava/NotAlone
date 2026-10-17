"""长期偏好控制器的合成 HTTP/PG 夹具；不启动 App 或调用外部模型。"""

import json
import os
from pathlib import Path
import sys

from fixture_cleanup import cleanup_fixture

ROOT = Path(__file__).resolve().parents[3]


def main():
    if (os.environ.get('CONDA_DEFAULT_ENV') != 'NotAlone' or Path.cwd() != ROOT / 'backend'
            or os.environ.get('PYTHONPATH', '').split(os.pathsep)[:2] != [str(ROOT / 'backend/src'), str(ROOT / 'backend')]):
        raise RuntimeError('偏好夹具须显式加载当前工作树和Conda环境。')
    from module_guard import bind_test_database_before_import, guard_modules, guard_test_migrations
    ownership_path = Path(os.environ["NOTALONE_PREFERENCE_OWNERSHIP"])
    database_name = bind_test_database_before_import(ownership_path)
    from tests.integration.server.test_expression_preferences import ExpressionPreferencesHttpTest
    expected = json.loads(os.environ['NOTALONE_PREFERENCE_EXPECTED_MODULES'])
    evidence_path = Path(os.environ['NOTALONE_PREFERENCE_OWNERSHIP']).parent / 'runtime-proof.json'
    fixture = ExpressionPreferencesHttpTest()
    ExpressionPreferencesHttpTest._prepared_database_name = database_name
    ExpressionPreferencesHttpTest._database_ownership_path = ownership_path
    migration_proof = {}
    try:
        fixture.setUpClass()
        os.environ.update(NOTALONE_DATABASE_URL=fixture.database_url, NOTALONE_TEST_DATABASE_URL=fixture.database_url)
        migration_proof = guard_test_migrations(fixture.database_url, fixture.database_name, ROOT)
        fixture.setUp()
        fixture._bind(fixture.contact_id)
        fixture._bind(fixture.second_contact_id)
        proof = guard_modules(ROOT, expected=expected, evidence_path=evidence_path, phase='ready')
        proof.update(migration_proof)
        print(json.dumps({"ready": {
            "port": int(fixture.backend.base_url.rsplit(":", 1)[1]), "token": fixture.backend.token,
            "contact_ids": [str(fixture.contact_id), str(fixture.second_contact_id)],
            **proof,
        }}), flush=True)
        for line in sys.stdin:
            if line.strip() == "stop":
                break
            raise ValueError("未知偏好夹具操作。")
    finally:
        try:
            guard_modules(ROOT, expected=expected, evidence_path=evidence_path, phase='complete')
            final_proof = json.loads(evidence_path.read_text())
            final_proof.update(migration_proof, child_pid=os.getpid(),
                               model_calls=len(fixture.reply_model.seen_calls))
            evidence_path.write_text(json.dumps(final_proof, ensure_ascii=False, indent=2))
        finally:
            cleanup_fixture(fixture)
            final_proof = json.loads(evidence_path.read_text())
            final_proof.update(database_remaining=False, fixture_cleanup_completed=True)
            evidence_path.write_text(json.dumps(final_proof, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
