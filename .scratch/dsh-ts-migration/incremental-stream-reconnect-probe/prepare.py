"""冻结当前真实源，并为仅合成增量流验收准备隔离进程审计。"""
from pathlib import Path
import hashlib,json,os,shutil,tempfile,tarfile
root=Path.cwd()
out=root/'.scratch/dsh-ts-migration/incremental-stream-reconnect-probe'
run=Path(tempfile.mkdtemp(prefix='na-incremental-reconnect-'))
frozen=run/'frozen'; frozen.mkdir()
parts=['backend/src','backend/database/migrations','backend-ts/src','backend-ts/profile']
paths=[]
for part in parts:
 paths += [p for p in (root/part).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc']
paths += [root/p for p in ['backend-ts/package.json','backend-ts/pnpm-lock.yaml','backend-ts/test/host-model-unconfigured-fixture.mjs']]
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}
def tree(data):return hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest()
for rel,sha in files.items():
 dest=frozen/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/rel,dest)
 assert hashlib.sha256(dest.read_bytes()).hexdigest()==sha
assert all(hashlib.sha256((root/p).read_bytes()).hexdigest()==s for p,s in files.items())
os.symlink(root/'backend-ts/node_modules',frozen/'backend-ts/node_modules',target_is_directory=True)
with tarfile.open(run/'source-snapshot.tar.gz','w:gz') as tar:
 for rel in files:tar.add(frozen/rel,arcname=rel,recursive=False)
node=os.environ.get('NOTALONE_RECONNECT_NODE',str(Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'))
python=os.environ.get('NOTALONE_RECONNECT_PYTHON',str(Path.home()/'miniconda3/envs/NotAlone/bin/python'))
for name in ['runtime','runner-home']: (run/name).mkdir()
meta={'root':str(root),'run':str(run),'frozen':str(frozen),'source_tree_sha256':tree(files),'files':files,'node':node,'python':python}
(run/'meta.json').write_text(json.dumps(meta,indent=2))
(run/'node-audit.mjs').write_text("""import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
const path=process.env.NOTALONE_SYNTHETIC_NETWORK_AUDIT_NODE;
function audit(kind,host){
 const value=String(host??'localhost');const allowed=value.startsWith('/')||['localhost','127.0.0.1','::1','0:0:0:0:0:0:0:1'].includes(value);
 if(path)fs.appendFileSync(path,JSON.stringify({pid:process.pid,kind,host:value,allowed,at:Date.now()})+'\\n');
 if(!allowed)throw Error('合成验收禁止外网传输');
}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];const host=typeof a==='object'?(a.path??a.host??'localhost'):typeof a==='string'&&!/^\\d+$/.test(a)?a:typeof args[1]==='string'?args[1]:'localhost';audit('connect',host);return connect.apply(this,args);};
const lookup=dns.lookup;dns.lookup=function(host,...args){audit('lookup',host);return lookup.call(this,host,...args);};
const plookup=dns.promises.lookup;dns.promises.lookup=async function(host,...args){audit('lookup',host);return plookup.call(this,host,...args);};
""")
(frozen/'backend/src/sitecustomize.py').write_text("""import sys,os,json,ipaddress
_path=os.environ.get('NOTALONE_SYNTHETIC_NETWORK_AUDIT')
def _audit(event,args):
 if event not in ('socket.connect','socket.getaddrinfo','socket.sendto'):return
 dest=args[1] if event in ('socket.connect','socket.sendto') else args[0]
 host=dest[0] if isinstance(dest,tuple) else dest
 allowed=isinstance(host,str) and (host.startswith('/') or host=='localhost')
 if not allowed:
  try:allowed=ipaddress.ip_address(host).is_loopback
  except ValueError:pass
 if _path:
  with open(_path,'a') as f:f.write(json.dumps({'pid':os.getpid(),'kind':event,'host':str(host),'allowed':allowed})+'\\n')
 if not allowed:raise RuntimeError('合成验收禁止外网传输')
sys.addaudithook(_audit)
""")
wrapper=run/'audited-node'
wrapper.write_text('#!/bin/bash\ncase "$1" in\n */@deepseek-ai/dsh/lib/bin.js) exec '+repr(node)+' --import '+repr(str(run/'node-audit.mjs'))+' "$@" >> '+repr(str(run/'dsh.stdout'))+' 2>> '+repr(str(run/'dsh.stderr'))+';;\n *) exec '+repr(node)+' --import '+repr(str(run/'node-audit.mjs'))+' "$@";;\nesac\n')
wrapper.chmod(0o700)
(run/'node-network-audit.jsonl').write_text('');(run/'python-network-audit.jsonl').write_text('')
off=Path('/tmp/notalone-dsh-official-687f282')
ref=json.loads((root/'.scratch/dsh-ts-migration/unconfigured-sync-composition-probe/official-source-hashes.json').read_text())
assert ref['commit']=='687f282e8625c6b8d11ff58211a90524be2e4317'
assert all(hashlib.sha256((off/p).read_bytes()).hexdigest()==s for p,s in ref['files'].items())
assert json.loads((off/'apps/cli/package.json').read_text())['version']=='0.2.1-rc.2'
assert json.loads((root/'backend-ts/node_modules/@deepseek-ai/dsh/package.json').read_text())['version']=='0.2.1-rc.2'
(run/'official-source-hashes.json').write_text(json.dumps(ref,indent=2))
print(json.dumps({'run':str(run),'source_tree_sha256':meta['source_tree_sha256'],'file_count':len(files),'official_version':'0.2.1-rc.2','official_sha_verified':True}))
