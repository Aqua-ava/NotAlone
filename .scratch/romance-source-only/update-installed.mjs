import assert from 'node:assert/strict';
import {readFile, writeFile, lstat, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {checkNoLinks, readBounded, readPackage} from '../../backend-ts/src/skills/skill-package.ts';
import {validateRomanceBundle, romanceBundleRoot} from '../../scripts/validate_romance_reply_skills.mjs';
const userData='/Users/local-user/Library/Application Support/NotAloneDesktop';
const cache=new URL('./',import.meta.url);
const baseline=JSON.parse(await readFile(new URL('install-baseline.json',cache),'utf8'));
const config=JSON.parse(await readFile(join(userData,'sqlite-development.json'),'utf8'));
const root=config.skillPackageRoot;
assert.equal(resolve(root),baseline.root);
assert.equal(resolve(root),join(userData,'skill-packages'));
checkNoLinks(root);
const {catalog}=await validateRomanceBundle();
const prepared=[];
for(const entry of catalog.entries){
 const target=join(root,entry.name);checkNoLinks(target);
 const identity=await lstat(target);assert.ok(identity.isDirectory());
 const current=readPackage(target),source=readPackage(join(romanceBundleRoot,entry.name));
 const before=baseline.packages.find(x=>x.name===entry.name);assert.ok(before);
 assert.equal(current.package_sha256,before.package_sha256,entry.name+': 安装内容已变更，保留用户修改');
 const original=new Map([['SKILL.md',readBounded(join(target,'SKILL.md'))],...current.resources.map(x=>[x.relative_path,x.content])]);
 const replacement=new Map([['SKILL.md',readBounded(join(romanceBundleRoot,entry.name,'SKILL.md'))],...source.resources.map(x=>[x.relative_path,x.content])]);
 assert.ok([...original.keys()].every(p=>replacement.has(p)),'不能丢弃既有文件');
 prepared.push({entry,target,identity,original,replacement,expected:source.package_sha256});
}
const raw=await readFile(join(userData,'managed/sqlite-backend.info'),'utf8');
const fields=Object.fromEntries(raw.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
assert.match(fields.address,/^127\.0\.0\.1:[1-9][0-9]{0,4}$/);assert.ok(fields.token);
const endpoint='http://'+fields.address;
const headers={authorization:'Bearer '+fields.token,'content-type':'application/json'};
async function list(){const response=await fetch(endpoint+'/api/skills',{headers,signal:AbortSignal.timeout(60000)});assert.ok(response.ok,'library_read_failed');return (await response.json()).skills;}
async function act(item,action){const response=await fetch(endpoint+'/api/skills/'+item.package_id+'/'+action,{method:'POST',headers,body:JSON.stringify({expected_head_revision:item.head_revision,confirmed:true}),signal:AbortSignal.timeout(60000)});const result=await response.json();assert.ok(response.ok,item.directory_name+':'+(result.error??'state_update_failed'));return result.skill;}
console.log(JSON.stringify({phase:'preflight_complete',packages:prepared.length}));
const allBefore=await list(),wanted=new Set(catalog.entries.map(e=>e.name));
const states=allBefore.filter(x=>wanted.has(x.directory_name));assert.equal(states.length,92);
assert.ok(states.every(x=>x.verification_reason!=='source_qualification_changed'&&x.verification_state!=='conflict'),'保留撤销或身份冲突状态，不能自动恢复');
console.log(JSON.stringify({phase:'preferences_read',packages:states.length}));
await writeFile(new URL('install-state-before.json',cache),JSON.stringify(states,null,2)+'\n');
let updated=0;
for(const item of prepared){
 let state=states.find(x=>x.directory_name===item.entry.name);const enabled=state.enabled_state==='enabled';
 const rollback=async()=>{for(const [relative,bytes]of item.original)await writeFile(join(item.target,relative),bytes);for(const relative of item.replacement.keys())if(!item.original.has(relative))await rm(join(item.target,relative));};
 const current=await lstat(item.target);assert.equal(current.dev,item.identity.dev);assert.equal(current.ino,item.identity.ino);
  assert.equal(readPackage(item.target).package_sha256,baseline.packages.find(x=>x.name===item.entry.name).package_sha256,'写入前检测到用户修改');
 if(enabled)state=await act(state,'disable');
 try{
  for(const [relative,bytes]of item.replacement){const path=join(item.target,relative);checkNoLinks(path);await writeFile(path,bytes);}
  assert.equal(readPackage(item.target).package_sha256,item.expected);
  const after=await lstat(item.target);assert.equal(after.ino,item.identity.ino);assert.equal(after.dev,item.identity.dev);
  state=await act(state,'verify');
  if(enabled)state=await act(state,'enable');
  assert.equal(state.enabled_state,states.find(x=>x.directory_name===item.entry.name).enabled_state,'启停状态变更');
  updated++;
 }catch(error){
  await rollback();
  if(enabled){const current=(await list()).find(x=>x.package_id===state.package_id);if(current?.enabled_state==='disabled'){const verified=await act(current,'verify');await act(verified,'enable');}}
  throw error;
 }
}
const allAfter=await list(),after=allAfter.filter(x=>wanted.has(x.directory_name));
for(const item of after){const original=states.find(x=>x.package_id===item.package_id);assert.ok(original);assert.equal(item.enabled_state,original.enabled_state);assert.equal(item.verification_state,'verified');const expected=prepared.find(x=>x.entry.name===item.directory_name).expected;assert.equal(item.revisions.find(r=>r.revision_no===item.current_revision_no).content_digest,expected);}
assert.deepEqual(allAfter.filter(x=>!wanted.has(x.directory_name)),allBefore.filter(x=>!wanted.has(x.directory_name)));
const result={updated,verified:after.length,enabled:after.filter(x=>x.enabled_state==='enabled').length,disabled:after.filter(x=>x.enabled_state==='disabled').length,unknown:after.filter(x=>x.enabled_state==='unknown').length,preferencesPreserved:true,directoryIdentitiesPreserved:true,otherPackagesUnchanged:true};
await writeFile(new URL('install-result.json',cache),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
