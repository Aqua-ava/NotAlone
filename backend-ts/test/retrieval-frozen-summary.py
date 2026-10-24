"""用冻结旧门槛汇总已观测两臂结果，不重跑或改写观测。"""
import dataclasses
import json
from pathlib import Path
import sys
metadata=json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0,str(Path(metadata['frozen_source_root'])/'backend/src'))
from notalone.retrieval.recall_evaluation import RecallCaseResult,summarize
report=json.load(sys.stdin)
result={arm:[] for arm in ('python','typescript')}
for arm in result:
    for repeat in range(1,4):
        rows=tuple(RecallCaseResult(**row[arm]) for row in report['recall'] if row['repeat']==repeat)
        result[arm].append([dataclasses.asdict(item) for item in summarize(rows)])
print(json.dumps(result))
