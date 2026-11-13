/** 阶段6合成图验收。默认仅离线；--run 才允许经过正式provider发送，禁止裸HTTP模型调用。 */
import type {Context} from '@deepseek-ai/cordis';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp,mkdir,realpath,rm,stat,readdir,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {parseEnv} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fixture as memoryFixture,record} from '../../../backend-ts/test/fixtures/memory-sqlite/support.mjs';
import {SqliteMediaService} from '../../../backend-ts/src/media/sqlite/service.ts';
import {SqliteMemoryExtraction} from '../../../backend-ts/src/memory/sqlite/service.ts';
import {createBuiltinMemoryContentRegistry} from '../../../backend-ts/src/memory/content/builtins.ts';
import {createSqliteExtractionModelPort} from '../../../backend-ts/src/memory/sqlite/model-port.ts';
import {createSqliteModelRuntime} from '../../../backend-ts/src/host/sqlite-model-runtime.ts';
import {resolveHostReplyConfiguration} from '../../../backend-ts/src/host/host-reply-config.ts';
import {normalizeModelImageInput} from '../../../backend-ts/src/platform/models/image-normalization.ts';
import {ActiveHolders} from '../../../backend-ts/src/storage/sqlite/deletion/holders.ts';
import type {ModelLedgerReceipt} from '../../../backend-ts/src/platform/models/model-ledger-contract.ts';
import {configureDiagnosticLog,diagnosticLog} from '../../../backend-ts/src/diagnostics/unified.ts';

const require=createRequire(new URL('../../../backend-ts/package.json',import.meta.url)),sharp=require('sharp');
const sourceWidth=1280,sourceHeight=1706,targetBytes=2043188;
const expectedLedger='/tmp/notalone-image-reliability-hw9x92j_/budget.sqlite';
const scriptPath=fileURLToPath(import.meta.url),repository=resolve(dirname(scriptPath),'../../..');
const resultPrefix='NOTALONE_SYNTHETIC_RESULT ',progressPrefix='NOTALONE_SYNTHETIC_PROGRESS ';
const report=(value:unknown)=>process.stdout.write(resultPrefix+JSON.stringify(value)+'\n');
const progress=(stage:string)=>process.stdout.write(progressPrefix+JSON.stringify({stage})+'\n');
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');

/** 只导出同次调用的字段数量及范围；原日志、身份、trace/context随临时目录删除。 */
export async function auditSyntheticImageDiagnostics(root:string,expectedCalls:ReadonlySet<string>,expectedImages:ReadonlySet<string>):Promise<Record<string,any>>{
 const rows:Record<string,any>[]=[];
 for(const name of (await readdir(join(root,'logs'))).filter(name=>/^backend-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/.test(name))){
  const path=join(root,'logs',name),entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink()||entry.uid!==process.getuid?.())throw Error('synthetic_diagnostic_file_invalid');
  for(const line of (await readFile(path,'utf8')).split('\n')){
   if(!line)continue;const row=JSON.parse(line);
   if(['processing.model_call','processing.model_image'].includes(row.event)&&expectedCalls.has(row.callId))rows.push(row);
  }
 }
 const calls=rows.filter(row=>row.event==='processing.model_call'),images=rows.filter(row=>row.event==='processing.model_image');
 const fields=['originalBytes','sentBytes','imageCount','requestBytes','failureCategory','durationMs'];
 const range=(list:Record<string,any>[],field:string)=>{const values=list.map(row=>row[field]).filter(value=>typeof value==='number'&&Number.isFinite(value));return {count:values.length,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};};
 const summarize=(list:Record<string,any>[])=>({records:list.length,fields:Object.fromEntries(fields.map(field=>[field,{present:list.filter(row=>Object.hasOwn(row,field)).length,...(field==='failureCategory'?{none:list.filter(row=>row[field]==='none').length}:range(list,field))}])),imageIdPresent:list.filter(row=>typeof row.imageId==='string').length});
 const missingFields=rows.filter(row=>fields.some(field=>!Object.hasOwn(row,field))).length;
 const unsafeFields=['message','cause','body','prompt','context','dataBase64','requestBody','responseBody'];
 const contentFields=rows.filter(row=>unsafeFields.some(field=>Object.hasOwn(row,field))).length;
 const perCallComplete=expectedCalls.size>0&&calls.length===expectedCalls.size&&[...expectedCalls].every(id=>calls.filter(row=>row.callId===id).length===1&&images.filter(row=>row.callId===id).length===calls.find(row=>row.callId===id)?.imageCount);
 const imagesComplete=expectedImages.size>0&&new Set(images.map(row=>row.imageId)).size===expectedImages.size&&images.every(row=>expectedImages.has(row.imageId));
 const valuesValid=rows.every(row=>Number.isSafeInteger(row.originalBytes)&&row.originalBytes>0&&Number.isSafeInteger(row.sentBytes)&&row.sentBytes>0&&row.sentBytes<=2*1024*1024&&Number.isSafeInteger(row.imageCount)&&row.imageCount>=1&&row.imageCount<=8&&Number.isSafeInteger(row.requestBytes)&&row.requestBytes>0&&typeof row.durationMs==='number'&&Number.isFinite(row.durationMs)&&row.durationMs>=0&&row.failureCategory==='none'&&row.stage==='response_received');
 return {passed:perCallComplete&&imagesComplete&&missingFields===0&&contentFields===0&&valuesValid,expectedCalls:expectedCalls.size,expectedImages:expectedImages.size,callSummary:summarize(calls),imageSummary:summarize(images),perCallComplete,imagesComplete,missingFields,contentFields,valuesValid};
}

/** 文件体积由真实像素熵产生；SVG只描述合成橘猫，不以元数据或尾部填充凑字节。 */
async function syntheticImage():Promise<{data:Buffer;noiseLevel:number;idatBytes:number}>{
 const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1706" viewBox="0 0 1280 1706">
 <rect x="130" y="80" width="1020" height="160" rx="36" fill="#fff"/>
 <text x="640" y="182" text-anchor="middle" font-family="sans-serif" font-size="60" fill="#343638">合成橘猫：豆豆</text>
 <path d="M845 1240 C1180 1300 1140 930 1035 1020" stroke="#d98035" stroke-width="120" stroke-linecap="round" fill="none"/>
 <ellipse cx="640" cy="1135" rx="290" ry="350" fill="#ec9a49"/>
 <ellipse cx="640" cy="1180" rx="170" ry="235" fill="#ffd59a"/>
 <path d="M355 690 L385 360 L575 555 M925 690 L895 360 L705 555" fill="#e8903e" stroke="#a95929" stroke-width="18"/>
 <path d="M390 594 L409 426 L513 565 M890 594 L871 426 L767 565" fill="#eea5a0"/>
 <ellipse cx="640" cy="735" rx="320" ry="268" fill="#efa052" stroke="#a95929" stroke-width="15"/>
 <path d="M540 500 L565 585 M640 480 L640 580 M740 500 L715 585" stroke="#b8662b" stroke-width="35" stroke-linecap="round"/>
 <ellipse cx="515" cy="710" rx="42" ry="58" fill="#46654a"/><ellipse cx="765" cy="710" rx="42" ry="58" fill="#46654a"/>
 <ellipse cx="515" cy="710" rx="12" ry="48" fill="#242424"/><ellipse cx="765" cy="710" rx="12" ry="48" fill="#242424"/>
 <path d="M610 796 Q640 776 670 796 L640 828 Z" fill="#c85d65"/>
 <path d="M640 825 Q610 875 570 842 M640 825 Q670 875 710 842" stroke="#794529" stroke-width="12" fill="none"/>
 <path d="M475 815 L255 775 M472 850 L245 855 M805 815 L1025 775 M808 850 L1035 855" stroke="#694631" stroke-width="9"/>
 <ellipse cx="445" cy="1430" rx="110" ry="65" fill="#ec9a49"/><ellipse cx="835" cy="1430" rx="110" ry="65" fill="#ec9a49"/>
 </svg>`);
 const overlay=await sharp(svg).ensureAlpha().raw().toBuffer(),random=Buffer.alloc(sourceWidth*sourceHeight*3);
 let state=0x73a9c641;for(let index=0;index<random.length;index++){state=(Math.imul(state,1664525)+1013904223)>>>0;random[index]=state>>>24;}
 let low=1,high=32,best:{data:Buffer;noiseLevel:number}|undefined;
 for(let iteration=0;iteration<14;iteration++){
  const level=(low+high)/2,pixels=Buffer.alloc(random.length);
  for(let pixel=0;pixel<sourceWidth*sourceHeight;pixel++)for(let channel=0;channel<3;channel++){
   const offset=pixel*3+channel,alpha=overlay[pixel*4+3]/255,noise=Math.round((random[offset]/255*2-1)*level);
   pixels[offset]=Math.round((220+noise)*(1-alpha)+overlay[pixel*4+channel]*alpha);
  }
  const data=await sharp(pixels,{raw:{width:sourceWidth,height:sourceHeight,channels:3}}).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();pixels.fill(0);
  if(!best||Math.abs(data.length-targetBytes)<Math.abs(best.data.length-targetBytes)){best?.data.fill(0);best={data,noiseLevel:level};}else data.fill(0);
  const bytes=best.data.length;
  if(Math.abs(bytes-targetBytes)/targetBytes<=0.005)break;
  // 当前编码长度决定下一步，最优缓冲只用于最终保留。
  const currentBytes=data.length;if(currentBytes<targetBytes)low=level;else high=level;
 }
 random.fill(0);overlay.fill(0);
 if(!best||Math.abs(best.data.length-targetBytes)/targetBytes>0.01)throw Error('synthetic_size_out_of_range');
 let idatBytes=0;for(let at=8;at+12<=best.data.length;){const length=best.data.readUInt32BE(at),kind=best.data.toString('ascii',at+4,at+8);if(kind==='IDAT')idatBytes+=length;at+=12+length;}
 return {...best,idatBytes};
}

export const name='notalone-image-synthetic-acceptance';
export const inject=['llm','appReady'];
export async function apply(ctx:Context):Promise<void>{
 if(process.env.NOTALONE_IMAGE_ACCEPTANCE_CHILD!=='1')throw Error('synthetic_profile_only');
 const diagnosticRoot=process.env.NOTALONE_DIAGNOSTIC_ROOT;if(!diagnosticRoot)throw Error('synthetic_diagnostic_root_required');
 const unified=diagnosticLog()??configureDiagnosticLog(diagnosticRoot,{proc:'backend'}),expectedCalls=new Set<string>(),expectedImages=new Set<string>();
 const mode=process.env.NOTALONE_IMAGE_ACCEPTANCE_MODE,cleanup:(()=>Promise<void>)[]=[];
 let stage='fixture',extraction:SqliteMemoryExtraction|undefined,media:SqliteMediaService|undefined;
 let runtime:Awaited<ReturnType<typeof createSqliteModelRuntime>>|undefined;
 let f:Awaited<ReturnType<typeof memoryFixture>>|undefined,closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  try{await extraction?.close();await media?.close();runtime?.stopAccepting();await runtime?.close();
   await f?.service.close();await f?.contacts.close();for(const callback of cleanup.reverse())await callback();
  }finally{await unified.close();}
 })();
 const ready=ctx.appReady!.onReady(()=>{void (async()=>{
  let summary:Record<string,unknown>;
  try{
   const source=await readFile(process.env.NOTALONE_SYNTHETIC_SOURCE_PATH!);
   const metadata=await sharp(source).metadata();
   if(metadata.width!==sourceWidth||metadata.height!==sourceHeight||Math.abs(source.length-targetBytes)/targetBytes>0.01)throw Error('synthetic_source_invalid');
   f=await memoryFixture({after:(callback:()=>Promise<void>)=>cleanup.push(callback)});
   const contactId=f.saved[0].contact_id,holders=new ActiveHolders();
   f.channel.page=async()=>({target:f!.target.descriptor,cursorIn:null,cursorOut:null,completedPartitions:['shard-a'],exhausted:true,records:[
    record('1',{text:'这是我养的橘猫豆豆，我每天晚上陪它玩。',sentAt:'1735689600000'}),
    record('2',{kind:'image',text:null,originalType:'3',sentAt:'1735689601000'}),
   ]});
   await f.service.synchronize(contactId);
   const messages=(await f.service.read(contactId)).messages,image=messages.find((message:{kind:string})=>message.kind==='image');
   if(!image)throw Error('synthetic_image_missing');
   media=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:f.service,userData:f.root,holders,adapters:[{
    version:'synthetic-cat-acceptance-v1',supports:(kind:string)=>kind==='image',async execute(context:any){
     await context.save({role:'image_display',expectedBytes:source.length,expectedSha256:hash(source),bytes:(async function*(){yield source;})(),
      validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
     return {association:{protocol:'media-association-v1',profileId:'synthetic-cat-acceptance-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-cat-pixels'}};
    },
   }]});
   await media.initialize();const saved=await media.extract(contactId,image.id,{requestKey:'save-synthetic-cat',goal:'extract'});
   if(saved.files.length!==1)throw Error('synthetic_media_save_failed');
   const receipts=new Map<string,ModelLedgerReceipt>();
   const accounting={reserve:async(receipt:ModelLedgerReceipt,claim:any)=>{await extraction!.accounting.reserve(receipt,claim);receipts.set(receipt.attempt_id,receipt);expectedCalls.add(receipt.attempt_id);},
    recordReserved:async(receipt:ModelLedgerReceipt)=>{await extraction!.accounting.recordReserved(receipt);receipts.set(receipt.attempt_id,receipt);},
    unconfirmedRequests:(scope:{owner_id:string;contact_id:string|null})=>extraction!.accounting.unconfirmedRequests!(scope)};
   stage='model_profile';runtime=await createSqliteModelRuntime({ctx,environment:process.env,userData:f.root,businessHome:f.root,
    infoPath:join(f.root,'synthetic-backend.info'),envFilePath:process.env.NOTALONE_SYNTHETIC_ENV_PATH!,accounting});
   if(!runtime.shared)throw Error('synthetic_model_unconfigured');
   if(mode==='run'&&!runtime.shared.provider.diagnosticProblemBudgetBound)throw Error('synthetic_budget_unbound');
   const model=createSqliteExtractionModelPort({ctx,configuration:runtime.configuration,provider:runtime.shared.provider,permit:runtime.shared.permit,
    authorizePurpose:async input=>{if(input.scope.owner_id!==f!.contacts.ownerId||input.scope.contact_id!==contactId)throw Error('synthetic_scope_denied');}});
   extraction=new SqliteMemoryExtraction(f.storage,f.contacts.ownerId,model,holders,undefined,undefined,undefined,
    {registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>media!.readMemoryImage(input)}});
   await extraction.initialize();progress('official_profile_ready');
   if(mode!=='run'){
    summary={passed:true,mode:'profile_check',budgetBound:runtime.shared.provider.diagnosticProblemBudgetBound,physicalCalls:0,
     source:{width:metadata.width,height:metadata.height,format:metadata.format,bytes:source.length},sqliteIntegrity:await f.storage.check()};
   }else{
    stage='extraction';const view=await extraction.startHistory(contactId,randomUUID());
    const runId=view.run?.runId??view.runId;if(typeof runId!=='string')throw Error('synthetic_run_not_started');
    await extraction.waitForIdle(runId);const done=await extraction.read(runId);
    const contactTasks=done.tasks.filter((task:any)=>task.scopeKind==='contact');
    if(contactTasks.length!==1||contactTasks[0].contactId!==contactId||done.inputs.some((input:any)=>input.contactId!==contactId))throw Error('synthetic_scope_violation');
    const trace=await extraction.trace(contactTasks[0].taskId),events=trace.events;
    const imageVersions=events.filter((event:any)=>event.kind==='image_inputs').flatMap((event:any)=>event.payload.images.map((item:any)=>{expectedImages.add(item.id);return {purpose:event.payload.purpose,
     originalBytes:item.originalBytes,bytes:item.bytes,width:item.width,height:item.height,format:item.requestMimeType,tier:item.normalizationTier};}));
    const imageCounts=done.contentCounts.find((item:any)=>item.kind==='image'),unknown=await extraction.accounting.unconfirmedRequests!({owner_id:f.contacts.ownerId,contact_id:contactId});
    const callStates=[...receipts.values()].map(receipt=>({dispatch:receipt.dispatch,outcome:receipt.outcome,requestBytes:receipt.input_budget?.serialized_bytes??0,latencyMs:receipt.latency_ms}));
    const verification={supported:0,uncertain:0,unsupported:0};for(const event of events)if(event.kind==='verification'&&event.payload.result?.verdict in verification)verification[event.payload.result.verdict as keyof typeof verification]++;
    summary={passed:imageCounts?.succeeded===1&&(imageCounts?.isolated??0)===0&&unknown.length===0&&callStates.length>0&&callStates.every(call=>call.outcome==='succeeded'),
     mode:'real_synthetic_acceptance',budgetBound:runtime.shared.provider.diagnosticProblemBudgetBound,source:{width:metadata.width,height:metadata.height,format:metadata.format,bytes:source.length},
     physicalCalls:callStates.length,calls:callStates,sent:imageVersions,processedContactCount:1,run:{state:done.state,total:done.total,succeeded:done.succeeded,isolated:done.isolated??0},
     candidateCount:done.candidates.length,verificationCounts:verification,unknownCalls:unknown.length,sqliteIntegrity:await f.storage.check()};
   }
   source.fill(0);
  }catch(error){
   const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(error.code)?error.code:'synthetic_acceptance_failed';
   summary={passed:false,stage,code};
  }
  try{await close();summary.cleanup='completed';}catch{summary.cleanup='failed';summary.passed=false;}
  if(mode==='run'){
   try{const diagnostics=await auditSyntheticImageDiagnostics(diagnosticRoot,expectedCalls,expectedImages);summary.unifiedDiagnostics={...diagnostics,writerStats:unified.stats()};if(!diagnostics.passed||!unified.stats().available)summary.passed=false;}
   catch{summary.unifiedDiagnostics={passed:false,code:'synthetic_diagnostic_audit_failed'};summary.passed=false;}
  }
  report(summary);
 })();});
 ctx.effect(()=>async()=>{ready();await close();});
}

async function main():Promise<void>{
 const args=new Set(process.argv.slice(2));for(const arg of args)if(!['--offline','--check-profile','--run'].includes(arg))throw Error('synthetic_argument_invalid');
 if(args.size>1)throw Error('synthetic_argument_invalid');
 const mode=args.has('--run')?'run':args.has('--check-profile')?'check-profile':'offline';
 if(mode==='run'){
  if(process.env.NOTALONE_PROBLEM_BUDGET!==expectedLedger||!process.env.NOTALONE_PROBLEM_ROUND)throw Error('synthetic_same_budget_required');
  const entry=await stat(expectedLedger);if(!entry.isFile()||(entry.mode&0o077)!==0)throw Error('synthetic_private_budget_required');
 }
 progress('generating_synthetic_pixels');const source=await syntheticImage(),sourceMeta=await sharp(source.data).metadata();
 const original={id:randomUUID(),mimeType:'image/png' as const,dataBase64:source.data.toString('base64')};
 const primary=await normalizeModelImageInput(original),degraded=await normalizeModelImageInput(primary,{tier:'degraded'});
 const describe=async(image:typeof primary)=>{const data=Buffer.from(image.dataBase64,'base64'),meta=await sharp(data).metadata();return {width:meta.width,height:meta.height,format:meta.format,bytes:data.length};};
 const preparation={source:{width:sourceMeta.width,height:sourceMeta.height,format:sourceMeta.format,bytes:source.data.length,targetBytes,relativeError:Math.abs(source.data.length-targetBytes)/targetBytes,
  idatBytes:source.idatBytes,otherBytes:source.data.length-source.idatBytes,noiseLevel:source.noiseLevel},primary:await describe(primary),degraded:await describe(degraded)};
 if(mode==='offline'){report({passed:true,mode:'offline',physicalCalls:0,...preparation});source.data.fill(0);return;}
 const temporary=await realpath(await mkdtemp(join(tmpdir(),'notalone-synthetic-model-acceptance-')));let child:ReturnType<typeof spawn>|undefined;
 try{
  const sourcePath=join(temporary,'synthetic-cat.png');await writeFile(sourcePath,source.data,{mode:0o600});source.data.fill(0);
  const profile=join(temporary,'profiles/notalone');await mkdir(profile,{recursive:true,mode:0o700});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}),{mode:0o600});
  await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(scriptPath)}\n`,{mode:0o600});
  const envPath=join(repository,'.env'),values=parseEnv(await readFile(envPath,'utf8'));
  const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:temporary,TMPDIR:temporary,DSH_HOME:temporary,DSH_TELEMETRY_DISABLED:'1',
   NOTALONE_IMAGE_ACCEPTANCE_CHILD:'1',NOTALONE_IMAGE_ACCEPTANCE_MODE:mode==='run'?'run':'check',NOTALONE_SYNTHETIC_SOURCE_PATH:sourcePath,
   NOTALONE_SYNTHETIC_ENV_PATH:await realpath(envPath),NOTALONE_DIAGNOSTIC_ROOT:temporary,
   ...(process.env.NOTALONE_PROBLEM_BUDGET?{NOTALONE_PROBLEM_BUDGET:process.env.NOTALONE_PROBLEM_BUDGET,NOTALONE_PROBLEM_ROUND:process.env.NOTALONE_PROBLEM_ROUND}:{})};
  for(const key of ['NOTALONE_DEEPSEEK_API_KEY','NOTALONE_OPENCODE_API_KEY','NOTALONE_DEEPSEEK_BASE_URL','NOTALONE_DEEPSEEK_MODEL','NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS'])if(values[key]!==undefined)environment[key]=values[key];
  if(resolveHostReplyConfiguration(environment).status!=='configured')throw Error('synthetic_model_unconfigured');
  child=spawn(process.execPath,[require.resolve('@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:temporary,env:environment,stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let output='',stderrBytes=0;
  child.stderr!.on('data',chunk=>{stderrBytes+=chunk.length;});
  const result=await new Promise<Record<string,unknown>>((accept,reject)=>{
   const timer=setTimeout(()=>reject(Error('synthetic_profile_timeout')),mode==='run'?15*60_000:90_000);
   child!.stdout!.on('data',chunk=>{output+=chunk.toString();if(output.length>128*1024){clearTimeout(timer);reject(Error('synthetic_profile_output_limit'));return;}
    const lines=output.split('\n');output=lines.pop()??'';
    for(const line of lines)if(line.startsWith(resultPrefix)){clearTimeout(timer);try{accept(JSON.parse(line.slice(resultPrefix.length)));}catch{reject(Error('synthetic_profile_result_invalid'));}}
     else if(line.startsWith(progressPrefix))process.stdout.write(line+'\n');
   });
   child!.once('exit',()=>{clearTimeout(timer);reject(Error('synthetic_profile_exited'));});
   child!.once('error',()=>{clearTimeout(timer);reject(Error('synthetic_profile_start_failed'));});
  });
  child.kill('SIGTERM');let stopTimer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([exited,new Promise<void>(accept=>{stopTimer=setTimeout(()=>{child?.kill('SIGKILL');accept();},5000);})]);if(stopTimer)clearTimeout(stopTimer);
  if(result.unifiedDiagnostics)await writeFile(join(dirname(expectedLedger),'stage6-synthetic-unified-diagnostic-summary.json'),JSON.stringify({observedAt:new Date().toISOString(),...result.unifiedDiagnostics as object},null,2)+'\n',{mode:0o600});
  report({...result,preparation,childStderrBytes:stderrBytes});if(!result.passed)process.exitCode=1;
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise<void>(accept=>setTimeout(()=>{child?.kill('SIGKILL');accept();},5000))]);}
  await rm(temporary,{recursive:true,force:true});
 }
}
if(resolve(process.argv[1]??'')===scriptPath)await main().catch(error=>{
 const code=error instanceof Error&&/^synthetic_[a-z_]{1,80}$/.test(error.message)?error.message:'synthetic_preparation_failed';
 report({passed:false,code});process.exitCode=1;
});
