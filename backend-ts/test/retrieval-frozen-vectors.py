"""冻结140例的实际本机向量与RRF对照臂，禁止联网和业务配置。"""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN']='1'
data=json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0,str(Path(data['frozen_source_root'])/'backend/src'))
from fastembed.common.preprocessor_utils import load_tokenizer
from notalone.memory_extraction import recall
texts=[row['text'] for row in data['vector_cases']]
queries=[row['query'] for row in data['vector_cases']]
inputs=queries+texts
snapshot=Path.home()/'.cache/notalone/memory-embedding/models--Qdrant--bge-small-zh-v1.5/snapshots/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59'
tokenizer,_=load_tokenizer(snapshot)
encoded=tokenizer.encode_batch(inputs)
pool=[SimpleNamespace(memory_id=f'00000000-0000-0000-0000-{i+1:012d}',text=text) for i,text in enumerate(texts)]
runs=[]
for repeat in range(1):
    vectors=recall.embed_texts(inputs)
    original=recall.embed_texts
    # 复用本轮真实已算向量，不改变旧RRF，避免相同文本额外再推理一轮。
    recall.embed_texts=lambda requested: vectors if requested==inputs else (_ for _ in ()).throw(AssertionError('输入改变'))
    try:
        ranked=[[item.memory_id for item in row] for row in recall.hybrid_candidates(queries,pool)]
    finally:
        recall.embed_texts=original
    runs.append({'repeat':repeat+1,'vectors':vectors,'ranking':ranked})
Path(sys.argv[2]).write_text(json.dumps({'ids':[row.ids for row in encoded],'mask':[row.attention_mask for row in encoded],'runs':runs}))
print(json.dumps({'vector_cases':len(texts),'inputs_per_repeat':len(inputs),'repeats':1,'dimensions':len(runs[0]['vectors'][0])}))
