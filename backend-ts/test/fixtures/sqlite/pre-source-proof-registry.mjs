import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,symlinkSync,appendFileSync,readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';

// 固定公开历史源码，仅用于对应结构的升级演练，不能给旧DDL装入现行来源动作。
export const preSourceProofRef='7b5def9bb26db2db1c0835332d38ca6341754a34';
const temporaryBase=realpathSync(tmpdir()),ownedPrefix=`notalone-pre-source-proof-${process.pid}-`,ownedList=join(temporaryBase,`notalone-pre-source-proof-${process.pid}.jsonl`);
const hybridProcessingRef='6829c083434483c11145757df8fa538e6f573eb0';
const snapshotRoots=new Map(),registryPromises=new Map();
function sourceRoot(reference=preSourceProofRef){
 if(![preSourceProofRef,hybridProcessingRef].includes(reference))throw Error('legacy_fixture_reference_invalid');
 if(snapshotRoots.has(reference))return snapshotRoots.get(reference);
 const repository=fileURLToPath(new URL('../../../../',import.meta.url)),temporary=mkdtempSync(join(temporaryBase,ownedPrefix));
 try{
  const archive=execFileSync('git',['-C',repository,'archive',reference,'backend-ts/src','backend-ts/package.json','pnpm-lock.yaml','backend-ts/test/fixtures/memory-management/supplier.mjs','backend-ts/test/fixtures/memory-sqlite/support.mjs'],{maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
  execFileSync('tar',['-xf','-','-C',temporary],{input:archive,stdio:['pipe','ignore','pipe']});
  symlinkSync(join(repository,'backend-ts/node_modules'),join(temporary,'backend-ts/node_modules'),'dir');
  writeFileSync(join(temporary,'.fixture-source.json'),JSON.stringify({ref:reference,pid:process.pid}),{mode:0o600});
  appendFileSync(ownedList,JSON.stringify(temporary)+'\n',{mode:0o600});
  snapshotRoots.set(reference,temporary);process.once('exit',()=>rmSync(temporary,{recursive:true,force:true}));return temporary;
 }catch(error){rmSync(temporary,{recursive:true,force:true});throw error;}
}
/** Worker可能被terminate；测试主进程after按本PID精确清单补清理，不扫描或删除其他任务目录。 */
export function cleanupPreSourceProofFixtures(){
 if(!existsSync(ownedList))return;
 for(const line of readFileSync(ownedList,'utf8').split('\n').filter(Boolean)){
  const root=JSON.parse(line);if(!existsSync(root))continue;
  if(dirname(root)!==temporaryBase||!basename(root).startsWith(ownedPrefix)||realpathSync(root)!==root)throw Error('legacy_fixture_cleanup_invalid');
  const marker=JSON.parse(readFileSync(join(root,'.fixture-source.json'),'utf8'));
  if(![preSourceProofRef,hybridProcessingRef].includes(marker.ref)||marker.pid!==process.pid)throw Error('legacy_fixture_cleanup_invalid');
  rmSync(root,{recursive:true,force:true});
 }
 rmSync(ownedList,{force:true});
}
/** 同一Worker中的旧动作错误转换为当前传输合同；不修改旧SQL、迁移或数据。 */
export function legacyAction(action){return {...action,execute(...args){try{return action.execute(...args);}catch(error){
 if(error?.name==='StorageFailure'&&typeof error.code==='string')throw new StorageFailure(error.code);throw error;
}}};}
export function loadPreSourceProofModule(relative,reference=preSourceProofRef){
 if(!/^[a-zA-Z0-9_./-]+\.ts$/.test(relative)||relative.split('/').includes('..'))throw Error('legacy_fixture_path_invalid');
 return import(pathToFileURL(join(sourceRoot(reference),'backend-ts/src',relative)).href);
}
/** 历史控制器与供应商替身必须使用同一固定协议，不能混用现行 local-ids 输出。 */
export function loadPreSourceProofFixture(relative,reference=preSourceProofRef){
 if(!/^[a-zA-Z0-9_./-]+\.mjs$/.test(relative)||relative.split('/').includes('..'))throw Error('legacy_fixture_path_invalid');
 return import(pathToFileURL(join(sourceRoot(reference),'backend-ts/test/fixtures',relative)).href);
}
export function loadPreSourceProofRegistry(reference=preSourceProofRef){
 if(!registryPromises.has(reference))registryPromises.set(reference,(async()=>{
  const {registry}=await loadPreSourceProofModule('storage/sqlite/registry.ts',reference);return {...registry,actions:registry.actions.map(legacyAction)};
 })());return registryPromises.get(reference);
}
export const loadHybridProcessingFixture=relative=>loadPreSourceProofFixture(relative,hybridProcessingRef);
export const loadHybridProcessingModule=relative=>loadPreSourceProofModule(relative,hybridProcessingRef);

/** 让旧渠道按当时正常使用合同产出可独立核验的账号/目标；事实由旧动作保存，非升级后补签。 */
export function certifyLegacyMetadata(channel){
 const inspect=channel.inspect.bind(channel),page=channel.page.bind(channel),close=channel.close?.bind(channel),loss=Promise.withResolvers();
 const capabilities=Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','serverIdUniqueConstraint','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail','durableIncremental','durableHistory','partitionGrowth'].map(key=>[key,'supported']));
 channel.guardSession={loss:loss.promise};
 channel.inspect=async scope=>({...await inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities});
 channel.page=async(...args)=>{const result=await page(...args);return {...result,...(result.exhausted?{resumeCursor:'synthetic-legacy-reader-tail'}:{})};};
 channel.tail=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:cursor,records:[],caughtUp:true});
 channel.close=async()=>{await close?.();loss.resolve();};return channel;
}

/** 只读观测真正存在的旧/新结构；不会给旧库添加proof或补签来源。 */
export function sourceSchemaSnapshot(tx,ownerId){
 const tables=tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('source_proof','history_continuity_fence','history_continuity_scope','history_guard_lease') ORDER BY name").map(row=>String(row.name));
 return {tables,proofs:tables.includes('source_proof')?tx.all('SELECT * FROM source_proof WHERE owner_id=? ORDER BY contact_id',[ownerId]):null};
}
