"""通过生产默认装配和公开 HTTP 核对敏感追踪的查询与删除。"""

import json
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

import httpx
import psycopg
from psycopg import sql

from notalone.application.import_service import ImportService
from notalone.memory_extraction.command import extract_main
from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
from notalone.memory_trace.command import memory_trace_main, source_trace_main
from notalone.persistence.background_tasks import (
    BackgroundTaskPersistenceError,
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.watermark_store import PostgresWatermarkStore
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from notalone.tasks.command import worker_main
from tests.integration.server import test_import_auto_flow as auto_support
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture,
    HttpBackend,
)


class MemoryTraceApiTest(CoreBusinessFlowFixture, unittest.TestCase):
    # 此组验证自动采纳后的追踪／删除链，显式使用合成测试放行配置。
    dimension_release = RELEASE_ALL_DIMENSIONS
    production_model_wiring = True
    extraction_model_factory = auto_support.AutoMemoryModel
    _import_auto = auto_support.ImportAutoFlowHttpTest._import_auto
    _task = auto_support.ImportAutoFlowHttpTest._task
    _wait_task = auto_support.ImportAutoFlowHttpTest._wait_task

    def setUp(self):
        super().setUp()
        self.addCleanup(self._release_models)

    def _release_models(self):
        for gate in self.extraction_model.gates.values():
            gate.release.set()

    def _install_fault(self, table, *, stage=None):
        name = "trace_api_fault_" + uuid4().hex
        with psycopg.connect(self.database_url) as connection:
            condition = (
                sql.SQL(" AND NEW.stage={}").format(sql.Literal(stage))
                if stage
                else sql.SQL("")
            )
            connection.execute(
                sql.SQL(
                    "CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id={}::uuid{} THEN RAISE EXCEPTION '合成故障，不应进入普通响应'; END IF; RETURN NEW; END $$"
                ).format(
                    sql.Identifier(name),
                    sql.Literal(str(self.owner_id)),
                    condition,
                )
            )
            connection.execute(
                sql.SQL(
                    "CREATE TRIGGER {} BEFORE INSERT ON public.{} FOR EACH ROW EXECUTE FUNCTION {}()"
                ).format(
                    sql.Identifier(name),
                    sql.Identifier(table),
                    sql.Identifier(name),
                )
            )

        def remove():
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    sql.SQL("DROP TRIGGER IF EXISTS {} ON public.{}").format(
                        sql.Identifier(name), sql.Identifier(table)
                    )
                )
                connection.execute(
                    sql.SQL("DROP FUNCTION IF EXISTS {}()").format(
                        sql.Identifier(name)
                    )
                )

        self.addCleanup(remove)
        return remove

    def test_automatic_import_is_queryable_from_original_record_to_memory(
        self,
    ):
        imported = self._import_auto(self.backend, "完整追踪", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        batches = self._get(self.backend, prefix + "/memory-traces")["batches"]
        self.assertEqual(len(batches), 1)
        detail = self._get(
            self.backend, prefix + "/memory-traces/" + batches[0]["trace_id"]
        )
        self.assertEqual(detail["status"], "succeeded")
        requests = [
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "model_request"
        ]
        self.assertEqual(
            [row["purpose"] for row in requests],
            ["extraction", "verification"],
        )
        self.assertIn(
            "我平时喜欢茉莉茶", requests[0]["messages"][1]["content"]
        )
        responses = [
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "model_response"
        ]
        self.assertEqual(len(responses), 2)
        self.assertTrue(
            all(
                row["provider_capture"] == "not_observable"
                for row in responses
            )
        )
        processing = self._get(
            self.backend,
            prefix
            + "/source-processing-traces/records/message/"
            + imported["fact_message"]["message_id"],
        )
        self.assertEqual(processing["availability"], "recorded")
        original = self._get(
            self.backend,
            prefix
            + "/source-processing-traces/"
            + processing["batches"][0]["batch_id"],
        )
        self.assertIn(
            "我平时喜欢茉莉茶", str(original["records"][0]["payload"])
        )
        memory = self._get(self.backend, prefix + "/memories")["memories"][0]
        lookup = self._get(
            self.backend,
            prefix
            + "/memory-traces/records/contact_memory/"
            + memory["memory_id"],
        )
        self.assertEqual(lookup["availability"], "recorded")
        self.assertEqual(lookup["batches"][0]["trace_id"], detail["trace_id"])

    def test_default_http_priority_factory_captures_real_sdk_for_zero_candidates(
        self,
    ):
        status, manual = self.backend.request(
            "/api/memories/manual-owner",
            {
                "text": "SDK 提取前手输的本人资料",
                "category": "common_fact",
                "topic": "other",
            },
        )
        self.assertEqual(status, 200)
        observed = []

        def local_http(request):
            observed.append(request.content.decode())
            wire = json.loads(request.content)
            schema = wire["tools"][0]["function"]["parameters"]["properties"]["units"]["properties"]
            labels = {unit: {"kind": "not_memory", "subject": "contact", "topic": "other",
                "dependency": None, "unresolved": False, "confidence": 0.95, "sensitivity": "none",
                **({"event": None} if "event" in item["properties"] else {})}
                for unit, item in schema.items()}
            return httpx.Response(
                200,
                json={
                    "id": "synthetic-sdk",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "deepseek-chat",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "synthetic-zero",
                                        "type": "function",
                                        "function": {
                                            "name": "GroundedMemoryLabels",
                                            "arguments": json.dumps({"units": labels}),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                },
            )

        def local_model(**options):
            source_client = options["http_client"]
            client = httpx.Client(
                transport=httpx.MockTransport(local_http),
                event_hooks={
                    key: list(value)
                    for key, value in source_client.event_hooks.items()
                },
            )
            self.addCleanup(client.close)
            source_client.close()
            return build_deepseek_model(
                api_key="synthetic-sdk-secret",
                base_url="http://127.0.0.1/synthetic/v1",
                http_client=client,
                extra_body=options["extra_body"],
            )

        with patch(
            "notalone.memory_extraction.cli_support.build_deepseek_model",
            side_effect=local_model,
        ):
            imported = self._import_auto(
                self.backend, "真实SDK零候选", "茉莉茶"
            )
            self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        batch = self._get(self.backend, prefix + "/memory-traces")["batches"][
            0
        ]
        detail = self._get(
            self.backend, prefix + "/memory-traces/" + batch["trace_id"]
        )
        self.assertEqual(detail["status"], "succeeded")
        self.assertEqual(detail["candidates"], [])
        self.assertEqual(len(observed), 1)
        provider = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "provider_request"
        )
        self.assertEqual(provider["body_text"], observed[0])
        self.assertEqual(
            provider["parsed_body"]["thinking"], {"type": "enabled"}
        )
        self.assertEqual(
            provider["parsed_body"]["tools"][0]["function"]["name"],
            "GroundedMemoryLabels",
        )
        response = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "model_response"
        )
        self.assertEqual(response["provider_capture"], "recorded")
        self.assertEqual(detail["calls"][0]["provider_attempts"], 1)
        self.assertNotIn("synthetic-sdk-secret", json.dumps(detail))
        self.assertEqual(
            self._get(self.backend, prefix + "/memories")["memories"], []
        )
        pool = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "memory_pool"
        )
        self.assertEqual(
            pool["owner_pool"][0]["memory_id"], manual["memory"]["memory_id"]
        )
        found = self._get(
            self.backend,
            prefix
            + "/memory-traces/records/message/"
            + imported["fact_message"]["message_id"],
        )
        self.assertEqual(found["batches"][0]["trace_id"], detail["trace_id"])
        window = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "window"
        )
        self.assertEqual(
            PostgresWatermarkStore(self.database_url).get(
                ContactScope(self.owner_id, UUID(imported["contact_id"]))
            ),
            UUID(window["watermark_planned"]),
        )
        self.assertEqual(
            self.backend.request(
                "/api/memories/owner/"
                + manual["memory"]["memory_id"]
                + "/delete",
                {},
            )[0],
            200,
        )
        deleted = self._get(
            self.backend, prefix + "/memory-traces/" + detail["trace_id"]
        )
        self.assertEqual(deleted["status"], "deleted")
        self.assertEqual(deleted["events"], [])

    def test_manual_owner_before_automatic_nonempty_extraction_is_deletable(
        self,
    ):
        status, manual = self.backend.request(
            "/api/memories/manual-owner",
            {
                "text": "自动提取前的本人手输合成资料",
                "category": "common_fact",
                "topic": "other",
            },
        )
        self.assertEqual(status, 200)
        imported = self._import_auto(self.backend, "本人资料后提取", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        found = self._get(
            self.backend,
            prefix
            + "/memory-traces/records/message/"
            + imported["fact_message"]["message_id"],
        )
        detail = self._get(
            self.backend,
            prefix + "/memory-traces/" + found["batches"][0]["trace_id"],
        )
        self.assertEqual(detail["status"], "succeeded")
        self.assertEqual(
            len(self._get(self.backend, prefix + "/memories")["memories"]), 1
        )
        self.assertIn("自动提取前的本人手输合成资料", str(detail))
        status, independent = self.backend.request("/api/memories/manual-contact", {
            "contact_id": imported["contact_id"], "text": "独立手输合成资料，不依赖被删除上下文。",
            "category": "common_fact", "topic": "other",
        })
        self.assertEqual(status, 200, independent)
        self.assertEqual(
            self.backend.request(
                "/api/memories/owner/"
                + manual["memory"]["memory_id"]
                + "/delete",
                {},
            )[0],
            200,
        )
        deleted = self._get(
            self.backend, prefix + "/memory-traces/" + detail["trace_id"]
        )
        self.assertEqual(deleted["status"], "deleted")
        self.assertNotIn("自动提取前的本人手输合成资料", str(deleted))
        # 提取实际读取过被删本人资料，派生正文必须沿冻结依赖擦除；独立手输仍在。
        retained = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual([item["memory_id"] for item in retained], [independent["memory"]["memory_id"]])

    def test_message_lookup_is_public_scoped_and_keeps_failed_batches(self):
        remove_fault = self._install_fault(
            "memory_extraction_trace_event", stage="model_response"
        )
        imported = self._import_auto(self.backend, "消息正查", "茉莉茶")
        self._wait_task(self.backend, imported, "failed")
        remove_fault()
        prefix = f"/api/contacts/{imported['contact_id']}"
        message_id = imported["fact_message"]["message_id"]
        path = prefix + "/memory-traces/records/message/" + message_id
        found = self._get(self.backend, path)
        self.assertEqual(found["availability"], "recorded")
        self.assertEqual(found["batches"][0]["status"], "trace_failed")
        processing = self._get(
            self.backend,
            prefix + "/source-processing-traces/records/message/" + message_id,
        )
        self.assertIn("batch_id", processing["batches"][0])
        self.assertIn("trace_id", found["batches"][0])
        env = {
            "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.owner_id),
            "NOTALONE_DISABLE_DOTENV": "1",
        }
        with patch.dict("os.environ", env), redirect_stdout(
            StringIO()
        ) as output:
            self.assertEqual(
                memory_trace_main(
                    [
                        "--contact-id",
                        imported["contact_id"],
                        "find",
                        "message",
                        message_id,
                    ]
                ),
                0,
            )
        self.assertEqual(
            json.loads(output.getvalue())["batches"][0]["trace_id"],
            found["batches"][0]["trace_id"],
        )
        other = self._import_auto(self.backend, "消息另一范围", "绿茶")
        self._wait_task(self.backend, other, "succeeded")
        for backend, query in (
            (self.other_backend, path),
            (
                self.backend,
                path.replace(imported["contact_id"], other["contact_id"]),
            ),
            (self.backend, path.replace(message_id, str(uuid4()))),
        ):
            with self.subTest(query=query):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(
                        Request(
                            backend.base_url + query,
                            headers={
                                "Authorization": f"Bearer {backend.token}"
                            },
                        )
                    )
                with caught.exception as response:
                    self.assertEqual(response.status, 404)
                    self.assertEqual(
                        response.headers["Cache-Control"], "no-store"
                    )
                    self.assertEqual(response.read(), b'{"error":"not_found"}')

    def test_cross_scope_and_missing_records_return_same_no_store_not_found(
        self,
    ):
        imported = self._import_auto(self.backend, "授权范围", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        batches = self._get(self.backend, prefix + "/memory-traces")["batches"]
        memory = self._get(self.backend, prefix + "/memories")["memories"][0]
        second = self._import_auto(self.backend, "另一联系人", "绿茶")
        self._wait_task(self.backend, second, "succeeded")
        other_prefix = f"/api/contacts/{second['contact_id']}"
        for backend, path in (
            (self.other_backend, prefix + "/memory-traces"),
            (
                self.other_backend,
                prefix + "/memory-traces/" + batches[0]["trace_id"],
            ),
            (self.backend, prefix + "/memory-traces/" + str(uuid4())),
            (
                self.backend,
                prefix
                + "/memory-traces/records/contact_memory/"
                + str(uuid4()),
            ),
            (
                self.other_backend,
                prefix
                + "/memory-traces/records/contact_memory/"
                + memory["memory_id"],
            ),
            (
                self.backend,
                prefix
                + "/source-processing-traces/records/message/"
                + str(uuid4()),
            ),
            (
                self.backend,
                other_prefix + "/memory-traces/" + batches[0]["trace_id"],
            ),
            (
                self.backend,
                other_prefix
                + "/memory-traces/records/contact_memory/"
                + memory["memory_id"],
            ),
            (
                self.backend,
                other_prefix
                + "/source-processing-traces/records/message/"
                + imported["fact_message"]["message_id"],
            ),
        ):
            with self.subTest(path=path):
                request = Request(
                    backend.base_url + path,
                    headers={"Authorization": f"Bearer {backend.token}"},
                )
                with self.assertRaises(HTTPError) as caught:
                    urlopen(request)
                with caught.exception as response:
                    self.assertEqual(response.status, 404)
                    self.assertEqual(
                        response.headers["Cache-Control"], "no-store"
                    )
                    self.assertEqual(response.read(), b'{"error":"not_found"}')

    def test_manual_trace_delete_retains_memory_and_processing_delete_erases_copies(
        self,
    ):
        imported = self._import_auto(self.backend, "手动删除", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        trace = self._get(self.backend, prefix + "/memory-traces")["batches"][
            0
        ]
        path = prefix + "/memory-traces/" + trace["trace_id"]
        memory = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.assertEqual(self.backend.request(path, method="DELETE")[0], 200)
        detail = self._get(self.backend, path)
        self.assertEqual((detail["status"], detail["events"]), ("deleted", []))
        self.assertEqual(
            self._get(self.backend, prefix + "/memories")["memories"][0],
            memory,
        )
        lookup = self._get(
            self.backend,
            prefix
            + "/memory-traces/records/contact_memory/"
            + memory["memory_id"],
        )
        self.assertEqual(lookup["availability"], "deleted")
        processing = self._get(
            self.backend, prefix + "/source-processing-traces"
        )["batches"][0]
        path = prefix + "/source-processing-traces/" + processing["batch_id"]
        self.assertEqual(self.backend.request(path, method="DELETE")[0], 200)
        deleted = self._get(self.backend, path)
        self.assertEqual(deleted["status"], "deleted")
        self.assertTrue(
            all(row["payload"] is None for row in deleted["records"])
        )

    def test_queries_work_without_model_configuration_and_cli_is_scoped(self):
        imported = self._import_auto(self.backend, "只读查询", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        client = InProcessClient(
            create_app(
                database_url=self.database_url,
                owner_id=self.owner_id,
                token="synthetic-read-only",
            )
        )
        path = f"/api/contacts/{imported['contact_id']}/memory-traces"
        for headers, expected in (
            ({}, 401),
            ({"Authorization": "Bearer synthetic-read-only"}, 200),
        ):
            response = client.get(path, headers=headers)
            self.assertEqual(response.status_code, expected)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        env = {
            "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.owner_id),
            "NOTALONE_DISABLE_DOTENV": "1",
        }
        with patch.dict("os.environ", env):
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(
                    memory_trace_main(
                        ["--contact-id", imported["contact_id"], "list"]
                    ),
                    0,
                )
            self.assertIn('"status":"succeeded"', output.getvalue())
            with redirect_stdout(StringIO()):
                self.assertEqual(
                    source_trace_main(
                        [
                            "--contact-id",
                            imported["contact_id"],
                            "find",
                            "message",
                            imported["fact_message"]["message_id"],
                        ]
                    ),
                    0,
                )
            with redirect_stderr(StringIO()) as error:
                self.assertEqual(
                    memory_trace_main(["--contact-id", str(uuid4()), "list"]),
                    1,
                )
                self.assertIn("not_found", error.getvalue())

    def test_trace_errors_are_safe_and_all_responses_disable_caching(self):
        imported = self._import_auto(self.backend, "安全错误", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        path = f"/api/contacts/{imported['contact_id']}/memory-traces"
        fault = create_app(
            database_url="host=/tmp dbname=missing_trace_" + uuid4().hex,
            owner_id=self.owner_id,
            token="synthetic-errors",
        )
        uninitialized = create_app(
            database_url=self.database_url,
            owner_id=None,
            token="synthetic-errors",
        )
        for app, expected, error_code in (
            (fault, 500, "trace_operation_failed"),
            (uninitialized, 503, "owner_uninitialized"),
        ):
            response = InProcessClient(app).get(
                path, headers={"Authorization": "Bearer synthetic-errors"}
            )
            self.assertEqual(response.status_code, expected)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.json(), {"error": error_code})
        client = InProcessClient(
            create_app(
                database_url=self.database_url,
                owner_id=self.owner_id,
                token="synthetic-errors",
            )
        )
        response = client.get(
            path + "?limit=0",
            headers={"Authorization": "Bearer synthetic-errors"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_bounded_pages_reach_old_batches_and_cursor_cannot_cross_scope(
        self,
    ):
        imported = self._import_auto(self.backend, "长期分页", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        oldest = self._get(self.backend, prefix + "/memory-traces")["batches"][
            0
        ]["trace_id"]
        oldest_processing = self._get(
            self.backend, prefix + "/source-processing-traces"
        )["batches"][0]["batch_id"]
        env = {
            "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.owner_id),
            "NOTALONE_DISABLE_DOTENV": "1",
        }
        for _ in range(3):
            with patch.dict("os.environ", env), redirect_stdout(StringIO()):
                self.assertEqual(
                    extract_main(["--contact-id", imported["contact_id"]]), 0
                )
            body = dict(imported["body"])
            body.pop("new_contact_name")
            body["contact_id"] = imported["contact_id"]
            self.assertEqual(
                self.backend.request("/api/imports/commit", body)[0], 200
            )
        second = self._import_auto(self.backend, "分页其他联系人", "绿茶")
        self._wait_task(self.backend, second, "succeeded")
        other_prefix = f"/api/contacts/{second['contact_id']}"
        for resource, identifier in (
            ("memory-traces", "trace_id"),
            ("source-processing-traces", "batch_id"),
        ):
            seen = []
            query = "?limit=1"
            while True:
                page = self._get(self.backend, prefix + "/" + resource + query)
                self.assertLessEqual(len(page["batches"]), 1)
                seen.extend(row[identifier] for row in page["batches"])
                if page["next_before"] is None:
                    break
                query = "?limit=1&before=" + page["next_before"]
            self.assertEqual(len(seen), 4)
            self.assertEqual(len(set(seen)), 4)
            self.assertEqual(
                seen[-1],
                oldest if resource == "memory-traces" else oldest_processing,
            )
            self.assertEqual(
                self._get(
                    self.backend, prefix + "/" + resource + "/" + seen[-1]
                )[identifier],
                seen[-1],
            )
            self.assertEqual(
                self.other_backend.request(
                    prefix + "/" + resource + "?before=" + seen[0]
                )[0],
                404,
            )
            self.assertEqual(
                self.backend.request(
                    other_prefix + "/" + resource + "?before=" + seen[0]
                )[0],
                404,
            )

    def test_confirmed_model_candidate_retains_its_original_trace(self):
        self.dimension_release = None
        backend = self._backend(self.owner_id)
        imported = self._import_auto(backend, "人工确认模型候选", "茉莉茶")
        self._wait_task(backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        candidate = self._get(backend, prefix + "/memory-candidates")[
            "candidates"
        ][0]
        lookup = self._get(
            backend,
            prefix
            + "/memory-traces/records/candidate/"
            + candidate["candidate_id"],
        )
        status, confirmed = backend.request(
            prefix
            + "/memory-candidates/"
            + candidate["candidate_id"]
            + "/confirm",
            {},
        )
        self.assertEqual(status, 200)
        self.assertEqual(confirmed["memory"]["adoption_method"], "manual")
        final = self._get(
            backend,
            prefix
            + "/memory-traces/records/contact_memory/"
            + confirmed["memory"]["memory_id"],
        )
        self.assertEqual(final["availability"], "recorded")
        self.assertEqual(
            final["batches"][0]["trace_id"], lookup["batches"][0]["trace_id"]
        )

    def test_ledger_ack_loss_preserves_one_id_and_unknown_receipt_then_retries(
        self,
    ):
        original_record = PostgresOutboundLedger.record
        failed_entries = []

        def lose_first_receipt(ledger, entry):
            original_record(ledger, entry)
            if entry.owner_id == self.owner_id and not failed_entries:
                failed_entries.append(str(entry.entry_id))
                raise RuntimeError("合成台账回执丢失")

        with patch.object(
            PostgresOutboundLedger, "record", lose_first_receipt
        ):
            imported = self._import_auto(self.backend, "台账回执", "茉莉茶")
            failed = self._wait_task(self.backend, imported, "failed")
        self.assertEqual(failed["error_code"], "worker_step_failed")
        task_scope = {
            "contact_id": imported["contact_id"],
            "task_id": imported["task_id"],
        }
        self.assertEqual(
            self.backend.request("/api/tasks/retry", task_scope)[0], 200
        )
        self.assertEqual(
            self.backend.request("/api/tasks/run", task_scope)[0], 200
        )
        self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        batches = self._get(self.backend, prefix + "/memory-traces")["batches"]
        calls = [
            call
            for batch in batches
            for call in self._get(
                self.backend, prefix + "/memory-traces/" + batch["trace_id"]
            )["calls"]
        ]
        ledger = self._get(self.backend, "/api/ledger/summary")
        self.assertEqual(ledger["total_calls"], 4)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len({call["call_id"] for call in calls}), 4)
        self.assertEqual(
            {call["ledger_entry_id"] for call in calls},
            {entry["entry_id"] for entry in ledger["recent"]},
        )
        unknown = [
            call for call in calls if call["ledger_commit_status"] == "unknown"
        ]
        self.assertEqual(
            [call["ledger_entry_id"] for call in unknown], failed_entries
        )
        self.assertEqual(unknown[0]["purpose"], "verification")
        self.assertEqual(
            len(self._get(self.backend, prefix + "/memories")["memories"]), 1
        )

    def test_manual_contact_and_owner_material_are_explicitly_not_applicable(
        self,
    ):
        imported = self._import_auto(self.backend, "手输资料", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        prefix = f"/api/contacts/{imported['contact_id']}"
        for path, kind in (
            ("/api/memories/manual-contact", "contact_memory"),
            ("/api/memories/manual-owner", "owner_memory"),
        ):
            status, created = self.backend.request(
                path,
                {
                    "contact_id": imported["contact_id"],
                    "text": "主动录入的合成资料",
                    "category": "common_fact",
                    "topic": "other",
                },
            )
            self.assertEqual(status, 200)
            result = self._get(
                self.backend,
                prefix
                + "/memory-traces/records/"
                + kind
                + "/"
                + created["memory"]["memory_id"],
            )
            self.assertEqual(result["availability"], "not_applicable")

    def test_source_processing_fault_is_exposed_without_input_and_does_not_import(
        self,
    ):
        imported = self._import_auto(self.backend, "来源故障前置", "茉莉茶")
        self._wait_task(self.backend, imported, "succeeded")
        self._install_fault("source_processing_record")
        body = dict(imported["body"])
        body.pop("new_contact_name")
        body["contact_id"] = imported["contact_id"]
        response = self.backend.request("/api/imports/commit", body)
        self.assertEqual(
            response, (503, {"error": "source_processing_write_failed"})
        )
        self.assertEqual(
            len(
                self._get(
                    self.backend,
                    f"/api/contacts/{imported['contact_id']}/messages",
                )["messages"]
            ),
            3,
        )

    def test_direct_cli_default_records_trace_and_reports_trace_fault_safely(
        self,
    ):
        backend = HttpBackend(
            create_app(
                database_url=self.database_url,
                owner_id=self.owner_id,
                token="synthetic-cli",
                import_service=ImportService(
                    repository=PostgresIngestRepository(self.database_url)
                ),
            ),
            self.owner_id,
        )
        self.addCleanup(backend.close)
        imported = self._import_auto(backend, "独立CLI追踪", "茉莉茶")
        self._install_fault(
            "memory_extraction_trace_event", stage="model_response"
        )
        env = {
            "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.owner_id),
            "NOTALONE_DISABLE_DOTENV": "1",
        }
        output = StringIO()
        with patch.dict("os.environ", env), patch(
            "notalone.memory_extraction.cli_support.build_deepseek_model",
            return_value=self.extraction_model,
        ), redirect_stdout(output):
            status = extract_main(
                ["--contact-id", imported["contact_id"], "--batch-size", "3"]
            )
        self.assertEqual(status, 1)
        self.assertIn("trace_write_failed", output.getvalue())
        self.assertNotIn("我平时喜欢", output.getvalue())
        prefix = f"/api/contacts/{imported['contact_id']}"
        trace = self._get(backend, prefix + "/memory-traces")["batches"][0]
        self.assertEqual(trace["status"], "trace_failed")
        detail = self._get(
            backend, prefix + "/memory-traces/" + trace["trace_id"]
        )
        self.assertEqual(len(detail["calls"]), 1)

    def test_stopped_late_extraction_is_distinct_and_keeps_one_trace_call_link(
        self,
    ):
        gate = self.extraction_model.block_call(0)
        imported = self._import_auto(self.backend, "晚结果", "茉莉茶")
        self.assertTrue(gate.entered.wait(5))
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        gate.release.set()
        prefix = f"/api/contacts/{imported['contact_id']}"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            batches = self._get(reopened, prefix + "/memory-traces")["batches"]
            if batches[0]["status"] != "running":
                break
            threading.Event().wait(0.02)
        detail = self._get(
            reopened, prefix + "/memory-traces/" + batches[0]["trace_id"]
        )
        self.assertEqual(
            (detail["status"], detail["error_code"]),
            ("stopped", "model_work_stopped"),
        )
        self.assertEqual(
            self._get(reopened, prefix + "/memories")["memories"], []
        )
        calls = detail["calls"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            (
                calls[0]["purpose"],
                calls[0]["response_status"],
                calls[0]["disposition"],
            ),
            ("extraction", "returned", "not_adopted"),
        )
        ledger = self._get(reopened, "/api/ledger/summary")
        self.assertEqual(ledger["total_calls"], 1)
        self.assertEqual(
            calls[0]["ledger_entry_id"], ledger["recent"][0]["entry_id"]
        )

    def test_stopped_late_verification_is_marked_not_adopted_without_recount(
        self,
    ):
        gate = self.extraction_model.block_call(1)
        imported = self._import_auto(self.backend, "核验晚结果", "茉莉茶")
        self.assertTrue(gate.entered.wait(5))
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        gate.release.set()
        prefix = f"/api/contacts/{imported['contact_id']}"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            batch = self._get(reopened, prefix + "/memory-traces")["batches"][
                0
            ]
            if batch["status"] != "running":
                break
            threading.Event().wait(0.02)
        detail = self._get(
            reopened, prefix + "/memory-traces/" + batch["trace_id"]
        )
        self.assertEqual(detail["status"], "stopped")
        self.assertEqual(len(detail["calls"]), 2)
        self.assertTrue(
            all(
                call["disposition"] == "not_adopted"
                for call in detail["calls"]
            )
        )
        self.assertEqual(
            self._get(reopened, "/api/ledger/summary")["total_calls"], 2
        )
        self.assertEqual(
            self._get(reopened, prefix + "/memories")["memories"], []
        )

    def test_call_receipt_fault_during_stop_is_visible_and_never_recounts_ledger(
        self,
    ):
        self._install_fault("memory_extraction_trace_call")
        gate = self.extraction_model.block_call(0)
        imported = self._import_auto(self.backend, "停止收据故障", "茉莉茶")
        self.assertTrue(gate.entered.wait(5))
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        gate.release.set()
        prefix = f"/api/contacts/{imported['contact_id']}"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            batch = self._get(reopened, prefix + "/memory-traces")["batches"][
                0
            ]
            if batch["status"] != "running":
                break
            threading.Event().wait(0.02)
        self.assertEqual(
            (batch["status"], batch["error_code"], batch["failure_stage"]),
            ("trace_failed", "trace_write_failed", "call_receipt"),
        )
        self.assertEqual(
            self._get(reopened, "/api/ledger/summary")["total_calls"], 1
        )
        self.assertEqual(
            self._get(reopened, prefix + "/memories")["memories"], []
        )

    def test_stopped_late_adjudication_keeps_all_call_links_once(self):
        first = self.extraction_model.block_call(0)
        imported = self._import_auto(self.backend, "裁决晚结果", "茉莉茶")
        self.assertTrue(first.entered.wait(5))
        prefix = f"/api/contacts/{imported['contact_id']}"
        status, manual = self.backend.request(
            "/api/memories/manual-contact",
            {
                "contact_id": imported["contact_id"],
                "text": "联系人很喜欢茉莉茶。",
                "category": "preference",
                "topic": "other",
            },
        )
        self.assertEqual(status, 200)
        adjudication = self.extraction_model.block_call(2)
        first.release.set()
        self.assertTrue(adjudication.entered.wait(5))
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        adjudication.release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            batch = self._get(reopened, prefix + "/memory-traces")["batches"][
                0
            ]
            if batch["status"] != "running":
                break
            threading.Event().wait(0.02)
        detail = self._get(
            reopened, prefix + "/memory-traces/" + batch["trace_id"]
        )
        self.assertEqual(detail["status"], "stopped")
        self.assertEqual(
            [row["purpose"] for row in detail["calls"]],
            ["extraction", "verification", "adjudication"],
        )
        self.assertEqual(
            self._get(reopened, "/api/ledger/summary")["total_calls"], 3
        )
        self.assertEqual(
            self._get(reopened, prefix + "/memories")["memories"],
            [manual["memory"]],
        )

    def test_response_trace_fault_has_safe_task_event_and_independent_recovery(
        self,
    ):
        remove = self._install_fault(
            "memory_extraction_trace_event", stage="model_response"
        )
        stream = self.backend.events()
        self.addCleanup(stream.close)
        imported = self._import_auto(self.backend, "响应追踪故障", "茉莉茶")
        task = self._wait_task(self.backend, imported, "failed")
        self.assertEqual(task["error_code"], "trace_write_failed")
        prefix = f"/api/contacts/{imported['contact_id']}"
        self.assertEqual(
            self._get(self.backend, prefix + "/memories")["memories"], []
        )
        watermark = PostgresWatermarkStore(self.database_url)
        scope = ContactScope(self.owner_id, UUID(imported["contact_id"]))
        self.assertIsNone(watermark.get(scope))
        self.assertIsNone(watermark.get_failure(scope))
        batches = self._get(self.backend, prefix + "/memory-traces")["batches"]
        self.assertEqual(len(batches), 3)
        calls = []
        for batch in batches:
            detail = self._get(
                self.backend, prefix + "/memory-traces/" + batch["trace_id"]
            )
            self.assertEqual(detail["error_code"], "trace_write_failed")
            calls.extend(detail["calls"])
        self.assertEqual(len(calls), 3)
        self.assertTrue(
            all(
                row["response_status"] == "returned"
                and row["disposition"] == "not_adopted"
                for row in calls
            )
        )
        summary = self._get(self.backend, "/api/ledger/summary")
        self.assertEqual(summary["total_calls"], 3)
        event_text = ""
        while "trace_write_failed" not in event_text:
            line = stream.readline().decode()
            self.assertTrue(line, "没有收到失败事件。")
            event_text += line
        self.assertNotIn("我平时喜欢", event_text)
        self.assertNotIn("合成故障", event_text)
        remove()
        self.assertEqual(
            self.backend.request(
                "/api/tasks/retry",
                {
                    "contact_id": imported["contact_id"],
                    "task_id": imported["task_id"],
                },
            )[0],
            200,
        )
        self.assertEqual(
            self.backend.request(
                "/api/tasks/run",
                {
                    "contact_id": imported["contact_id"],
                    "task_id": imported["task_id"],
                },
            )[0],
            200,
        )
        self._wait_task(self.backend, imported, "succeeded")
        self.assertEqual(
            len(self._get(self.backend, prefix + "/memories")["memories"]), 1
        )
        self.assertEqual(
            self._get(self.backend, "/api/ledger/summary")["total_calls"], 5
        )

    def test_trace_and_task_state_fault_keeps_primary_error_in_http_event(
        self,
    ):
        self._install_fault(
            "memory_extraction_trace_event", stage="model_response"
        )
        original_fail = PostgresBackgroundTaskRepository.fail_step

        def unavailable(repository, claim, **options):
            if claim.owner_id == self.owner_id:
                raise BackgroundTaskPersistenceError("合成任务状态不可写")
            return original_fail(repository, claim, **options)

        stream = self.backend.events()
        self.addCleanup(stream.close)
        with patch.object(
            PostgresBackgroundTaskRepository, "fail_step", unavailable
        ):
            imported = self._import_auto(self.backend, "双故障 HTTP", "茉莉茶")
            event_text = ""
            while True:
                line = stream.readline().decode()
                self.assertTrue(line)
                event_text += line
                if line.startswith("data:"):
                    payload = json.loads(line[5:])["payload"]
                    if payload.get("step") == "extract_memory" and payload.get(
                        "error_code"
                    ):
                        break
        self.assertEqual(payload["error_code"], "trace_write_failed")
        self.assertEqual(payload["failure_state_commit"], "unknown")
        self.assertEqual(payload["attempt_count"], 1)
        self.assertNotIn("合成任务", event_text)
        self.assertNotIn("我平时喜欢", event_text)
        task = self._task(self.backend, imported)
        self.assertEqual(task["status"], "running")
        self.assertEqual(task["retry_count"], 0)
        self.assertEqual(task["steps"][2]["attempt_count"], 1)

    def test_trace_and_task_state_fault_is_not_reported_idle_by_worker_cli(
        self,
    ):
        backend = HttpBackend(
            create_app(
                database_url=self.database_url,
                owner_id=self.owner_id,
                token="synthetic-double-fault",
                import_service=ImportService(
                    repository=PostgresIngestRepository(self.database_url)
                ),
            ),
            self.owner_id,
        )
        self.addCleanup(backend.close)
        imported = self._import_auto(backend, "双故障 CLI", "茉莉茶")
        self._install_fault(
            "memory_extraction_trace_event", stage="model_response"
        )
        original_fail = PostgresBackgroundTaskRepository.fail_step

        def unavailable(repository, claim, **options):
            if claim.owner_id == self.owner_id:
                raise BackgroundTaskPersistenceError("合成任务状态不可写")
            return original_fail(repository, claim, **options)

        output = StringIO()
        env = {
            "NOTALONE_DATABASE_URL": self.database_url,
            "NOTALONE_OWNER_ID": str(self.owner_id),
            "NOTALONE_DISABLE_DOTENV": "1",
        }
        with patch.dict("os.environ", env), patch(
            "notalone.memory_extraction.cli_support.build_deepseek_model",
            return_value=self.extraction_model,
        ), patch.object(
            PostgresBackgroundTaskRepository, "fail_step", unavailable
        ), redirect_stdout(
            output
        ):
            result = worker_main(["--contact-id", imported["contact_id"]])
        self.assertEqual(result, 1)
        self.assertIn("error=trace_write_failed", output.getvalue())
        self.assertIn("failure_state_commit=unknown", output.getvalue())
        self.assertNotIn("我平时喜欢", output.getvalue())
        task = self._task(backend, imported)
        self.assertEqual(task["status"], "running")
        self.assertEqual(task["retry_count"], 0)
        self.assertEqual(task["steps"][2]["attempt_count"], 1)
        scope = ContactScope(self.owner_id, UUID(imported["contact_id"]))
        self.assertIsNone(PostgresWatermarkStore(self.database_url).get(scope))
        self.assertIsNone(
            PostgresWatermarkStore(self.database_url).get_failure(scope)
        )

    def test_source_deleted_during_model_return_keeps_only_minimal_call_link(
        self,
    ):
        gate = self.extraction_model.block_call(0)
        imported = self._import_auto(self.backend, "来源删除晚响应", "茉莉茶")
        self.assertTrue(gate.entered.wait(5))
        prefix = f"/api/contacts/{imported['contact_id']}"
        self.assertEqual(
            self.backend.request(
                prefix + "/sources/" + imported["source"]["source_id"],
                method="DELETE",
            )[0],
            202,
        )
        # 关闭释放旧 Worker 全局锁，来源在已开始模型尚未返回时完成清除。
        self.backend.server.shutdown()
        reopened = self._backend(self.owner_id)
        status, deletion = reopened.request(
            prefix + "/sources/" + imported["source"]["source_id"],
            method="DELETE",
        )
        self.assertEqual(status, 202)
        self._wait_task(
            reopened,
            {
                "contact_id": imported["contact_id"],
                "task_id": deletion["task_id"],
            },
            "succeeded",
        )
        gate.release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            summary = self._get(reopened, "/api/ledger/summary")
            if summary["total_calls"]:
                break
            threading.Event().wait(0.02)
        batches = self._get(reopened, prefix + "/memory-traces")["batches"]
        detail = self._get(
            reopened, prefix + "/memory-traces/" + batches[0]["trace_id"]
        )
        self.assertEqual(detail["status"], "deleted")
        self.assertEqual(detail["events"], [])
        self.assertEqual(len(detail["calls"]), 1)
        self.assertEqual(detail["calls"][0]["response_status"], "returned")
        self.assertEqual(summary["total_calls"], 1)
        self.assertNotIn("茉莉茶", str(detail))
        self.assertEqual(
            self._get(reopened, prefix + "/memories")["memories"], []
        )
