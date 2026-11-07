import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,symlinkSync,appendFileSync,readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';

// 固定02完成时的公开源码；仅旧结构演练使用，不能让旧DDL运行46的source_proof动作。
export const preSourceProofRef='7b5def9bb26db2db1c0835332d38ca6341754a34';
const temporaryBase=realpathSync(tmpdir()),ownedPrefix=`notalone-pre-source-proof-${process.pid}-`,ownedList=join(temporaryBase,`notalone-pre-source-proof-${process.pid}.jsonl`);
let snapshotRoot,registryPromise;
function sourceRoot(){
 if(snapshotRoot)return snapshotRoot;
 const repository=fileURLToPath(new URL('../../../../',import.meta.url)),temporary=mkdtempSync(join(temporaryBase,ownedPrefix));
 try{
  const archive=execFileSync('git',['-C',repository,'archive',preSourceProofRef,'backend-ts/src'],{maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
  execFileSync('tar',['-xf','-','-C',temporary],{input:archive,stdio:['pipe','ignore','pipe']});
  symlinkSync(join(repository,'backend-ts/node_modules'),join(temporary,'backend-ts/node_modules'),'dir');
  writeFileSync(join(temporary,'.fixture-source.json'),JSON.stringify({ref:preSourceProofRef,pid:process.pid}),{mode:0o600});
  appendFileSync(ownedList,JSON.stringify(temporary)+'\n',{mode:0o600});
  snapshotRoot=temporary;process.once('exit',()=>rmSync(temporary,{recursive:true,force:true}));return snapshotRoot;
 }catch(error){rmSync(temporary,{recursive:true,force:true});throw error;}
}
/** Worker可能被terminate；测试主进程after按本PID精确清单补清理，不扫描或删除其他任务目录。 */
export function cleanupPreSourceProofFixtures(){
 if(!existsSync(ownedList))return;
 for(const line of readFileSync(ownedList,'utf8').split('\n').filter(Boolean)){
  const root=JSON.parse(line);if(!existsSync(root))continue;
  if(dirname(root)!==temporaryBase||!basename(root).startsWith(ownedPrefix)||realpathSync(root)!==root)throw Error('legacy_fixture_cleanup_invalid');
  const marker=JSON.parse(readFileSync(join(root,'.fixture-source.json'),'utf8'));
  if(marker.ref!==preSourceProofRef||marker.pid!==process.pid)throw Error('legacy_fixture_cleanup_invalid');
  rmSync(root,{recursive:true,force:true});
 }
 rmSync(ownedList,{force:true});
}
/** 同一Worker中的旧动作错误转换为当前传输合同；不修改旧SQL、迁移或数据。 */
export function legacyAction(action){return {...action,execute(...args){try{return action.execute(...args);}catch(error){
 if(error?.name==='StorageFailure'&&typeof error.code==='string')throw new StorageFailure(error.code);throw error;
}}};}
export function loadPreSourceProofModule(relative){
 if(!/^[a-zA-Z0-9_./-]+\.ts$/.test(relative)||relative.split('/').includes('..'))throw Error('legacy_fixture_path_invalid');
 return import(pathToFileURL(join(sourceRoot(),'backend-ts/src',relative)).href);
}
export function loadPreSourceProofRegistry(){return registryPromise??=(async()=>{
 const {registry}=await loadPreSourceProofModule('storage/sqlite/registry.ts');return {...registry,actions:registry.actions.map(legacyAction)};
})();}

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
