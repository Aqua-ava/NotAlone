import assert from 'node:assert/strict';
import {readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {checkNoLinks,readBounded,sha256} from '../../backend-ts/src/skills/skill-package.ts';
import {validateRomanceBundle,romanceBundleRoot} from '../../scripts/validate_romance_reply_skills.mjs';
const userData='/Users/local-user/Library/Application Support/NotAloneDesktop';
const oldRoot=join(userData,'skill-packages'),sourceRoot=resolve(romanceBundleRoot);
checkNoLinks(oldRoot);checkNoLinks(sourceRoot);
const {catalog}=await validateRomanceBundle();
async function tree(root,relative=''){
 const rows=[];
 for(const name of (await readdir(join(root,relative))).sort()){
  if(name==='.DS_Store')continue;
  const path=join(root,relative,name),rel=relative?relative+'/'+name:name;
  const stat=await lstat(path);assert.ok(!stat.isSymbolicLink(),rel+': 链接不参与删除');
  if(stat.isDirectory()){rows.push({path:rel,kind:'directory'});rows.push(...await tree(root,rel));}
  else{assert.ok(stat.isFile()&&stat.nlink===1,rel+': 非普通独立文件');const bytes=readBounded(path);rows.push({path:rel,kind:'file',size:bytes.length,sha256:sha256(bytes)});}
 }
 return rows;
}
const entries=[];
for(const entry of catalog.entries){
 const original=await tree(join(oldRoot,entry.name)),source=await tree(join(sourceRoot,entry.name));
 assert.deepEqual(original,source,entry.name+': 发现不同内容，不删除');
 const stat=await lstat(join(oldRoot,entry.name));
 entries.push({name:entry.name,dev:stat.dev,ino:stat.ino,tree:original});
}
const known=new Set(catalog.entries.map(e=>e.name)),rootEntries=await readdir(oldRoot,{withFileTypes:true});
assert.ok(rootEntries.filter(e=>e.isDirectory()).every(e=>known.has(e.name)),'旧根有额外目录，需先保留并核对');
assert.ok(readBounded(join(oldRoot,'SOURCES.md')).equals(readBounded(join(sourceRoot,'SOURCES.md'))),'旧根来源文档不同，不删除');
await writeFile(new URL('copy-audit.json',import.meta.url),JSON.stringify({oldRoot,sourceRoot,packages:entries},null,2)+'\n');
console.log(JSON.stringify({identicalPackages:entries.length,files:entries.reduce((n,e)=>n+e.tree.filter(r=>r.kind==='file').length,0),oldRootFiles:rootEntries.filter(e=>!e.isDirectory()).map(e=>e.name),source:sourceRoot}));
