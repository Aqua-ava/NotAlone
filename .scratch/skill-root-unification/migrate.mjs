import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {loadStartupConfiguration,loadManifest} from '../../backend-ts/src/platform/cutover/control.ts';
import {SqliteStorage} from '../../backend-ts/src/storage/sqlite/client.ts';
import {SqliteSkillLibrary} from '../../backend-ts/src/skills/sqlite/library.ts';
import {prepareSkillRootRelocation,recoverSkillRootRelocation} from '../../backend-ts/src/skills/sqlite/root-relocation.ts';
const userData='/Users/local-user/Library/Application Support/NotAloneDesktop',targetRoot=resolve('reply-skills/romance');
assert.ok(!existsSync(join(userData,'managed/sqlite-backend.info'))&&!existsSync(join(userData,'managed/sqlite-backend.info.dsh-lock')),'App仍在运行，保留当前配置');
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2);
const original=loadStartupConfiguration(userData),manifest=loadManifest(userData);
assert.ok(original&&manifest?.target?.ownerId);assert.ok([join(userData,'skill-packages'),targetRoot].includes(original.skillPackageRoot));
const ownerId=manifest.target.ownerId;
let baseline;
try{baseline=JSON.parse(await readFile(new URL('before-at-stop.json',import.meta.url),'utf8'));}
catch(error){
 if(error.code!=='ENOENT')throw error;
 const storage=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:original.expectedDatabaseId});
 try{baseline={config:original,states:await storage.execute('skills.list',{ownerId})};await writeFile(new URL('before-at-stop.json',import.meta.url),json(baseline)+'\n',{flag:'wx'});baseline=JSON.parse(json(baseline));}
 finally{await storage.close();}
}
const plan=await prepareSkillRootRelocation(userData,targetRoot);
if(plan)await writeFile(new URL('migration-plan.json',import.meta.url),json(plan)+'\n');
await recoverSkillRootRelocation(userData);
const configuration=loadStartupConfiguration(userData);assert.equal(configuration.skillPackageRoot,targetRoot);
assert.equal(configuration.expectedDatabaseId,baseline.config.expectedDatabaseId);
const storage=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:configuration.expectedDatabaseId});
try{
 const library=new SqliteSkillLibrary(storage,ownerId,targetRoot),items=await library.inspect(),after=JSON.parse(json(items));
 assert.equal(after.length,92);
 const unchanged=item=>{const {directoryIdentity,headRevision,...rest}=item;return rest;};
 assert.deepEqual(after.map(unchanged),baseline.states.map(unchanged));
 for(const item of after){const old=baseline.states.find(s=>s.id===item.id);assert.equal(BigInt(item.headRevision),BigInt(old.headRevision)+1n);assert.equal(JSON.parse(item.directoryIdentity)[0],join(targetRoot,item.directoryName));}
 const result={packages:after.length,root:targetRoot,enabled:after.filter(s=>s.enabledState==='enabled').length,disabled:after.filter(s=>s.enabledState==='disabled').length,unknown:after.filter(s=>s.enabledState==='unknown').length,verified:after.filter(s=>s.verificationState==='verified').length,idsPreferencesAndRevisionsPreserved:true};
 await writeFile(new URL('migration-result.json',import.meta.url),json(result)+'\n');console.log(JSON.stringify(result));
}finally{await storage.close();}
