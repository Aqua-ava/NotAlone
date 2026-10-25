"""本轮合成验证：原始日志直接落仓库外，公开副本只替换路径。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path.cwd().resolve()
public = Path(__file__).resolve().parent
private = Path(sys.argv[1]).resolve()
name = sys.argv[2]
assert private.is_dir() and not private.is_relative_to(root)
assert private.stat().st_mode & 0o777 == 0o700
assert name.endswith('.log') and '/' not in name
raw_path = private / name
assert not raw_path.exists(), '冻结日志不覆盖'
descriptor = os.open(raw_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'wb') as stream:
    result = subprocess.run(sys.argv[3:], stdout=stream, stderr=subprocess.STDOUT)
raw = raw_path.read_bytes()
sanitized = raw.decode(errors='replace').replace(str(root), '<REPO>').replace(str(Path.home()), '<HOME>').replace(str(private), '<RAW>')
public_path = public / name
public_path.write_text(sanitized)
manifest = public / 'evidence-shas.json'
data = json.loads(manifest.read_text())
assert name not in {item['artifact'] for item in data['artifacts']}
data['artifacts'].append({'artifact': name, 'exit_code': result.returncode,
    'raw_sha256': hashlib.sha256(raw).hexdigest(),
    'public_sha256': hashlib.sha256(public_path.read_bytes()).hexdigest()})
manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print('\n'.join(sanitized.splitlines()[-60:]))
sys.exit(result.returncode)
