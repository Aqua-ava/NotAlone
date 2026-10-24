from pathlib import Path
import os, shutil, subprocess, tarfile, tempfile, hashlib, json
root=Path.cwd()
sources=['foreground-location-api.ts','foreground-location-locator.ts','foreground-location-name-matching.ts','foreground-location-sessions.ts']
tests=['foreground-location-api.test.mjs','foreground-location-authority.test.mjs','foreground-location-locator.test.mjs','foreground-location-name-matching.test.mjs','foreground-location-sessions.test.mjs','foreground-location-frozen.test.mjs']
files=[f'backend-ts/src/{name}' for name in sources]+[f'backend-ts/test/{name}' for name in tests]+['backend-ts/test/foreground-location-fixture.mjs','backend-ts/test/foreground-location-frozen-fixture.py']
base=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
hashes={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files}
node=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
with tempfile.TemporaryDirectory(prefix='notalone-foreground-domain-') as directory:
 temp=Path(directory);archive=temp/'base.tar'
 subprocess.run(['git','archive','--output',str(archive),base,'backend','backend-ts'],check=True)
 with tarfile.open(archive) as source:source.extractall(temp,filter='data')
 archive.unlink()
 for name in files:shutil.copyfile(root/name,temp/name)
 (temp/'backend-ts/node_modules').symlink_to(root/'backend-ts/node_modules',target_is_directory=True)
 git_dir=subprocess.check_output(['git','rev-parse','--absolute-git-dir'],text=True).strip()
 (temp/'.git').write_text('gitdir: '+git_dir+'\n')
 env={**os.environ,'NOTALONE_DISABLE_DOTENV':'1'}
 subprocess.run([str(node),'--test','--test-concurrency=1',*[f'test/{name}' for name in tests]],cwd=temp/'backend-ts',env=env,check=True,timeout=180)
 subprocess.run([str(node),'node_modules/typescript/bin/tsc','--noEmit'],cwd=temp/'backend-ts',env=env,check=True,timeout=60)
assert all(hashlib.sha256((root/name).read_bytes()).hexdigest()==digest for name,digest in hashes.items())
print(json.dumps({'base':base,'files':hashes,'tests':len(tests),'typecheck':'passed','history':'readonly git show frozen baseline'}))
