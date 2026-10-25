/** 固定捕获 Ticket 25 修复提交；当前工作树漂移不能改变随后执行的候选。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,readdir,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const sha=value=>createHash('sha256').update(value).digest('hex');
const SOURCE_COMMIT='HEAD';
const sourceRoots=['backend-ts/src','backend/src','backend/database/migrations'];
const extras=['backend-ts/experiments/README.md','backend-ts/experiments/build-reply-blind-packet.mjs','backend-ts/experiments/reply-blind-packet.mjs','backend-ts/test/fixtures/reply-blind-packet-pilot.json','backend-ts/test/reply-blind-packet.test.mjs','backend-ts/test/host-storage-fixture.mjs','backend-ts/test/reply-service-runtime-support.mjs','backend-ts/test/reply-service-runtime-plugin.ts','backend-ts/test/observe.mjs','backend-ts/profile/cordis.patch.yml','backend-ts/profile/host.patch.yml','backend-ts/pnpm-lock.yaml','backend-ts/package.json','backend-ts/tsconfig.json'];

export async function enumerateFiles(directory,prefix=''){
 const result=[];
 for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  const name=prefix+entry.name;
  if(entry.isDirectory())result.push(...await enumerateFiles(join(directory,entry.name),name+'/'));
  else if(entry.isFile())result.push(name);
  else throw Error('候选源码含非普通文件，必须先明确可复现来源：'+name);
 }
 return result;
}

async function sourceNames(root){
 const python=(await enumerateFiles(join(root,'backend/src'))).filter(name=>name.endsWith('.py')).map(name=>'backend/src/'+name);
 const migrations=(await enumerateFiles(join(root,'backend/database/migrations'))).filter(name=>name.endsWith('.sql')).map(name=>'backend/database/migrations/'+name);
 return [...new Set([...(await enumerateFiles(join(root,'backend-ts/src'))).map(name=>'backend-ts/src/'+name),...extras,...python,...migrations])].sort();
}
export async function captureSource(root,sourceCommit=SOURCE_COMMIT){
 const base=execFileSync('git',['rev-parse',`${sourceCommit}^{commit}`],{cwd:root,encoding:'utf8'}).trim();
 const status=execFileSync('git',['status','--porcelain','--','backend-ts/src','backend-ts/experiments','backend/src','backend/database/migrations'],{cwd:root,encoding:'utf8'});
 if(status.trim())throw Error('source_snapshot_requires_clean_execution_paths');
 const listed=execFileSync('git',['ls-tree','-r','-z','--name-only',base,'--',...sourceRoots,...extras],{cwd:root,encoding:'buffer'}).toString('utf8').split('\0').filter(Boolean);
 const names=[...new Set(listed.filter(name=>name.startsWith('backend-ts/src/')||extras.includes(name)||name.startsWith('backend/src/')&&name.endsWith('.py')||name.startsWith('backend/database/migrations/')&&name.endsWith('.sql')))].sort();
 assert.ok(names.length>0,'固定提交源码为空');
 const temporary=await mkdtemp(join(tmpdir(),'notalone-fixed-commit-'));
 try{
  const archive=execFileSync('git',['archive','--format=tar',base,'--',...sourceRoots,...extras],{cwd:root,maxBuffer:64*1024*1024});
  const extraction=spawnSync('tar',['-xf','-','-C',temporary],{input:archive,maxBuffer:64*1024*1024});
  assert.equal(extraction.status,0,extraction.stderr?.toString('utf8'));
  assert.deepEqual(await sourceNames(temporary),names,'固定提交文件集合与枚举不一致');
  const bytes=new Map(await Promise.all(names.map(async name=>[name,await readFile(join(temporary,name))])));
  const files=Object.fromEntries([...bytes].map(([name,value])=>[name,sha(value)]));
  return {bytes,manifest:{base_commit:base,requested_commit:sourceCommit,executed_tree_kind:'git_commit_tree',matches_commit_tree:true,modified_or_deleted_paths:[],untracked_paths:[],files}};
 }finally{
  await rm(temporary,{recursive:true,force:true});
 }
}

export async function freezeSource(snapshot,directory){
 for(const [name,bytes]of snapshot.bytes){const target=join(directory,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
 await verifyFrozenSource(snapshot.manifest,directory);
}

export async function verifyFrozenSource(manifest,directory){
 const actualNames=await sourceNames(directory);
 assert.deepEqual(actualNames,Object.keys(manifest.files).sort(),'固定候选文件集合变化');
 for(const name of actualNames)assert.equal(sha(await readFile(join(directory,name))),manifest.files[name],'固定候选内容变化：'+name);
}
