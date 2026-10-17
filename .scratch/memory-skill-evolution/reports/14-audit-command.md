# 任务14：实际历史复算命令

此处保存主 Agent 已执行的只读分析主体；Conda 安装路径以 `conda info --base` 表示。原始结果没有重跑或修改。命令只读取仓库内合成冻结证据，生成 `14-historical-audit.json`；没有产品 runner、模型、SQL 或 App 调用。

复算前位于包含总协调基线 `ada604d9` 的任务工作树根目录；保持 [分析计划](14-audit-plan.md) 不变。此命令生成固定三项子集及原始指标；原始源码摘要核对、Hindsight 边界及事后 gold 上界是单独追加的研究证据，不参与规则选择。

```bash
source "$(conda info --base)/etc/profile.d/conda.sh" && conda activate NotAlone && NOTALONE_DISABLE_DOTENV=1 PYTHON_DOTENV_DISABLED=1 PYTHONPATH=backend/src python - <<'PY'
from dataclasses import asdict, replace
from pathlib import Path
from uuid import UUID
import hashlib
import json
import math

from notalone.experiments.hindsight_dataset import build_dataset, dataset_documents
from notalone.experiments.hindsight_metrics import (
    MemoryIdentity, QueryResult, SelectedMemory, grouped_summaries
)
from notalone.retrieval.lexical import RELEVANCE_THRESHOLD, score

root = Path.cwd()
result_path = root / "experiments/pgvector/runs/native-v3/result.json"
raw = result_path.read_bytes()
result = json.loads(raw)
dataset = json.loads((root / "experiments/hindsight/v2/dataset.json").read_text())
queries = {item["query_id"]: item for item in dataset["queries"]}
memories = {item["memory_id"]: item for item in dataset["memories"]}

def identity(item):
    return MemoryIdentity(
        item["layer"], UUID(item["owner_id"]),
        UUID(item["contact_id"]) if item["contact_id"] else None,
        UUID(item["memory_id"]),
    )

def decode(item):
    fields = dict(item)
    for layer in ("contact", "owner"):
        fields[layer + "_gold"] = tuple(identity(x) for x in item[layer + "_gold"])
        fields[layer + "_selected"] = tuple(
            SelectedMemory(
                identity(x["identity"]), x["text"],
                tuple(UUID(s) for s in x["source_ids"]),
                x["revision"], x["selection_reason"],
            )
            for x in item[layer + "_selected"]
        )
    return QueryResult(**fields)

arms = {
    "A_lexical": tuple(decode(r) for r in result["baseline_results"]),
    "B_vector": tuple(decode(r) for r in result["vector_results"]),
}
by_a = {r.query_id: r for r in arms["A_lexical"]}
assert len(by_a) == 103
assert {r.query_id for r in arms["B_vector"]} == set(by_a)
assert set(by_a) == {q["query_id"] for q in dataset["queries"] if q["split"] == "final"}
for b in arms["B_vector"]:
    a = by_a[b.query_id]
    assert (a.contact_gold, a.owner_gold) == (b.contact_gold, b.owner_gold)
    assert queries[b.query_id]["group"] == b.group

# 固定子集分析：不调整原始阈值、不重新检索或补齐。
arms["B_first_only"] = tuple(
    replace(b, contact_selected=b.contact_selected[:1]) for b in arms["B_vector"]
)
arms["A_else_B_first"] = tuple(
    replace(b, contact_selected=by_a[b.query_id].contact_selected or b.contact_selected[:1])
    for b in arms["B_vector"]
)
arms["B_lexical_filter"] = tuple(
    replace(
        b, contact_selected=tuple(
            m for m in b.contact_selected
            if score(queries[b.query_id]["text"], m.text).score >= RELEVANCE_THRESHOLD
        ),
    )
    for b in arms["B_vector"]
)
summaries = {name: grouped_summaries(rows) for name, rows in arms.items()}
for name, recorded in (("A_lexical", result["baseline_summaries"]), ("B_vector", result["vector_summaries"])):
    for group, fields in recorded.items():
        for key, value in fields.items():
            actual = summaries[name][group][key]
            assert (
                math.isclose(actual, value, abs_tol=1e-12)
                if isinstance(value, float) else actual == value
            ), (name, group, key, actual, value)

pairs = []
safety = {name: {"scope_mismatches": 0, "non_active": 0, "revision_mismatches": 0, "source_mismatches": 0, "state_negative_selected": 0} for name in arms}
for b in arms["B_vector"]:
    a = by_a[b.query_id]
    gold = set(b.contact_gold)
    pairs.append({
        "query_id": b.query_id, "group": b.group, "inherited_status_A": a.status,
        "inherited_status_B": b.status, "A_contact_empty": not a.contact_selected,
        "A_wrong_ids": [str(m.identity.memory_id) for m in a.contact_selected if m.identity not in gold],
        "B_wrong_ids": [str(m.identity.memory_id) for m in b.contact_selected if m.identity not in gold],
        "selections": {name: [str(m.identity.memory_id) for m in next(r for r in rows if r.query_id == b.query_id).contact_selected] for name, rows in arms.items()},
    })
for name, rows in arms.items():
    for r in rows:
        q_scope = queries[r.query_id]["scope"]
        selected_contact = r.contact_selected
        assert len(selected_contact) <= 5 and sum(len(m.text) for m in selected_contact) <= 600
        assert len(r.owner_selected) <= 3 and sum(len(m.text) for m in r.owner_selected) <= 240
        for m in (*selected_contact, *r.owner_selected):
            frozen = memories[str(m.identity.memory_id)]
            assert m.text == frozen["text"]
            safety[name]["scope_mismatches"] += int(str(m.identity.owner_id) != q_scope["owner_id"] or (m.identity.layer == "contact" and str(m.identity.contact_id) != q_scope["contact_id"]))
            safety[name]["non_active"] += int(frozen["status"] != "active")
            safety[name]["revision_mismatches"] += int(m.revision != frozen["revision"])
            safety[name]["source_mismatches"] += int(set(map(str, m.source_ids)) != set(frozen["source_ids"]))
            safety[name]["state_negative_selected"] += int(frozen["role"] == "state_negative")

hashes = {}
for name, content in dataset_documents(build_dataset()).items():
    frozen_path = root / "experiments/hindsight/v2" / name
    digest = hashlib.sha256(frozen_path.read_bytes()).hexdigest()
    assert digest == result["dataset_hashes"][name]
    assert digest == hashlib.sha256(content.encode()).hexdigest()
    hashes[name] = digest
latency = {}
for name in ("A_lexical", "B_vector"):
    values = sorted(r.elapsed_ms for r in arms[name])
    latency[name] = {
        "inherited_attempts": len(values), "p50_ms": values[math.ceil(.50 * len(values)) - 1],
        "p95_ms": values[math.ceil(.95 * len(values)) - 1], "max_ms": max(values),
        "failures": sum(r.status == "failed" for r in arms[name]),
        "new_path_measured": False,
    }
assert math.isclose(latency["B_vector"]["p95_ms"], result["latency"]["p95_ms"])
quality = [p for p in pairs if p["group"] in ("direct", "paraphrase", "empty", "topic")]
transition = {
    "new_B_wrong_queries": [p["query_id"] for p in quality if not p["A_wrong_ids"] and p["B_wrong_ids"]],
    "fixed_A_wrong_queries": [p["query_id"] for p in quality if p["A_wrong_ids"] and not p["B_wrong_ids"]],
    "shared_wrong_queries": [p["query_id"] for p in quality if p["A_wrong_ids"] and p["B_wrong_ids"]],
}
module_hashes = {
    path: hashlib.sha256((root / path).read_bytes()).hexdigest()
    for path in ("backend/src/notalone/experiments/hindsight_metrics.py", "backend/src/notalone/experiments/hindsight_dataset.py", "backend/src/notalone/retrieval/lexical.py")
}
audit = {
    "schema_version": 1, "integration_base": "ada604d9",
    "execution_mode": "retrospective_required_condition_analysis",
    "fresh_heldout_validation": False, "new_embedding_calls": 0, "new_database_queries": 0,
    "raw_result_sha256": hashlib.sha256(raw).hexdigest(), "frozen_data_sha256": hashes,
    "analysis_plan_sha256": hashlib.sha256((root / ".scratch/memory-skill-evolution/reports/14-audit-plan.md").read_bytes()).hexdigest(),
    "analysis_module_sha256": module_hashes,
    "summaries": summaries, "quality_error_transition": transition,
    "frozen_snapshot_safety_audit": safety, "historical_latency": latency,
    "historical_lifecycle": result["lifecycle"],
    "timeout": {"historical_count": None, "reason": "记忆检索Port无超时参数，旧结果没有独立超时字段；不能据0失败宣称超时控制通过。"},
    "per_query": pairs,
}
output = root / ".scratch/memory-skill-evolution/reports/14-historical-audit.json"
output.write_text(json.dumps(audit, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
print(json.dumps({
    "output": str(output.relative_to(root)), "old_summaries_verified": True,
    "arms": {name: {group: data for group, data in summary.items() if group in ("final/quality", "final/paraphrase", "final/direct")} for name, summary in summaries.items()},
    "error_transition_counts": {k: len(v) for k, v in transition.items()},
    "safety": safety, "historical_latency": latency,
}, ensure_ascii=False, indent=2))
PY
```

## 单独追加的源码、旧重排与gold上界核对

以下为同次研究实际执行的第二段命令。它复核原摘要，按已公开gold计算乐观选择空间，读取已有Hindsight报告；不训练、校准或执行可用判别器。与上一段顺序运行即可重建完整机器证据。

```bash
source "$(conda info --base)/etc/profile.d/conda.sh" && conda activate NotAlone && python - <<'PY'
from pathlib import Path
import hashlib
import json
import subprocess
p=Path('.scratch/memory-skill-evolution/reports/14-historical-audit.json')
a=json.loads(p.read_text())
r=json.loads(Path('experiments/pgvector/runs/native-v3/result.json').read_text())
verification={}
for name,digest in r['provenance']['participating_module_sha256'].items():
    blob=subprocess.run(['git','show','53372729:'+name],check=True,capture_output=True).stdout
    verification[name]={'sha256':hashlib.sha256(blob).hexdigest(),'matches_recorded':hashlib.sha256(blob).hexdigest()==digest}
assert all(v['matches_recorded'] for v in verification.values())
a['historical_source_provenance']={'public_evidence_commit':'53372729','recorded_run_start_commit':r['provenance']['code_commit_at_run'],'run_start_public_commit':'6dc1a499e6a524c9e69cb34ec0aa9ed709ac5134','participating_original_sources':verification,'current_code_is_not_asserted_identical':True}
quality=[q for q in a['per_query'] if q['group'] in ('direct','paraphrase','empty','topic')]
reject=[q['query_id'] for q in quality if q['A_contact_empty'] and q['selections']['A_else_B_first'] and q['selections']['A_else_B_first'][0] in q['B_wrong_ids']]
assert len(reject)==9
a['posthoc_oracle_feasibility_bound']={'execution_mode':'gold_oracle_bound_not_a_method','fresh_validation':False,'description':'仅用gold拒绝A为空时新增的无关首条；这是可行空间上界，不是可实现判别器或性能证据。','rejected_query_ids':reject,'quality_injection_queries':a['summaries']['A_else_B_first']['final/quality']['irrelevant_injection_queries']-len(reject),'quality_denominator':95,'paraphrase_macro_recall':a['summaries']['A_else_B_first']['final/paraphrase']['macro_recall_at_5'],'direct_macro_recall':a['summaries']['A_else_B_first']['final/direct']['macro_recall_at_5']}
hpath=Path('experiments/hindsight/comparison-v2-r2/result.json')
h=json.loads(hpath.read_text())
a['prior_hindsight_boundary']={'source_sha256':hashlib.sha256(hpath.read_bytes()).hexdigest(),'paraphrase_recall':h['summaries']['B']['final/paraphrase']['macro_recall_at_5'],'direct_recall':h['summaries']['B']['final/direct']['macro_recall_at_5'],'quality_injection_queries':h['summaries']['B']['final/quality']['irrelevant_injection_queries'],'quality_denominator':95,'p95_ms':h['latency']['B']['all_attempts']['p95_ms'],'timeout_failures':h['latency']['B']['timeout_failures'],'denominator':103,'not_rerun':True}
p.write_text(json.dumps(a,ensure_ascii=False,indent=2,sort_keys=True)+'\n')
print(json.dumps({'original_sources_verified':len(verification),'oracle_reject_count':len(reject),'hindsight_not_rerun':True},ensure_ascii=False))
PY
```
