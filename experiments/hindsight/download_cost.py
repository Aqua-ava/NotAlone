import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

RUNTIME = Path('/tmp/notalone-hindsight-runtime-f7dd3f4')
CACHE = Path(tempfile.mkdtemp(prefix='notalone-hindsight-cost-', dir='/tmp'))
OUTPUT = Path('/tmp/notalone-hindsight-cost-evidence.json')
MODELS = [
    ('BAAI/bge-small-zh-v1.5', '7999e1d3359715c523056ef9478215996d62a620'),
    ('cross-encoder/mmarco-mMiniLMv2-L12-H384-v1', '1427fd652930e4ba29e8149678df786c240d8825'),
]
IGNORE = ['*.bin', '*.h5', '*.ot', 'onnx/*', 'openvino/*', 'flax_model.msgpack']
DEADLINE = 180
result = {
    'kind': 'isolated_first_download_cost',
    'recorded_at': datetime.now(timezone.utc).isoformat(),
    '说明': '新建独立空缓存，从公开 Hugging Face 模型地址实际下载；不复制或链接正式缓存，不发送合成 query 或资料；结束后删除本轮独立缓存。',
    'cache': str(CACHE),
    'huggingface_hub_version': importlib.metadata.version('huggingface_hub'),
    'python_version': sys.version.split()[0],
    'ignore_patterns': IGNORE,
    'timeouts': {'per_model_process_seconds': DEADLINE, 'etag_seconds': 15, 'download_read_seconds': 30},
    'token': False,
    'endpoint': 'https://huggingface.co',
    '依赖安装限制': '最初 Hindsight/uv 依赖安装耗时没有完整测量记录；本补测不将现有已缓存 venv 或 uv 缓存误称首次安装。',
    'models': [],
    'status': 'running',
}


def persist():
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')


worker = r'''
import json,time,sys
from pathlib import Path
from huggingface_hub import snapshot_download
repo,revision,cache_dir,ignore = sys.argv[1:]
started=time.perf_counter()
try:
    path=snapshot_download(repo_id=repo,revision=revision,cache_dir=cache_dir,ignore_patterns=json.loads(ignore),token=False,force_download=True,local_files_only=False,etag_timeout=15,endpoint='https://huggingface.co')
    print(json.dumps({'status':'downloaded','snapshot':path,'download_elapsed_ms':(time.perf_counter()-started)*1000}))
except Exception as exc:
    print(json.dumps({'status':'failed','error_type':type(exc).__name__,'error':str(exc),'download_elapsed_ms':(time.perf_counter()-started)*1000}))
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files_evidence(repo, revision):
    model_root = CACHE / 'models/hub' / ('models--' + repo.replace('/', '--'))
    snapshot = model_root / 'snapshots' / revision
    manifest = []
    if snapshot.exists():
        for path in sorted(snapshot.rglob('*')):
            if path.is_file():
                relative = str(path.relative_to(snapshot))
                entry = {'path': relative, 'bytes': path.stat().st_size}
                if path.suffix == '.json':
                    entry['sha256'] = digest(path)
                    formal = RUNTIME / 'models/hub' / ('models--' + repo.replace('/', '--')) / 'snapshots' / revision / relative
                    entry['formal_config_sha256'] = digest(formal) if formal.is_file() else None
                    entry['same_as_formal_config'] = formal.is_file() and entry['sha256'] == entry['formal_config_sha256']
                manifest.append(entry)
    blobs = model_root / 'blobs'
    actual_blob_bytes = sum(path.stat().st_size for path in blobs.rglob('*') if path.is_file()) if blobs.exists() else 0
    return {'snapshot_file_count':len(manifest),'snapshot_file_bytes':sum(entry['bytes'] for entry in manifest),'download_blob_file_bytes':actual_blob_bytes,'files':manifest}


persist()
try:
    for repo, revision in MODELS:
        print(json.dumps({'event':'download_started','model':repo,'timeout_seconds':DEADLINE}), flush=True)
        env = {
            'PATH':'/usr/bin:/bin:/usr/sbin:/sbin',
            'PYTHON_DOTENV_DISABLED':'1',
            'HF_HOME':str(CACHE / 'models'),
            'XDG_CACHE_HOME':str(CACHE / 'other-cache'),
            'HF_HUB_DISABLE_XET':'1',
            'HF_HUB_DISABLE_IMPLICIT_TOKEN':'1',
            'HF_HUB_DISABLE_PROGRESS_BARS':'1',
            'HF_HUB_DOWNLOAD_TIMEOUT':'30',
            'HF_HUB_ETAG_TIMEOUT':'15',
            'TOKENIZERS_PARALLELISM':'false',
        }
        started = time.perf_counter()
        try:
            completed = subprocess.run([str(RUNTIME / 'venv/bin/python'), '-c', worker, repo, revision, str(CACHE / 'models/hub'), json.dumps(IGNORE)],env=env,cwd=CACHE,text=True,capture_output=True,timeout=DEADLINE)
            lines = completed.stdout.strip().splitlines()
            measured = json.loads(lines[-1]) if lines else {'status':'failed','error_type':'WorkerExit','returncode':completed.returncode,'error':'子进程未输出下载完成证据。'}
            if 'error' in measured:
                measured['error'] = re.sub(r'https?://[^\s\)\]\"\']+', lambda m:m.group(0).split('?')[0], measured['error'])[:1500]
        except subprocess.TimeoutExpired:
            measured = {'status':'timed_out','error_type':'TimeoutExpired','error':'本模型首次下载达到明确的180秒进程期限，未计下载成功。'}
        measured.update({'model':repo,'revision':revision,'process_elapsed_ms':(time.perf_counter()-started)*1000})
        measured.update(files_evidence(repo, revision))
        result['models'].append(measured)
        persist()
        print(json.dumps({'event':'download_finished','model':repo,'status':measured['status'],'elapsed_ms':measured.get('download_elapsed_ms',measured['process_elapsed_ms']),'bytes':measured['snapshot_file_bytes']}, ensure_ascii=False), flush=True)
    result['status'] = 'passed' if all(item['status']=='downloaded' for item in result['models']) else 'partial_or_failed'
finally:
    shutil.rmtree(CACHE)
    result['cache_removed'] = not CACHE.exists()
    result['cleanup_scope'] = '只删除本子任务 tempfile.mkdtemp 创建的独立下载缓存；正式 runtime/cache 未改。'
    persist()
    print(json.dumps({'event':'finished','status':result['status'],'cache_removed':result['cache_removed'],'output':str(OUTPUT)}, ensure_ascii=False), flush=True)
