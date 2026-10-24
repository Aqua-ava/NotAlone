"""冻结当前产品字节并准备本轮独占运行环境，不改产品源。"""
import hashlib,json,os,pathlib,shutil,subprocess,tempfile
root=pathlib.Path.cwd(); out=root/'.scratch/dsh-ts-migration/incremental-abrupt-restart-probe'
run=pathlib.Path(tempfile.mkdtemp(prefix='na-abrupt-restart-',dir='/tmp')); frozen=run/'frozen'; frozen.mkdir()
old=json.loads((root/'.scratch/dsh-ts-migration/unconfigured-sync-composition-probe/source-hashes.json').read_text())
files=set(old['files'])
for base in ['backend-ts/src','backend-ts/test','backend/src/notalone','backend/database/migrations','backend-ts/profile']:
 for p in (root/base).rglob('*'):
  if p.is_file() and not any(v in p.parts for v in ['__pycache__','node_modules','.git']) and p.suffix not in ['.pyc']:
   files.add(str(p.relative_to(root)))
files=sorted(p for p in files if (root/p).is_file())
hashes={}
for p in files:
 data=(root/p).read_bytes(); dest=frozen/p; dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(data)
 hashes[p]=hashlib.sha256(data).hexdigest()
changed=[p for p,h in hashes.items() if hashlib.sha256((root/p).read_bytes()).hexdigest()!=h]
if changed: raise RuntimeError('冻结期间源改变：'+repr(changed))
(frozen/'backend-ts/node_modules').symlink_to(root/'backend-ts/node_modules',target_is_directory=True)
for name in ['runtime','audit','home','logs']:(run/name).mkdir(mode=0o700)
sha=hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()
meta={'run':str(run),'frozen':str(frozen),'source_tree_sha256':sha,'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'files':hashes}
(run/'meta.json').write_text(json.dumps(meta,indent=2)); (out/'run-path.txt').write_text(str(run)+'\n')
node=os.environ.get('NOTALONE_TEST_NODE',str(pathlib.Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')); python=os.environ.get('NOTALONE_TEST_PYTHON',str(pathlib.Path.home()/'miniconda3/envs/NotAlone/bin/python'))
(run/'audited-node').write_text('#!/bin/sh\nexec '+node+' --import '+str(run/'audit/network.mjs')+' "$@"\n');(run/'audited-node').chmod(0o700)
# Python保持真实可执行文件身份，sitecustomize只注入传输审计。
shutil.copy2(out/'sitecustomize.py',run/'audit/sitecustomize.py')
(frozen/'backend/src/sitecustomize.py').symlink_to(run/'audit/sitecustomize.py')
shutil.copy2(out/'network-audit.mjs',run/'audit/network.mjs')
shutil.copy2(out/'launcher-helper.mjs',run/'helper.mjs')
shutil.copy2(out/'probe.mjs',run/'probe.mjs')
print(json.dumps({'run':str(run),'file_count':len(hashes),'source_tree_sha256':sha,'head':meta['head']}))
