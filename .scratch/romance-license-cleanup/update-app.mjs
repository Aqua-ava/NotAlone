import assert from 'node:assert/strict';
import {readFile, writeFile, lstat, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {checkNoLinks,readBounded,readPackage,sha256} from '../../backend-ts/src/skills/skill-package.ts';
import {romanceBundleRoot,validateRomanceBundle} from '../../scripts/validate_romance_reply_skills.mjs';
const userData='/Users/local-user/Library/Application Support/NotAloneDesktop';
const baseline=JSON.parse(await readFile(new URL('before.json',import.meta.url),'utf8'));
const config=JSON.parse(await readFile(join(userData,'sqlite-development.json'),'utf8'));
assert.equal(config.skillPackageRoot,baseline.root);checkNoLinks(baseline.root);
const {catalog}=await validateRomanceBundle();
const prepared=[];
for(const entry of catalog.entries){
 const record=baseline.packages.find(p=>p.name===entry.name);assert.ok(record);
 const target=join(baseline.root,entry.name),source=join(romanceBundleRoot,entry.name),licensePath=join(target,'references/LICENSES.txt');
 const stat=await lstat(target);assert.equal(stat.dev,record.dev);assert.equal(stat.ino,record.ino);
 assert.equal(readPackage(target).package_sha256,record.package_sha256,entry.name+': 安装包已有修改，保留');
 assert.equal(sha256(readBounded(join(source,'SKILL.md'))),record.document_sha256);
 assert.equal(sha256(readBounded(join(source,'references/cases.md'))),record.cases_sha256);
 const license=readBounded(licensePath);assert.equal(sha256(license),record.license_sha256);
 prepared.push({entry,record,target,licensePath,license,expected:readPackage(source).package_sha256});
}
const sourcesPath=join(baseline.root,'SOURCES.md'),sources=readBounded(join(romanceBundleRoot,'SOURCES.md'));
checkNoLinks(sourcesPath);
try{assert.ok(readBounded(sourcesPath).equals(sources),'保留App根已有的不同来源文档');}catch(error){if(error.code!=='ENOENT')throw error;}
const raw=await readFile(join(userData,'managed/sqlite-backend.info'),'utf8');
const fields=Object.fromEntries(raw.trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
assert.match(fields.address,/^127\.0\.0\.1:[1-9][0-9]{0,4}$/);assert.ok(fields.token);
const headers={authorization:'Bearer '+fields.token,'content-type':'application/json'},endpoint='http://'+fields.address;
async function list(){const r=await fetch(endpoint+'/api/skills',{headers,signal:AbortSignal.timeout(60000)});assert.ok(r.ok,'skill_list_failed');return (await r.json()).skills;}
async function act(item,action){const r=await fetch(endpoint+'/api/skills/'+item.package_id+'/'+action,{method:'POST',headers,body:JSON.stringify({expected_head_revision:item.head_revision,confirmed:true}),signal:AbortSignal.timeout(60000)});const body=await r.json();assert.ok(r.ok,item.directory_name+':'+(body.error??'state_update_failed'));return body.skill;}
console.log(JSON.stringify({phase:'preflight_complete',packages:prepared.length}));
const wanted=new Set(catalog.entries.map(e=>e.name));
const before=(await list()).filter(p=>wanted.has(p.directory_name));assert.equal(before.length,92);
await writeFile(new URL('before-states.json',import.meta.url),JSON.stringify(before,null,2)+'\n');
console.log(JSON.stringify({phase:'preferences_read',packages:before.length}));
await writeFile(sourcesPath,sources);
let removed=0,verified=0;
for(const item of prepared){
 let state=before.find(p=>p.directory_name===item.entry.name);const originalState=state.enabled_state;
 const eligible=state.verification_reason!=='source_qualification_changed'&&state.verification_state!=='conflict';
 const stat=await lstat(item.target);assert.equal(stat.dev,item.record.dev);assert.equal(stat.ino,item.record.ino);
 assert.equal(readPackage(item.target).package_sha256,item.record.package_sha256,'删除前检测到包有修改');
 if(originalState==='enabled'&&eligible)state=await act(state,'disable');
 let deleted=false;
 try{
  checkNoLinks(item.licensePath);assert.equal(sha256(readBounded(item.licensePath)),item.record.license_sha256);
  await unlink(item.licensePath);deleted=true;
  assert.equal(readPackage(item.target).package_sha256,item.expected);
  if(eligible){state=await act(state,'verify');verified++;}
  if(originalState==='enabled'&&eligible)state=await act(state,'enable');
  assert.equal(state.enabled_state,originalState);removed++;
 }catch(error){
  if(deleted)await writeFile(item.licensePath,item.license,{flag:'wx'});
  if(originalState==='enabled'&&eligible&&state.enabled_state==='disabled')await act(state,'enable');
  throw error;
 }
}
const after=(await list()).filter(p=>wanted.has(p.directory_name));
for(const item of after){
 const original=before.find(p=>p.package_id===item.package_id);assert.ok(original);assert.equal(item.enabled_state,original.enabled_state);
 const expected=prepared.find(p=>p.entry.name===item.directory_name);
 assert.equal(readPackage(join(baseline.root,item.directory_name)).package_sha256,expected.expected);
 if(item.verification_state==='verified')assert.equal(item.revisions.find(r=>r.revision_no===item.current_revision_no).content_digest,expected.expected);
 const stat=await lstat(expected.target);assert.equal(stat.dev,expected.record.dev);assert.equal(stat.ino,expected.record.ino);
}
const result={removed,verified,packages:after.length,enabled:after.filter(p=>p.enabled_state==='enabled').length,disabled:after.filter(p=>p.enabled_state==='disabled').length,unknown:after.filter(p=>p.enabled_state==='unknown').length,preferencesPreserved:true,contentPreserved:true,notices:'SOURCES.md'};
await writeFile(new URL('result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
