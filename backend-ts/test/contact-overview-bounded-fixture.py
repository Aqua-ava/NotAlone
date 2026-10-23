"""只在明确创建的合成库保存旧编译器产生的六类有限证明，不调用外部模型。"""
import json
import hashlib
import sys
from dataclasses import replace
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from notalone.memory import SourceDependencyMode
from notalone.memory_extraction.models import MessageSender
from notalone.memory_extraction.evidence import build_dimension_evidence
from notalone.memory_extraction.verification import validate_source_verification
from notalone.persistence.memory_correction import candidate_from_row
from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence
from tests.unit.memory_extraction.test_bounded_runtime_proof import (
    messages_window, compiled_fact, expected_proposal,
)

url = sys.argv[1]
assert url.split('dbname=')[1].startswith('notalone_ts_host_') and url.endswith('_test')
cases = [
    (("我刚刚到家。",), {}, "event", None, None, "BR_AUTHOR_ARRIVAL_V1", "direct_quote", {}),
    (("这里的“他”指我姐。", "我哥前天把他的雨伞借给我了。"), {}, "relationship_event", "0:0", None, "BR_KIN_LEND_V1", "completed_cross", {}),
    (("这里提到我姐和我同事。", "这里的“她”指我同事。", "我姐昨天没有把她的书借给我。"), {}, "relationship_event", "1:0", None, "BR_TWO_ROLES_V1", "negative_cross", {}),
    (("你已经抵达机场了吗？", "已抵达了。"), {"senders": ("self", "contact")}, "state", "0:0", None, "BR_COMPLETED_QA_V1", "completed_answer", {"question": True}),
    (("我哥前天让我后天帮她顶个班。这里的“她”指我姐。",), {}, "reported_event", "0:1", "0:0", "BR_REQUEST_V1", "reported_inline", {"request": True}),
    (("这里的“他”指我同事。", "我姐昨天让我明天帮他顶个班。"), {}, "relationship_event", "0:0", None, "BR_REQUEST_V1", "received_cross", {"request": True}),
    (("如果天晴，我计划后天只跑约2.5公里。",), {}, "plan", None, "0:1", "BR_COND_RUN_V1", "conditional_plan", {"condition": True}),
]
results = []
with psycopg.connect(url, row_factory=dict_row) as c:
    for texts, options, kind, dependency, main_id, rule, variant, proof_options in cases:
        owner, contact = uuid4(), uuid4()
        window = messages_window(texts, **options)
        actual = []
        c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成维度用户')", (owner,))
        c.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成维度联系人')", (contact, owner))
        for message in window.messages:
            source, ref = uuid4(), uuid4()
            snapshot = {**message.source_snapshots[0], 'source_ref_id': str(ref), 'source_id': str(source), 'source_content_sha256': hashlib.sha256(str(source).encode()).hexdigest()}
            actual.append(replace(message, source_snapshots=(snapshot,)))
            c.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'manual','合成维度资料',%s,1)", (source, owner, contact, snapshot['source_content_sha256']))
            c.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,%s,'text',%s,%s)", (message.message_id, owner, contact, 'user' if message.sender is MessageSender.SELF else 'contact', message.text, message.occurred_at))
            c.execute("INSERT INTO public.message_source_ref(id,owner_id,contact_id,message_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,%s,'source_document',%s,%s,%s)", (ref, owner, contact, message.message_id, source, snapshot['locator'], Jsonb(snapshot['raw_payload'])))
        window = replace(window, owner_id=owner, contact_id=contact, messages=tuple(actual))
        fact = replace(compiled_fact(window, kind=kind, dependency=dependency, main_id=main_id, condition=proof_options.get('condition', False)), source_dependency_mode=SourceDependencyMode.ALL)
        proposal = expected_proposal(window, fact, rule, variant, **proof_options)
        result, = validate_source_verification(({'candidate_index': 0, 'verdict': 'supported', 'issues': [], 'evidence': [{'message_id': str(window.messages[-1].message_id), 'quote': window.messages[-1].text}], 'proof': proposal},), window=window, facts=(fact,), mode='nullable-proof-v3')
        evidence = build_dimension_evidence(window, fact, result)
        assert evidence is not None and evidence.source_bound and evidence.semantic_basis is not None, rule
        candidate = uuid4()
        row = c.execute("""INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,topic,subject,source_ids,status,confidence,risk_flags,alternatives,interpretation_reason,valid_at,invalid_at,event,conditions,dimension_evidence,source_dependency_mode)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'confirmed',%s,%s,%s,%s,%s,%s,%s,%s,%s,'all') RETURNING *""", (
            candidate, owner, contact, fact.text, fact.category.value, fact.topic.value, fact.subject.value, list(fact.source_message_ids), fact.confidence, list(fact.risk_flags), list(fact.alternatives), fact.interpretation_reason, fact.valid_at, fact.invalid_at,
            Jsonb(fact.event.to_payload()) if fact.event else None, Jsonb(fact.conditions.to_payload()) if fact.conditions else None, Jsonb(evidence.to_payload()))).fetchone()
        rebound = bind_stored_dimension_evidence(c, candidate_from_row(row))
        assert rebound is not None and rebound.source_bound, rule
        results.append({'id': str(candidate), 'rule': rule, 'variant': variant})
print(json.dumps(results))
