"""回复回执投影：读取失败标记只增字段，不改变既有三键语义。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from uuid import uuid4

from notalone.reply.interface import ContextReceipt
from notalone.server.app import _reply_payload


def _reply(**overrides):
    values = {
        "reply_request_id": uuid4(),
        "candidates": (),
        "context_receipt": ContextReceipt(evidence_ids=(), expression_preference_ids=()),
        "used_skill": None,
        "input_budget": None,
        "basis_changes": (),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class ReplyReceiptProjectionTest(unittest.TestCase):
    def test_read_failure_flags_are_exposed_in_http_receipt(self) -> None:
        payload = _reply_payload(
            _reply(
                context_receipt=ContextReceipt(
                    evidence_ids=(),
                    expression_preference_ids=(),
                    layered_read_failed=True,
                    owner_layered_read_failed=True,
                    overview_read_failed=True,
                )
            )
        )

        receipt = payload["context_receipt"]
        self.assertTrue(receipt["layered_read_failed"])
        self.assertTrue(receipt["owner_layered_read_failed"])
        self.assertTrue(receipt["overview_read_failed"])

    def test_healthy_reads_keep_false_defaults(self) -> None:
        receipt = _reply_payload(_reply())["context_receipt"]

        self.assertFalse(receipt["layered_read_failed"])
        self.assertFalse(receipt["owner_layered_read_failed"])
        self.assertFalse(receipt["overview_read_failed"])


if __name__ == "__main__":
    unittest.main()
