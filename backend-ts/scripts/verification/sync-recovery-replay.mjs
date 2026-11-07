#!/usr/bin/env node
/** 使用正式同步服务在历史备份副本演练原地恢复、进程重开与自有进程硬中断；仅输出匿名聚合。 */
import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {createWriteStream,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {SharedWechatClient} from '../../src/history/wechat/shared-client.ts';
import {loadSharedNarrowWechatOptions} from '../../src/history/wechat/artifacts.ts';
import {createWechatHistoryChannel} from '../../src/history/sqlite/wechat-channel.ts';
import {SqliteHistoryService} from '../../src/history/sqlite/service.ts';
import {copyBackup,readQuery,snapshot,assertDataPreserved,openReplayStorage,safeCode,verifyReplayArtifact,blockedContactRows} from './sync-replay-support.mjs';

const argumentsMap=new Map(process.argv.slice(2).map(value=>{const at=value.indexOf('=');return [value.slice(2,at<0?undefined:at),at<0?true:value.slice(at+1)];}));
const send=message=>process.send?.(message);
const ownReaderPids=()=>{try{return execFileSync('pgrep',['-P',String(process.pid)],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(Number);}catch(error){if(error.status===1)return [];throw error;}};

async function pass(config) {
 const {userData,executable,inject,hard,limit,expectUnavailable}=config;const transientLimit=config.transientRetries??0,file=join(userData,'managed/sqlite/notalone.sqlite');
 const started=performance.now();let storage,shared,history;
 const result={pass:config.pass,ok:0,failed:0,errorCodes:{},existingFences:0,eligible:0,injected:0,anchors:0,recoveryTables:0,pageRecords:0,oldPageRecords:0};
 try{
  storage=await openReplayStorage(userData);
  const ownerId=readQuery(file,"SELECT owner_id FROM owner WHERE state='active' LIMIT 1")[0].owner_id;
  const existingFenced=new Set(blockedContactRows(file).filter(r=>r.owner_id===ownerId).map(r=>r.contact_id));
  const candidates=readQuery(file,"SELECT id FROM contact WHERE owner_id=? AND state='active' ORDER BY id",[ownerId]);
  const eligible=[];
  for(const row of candidates){try{await storage.execute('identity.eligibility',{ownerId,contactId:row.id});eligible.push(row.id);}catch{/* 撤销或缺少资格者不恢复。 */}}
  result.eligible=eligible.length;result.existingFences=eligible.filter(id=>existingFenced.has(id)).length;
  result.nonEligibleBlocked=snapshot(file).fences-result.existingFences;
  const eligibleSet=new Set(eligible);
  const afterSnapshot=()=>({...snapshot(file),eligibleFences:blockedContactRows(file).filter(r=>r.owner_id===ownerId&&eligibleSet.has(r.contact_id)).length});
  let selected=config.contactIds??eligible;
  if(limit)selected=selected.slice(0,limit);
  result.selected=selected.length;
  if(inject){
   for(const contactId of selected){if(existingFenced.has(contactId))continue;const token=await storage.execute('identity.eligibility',{ownerId,contactId});await storage.execute('history.markContinuityLost',{token});result.injected++;}
  }
  result.before=snapshot(file);
  shared=new SharedWechatClient(()=>loadSharedNarrowWechatOptions(executable));
  const contacts={ownerId,eligibility:contactId=>storage.execute('identity.eligibility',{ownerId,contactId}),validate:token=>storage.execute('identity.validate',{ownerId,token})};
  const positions=new Map();
  result.stageErrors={};
  const create=()=>{
   const channel=createWechatHistoryChannel(executable,undefined,shared);
   for(const name of ['inspect','target','resumeTarget','recoverTarget','page']){if(typeof channel[name]!=='function')continue;const original=channel[name].bind(channel);channel[name]=async(...values)=>{try{return await original(...values);}catch(error){const key=`${name}:${safeCode(error)}`;result.stageErrors[key]=(result.stageErrors[key]??0)+1;throw error;}};}
   const recover=channel.recoverTarget?.bind(channel),page=channel.page.bind(channel),inspect=channel.inspect.bind(channel),target=channel.target.bind(channel);
   if(recover)channel.recoverTarget=async(scope,previous,wanted,signal)=>{
    positions.set(scope.token.contact_id,wanted);result.recoveryTables+=wanted.length;
    const recovered=await recover(scope,previous,wanted,signal);result.anchors+=recovered.anchors.length;
    return recovered;
   };
   channel.inspect=async(scope,signal)=>{const report=await inspect(scope,signal);
    return report;};
   channel.target=target;
   channel.page=async(scope,fixed,cursor,signal,options)=>{
    const response=await page(scope,fixed,cursor,signal,options);result.pageRecords+=response.records.length;
    const wanted=positions.get(scope.token.contact_id);
    if(wanted)for(const record of response.records){const position=wanted.find(p=>p.partition===record.partition&&p.table===record.table);if(position&&record.localId!==null&&BigInt(record.localId)<=BigInt(position.maxLocalId))result.oldPageRecords++;}
    return response;
   };
   return channel;
  };
  history=new SqliteHistoryService(storage,contacts,create,undefined,undefined,undefined,shared);
  send({event:'opened',pass:config.pass,eligible:eligible.length,existingFences:result.existingFences,injected:result.injected});
  result.transientRetries=0;result.transientErrors={};result.retryEvents=[];
  for(const contactId of selected){
   const contactStarted=performance.now();
   for(let attempt=0;attempt<=transientLimit;attempt++){
    const needsBefore=blockedContactRows(file).length;
    try{await history.synchronize(contactId);result.ok++;break;}
    catch(error){
     const code=safeCode(error),temporary=['history_native_unavailable','history_source_unverified'].includes(code);
     if(temporary){
      const needsAfter=blockedContactRows(file).length,delayMs=attempt<transientLimit?Math.min(60_000,1000*2**attempt):0;
      const event={contactPrefix:contactId.slice(0,8),code,attempt:attempt+1,delayMs,needsBefore,needsAfter};
      result.transientErrors[code]=(result.transientErrors[code]??0)+1;if(result.retryEvents.length<200)result.retryEvents.push(event);
      send({event:'transient-failure',pass:config.pass,...event});assert.ok(needsAfter<=needsBefore,'暂不可核验尝试不得新增needs');
      if(attempt<transientLimit){result.transientRetries++;
       // 复现生产coordinator的指数退避；最多四次，真实来源变化码不进入此分支。
       await new Promise(resolve=>setTimeout(resolve,delayMs));continue;}
     }
     result.failed++;result.errorCodes[code]=(result.errorCodes[code]??0)+1;break;
    }
   }
   (result.contactMs??=[]).push(Math.round(performance.now()-contactStarted));
   if(hard){if(expectUnavailable)await shared.run('hard-lifecycle-metadata',native=>native.accountMetadata());result.after=afterSnapshot();result.elapsedMs=Math.round(performance.now()-started);send({event:'hard-ready',result,readerPids:ownReaderPids()});await new Promise(()=>{});}
  }
  const sorted=result.contactMs.sort((a,b)=>a-b);result.contactMs={min:sorted[0]??0,median:sorted[Math.floor(sorted.length/2)]??0,max:sorted.at(-1)??0};
  result.after=afterSnapshot();result.elapsedMs=Math.round(performance.now()-started);
  assertDataPreserved(result.before,result.after);
  assert.equal(result.oldPageRecords,0,'恢复后不整段重读旧正文');
  await history.close();history=undefined;await shared.close();shared=undefined;await storage.close();storage=undefined;
  send({event:'completed',result,contactIds:selected});
 }finally{await history?.close();await shared?.close();await storage?.close();}
}

export function childPass(config) {
 return new Promise((resolve,reject)=>{
  const child=fork(fileURLToPath(import.meta.url),['--child'],{stdio:['ignore','pipe','pipe','ipc'],execArgv:[]});
  const log=createWriteStream(join(config.userData,`pass-${config.pass}.log`),{flags:'wx',mode:0o600});child.stdout.pipe(log);child.stderr.pipe(log);
  let result,hard=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('replay_pass_timeout'));},20*60_000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('message',message=>{
   if(message.event==='opened'||message.event==='transient-failure')console.log(JSON.stringify(message));
   if(message.event==='fatal')result={fatal:message.code};
   if(message.event==='completed'){result=message;writeFileSync(join(config.userData,`pass-${config.pass}.json`),JSON.stringify(message.result)+'\n',{flag:'wx',mode:0o600});}
   if(message.event==='hard-ready'){
    result=message;hard=true;result.result.killedReaderCount=message.readerPids.length;
    for(const pid of message.readerPids){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    child.kill('SIGKILL');
   }
  });
  child.on('exit',(code,signal)=>{clearTimeout(timer);log.end();if(result?.result&&(hard?signal==='SIGKILL':code===0))resolve({...result,hardKilled:hard});else reject(Object.assign(new Error(result?.fatal??'replay_child_failed'),{code:result?.fatal??'replay_child_failed'}));});
  child.send(config);
 });
}

async function main() {
 const backup=argumentsMap.get('backup'),requested=argumentsMap.get('user-data'),executable=verifyReplayArtifact(argumentsMap.get('executable'),argumentsMap.get('artifact-root'));
 const passes=Number(argumentsMap.get('passes')??5),limit=argumentsMap.has('limit')?Number(argumentsMap.get('limit')):undefined;
 assert.ok(Number.isSafeInteger(passes)&&passes>=0);assert.ok(limit===undefined||Number.isSafeInteger(limit)&&limit>0);
 const scenario=argumentsMap.get('expect')??'normal';assert.ok(['normal','unavailable'].includes(scenario));
 const expectUnavailable=scenario==='unavailable',transientRetries=Number(argumentsMap.get('transient-retries')??0);assert.ok(Number.isSafeInteger(transientRetries)&&transientRetries>=0&&transientRetries<=4);
 const copy=copyBackup(backup,requested),before=snapshot(copy.file),results=[];let availabilityBaseline;
 const assertScenario=(result,hard=false)=>{if(!expectUnavailable){assert.equal(result.failed,0,'在线有效范围全部可恢复');assert.equal(result.ok,hard?1:result.selected,'完整在线轮逐位成功，硬中断轮首位成功');assert.equal(result.after.eligibleFences,0,'有效读取范围的来源均恢复');assert.equal(result.after.fences,result.nonEligibleBlocked,'无效范围保留，不能新增有效范围围栏');return;}assert.equal(result.ok,0,'微信未运行时不接受正文');assert.equal(result.pageRecords,0);assert.equal(result.anchors,0);assert.ok(result.failed>0);assert.ok(Object.keys(result.errorCodes).every(code=>['history_source_unverified','history_native_unavailable'].includes(code)),'只允许明确暂不可核验错误');assert.equal(result.after.fences,availabilityBaseline??result.before.fences,'暂不可核验不新增围栏');};
 const initial=await childPass({userData:copy.userData,executable,pass:0,inject:argumentsMap.has('inject')?argumentsMap.get('inject')!=='false':!expectUnavailable,limit,expectUnavailable,transientRetries});results.push(initial.result);availabilityBaseline=initial.result.before.fences;assertScenario(initial.result);
 console.log(JSON.stringify({event:'pass-result',...initial.result}));
 for(let passNo=1;passNo<=passes;passNo++){
  const completed=await childPass({userData:copy.userData,executable,pass:passNo,inject:false,hard:passNo===2,contactIds:initial.contactIds,expectUnavailable,transientRetries});
  console.log(JSON.stringify({event:'pass-attempt',hardKilled:completed.hardKilled,...completed.result}));
  assertScenario(completed.result,completed.hardKilled);
  const previous=results.at(-1).after;assert.ok(completed.result.after.fences<=previous.fences,'重开或硬中断不增加围栏');
  assertDataPreserved(before,completed.result.after);results.push(completed.result);console.log(JSON.stringify({event:'pass-result',hardKilled:completed.hardKilled,...completed.result}));
 }
 const after=snapshot(copy.file);assertDataPreserved(before,after);assert.equal(copy.unchanged(),true,'源备份不变');
 console.log(JSON.stringify({event:'summary',scenario,reopens:passes,hardInterrupts:results.length>2?1:0,before,after,backupUnchanged:copy.unchanged(),results}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(argumentsMap.has('child'))process.once('message',config=>void pass(config).then(()=>process.exit(0)).catch(error=>{send({event:'fatal',code:safeCode(error)});process.exit(1);}));
 else await main();
}
