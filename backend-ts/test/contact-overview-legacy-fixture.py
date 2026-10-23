"""旧v1/v2语义证明的独立合成PG基线；不访问模型、真实资料或配置。"""
import json
import sys
from dataclasses import replace
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from notalone.memory import MemoryCategory
from notalone.memory.dimension_evidence import SemanticBasis
from notalone.memory_extraction.models import FactSubject, SpeechAct, AssertionStatus, MessageSender
from notalone.memory_extraction.evidence import build_dimension_evidence
from notalone.memory_extraction.source_proof import _parse_text, _basis, _align_frame, _arrival, _author_quote, _author_quote_basis
from notalone.persistence.memory_correction import candidate_from_row
from notalone.persistence.dimension_evidence import bind_stored_dimension_evidence
from tests.unit.memory_extraction.test_source_proof import window_for
from tests.unit.memory_extraction.dimension_helpers import synthetic_fact

url=sys.argv[1]
assert url.split('dbname=')[1].startswith('notalone_ts_host_') and url.endswith('_test')
cases=[
 ('我刚到家','联系人刚到家','contact','assertion','asserted','recent_state',1),
 ('我姐把她的车借给我了。这里的“她”指我姐。','联系人的姐姐把自己的车借给了联系人','contact','assertion','asserted','relationship_note',1),
 ('我姐昨天没把她的雨伞借给我。这里的“她”指我姐。','用户的姐姐昨天没有把自己的雨伞借给用户','self','assertion','asserted','relationship_note',1),
 ('我同事让我周末帮他顶个班。这里的“他”指我同事。','用户的同事已提出请托，内容是希望用户周末替该同事顶班，未说明接受','self','report','reported','relationship_note',1),
 ('我同事让我周末帮他顶个班。这里的“他”指我同事。','用户已收到用户的同事请托；所请内容为用户周末替该同事顶班，未说明接受','self','assertion','asserted','relationship_note',1),
 ('如果天晴，我计划明天只跑约3公里','如果天晴，联系人计划明天只跑约3000米','contact','plan','conditional','recent_state',1),
 ('如果天晴，我计划后天跑约7.5公里。','如果天晴，联系人计划后天跑约7500米','contact','plan','conditional','recent_state',1),
 ('我刚刚到家。','联系人原话：“我刚刚到家。”','contact','assertion','asserted','common_fact',2),
 (' 我刚到家。 ',' 用户原话：“我刚到家。” ','self','assertion','asserted','common_fact',2),
]
results=[]
with psycopg.connect(url,row_factory=dict_row) as c:
 for text,claim,sender,speech,assertion,category,version in cases:
  owner,contact,source,ref,message_id,candidate= [uuid4() for _ in range(6)]
  window=window_for(text,MessageSender(sender))
  snapshot={**window.messages[0].source_snapshots[0],'source_ref_id':str(ref),'source_id':str(source)}
  message=replace(window.messages[0],message_id=message_id,source_snapshots=(snapshot,))
  window=replace(window,owner_id=owner,contact_id=contact,messages=(message,))
  fact=synthetic_fact(text=claim,source_message_ids=(message_id,),subject=FactSubject(sender),speech_act=SpeechAct(speech),assertion_status=AssertionStatus(assertion),category=MemoryCategory(category))
  source_parse=(_arrival(text,sender,source=True) if version==2 else _parse_text(text,sender,source=True))
  target_parse=(_author_quote(claim,text) if version==2 else _parse_text(claim,sender,source=False))
  source_parse=_align_frame(source_parse,target_parse)
  basis=(_author_quote_basis if version==2 else _basis)(source_parse,target_parse,message,fact)
  evidence=replace(build_dimension_evidence(window,fact,None),version=version+1,semantic_basis=SemanticBasis.from_payload(basis))
  c.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成旧维度用户')",(owner,))
  c.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES(%s,%s,'合成旧维度联系人')",(contact,owner))
  c.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES(%s,%s,%s,'manual','合成旧维度资料',%s,1)",(source,owner,contact,snapshot['source_content_sha256']))
  c.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES(%s,%s,%s,%s,'text',%s,%s)",(message_id,owner,contact,'user' if sender=='self' else 'contact',text,message.occurred_at))
  c.execute("INSERT INTO public.message_source_ref(id,owner_id,contact_id,message_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,%s,'source_document',%s,%s,%s)",(ref,owner,contact,message_id,source,snapshot['locator'],Jsonb(snapshot['raw_payload'])))
  row=c.execute("""INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,topic,subject,source_ids,status,confidence,risk_flags,alternatives,interpretation_reason,dimension_evidence)
   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'confirmed',%s,%s,%s,%s,%s) RETURNING *""",(candidate,owner,contact,claim,category,fact.topic.value,sender,[message_id],fact.confidence,list(fact.risk_flags),list(fact.alternatives),fact.interpretation_reason,Jsonb(evidence.to_payload()))).fetchone()
  rebound=bind_stored_dimension_evidence(c,candidate_from_row(row))
  assert rebound is not None and rebound.source_bound, claim
  results.append({'id':str(candidate),'claim':claim,'version':version})
print(json.dumps(results))
