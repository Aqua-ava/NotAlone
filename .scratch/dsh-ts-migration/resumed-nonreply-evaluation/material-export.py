"""只读固定Git树导出全部冻结材料；不加载dotenv、业务库或模型。"""
import dataclasses
import datetime
import enum
import hashlib
import io
import json
from pathlib import Path
import random
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '3c168296e9e8edaa43b8b323ff693e790e709069'
MANIFEST_SHA = '84b81a3255bffe8bc69da6f38c0dd79e1ba83510454ef8a9091c947b995b362b'


def canonical(value):
    if dataclasses.is_dataclass(value):
        return canonical(dataclasses.asdict(value))
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [canonical(item) for item in value]
    return value


def digest(value):
    return hashlib.sha256(json.dumps(canonical(value), ensure_ascii=False,
        sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def export():
    manifest_path = ROOT / '.scratch/dsh-ts-migration/baseline/material-manifest.json'
    manifest_bytes = manifest_path.read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest() == MANIFEST_SHA, 'material_manifest_drift'
    manifest = json.loads(manifest_bytes)
    assert manifest['baseline_commit'] == BASELINE
    checks = []
    for material in manifest['materials']:
        path = material['path']
        content = subprocess.check_output(['git', 'show', f'{BASELINE}:{path}'], cwd=ROOT) \
            if material.get('source_ref') == '3c168296' else (ROOT / path).read_bytes()
        actual = hashlib.sha256(content).hexdigest()
        assert actual == material['sha256'], f'material_file_drift:{path}'
        checks.append({'path': path, 'sha256': actual, 'source_ref': material.get('source_ref')})
    with tempfile.TemporaryDirectory(prefix='notalone-nonreply-export-') as directory:
        archive = subprocess.check_output(['git', 'archive', BASELINE, 'backend/src/notalone'], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(directory, filter='data')
        sys.path.insert(0, str(Path(directory) / 'backend/src'))
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
        from notalone.retrieval.recall_cases import CASES as RECALL_CASES
        reply = json.loads(subprocess.check_output(['git', 'show',
            f'{BASELINE}:backend/tests/fixtures/fidelity/synthetic-v1.json'], cwd=ROOT))['cases']
        organization = json.loads((ROOT / '.scratch/dsh-ts-migration/baseline/organization-learning-cases.json').read_text())['cases']
        suites = {'memory_extraction': [canonical(c) for c in (*CASES, *SEMANTIC_CASES)],
            'memory_recall': [canonical(c) for c in RECALL_CASES],
            'reply_fidelity': reply, 'organization_learning': organization}
        for suite in manifest['suites']:
            cases = suites[suite['suite']]
            hashes = {c[suite['case_id_field']]: digest(c) for c in cases}
            assert len(cases) == len(hashes) == suite['count'], 'material_case_count'
            assert hashes == {c['case_id']: c['canonical_case_sha256'] for c in suite['cases']}, f'material_case_drift:{suite["suite"]}'
        cases = [{'case_id': c['name'], 'domain': 'memory_extraction', 'case_sha256': digest(c),
            'material': c} for c in suites['memory_extraction']]
        cases += [{'case_id': c['case_id'], 'domain': c['domain'], 'case_sha256': digest(c),
            'material': c} for c in organization]
        cases.sort(key=lambda c: (c['domain'], c['case_id']))
        rng = random.Random(102)
        pairs = [{'case_index': i, 'repeat': repeat, 'order': rng.choice(['AB', 'BA'])}
            for repeat in range(1, 4) for i in range(len(cases))]
        rng.shuffle(pairs)
        return {'baseline_commit': BASELINE, 'manifest_sha256': MANIFEST_SHA,
            'material_checks': checks, 'total_unique_cases': manifest['total_unique_cases'],
            'cases': cases, 'pairs': pairs, 'seed': 102, 'canonical_cases_sha256': digest(cases),
            'model_calls_performed': 0, 'database_access_performed': False}


if __name__ == '__main__':
    print(json.dumps(export(), ensure_ascii=False, separators=(',', ':')))
