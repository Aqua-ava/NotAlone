"""本任务验证原件仅存仓库外；公开副本替换本机路径并附双摘要。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
NODE = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'

label, working_directory, *arguments = sys.argv[1:]
def source_snapshot():
    files = sorted(p for directory in ['backend-ts/src', 'desktop/src', 'backend/database/migrations']
                   for p in (ROOT / directory).rglob('*') if p.is_file())
    records = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    serialized = json.dumps(records, ensure_ascii=False, sort_keys=True).encode()
    return {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'runtime_source_sha256': hashlib.sha256(serialized).hexdigest(), 'runtime_file_count': len(files)}

before = source_snapshot()
private = Path(tempfile.mkdtemp(prefix='notalone-stop-evidence-'))
os.chmod(private, 0o700)
raw = private / (label + '.log')
env = dict(os.environ, PATH=str(NODE.parent) + ':' + os.environ.get('PATH', ''))
chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
if chrome.is_file():
    env.setdefault('NOTALONE_TEST_CHROMIUM_PATH', str(chrome))
with raw.open('wb') as log:
    os.chmod(raw, 0o600)
    result = subprocess.run([str(NODE), *arguments], cwd=ROOT / working_directory,
                            env=env, stdout=log, stderr=subprocess.STDOUT)
data = raw.read_bytes()
public = data.decode('utf-8', errors='replace').replace(str(ROOT), '<REPO>').replace(str(Path.home()), '<HOME>')
public = public.replace(str(private), '<PRIVATE_EVIDENCE>')
public_path = OUT / (label + '.public.log')
public_path.write_text(public)
entry = {'exit_code': result.returncode, 'cwd': working_directory, 'command': ['node', *arguments],
         'raw_sha256': hashlib.sha256(data).hexdigest(),
         'public_sha256': hashlib.sha256(public.encode()).hexdigest(),
         'private_directory_mode': oct(private.stat().st_mode & 0o777),
         'raw_file_mode': oct(raw.stat().st_mode & 0o777),
         'chromium': 'system-chrome' if env.get('NOTALONE_TEST_CHROMIUM_PATH') == str(chrome) else 'default',
         'public_file': public_path.name}
entry.update(source_before=before, source_after=source_snapshot())
entry['source_stable_during_run'] = entry['source_before'] == entry['source_after']
(private / 'index.json').write_text(json.dumps(entry, ensure_ascii=False, indent=2) + '\n')
os.chmod(private / 'index.json', 0o600)
(OUT / (label + '.json')).write_text(json.dumps(entry, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(entry, ensure_ascii=False))
print('\n'.join(public.splitlines()[-45:]))
sys.exit(result.returncode if entry['source_stable_during_run'] else 2)
