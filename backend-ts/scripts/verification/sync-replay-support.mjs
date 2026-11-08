/** 大库副本回放共用工具；正式 Worker 校验不变，仅放宽本脚本的打开等待。 */
import assert from 'node:assert/strict';
import {constants, copyFileSync, existsSync, mkdirSync, realpathSync, statSync, statfsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

export function copyBackup(backupArg, userDataArg) {
 const backup=realpathSync(backupArg),requested=resolve(userDataArg),temporaryRoot=realpathSync(tmpdir());
 assert.ok(backup.endsWith('/before-migration-43-20261107.sqlite'),'只允许指定的历史备份');
 assert.ok([temporaryRoot,realpathSync('/tmp')].includes(realpathSync(dirname(requested))),'副本必须是临时根直属新目录');
 assert.equal(existsSync(requested),false,'副本目录不得复用');
 assert.ok(statfsSync(temporaryRoot).bavail*statfsSync(temporaryRoot).bsize>=15*2**30,'临时卷至少15GiB可用');
 const original=statSync(backup);mkdirSync(join(requested,'managed/sqlite'),{recursive:true,mode:0o700});
 const userData=realpathSync(requested),file=join(userData,'managed/sqlite/notalone.sqlite');
 copyFileSync(backup,file,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
 return {backup,userData,file,unchanged:()=>{const current=statSync(backup);return ['dev','ino','size','mtimeMs','ctimeMs'].every(key=>current[key]===original[key]);}};
}
/** 仅克隆本轮已经关闭的自有副本；不打开源副本写连接，不覆盖已有目录。 */
export function cloneReplayCopy(sourceArg,userDataArg) {
 const source=realpathSync(sourceArg),requested=resolve(userDataArg),temporaryRoot=realpathSync(tmpdir());
 assert.ok(source.startsWith(realpathSync('/tmp')+'/notalone-sync-'),'只允许已有自有临时副本');
 assert.ok([temporaryRoot,realpathSync('/tmp')].includes(realpathSync(dirname(requested))),'输出必须是临时根直属新目录');
 assert.equal(existsSync(requested),false);assert.ok(statfsSync(temporaryRoot).bavail*statfsSync(temporaryRoot).bsize>=15*2**30);
 const origin=join(source,'managed/sqlite/notalone.sqlite'),original=statSync(origin);
 const held=[origin,origin+'-wal',origin+'-shm'].filter(existsSync);
 try{const pids=execFileSync('lsof',['-t','--',...held],{encoding:'utf8'});assert.equal(pids.trim(),'','源副本仍有进程占用');}
 catch(error){if(error.status!==1)throw error;}
 assert.ok(!existsSync(origin+'-wal')||statSync(origin+'-wal').size===0,'源副本有未合并WAL，不能按主文件克隆');
 mkdirSync(join(requested,'managed/sqlite'),{recursive:true,mode:0o700});const userData=realpathSync(requested),file=join(userData,'managed/sqlite/notalone.sqlite');
 copyFileSync(origin,file,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
 return {userData,file,sourceUnchanged:()=>{const current=statSync(origin);return ['dev','ino','size','mtimeMs','ctimeMs'].every(key=>current[key]===original[key]);}};
}
export function blockedContactRows(file) {
 const proof=readQuery(file,"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_proof'").length>0;
 return readQuery(file,proof?"SELECT owner_id,contact_id FROM source_proof WHERE state='needs_confirmation'":'SELECT owner_id,contact_id FROM history_continuity_fence');
}
export function readQuery(file,sql,parameters=[]) {
 const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare(sql).all(...parameters);}finally{db.close();}
}
export function snapshot(file) {
 const tables=new Set(readQuery(file,"SELECT name FROM sqlite_schema WHERE type='table'").map(r=>r.name));
 const count=table=>Number(readQuery(file,`SELECT count(*) n FROM ${table}`)[0].n);
 const references=['memory','memory_candidate','memory_citation','memory_document','memory_document_version','reply_candidate','reply_candidate_version','reply_candidate_context','reply_candidate_input_source'];
 return {fences:tables.has('source_proof')?Number(readQuery(file,"SELECT count(*) n FROM source_proof WHERE state='needs_confirmation'")[0].n):count('history_continuity_fence'),
  bindings:count('conversation_binding'),messages:count('message'),readGoals:count('read_goal'),captures:count('sync_capture'),
  references:Object.fromEntries(references.filter(t=>tables.has(t)).map(t=>[t,count(t)]))};
}
export function assertDataPreserved(before,after) {
 assert.equal(after.bindings,before.bindings,'绑定总数不变');assert.ok(after.messages>=before.messages,'消息总数只增不减');
 assert.deepEqual(after.references,before.references,'记忆、候选、整理版本和引用行数不变');
}
export async function openReplayStorage(userData,{registryModule}={}) {
 const file=join(userData,'managed/sqlite/notalone.sqlite'),identity=readQuery(file,'SELECT database_id,role FROM database_instance WHERE slot=1')[0];
 const worker=new Worker(new URL('../../src/storage/sqlite/worker.ts',import.meta.url),{
  workerData:{userData,intent:'open',expectedDatabaseId:identity.database_id,role:identity.role,...(registryModule?{registryModule}:{})},execArgv:['--experimental-strip-types']});
 let status;
 try{status=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{void worker.terminate();reject(new Error('replay_open_timeout'));},600_000);
  const fail=error=>{clearTimeout(timer);reject(error);};worker.once('error',fail);
  worker.once('message',message=>{clearTimeout(timer);worker.off('error',fail);message.code?reject(Object.assign(new Error(message.code),{code:message.code})):resolve(message.value);});
 });}catch(error){await worker.terminate();throw error;}
 let nextId=0,failed;const pending=new Map();
 function failAll(error){failed=error;for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();}
 worker.on('error',failAll);worker.on('exit',()=>failAll(new Error('replay_worker_exit')));
 worker.on('message',message=>{const p=pending.get(message.id);if(!p||message.started)return;clearTimeout(p.timer);pending.delete(message.id);
  message.code?p.reject(Object.assign(new Error(message.code),{code:message.code})):p.resolve(message.value);});
 const execute=(name,input)=>new Promise((resolve,reject)=>{if(failed)return reject(failed);const id=++nextId;
  const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error('replay_action_timeout'),{code:'replay_action_timeout'}));},60_000);
  pending.set(id,{resolve,reject,timer});worker.postMessage({id,name,input,lease:status});});
 return {status,execute,close:async()=>{try{if(!failed)await execute('storage.close',{});}finally{await worker.terminate();}},terminate:()=>worker.terminate()};
}
export const safeCode=error=>typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(error.code)?error.code:'replay_failed';

export function verifyReplayArtifact(executableArg,artifactRootArg) {
 const defaultRoot=fileURLToPath(new URL('../../../local-tools/wx-cli/.notalone-builds',import.meta.url));
 const root=realpathSync(artifactRootArg??defaultRoot),executable=realpathSync(executableArg);
 assert.ok(root.endsWith('/local-tools/wx-cli/.notalone-builds'),'只允许显式的独立CLI构建根');
 assert.ok(executable.startsWith(root+'/'),'读取器必须属于已选择的构建根');
 assert.ok(existsSync(join(dirname(dirname(executable)),'source-identity-upgrade-receipt.json')),'新制品必须先经正式升级配对');
 return executable;
}
