"""真实模型记忆提取冒烟：只在显式提供凭据时运行。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg

from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from notalone.memory_extraction.adjudication_adapters import (
    LangChainAdjudicationRuntime,
)
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.command import run_extraction
from notalone.persistence import (
    PostgresMemoryStore,
    PostgresOwnerMemoryStore,
    PostgresOutboundLedger,
    PostgresRetrieval,
)
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)

_SYNTHETIC_DIALOG = (
    ("contact", "在吗？"),
    ("user", "在的"),
    ("contact", "我下周要去上海出差，回来再聚。"),
    ("user", "好，我最近在健身增肌，等回来切磋。"),
    ("contact", "别发语音了，我这边看不了，打字就行。"),
)


class RealExtractionSmokeTest(unittest.TestCase):
    """合成对话经真实模型提取；不读取任何私人聊天资料。"""

    @classmethod
    def setUpClass(cls) -> None:
        if not os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "").strip():
            raise unittest.SkipTest(
                "未提供 NOTALONE_DEEPSEEK_API_KEY，跳过真实提取冒烟。"
            )
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("冒烟只允许 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.source_id = uuid4()
        self.message_ids = []
        base = datetime.now(timezone.utc) - timedelta(hours=1)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name)"
                " VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "合成联系人"),
            )
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-smoke.jsonl',
                          %s, %s, 'active')
                """,
                (
                    self.source_id,
                    self.owner_id,
                    self.contact_id,
                    "c" * 64,
                    len(_SYNTHETIC_DIALOG),
                ),
            )
            for index, (speaker, text) in enumerate(_SYNTHETIC_DIALOG):
                message_id = uuid4()
                self.message_ids.append(message_id)
                connection.execute(
                    """
                    INSERT INTO public.message (
                        id, owner_id, contact_id,
                        speaker, message_type, text_content, occurred_at
                    ) VALUES (%s, %s, %s, %s, 'text', %s, %s)
                    """,
                    (
                        message_id,
                        self.owner_id,
                        self.contact_id,
                        speaker,
                        text,
                        base + timedelta(minutes=index),
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO public.message_source_ref (
                        id, message_id, owner_id, contact_id,
                        source_kind, source_document_id, source_locator, raw_payload
                    ) VALUES (gen_random_uuid(), %s, %s, %s,
                              'source_document', %s, %s, '{}'::jsonb)
                    """,
                    (
                        message_id,
                        self.owner_id,
                        self.contact_id,
                        self.source_id,
                        f"smoke-{index}",
                    ),
                )
            connection.commit()
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.outbound_ledger_entry"
                " WHERE owner_id = %s",
                (self.owner_id,),
            )
            connection.execute(
                "DELETE FROM public.memory_extraction_watermark"
                " WHERE owner_id = %s",
                (self.owner_id,),
            )
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
            connection.commit()

    def test_real_extraction_end_to_end(self) -> None:
        model = build_deepseek_model()
        memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        owner_store = PostgresOwnerMemoryStore(TEST_DATABASE_URL)
        ledger = PostgresOutboundLedger(TEST_DATABASE_URL)
        messages = load_contact_messages(self.scope, TEST_DATABASE_URL)
        self.assertEqual(len(messages), len(_SYNTHETIC_DIALOG))

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=LangChainExtractionRuntime(model=model),
            memory_port=memory_store,
            owner_memory_port=owner_store,
            adjudication_runtime=LangChainAdjudicationRuntime(model=model),
            ledger=ledger,
        )

        confirmed = memory_store.list_confirmed(self.scope)
        owner_memories = owner_store.list_active(self.owner_id)
        ledger_entries = ledger.list_by_owner(self.owner_id)
        retrieval = PostgresRetrieval(
            TEST_DATABASE_URL,
            memory_store=memory_store,
            owner_memory_store=owner_store,
        )
        retrieved_contact = retrieval.search_confirmed_memories(
            scope=self.scope
        )
        retrieved_owner = retrieval.search_owner_memories(
            owner_id=self.owner_id
        )

        # 稳定断言：至少一条自动采纳的联系人记忆，带合法来源与主题。
        self.assertGreaterEqual(len(confirmed), 1)
        valid_ids = set(self.message_ids)
        for memory in confirmed:
            self.assertEqual(memory.adoption_method.value, "auto")
            self.assertTrue(
                set(memory.source_ids) & (valid_ids | {self.source_id})
            )
        # 负例：闲聊不产出记忆。
        for memory in confirmed:
            self.assertNotIn("在吗", memory.text)
        # 台账：真实外部调用有记录。
        self.assertGreaterEqual(len(ledger_entries), 1)
        self.assertTrue(
            all(entry.model_name.strip() for entry in ledger_entries)
        )
        # 检索两路可见。
        self.assertGreaterEqual(len(retrieved_contact), 1)

        # 观察点：记录首次真实提取数据供评估。
        print(f"\n[smoke] batches={stats.batches} extracted={stats.extracted}")
        print(
            f"[smoke] adopted={stats.adopted} updated={stats.updated}"
            f" pending={stats.pending} duplicate={stats.skipped_duplicate}"
            f" rejected={stats.rejected_by_contract}"
        )
        print(
            f"[smoke] contact_memories={len(confirmed)}"
            f" owner_memories={len(owner_memories)}"
        )
        print(
            f"[smoke] ledger_entries={len(ledger_entries)}"
            f" outcomes={[e.outcome.value for e in ledger_entries]}"
            f" models={sorted({e.model_name for e in ledger_entries})}"
        )
        print(
            f"[smoke] retrieved_contact={len(retrieved_contact)}"
            f" retrieved_owner={len(retrieved_owner)}"
        )


if __name__ == "__main__":
    unittest.main()
