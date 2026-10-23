"""把已冻结的合成有限候选投影为既有关系资料，供概览差分核验。"""
import json
import sys
from uuid import uuid4
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from notalone.persistence.correction_evidence import capture_message_snapshot
from notalone.persistence.memory_correction import candidate_from_row
from notalone.memory.evidence_binding import candidate_digest

url = sys.argv[1]
assert url.split('dbname=')[1].startswith('notalone_ts_host_') and url.endswith('_test')
results = []
with psycopg.connect(url, row_factory=dict_row) as connection:
    for row in connection.execute('SELECT * FROM public.memory_candidate ORDER BY id').fetchall():
        frozen = capture_message_snapshot(connection, owner_id=row['owner_id'], contact_id=row['contact_id'],
            message_ids=set(row['source_ids']), source_ids=tuple(row['source_ids']))
        frozen['kind'] = 'generation'
        if row['conditions']:
            for item in row['conditions']['items']:
                if item['evidence']:
                    item['source_supported'] = True
            row['dimension_evidence']['candidate_sha256'] = candidate_digest(candidate_from_row(row), version=4)
        connection.execute('UPDATE public.memory_candidate SET correction_evidence=%s,conditions=%s,dimension_evidence=%s WHERE id=%s',
            (Jsonb(frozen), Jsonb(row['conditions']) if row['conditions'] else None, Jsonb(row['dimension_evidence']), row['id']))
        connection.execute('''INSERT INTO public.confirmed_memory
            (id,owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method,confidence,
             risk_flags,valid_at,invalid_at,event,conditions,source_dependency_mode)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'manual',%s,%s,%s,%s,%s,%s,'all')''',
            (uuid4(),row['owner_id'],row['contact_id'],row['text_content'],row['category'],row['topic'],row['source_ids'],row['id'],
             row['confidence'],row['risk_flags'],row['valid_at'],row['invalid_at'],Jsonb(row['event']) if row['event'] else None,
             Jsonb(row['conditions']) if row['conditions'] else None))
        results.append({'owner': str(row['owner_id']), 'contact': str(row['contact_id']), 'conditions': bool(row['conditions'])})
print(json.dumps(results))
