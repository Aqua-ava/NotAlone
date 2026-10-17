"""只在本轮隔离库，通过正式提取和追踪持久化接缝准备合成页面输入。"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from uuid import UUID

import psycopg

from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.source_processing import save_processing_batch
from notalone.scopes import ContactScope
from notalone.source_processing.models import ProcessingRecord

spec = importlib.util.spec_from_file_location(
    "memory_database_fixture", Path(__file__).with_name("memory-database.py"),
)
assert spec is not None and spec.loader is not None
memory_database = importlib.util.module_from_spec(spec)
spec.loader.exec_module(memory_database)


class SyntheticRuntime:
    def __init__(self, payload=(), *, fail=False):
        self.payload = payload
        self.fail = fail

    def extract(self, window):
        if self.fail:
            raise ExtractionRuntimeError("合成模型不可用")
        return self.payload


def create_database(mode="full", ownership_path=None):
    data = memory_database.create_database(ownership_path=ownership_path)
    try:
        url = data["database_url"]
        scope = ContactScope(UUID(data["owner_id"]), UUID(data["contact_ids"][0]))
        messages = load_contact_messages(database_url=url, scope=scope)
        trace_store = PostgresExtractionTraceStore(url)
        memory_store = PostgresMemoryStore(url)

        def extract(runtime):
            return run_extraction(
                scope=scope, messages=messages, watermark_message_id=None,
                runtime=runtime, memory_port=memory_store,
                owner_memory_port=PostgresOwnerMemoryStore(url), trace_store=trace_store,
            )

        # 21 个真实零候选执行，覆盖有界分页；脚本模型没有供应商请求捕获，缺口如实保存。
        for _ in range(21 if mode == "full" else 0):
            extract(SyntheticRuntime())
        text = "本人参加合成追踪活动。" if mode == "deletion-owner" else "甲参加合成追踪活动。"
        extract(SyntheticRuntime(({
            "text": text, "category": "common_fact", "subject": "self" if mode == "deletion-owner" else "contact",
            "topic": "other", "source_message_ids": [str(messages[0].message_id)],
            "confidence": 0.9, "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "合成确定性返回，用于页面验证。",
        },)))
        pending = memory_store.list_pending_candidates(scope)
        candidate = next(item for item in pending if item.text == text)
        lookup = trace_store.find_record(scope, "candidate", candidate.candidate_id)
        recorded_id = lookup["batches"][0]["trace_id"]
        # 人工确认模型候选仍反查真实批次；不是手输资料。
        confirmed = None
        if mode != "deletion-candidate":
            service = memory_database.MemoryService(contact_memory=memory_store, owner_memory=PostgresOwnerMemoryStore(url))
            confirmed = service.confirm_candidate(
                owner_id=scope.owner_id, contact_id=scope.contact_id,
                candidate_id=candidate.candidate_id,
                expected_correction_decision_ids=tuple(
                    review.decision_id for review in candidate.correction_review
                ),
            )
        if mode == "full":
            extract(SyntheticRuntime(fail=True))
        with psycopg.connect(url) as connection:
            ref_id = connection.execute(
                "SELECT id FROM public.message_source_ref WHERE message_id=%s",
                (messages[0].message_id,),
            ).fetchone()[0]
            processing_id = save_processing_batch(
                connection, scope=scope, source_kind="source_document", source_id=UUID(data["source_document_id"]),
                records=(ProcessingRecord.capture("synthetic:1", {
                    "original": {"text": "合成来源处理原文"}, "normalized": {"text_content": messages[0].text},
                    "capture_layer": "synthetic_fixture", "outcome": "saved",
                }),),
                receipts={"synthetic:1": {"message_id": str(messages[0].message_id), "source_ref_id": str(ref_id), "outcome": "saved"}},
            )
        return {**data, "trace_id": recorded_id, "traced_memory_id": str(confirmed.memory_id) if confirmed else None, "trace_text": text,
                "trace_candidate_id": str(candidate.candidate_id), "processing_id": str(processing_id), "trace_message_id": str(messages[0].message_id)}
    except BaseException:
        memory_database.contact_database.drop_database(data["database_name"])
        raise


if __name__ == "__main__":
    if os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone" or os.environ.get("NOTALONE_DISABLE_DOTENV") != "1":
        raise RuntimeError("追踪夹具须激活 NotAlone 并禁用默认 dotenv。")
    if len(sys.argv) >= 2 and sys.argv[1] == "create":
        arguments = sys.argv[2:]
        ownership_path = arguments.pop() if arguments and Path(arguments[-1]).is_absolute() else None
        if arguments not in ([], ["deletion-contact"], ["deletion-owner"], ["deletion-candidate"]):
            raise ValueError("未知追踪夹具操作。")
        print(json.dumps(create_database(arguments[0] if arguments else "full", ownership_path)))
    elif len(sys.argv) == 3 and sys.argv[1] == "drop":
        memory_database.contact_database.drop_database(sys.argv[2])
    else:
        raise ValueError("未知追踪夹具操作。")
