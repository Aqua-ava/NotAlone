import assert from 'node:assert/strict';
import {readFile,readdir,lstat,rm,unlink,rmdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {checkNoLinks,readBounded,sha256,validateName} from '../../backend-ts/src/skills/skill-package.ts';
import {loadStartupConfiguration} from '../../backend-ts/src/platform/cutover/control.ts';
import {skillRootRelocationJournal} from '../../backend-ts/src/skills/sqlite/root-relocation.ts';
const userData='/Users/local-user/Library/Application Support/NotAloneDesktop',audit=JSON.parse(await readFile(new URL('copy-audit.json',import.meta.url),'utf8'));
assert.equal(audit.oldRoot,join(userData,'skill-packages'));assert.equal(audit.sourceRoot,resolve('reply-skills/romance'));
assert.equal(loadStartupConfiguration(userData).skillPackageRoot,audit.sourceRoot);
assert.ok(!existsSync(skillRootRelocationJournal(userData)),'迁移尚未结束，不删除');
const proof=JSON.parse(await readFile(new URL('app-before-delete.json',import.meta.url),'utf8'));assert.equal(proof.verified,92);assert.equal(proof.root,audit.sourceRoot);
checkNoLinks(audit.oldRoot);checkNoLinks(audit.sourceRoot);
async function tree(root,relative=''){
 const rows=[];
 for(const name of (await readdir(join(root,relative))).sort()){
  if(name==='.DS_Store')continue;
  const path=join(root,relative,name),rel=relative?relative+'/'+name:name,stat=await lstat(path);
  assert.ok(!stat.isSymbolicLink(),rel+': 目录已改变');
  if(stat.isDirectory()){rows.push({path:rel,kind:'directory'});rows.push(...await tree(root,rel));}
  else{assert.ok(stat.isFile()&&stat.nlink===1);const bytes=readBounded(path);rows.push({path:rel,kind:'file',size:bytes.length,sha256:sha256(bytes)});}
 }
 return rows;
}
const remaining=[];
for(const p of audit.packages){
 validateName(p.name);
 const path=join(audit.oldRoot,p.name);if(!existsSync(path))continue;
 const stat=await lstat(path);assert.equal(stat.dev,p.dev);assert.equal(stat.ino,p.ino);
 assert.deepEqual(await tree(path),p.tree,p.name+': 旧副本有变更');
 assert.deepEqual(await tree(join(audit.sourceRoot,p.name)),p.tree,p.name+': 仓库内容有变更');remaining.push(p);
}
const sourceNotice=readBounded(join(audit.sourceRoot,'SOURCES.md'));
if(existsSync(join(audit.oldRoot,'SOURCES.md')))assert.ok(readBounded(join(audit.oldRoot,'SOURCES.md')).equals(sourceNotice));
let removed=0;
for(const p of remaining){
 const path=join(audit.oldRoot,p.name),stat=await lstat(path);assert.equal(stat.dev,p.dev);assert.equal(stat.ino,p.ino);
 assert.deepEqual(await tree(path),p.tree);await rm(path,{recursive:true});removed++;
}
for(const name of ['SOURCES.md','.DS_Store']){const path=join(audit.oldRoot,name);if(existsSync(path)){checkNoLinks(path);assert.ok((await lstat(path)).isFile());await unlink(path);}}
const leftovers=await readdir(audit.oldRoot);if(leftovers.length===0)await rmdir(audit.oldRoot);
const result={removedThisRun:removed,totalDuplicatePackagesRemoved:audit.packages.length,legacyRootRemoved:!existsSync(audit.oldRoot),leftovers,onlySkillRoot:audit.sourceRoot};
await writeFile(new URL('delete-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
