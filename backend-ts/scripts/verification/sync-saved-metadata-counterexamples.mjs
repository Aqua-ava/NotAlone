#!/usr/bin/env node
/** before43 副本的元数据注入反例；默认使用存档，加 --executable 时由独立正式原生读取器取得当前元数据。 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync,constants,existsSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {StorageFailure} from '../../src/storage/sqlite/contracts.ts';
import {SqliteHistoryService} from '../../src/history/sqlite/service.ts';
import {SharedWechatClient} from '../../src/history/wechat/shared-client.ts';
import {loadSharedNarrowWechatOptions} from '../../src/history/wechat/artifacts.ts';
import {createWechatHistoryChannel} from '../../src/history/sqlite/wechat-channel.ts';
import {historyTargetTransition} from '../../src/history/partition-growth.ts';
import {copyBackup,readQuery,snapshot,openReplayStorage,assertDataPreserved,safeCode,verifyReplayArtifact,blockedContactRows} from './sync-replay-support.mjs';
const args=new Map(process.argv.slice(2).map(value=>{const at=value.indexOf('=');return [value.slice(2,at),value.slice(at+1)];}));
const executable=args.has('executable')?verifyReplayArtifact(args.get('executable'),args.get('artifact-root')):undefined;
const mode=executable?'current-native-metadata':'saved-metadata';
const base=copyBackup(args.get('backup'),args.get('user-data'));let storage=await openReplayStorage(base.userData);
const ownerId=readQuery(base.file,"SELECT owner_id FROM owner WHERE state='active' LIMIT 1")[0].owner_id;
let contactId,token,report,target;
const blocked=new Set(blockedContactRows(base.file).filter(r=>r.owner_id===ownerId).map(r=>r.contact_id));
for(const row of readQuery(base.file,"SELECT id FROM contact WHERE owner_id=? AND state='active' ORDER BY id",[ownerId])){
 if(blocked.has(row.id))continue;
 try{
  const candidate=await storage.execute('identity.eligibility',{ownerId,contactId:row.id});
  const saved=readQuery(base.file,'SELECT support_json,target_json FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY creation_no DESC,created_at DESC,id DESC LIMIT 1',[ownerId,row.id])[0];
  if(!saved)continue;const fixed=JSON.parse(saved.target_json),supported=JSON.parse(saved.support_json);
  if(!fixed.tables.length||supported.status!=='supported'||supported.continuity!=='same-source-instances-normal-use-v1')continue;
  contactId=row.id;token=candidate;target=fixed;report=supported;break;
 }catch{/* 只选确有存档来源基线的当前有效联系人。 */}
}
assert.ok(contactId,'必须有非空物理目标的有效存档支持档');
// 正向控制：默认只用存档；当前模式另由正式原生接口重取支持档和物理目标。
if(executable){
 const scope=await storage.execute('history.scope',{token}),shared=new SharedWechatClient(()=>loadSharedNarrowWechatOptions(executable));
 const channel=createWechatHistoryChannel(executable,undefined,shared);
 try{report=await channel.inspect(scope);target=await channel.target(scope);}finally{await channel.close();await shared.close();}
}
// 只调用正式元数据准备动作并释放，不进入任何正文方法。
const controlBefore=snapshot(base.file),guardId=randomUUID();
const control=await storage.execute('history.prepareNormalUseGuard',{token,report,target,guardId});assert.equal(control.ok,true,'原存档元数据可通过正式判据');
await storage.execute('history.guardRelease',{token,guardId,normalUse:true,sourceLost:false,deferVerification:true});
assert.equal(snapshot(base.file).fences,controlBefore.fences);await storage.close();storage=undefined;
console.log(JSON.stringify({event:'metadata-positive-control',mode,accepted:true,bodyMethods:0,fences:controlBefore.fences}));
const changes={
 account:({report})=>{report.accountKey='synthetic_changed_account';},
 conversation:({report})=>{report.conversationKey='synthetic_changed_conversation';},
 generation:({report})=>{report.sourceGeneration='c'.repeat(64);},
 'missing-shard':({target})=>{const gone=target.tables[0].partition;target.tables=target.tables.filter(t=>t.partition!==gone);target.partitions=target.partitions.filter(p=>p!==gone);},
 'replaced-table':({target})=>{assert.notEqual(target.tables[0].instance,'a'.repeat(64));target.tables[0].instance='a'.repeat(64);},
 'file-identity':({target})=>{const old=target.checkedPartitions[0],replacement='b'.repeat(64);assert.notEqual(old,replacement);target.checkedPartitions=target.checkedPartitions.map(p=>p===old?replacement:p);target.partitions=target.partitions.map(p=>p===old?replacement:p);target.tables=target.tables.map(t=>t.partition===old?{...t,partition:replacement}:t);},
};
const results=[];
for(const [name,change] of Object.entries(changes)){
 const userData=base.userData+`-${name}`;assert.equal(existsSync(userData),false);assert.equal(dirname(userData),realpathSync('/tmp'));
 mkdirSync(join(userData,'managed/sqlite'),{recursive:true,mode:0o700});const file=join(userData,'managed/sqlite/notalone.sqlite');copyFileSync(base.file,file,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
 const before=snapshot(file);storage=await openReplayStorage(userData);let history,shared,bodyMethods=0,nativeMetadataMethods=0;
 const observed={report:structuredClone(report),target:structuredClone(target)};change(observed);
 const loss=Promise.withResolvers();
 const forbidden=async()=>{bodyMethods++;throw new StorageFailure('replay_body_forbidden');};
 let channel;
 if(executable){
  shared=new SharedWechatClient(()=>loadSharedNarrowWechatOptions(executable));channel=createWechatHistoryChannel(executable,undefined,shared);
  const inspect=channel.inspect.bind(channel),currentTarget=channel.target.bind(channel);
  channel.inspect=async(scope,signal)=>{nativeMetadataMethods++;const current=await inspect(scope,signal);
   for(const key of ['accountKey','conversationKey','sourceGeneration','schemaFingerprint'])assert.ok(current[key]===report[key],'反例注入前当前原生元数据应与正向控制一致');
   const changed={report:structuredClone(current),target:structuredClone(target)};change(changed);return changed.report;};
  channel.target=async(scope,signal)=>{nativeMetadataMethods++;const current=await currentTarget(scope,signal);assert.equal(historyTargetTransition(target,current,false),'same','只改变本反例指定维度');
   const changed={report:structuredClone(report),target:structuredClone(current)};change(changed);return changed.target;};
  // 只测试inspect/target门禁，避免可选续读捷径先读取锚点；不改报告的任何真实能力。
  channel.resumeTarget=undefined;channel.recoverTarget=undefined;channel.page=forbidden;channel.tail=forbidden;
 }else channel={guardSession:{loss:loss.promise},inspect:async()=>structuredClone(observed.report),target:async()=>structuredClone(observed.target),page:forbidden,tail:forbidden,close:async()=>{loss.resolve();}};
 const contacts={ownerId,eligibility:id=>storage.execute('identity.eligibility',{ownerId,contactId:id}),validate:current=>storage.execute('identity.validate',{ownerId,token:current})};
 let code;
 try{history=new SqliteHistoryService(storage,contacts,channel,undefined,undefined,undefined,shared);try{await history.synchronize(contactId);assert.fail('变化的元数据不得同步成功');}catch(error){code=safeCode(error);assert.notEqual(code,'replay_body_forbidden');}}
 finally{await history?.close();await shared?.close();await storage.close();storage=undefined;}
 const after=snapshot(file);assertDataPreserved(before,after);assert.equal(after.messages,before.messages);assert.equal(after.fences,before.fences+1,'每个独立反例均真正新增一位围栏');assert.equal(bodyMethods,0,'反例不得调用正文方法');
 const fenced=blockedContactRows(file).filter(r=>r.owner_id===ownerId&&r.contact_id===contactId);assert.equal(fenced.length,1);
 const result={mode,name,code,nativeReaderUsed:!!executable,nativeMetadataMethods,beforeFences:before.fences,afterFences:after.fences,bindings:after.bindings,messages:after.messages,referenceRowsUnchanged:true,bodyMethods};results.push(result);console.log(JSON.stringify({event:'metadata-counterexample',...result}));
 writeFileSync(join(base.userData,`case-${name}.json`),JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});
 if(args.get('keep-case-copies')==='false'){
  const held=[file,file+'-wal',file+'-shm'].filter(existsSync);try{const pids=execFileSync('lsof',['-t','--',...held],{encoding:'utf8'});assert.equal(pids.trim(),'','已完成反例副本仍有占用');}catch(error){if(error.status!==1)throw error;}
  assert.ok(userData.startsWith(base.userData+'-')&&dirname(userData)===realpathSync('/tmp'));rmSync(userData,{recursive:true});
 }
}
assert.equal(base.unchanged(),true);
console.log(JSON.stringify({event:'metadata-counterexample-summary',mode,positiveMetadataControl:true,passed:results.length,bodyMethods:0,nativeReaderUsed:!!executable,backupUnchanged:true,results}));
