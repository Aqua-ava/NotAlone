"""仅本次停止修复的本地验证；原始输出留在仓库外。"""
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

def sha(data):
    return hashlib.sha256(data).hexdigest()

def snapshot():
    paths = ['desktop/src/main/reply/assistant-generation-jobs.ts',
             'desktop/tests/assistant-generation-preparation-stop.test.mjs',
             'desktop/tests/assistant-generation-stop.test.mjs']
    return {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'source_sha256': {p: sha((ROOT / p).read_bytes()) for p in paths},
            'staged_diff_sha256': sha(subprocess.check_output(['git', 'diff', '--cached', '--raw', '--no-abbrev'], cwd=ROOT))}

label, cwd, *arguments = sys.argv[1:]
before = snapshot()
private = Path(tempfile.mkdtemp(prefix='notalone-same-key-evidence-'))
os.chmod(private, 0o700)
raw = private / (label + '.log')
env = dict(os.environ, PATH=str(NODE.parent) + ':' + os.environ.get('PATH', ''),
           NOTALONE_REVIEW_FIXED_ROOT=str(ROOT))
chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
if chrome.is_file():
    env.setdefault('NOTALONE_TEST_CHROMIUM_PATH', str(chrome))
with raw.open('wb') as log:
    os.chmod(raw, 0o600)
    result = subprocess.run([str(NODE), *arguments], cwd=ROOT / cwd, env=env,
                            stdout=log, stderr=subprocess.STDOUT)
data = raw.read_bytes()
public = data.decode(errors='replace').replace(str(ROOT), '<REPO>').replace(str(Path.home()), '<HOME>')
public = public.replace(str(private), '<PRIVATE_EVIDENCE>')
public_path = OUT / (label + '.public.log')
public_path.write_text(public)
entry = {'command': ['node', *arguments], 'cwd': cwd, 'exit_code': result.returncode,
         'raw_sha256': sha(data), 'public_sha256': sha(public.encode()),
         'private_directory_mode': oct(private.stat().st_mode & 0o777),
         'raw_file_mode': oct(raw.stat().st_mode & 0o777), 'source_before': before,
         'source_after': snapshot(), 'public_file': public_path.name}
entry['source_stable'] = entry['source_before'] == entry['source_after']
(OUT / (label + '.json')).write_text(json.dumps(entry, ensure_ascii=False, indent=2) + '\n')
(private / 'index.json').write_text(json.dumps(entry, ensure_ascii=False, indent=2) + '\n')
os.chmod(private / 'index.json', 0o600)
print(json.dumps(entry, ensure_ascii=False))
print('\n'.join(public.splitlines()[-40:]))
sys.exit(result.returncode if entry['source_stable'] else 2)
