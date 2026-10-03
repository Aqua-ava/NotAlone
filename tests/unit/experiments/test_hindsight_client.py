"""通过本机 HTTP 边界验证分数缺口和部分重排诊断。"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from notalone.experiments.hindsight_client import HindsightFailure, HindsightHttpClient


class HindsightHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.log = Path(self.tmp.name) / "service.log"
        self.log.write_text("已存在的旧日志\n")
        self.diagnostic = "[4] Reranking [cross-encoder]: 1 candidates scored in 0.01s\n[RECALL synthetic-call] Complete: 1 facts\n"
        self.response = {
            "results": [
                {
                    "id": "unit",
                    "type": "world",
                    "document_id": "memory-id",
                    "metadata": {"local_memory_id": "id"},
                    "scores": {"reranker": 0.006, "final": 0.007},
                }
            ]
        }
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.rfile.read(int(self.headers["Content-Length"]))
                with fixture.log.open("a") as log:
                    log.write(fixture.diagnostic)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(fixture.response).encode())

            def log_message(self, format: str, *args: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = HindsightHttpClient(
            base_url=f"http://127.0.0.1:{self.server.server_port}", log_path=self.log
        )

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def test_real_score_and_same_call_completion_are_required(self) -> None:
        result = self.client.recall(
            bank_id="notalone-experiment-synthetic", query="合成查询"
        )
        self.assertTrue(result.rerank_complete)
        self.assertEqual(result.hits[0].reranker, 0.006)

    def test_partial_timeout_is_failure_even_when_scores_exist(self) -> None:
        self.diagnostic = (
            "Reranking: Reranker exhausted its budget after scoring 1/2 candidates; ranking the remainder by RRF order\n"
            + self.diagnostic
        )
        with self.assertRaises(HindsightFailure):
            self.client.recall(
                bank_id="notalone-experiment-synthetic", query="合成查询"
            )

    def test_old_completion_does_not_prove_new_call_completed(self) -> None:
        self.log.write_text(self.diagnostic)
        self.diagnostic = ""
        with self.assertRaises(HindsightFailure):
            self.client.recall(
                bank_id="notalone-experiment-synthetic", query="合成查询"
            )

    def test_other_banks_and_cloud_urls_are_rejected_before_transport(self) -> None:
        with self.assertRaises(ValueError):
            self.client.request("DELETE", "/v1/default/banks/business-contact")
        with self.assertRaises(ValueError):
            HindsightHttpClient(base_url="https://example.com", log_path=self.log)


if __name__ == "__main__":
    unittest.main()
