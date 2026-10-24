"""只从冻结Git树及显式合成manifest导出材料，不加载业务环境或凭据。"""
import dataclasses
import datetime
import enum
import hashlib
import io
import json
import os
import random
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / '.scratch/dsh-ts-migration/baseline/material-manifest.json'
BASELINE = '3c168296e9e8edaa43b8b323ff693e790e709069'

def canonical(value):
    if dataclasses.is_dataclass(value):
        return canonical(dataclasses.asdict(value))
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [canonical(item) for item in value]
    return value

def encoded(value):
    return json.dumps(canonical(value), ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

def main():
    manifest = json.loads(MANIFEST.read_text())
    assert manifest['baseline_commit'] == BASELINE
    material_checks = []
    for entry in manifest['materials']:
        content = (subprocess.check_output(['git', 'show', f'{BASELINE}:{entry["path"]}'], cwd=ROOT)
                   if entry.get('source_ref') == '3c168296' else (ROOT / entry['path']).read_bytes())
        actual = hashlib.sha256(content).hexdigest()
        assert actual == entry['sha256'], entry['path']
        material_checks.append({'path': entry['path'], 'sha256': actual})
    frozen = Path(tempfile.mkdtemp(prefix='notalone-retrieval-frozen-'))
    archive = subprocess.check_output(['git', 'archive', BASELINE, 'backend/src/notalone'], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(frozen, filter='data')
    sys.path.insert(0, str(frozen / 'backend/src'))
    from notalone.retrieval.recall_cases import CASES as recall_cases
    from notalone.memory_extraction.evaluation_cases import CASES as extraction_cases
    from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
    from notalone.retrieval.recall_evaluation import evaluate_case, summarize
    from notalone.retrieval.lexical import build_query_tokens
    extraction = (*extraction_cases, *SEMANTIC_CASES)
    for suite, cases in [('memory_recall', recall_cases), ('memory_extraction', extraction)]:
        expected = next(item for item in manifest['suites'] if item['suite'] == suite)
        hashes = {item.name: hashlib.sha256(encoded(item)).hexdigest() for item in cases}
        assert len(cases) == expected['count'] == len(hashes)
        assert hashes == {item['case_id']: item['canonical_case_sha256'] for item in expected['cases']}, suite
    ordered_recall = sorted(recall_cases, key=lambda case: case.name)
    ordered_extract = sorted(extraction, key=lambda case: case.name)
    rng = random.Random(102)
    plan = [{'index': index, 'repeat': repeat, 'order': rng.choice(['AB', 'BA'])}
            for repeat in range(3) for index in range(len(ordered_recall))]
    rng.shuffle(plan)
    vector_plan = [rng.choice(['AB', 'BA']) for _ in range(3)]
    vectors = []
    for case in ordered_extract:
        text = '\n'.join(body for _, body in case.messages)
        # 查询规则在向量运行前固定：旧词法query tokens中长度>=2的头8个词，以空格分隔。
        query = ' '.join(token.text for token in build_query_tokens(text) if len(token.text) >= 2)
        query = ' '.join(query.split()[:8])
        vectors.append({'case_id': case.name, 'text': text, 'query': query})
    output = {'baseline_commit': BASELINE, 'manifest_sha256': hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
              'material_checks': material_checks, 'frozen_source_root': str(frozen),
              'recall_cases': canonical(ordered_recall), 'execution_plan': plan, 'vector_plan': vector_plan,
              'vector_cases': vectors, 'vector_input_sha256': hashlib.sha256(encoded(vectors)).hexdigest()}
    Path(sys.argv[1]).write_text(json.dumps(output, ensure_ascii=False))
    print(json.dumps({'materials_verified': len(material_checks), 'recall_cases': len(recall_cases),
                      'extraction_cases': len(extraction), 'scheduled_pairs': len(plan)}))

if __name__ == '__main__':
    main()
