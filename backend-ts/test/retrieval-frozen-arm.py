"""冻结旧臂单次执行；由外部固定AB/BA计划调度。"""
import dataclasses
import json
from pathlib import Path
import sys
metadata=json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0,str(Path(metadata['frozen_source_root'])/'backend/src'))
from notalone.retrieval.recall_cases import CASES
from notalone.retrieval.recall_evaluation import evaluate_case
case=next(item for item in CASES if item.name==sys.argv[2])
print(json.dumps(dataclasses.asdict(evaluate_case(case)),ensure_ascii=False))
