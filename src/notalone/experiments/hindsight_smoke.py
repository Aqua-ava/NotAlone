"""真实服务上的小量合成记忆闭环，不作为质量验收。"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from notalone.experiments.hindsight_adapter import HindsightRetrieval
from notalone.experiments.hindsight_client import (
    HindsightHttpClient,
    bank_id_for,
    document_id_for,
)
from notalone.experiments.hindsight_runtime import DEFAULT_RUNTIME
from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
)
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from notalone.scopes import ContactScope, VerifiedConversationScope


def run_smoke(*, runtime: Path, tau: float = 0.003) -> dict[str, object]:
    scope = ContactScope(uuid4(), uuid4())
    bank_id = bank_id_for(scope)
    client = HindsightHttpClient(
        base_url="http://127.0.0.1:18888", log_path=runtime / "service.log"
    )
    health = client.request("GET", "/health")
    config = client.create_bank(bank_id)
    initial = client.request(
        "GET", client.bank_path(bank_id) + "/memories/list?limit=1"
    )
    mental_models = client.request("GET", client.bank_path(bank_id) + "/mental-models")
    resolved = config.get("config")
    if (
        not isinstance(resolved, dict)
        or resolved.get("retain_extraction_mode") != "chunks"
        or resolved.get("enable_auto_consolidation") is not False
        or initial.get("total") != 0
        or mental_models.get("items") != []
    ):
        raise RuntimeError("新 bank 为空、chunks 或禁止归纳配置未获验证。")
    source_id, target_id, binding_id = uuid4(), uuid4(), uuid4()
    store = InMemoryMemoryStore()
    records: list[dict[str, object]] = []
    for text, method, confidence in (
        ("对方乳糖不耐受", "auto", 0.83),
        ("对方喜欢周末爬山", "manual", 1.0),
        ("对方喜欢读科幻小说", "auto", 0.92),
    ):
        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=scope,
            text=text,
            category=MemoryCategory.PREFERENCE,
            source_ids=(source_id,),
            confidence=confidence,
        )
        store.create_candidate(candidate)
        memory = store.confirm(
            scope=scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod(method),
        )
        records.append(
            {
                "content": memory.text,
                "document_id": document_id_for(memory.memory_id),
                "timestamp": "unset",
                "update_mode": "replace",
                "metadata": {
                    "local_memory_id": str(memory.memory_id),
                    "owner_id": str(scope.owner_id),
                    "contact_id": str(scope.contact_id),
                    "layer": "confirmed_memory",
                    "revision": str(memory.revision),
                },
            }
        )
    retain = client.retain(bank_id=bank_id, items=records)
    query = "牛奶喝完肚子难受，晚餐能换一道吗"
    local = InMemoryRetrieval(
        messages=(RetrievedMessage(target_id, scope, query, source_ids=(source_id,)),),
        memory_store=store,
    )
    adapter = HindsightRetrieval(local=local, client=client, tau=tau)
    command = GenerateReply(
        idempotency_key=uuid4(),
        scope=scope,
        conversation_binding_id=binding_id,
        content=ReplyToMessage(
            target_id, ConfirmedDirection("询问晚餐替换", DirectionSource.DIRECT_INPUT)
        ),
    )
    verified = VerifiedConversationScope(scope.owner_id, scope.contact_id, binding_id)
    builder = RetrievalReplyContext(retrieval=adapter, skill_library_revision=0)
    started = time.perf_counter()
    context = builder.build(command=command, verified_scope=verified)
    builder.validate_current(context)
    elapsed = (time.perf_counter() - started) * 1000
    selected = [e for e in context.evidence if e.kind == "confirmed_memory"]
    baseline_context = RetrievalReplyContext(
        retrieval=local, skill_library_revision=0
    ).build(command=command, verified_scope=verified)
    return {
        "kind": "synthetic_smoke_only",
        "health": health,
        "bank_id": bank_id,
        "scope": {"owner_id": str(scope.owner_id), "contact_id": str(scope.contact_id)},
        "bank_config": config,
        "initial_empty_bank": initial,
        "initial_mental_models": mental_models,
        "fixture": records,
        "retain": retain,
        "query": query,
        "tau_B": tau,
        "tau_status": "临时 smoke 阈值，尚未独立校准",
        "score_field": "scores.reranker（HTTP归一化值）",
        "full_elapsed_ms": elapsed,
        "baseline_selected": [
            e.text for e in baseline_context.evidence if e.kind == "confirmed_memory"
        ],
        "selected": [
            {
                "memory_id": str(e.evidence_id),
                "text": e.text,
                "revision": e.revision,
                "source_ids": [str(s) for s in e.source_ids],
            }
            for e in selected
        ],
        "diagnostics": asdict(adapter.last_attempt),
        "pass": adapter.last_attempt.status == "success"
        and [e.text for e in selected] == ["对方乳糖不耐受"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="只用新建合成资料运行真实 Hindsight smoke。"
    )
    parser.add_argument("--runtime-dir", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tau", type=float, default=0.003)
    args = parser.parse_args()
    result = run_smoke(runtime=args.runtime_dir, tau=args.tau)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n"
    )
    print(
        json.dumps(
            {
                "pass": result["pass"],
                "selected": result["selected"],
                "elapsed_ms": result["full_elapsed_ms"],
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    if not result["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
