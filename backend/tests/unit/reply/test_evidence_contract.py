"""回复证据 kind/status 白名单单一来源的合成契约测试。

审查发现：证据 kind/status 白名单散落在 ``reply/context``、``reply/generator``、
``reply/store`` 与 ``persistence/reply_store`` 四处，迁移 SQL 另有一份。
本用例断言四处 Python 白名单引用同一份常量与同一个契约函数，并核对迁移
里的 SQL 列表与 ``EVIDENCE_KINDS`` 一致。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from notalone.persistence import reply_store as persistence_reply_store
from notalone.reply import context as reply_context
from notalone.reply import generator as reply_generator
from notalone.reply import store as reply_store
from notalone.reply.context import (
    EVIDENCE_KINDS,
    EVIDENCE_STATUSES,
    EVIDENCE_STATUSES_BY_KIND,
    PENDING_CANDIDATE_SELECTION_REASON,
    evidence_contract_is_valid,
)


MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "database"
    / "migrations"
    / "037_pending_candidate_evidence_kind.sql"
)


class EvidenceWhitelistSourceTest(unittest.TestCase):
    def test_all_four_boundaries_share_one_kind_constant(self) -> None:
        for module in (
            reply_context,
            reply_generator,
            reply_store,
            persistence_reply_store,
        ):
            with self.subTest(module=module.__name__):
                self.assertIs(module.EVIDENCE_KINDS, EVIDENCE_KINDS)

    def test_all_four_boundaries_share_one_contract_function(self) -> None:
        for module in (
            reply_generator,
            reply_store,
            persistence_reply_store,
        ):
            with self.subTest(module=module.__name__):
                self.assertIs(
                    module.evidence_contract_is_valid,
                    evidence_contract_is_valid,
                )

    def test_kind_and_status_constants_agree(self) -> None:
        self.assertEqual(
            EVIDENCE_STATUSES_BY_KIND.keys() | set(),
            set(EVIDENCE_KINDS),
        )
        for kind, allowed in EVIDENCE_STATUSES_BY_KIND.items():
            with self.subTest(kind=kind):
                self.assertTrue(allowed)
                self.assertTrue(set(allowed) <= set(EVIDENCE_STATUSES))

    def test_migration_kind_list_matches_the_shared_constant(self) -> None:
        """SQL 列表保持独立，但必须与 ``EVIDENCE_KINDS`` 逐项一致。"""

        sql = MIGRATION_PATH.read_text(encoding="utf-8")
        check = re.search(
            r"CHECK\s*\(\s*kind\s+IN\s*\((.*?)\)\s*\)",
            sql,
            re.DOTALL,
        )
        self.assertIsNotNone(check, "迁移缺少 kind 白名单 CHECK")
        kinds = tuple(re.findall(r"'([a-z_]+)'", check.group(1)))
        self.assertEqual(kinds, EVIDENCE_KINDS)
        # 迁移注释必须指回常量所在模块，避免下次修改时各改各的。
        self.assertIn("reply/context.py", sql)
        self.assertIn("EVIDENCE_KINDS", sql)

    def test_pending_candidate_requires_pending_status_and_annotation(self) -> None:
        self.assertTrue(
            evidence_contract_is_valid(
                kind="pending_candidate",
                status="pending",
                selection_reason=PENDING_CANDIDATE_SELECTION_REASON + "候选分类 x。",
            )
        )
        # 状态不是 pending：不能借 active 冒充已确认资料。
        self.assertFalse(
            evidence_contract_is_valid(
                kind="pending_candidate",
                status="active",
                selection_reason=PENDING_CANDIDATE_SELECTION_REASON,
            )
        )
        # 状态是 pending、理由被改写成「已确认」：伪造标注必须拒绝。
        self.assertFalse(
            evidence_contract_is_valid(
                kind="pending_candidate",
                status="pending",
                selection_reason="已确认、可以当作事实。",
            )
        )

    def test_other_kinds_follow_the_same_status_map(self) -> None:
        self.assertTrue(
            evidence_contract_is_valid(
                kind="message",
                status="active",
                selection_reason="待回复消息。",
            )
        )
        self.assertFalse(
            evidence_contract_is_valid(
                kind="message",
                status="deleted",
                selection_reason="待回复消息。",
            )
        )
        self.assertFalse(
            evidence_contract_is_valid(
                kind="unknown_kind",
                status="active",
                selection_reason="未知类型。",
            )
        )
        self.assertTrue(
            evidence_contract_is_valid(
                kind="user_draft",
                status="user_input",
                selection_reason="用户原句。",
            )
        )


if __name__ == "__main__":
    unittest.main()
