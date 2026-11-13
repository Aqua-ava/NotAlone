// 临时桌面验收补丁生成器；不会提交，不接触用户库，不发模型请求。
import {readFile,writeFile,lstat,mkdtemp,rename,rm,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const project=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const target=join(project,'desktop/src/main/memory/fixed-processing.ts');
const require=createRequire(join(project,'desktop/package.json')),{build}=require('esbuild');
const hash=text=>createHash('sha256').update(text).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const args=process.argv.slice(2),command=args.shift()??'check',options={};
for(let index=0;index<args.length;index+=2){if(!['--scope-file','--backup-dir'].includes(args[index])||!args[index+1])throw Error('temporary_ui_arguments_invalid');options[args[index]]=args[index+1];}
function replaceOne(source,anchor,replacement){if(source.split(anchor).length!==2)throw Error('temporary_ui_source_anchor_changed');return source.replace(anchor,replacement);}
async function privateFile(file){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('temporary_ui_private_file_required');return stat;}
async function atomicWrite(text,mode){const temporary=target+'.temporary-image-retry-ui';await writeFile(temporary,text,{flag:'wx',mode});try{await rename(temporary,target);}finally{await rm(temporary,{force:true});}}
function patched(source,scope){
 const fixed=JSON.stringify(scope),marker='  // 临时CUA图片隔离视图：只供显式开发进程与固定样本；必须在验收后还原。';
 const helpers=`${marker}
  private readonly imageRetryUiScope=${fixed};
  private imageRetryUiState:{key:string;done:boolean;operationId?:string}|undefined;
  private imageRetryUiHealth:{key:string;value?:{generation:number;key:string};pending?:Promise<{generation:number;key:string}>}|undefined;
  private imageRetryUiEnabled():boolean{return process.argv.includes('--notalone-dev')&&process.env.NOTALONE_DEV_IMAGE_RETRY_UI==='1';}
  private async imageRetryUiContext():Promise<{generation:number;key:string}|null>{
    if(!this.imageRetryUiEnabled())return null;
    const selected=this.contacts?.getState();if(selected?.selectedContactId!==this.imageRetryUiScope.contactId)return null;
    if(process.env.NOTALONE_BACKGROUND_PROCESSING!=='manual'||process.env.NOTALONE_IMAGE_ACCEPTANCE_CONTACT!==this.imageRetryUiScope.contactId)throw invalid();
    const generation=this.backend.getConnectionGeneration();if(generation===undefined)throw invalid();
    const key=[selected.selectedContactId,selected.scopeRevision,generation].join(':');
    const requireCurrent=()=>{const current=this.contacts!.getState();if(current.selectedContactId!==selected.selectedContactId||current.scopeRevision!==selected.scopeRevision||generation!==this.backend.getConnectionGeneration())throw invalid();};
    let health=this.imageRetryUiHealth;if(!health||health.key!==key){health={key};this.imageRetryUiHealth=health;}const checked=health;
    if(checked.value){requireCurrent();return checked.value;}
    if(!checked.pending)checked.pending=(async()=>{
      const status=await this.request('/api/runtime/status','GET',undefined,generation,'mode');
      const automatic=await this.request('/api/memory-processing/automatic','GET',undefined,generation,'mode');
      const schedule=await this.request('/api/memory-processing/schedule','GET',undefined,generation,'mode');
      const runtime=row(status.data),identity=row(runtime.storageIdentity);
      if(runtime.state!=='running'||runtime.runtime!=='dsh'||runtime.hostRuntime!=='typescript'||runtime.storage!=='sqlite'||runtime.background_processing!=='manual'
        ||identity.ownerId!==this.imageRetryUiScope.ownerId||identity.available!==true||row(automatic.data).enabled!==false||row(schedule.data).acceptanceBudgetBound!==true)throw invalid();
      requireCurrent();if(this.imageRetryUiHealth!==checked)throw invalid();
      if(this.imageRetryUiState?.key!==key)this.imageRetryUiState={key,done:false};
      checked.value={generation,key};return checked.value;
    })();
    try{const result=await checked.pending;requireCurrent();if(this.imageRetryUiHealth!==checked)throw invalid();return result;}
    catch(error){if(this.imageRetryUiHealth===checked)this.imageRetryUiHealth=undefined;throw error;}
    finally{checked.pending=undefined;}
  }
  private imageRetryUiView(context:{generation:number;key:string}):FixedProcessingView{
    if(this.imageRetryUiState?.key!==context.key)throw invalid();const done=this.imageRetryUiState.done;
    const contactId=this.imageRetryUiScope.contactId;
    const run=readFixedProcessingRun({runId:'11111111-1111-4111-8111-111111111111',state:done?'pending':'completed',total:1,succeeded:0,failed:0,unknown:0,
      stage:done?'extraction_verification':'completed',laterStages:done?'pending':'completed',status:done?'waiting':'completed',statusReason:null,sharedFaultCode:null,
      actions:done?[]:['retry_images'],controlVersion:done?1:0,pending:done?1:0,revoked:0,isolated:done?0:1,
      calls:{prepared:0,sending:0,succeeded:0,failed:0,unknown:0},contentCounts:[{kind:'image',total:1,succeeded:0,isolated:done?0:1}],
      tasks:[{taskId:'22222222-2222-4222-8222-222222222222',scopeKind:'contact',contactId,state:done?'pending':'succeeded',total:1,succeeded:0,errorCode:null}],inputs:[],candidates:[]});
    return {connectionGeneration:context.generation,contactId,run,queue:{pending:0,nextDueAt:null,blockedContacts:0,history:{pending:done?1:0},
      content:[{kind:'image',pending:done?1:0,unavailable:0,isolated:done?0:1,unadmitted:0}],later:{pending:0,nextDueAt:null,stage:null}}};
  }
`;
 source=replaceOne(source,'export class FixedMemoryProcessingController {\n','export class FixedMemoryProcessingController {\n'+helpers);
 const read="      const requested = row(input); exact(requested, ['contactId']); const contactId = id(requested.contactId);\n";
 source=replaceOne(source,read,read+"      if(this.imageRetryUiEnabled()&&contactId===this.imageRetryUiScope.contactId){const context=await this.imageRetryUiContext();if(!context)throw invalid();return this.imageRetryUiView(context);}\n");
 const automatic='  async readAutomatic(): Promise<FixedProcessingAutomatic> {\n';
 source=replaceOne(source,automatic,automatic+"    if(this.imageRetryUiEnabled()){const context=await this.imageRetryUiContext();if(context)return {connectionGeneration:context.generation,enabled:true};}\n");
 const set="    const value = this.generation(input, ['enabled', 'connectionGeneration']);\n";
 source=replaceOne(source,set,set+"    if(this.imageRetryUiEnabled())throw invalid();\n");
 for(const anchor of ['  async startHistory(input:FixedProcessingHistoryStart):Promise<FixedProcessingHistoryResult> {\n','  async start(input: FixedProcessingStart): Promise<FixedProcessingView> {\n']){
  source=replaceOne(source,anchor,anchor+'    if(this.imageRetryUiEnabled())throw invalid();\n');
 }
 const control='    const actionVersion = count(value.controlVersion);\n';
 const intercept=`    if(this.imageRetryUiEnabled()&&action!=='retry-images')throw invalid();
    if(this.imageRetryUiEnabled()&&action==='retry-images'){
      const context=await this.imageRetryUiContext(),operationId=id(value.operationId);
      if(!context||context.generation!==value.connectionGeneration||runId!=='11111111-1111-4111-8111-111111111111'||actionVersion!==0)throw invalid();
      if(this.imageRetryUiState!.done&&this.imageRetryUiState!.operationId!==operationId)throw invalid();
      this.imageRetryUiState!.done=true;this.imageRetryUiState!.operationId=operationId;
      return this.imageRetryUiView(context);
    }
`;
 return replaceOne(source,control,control+intercept);
}
async function checkSyntheticController(source){
 const scope={ownerId:'00000000-0000-4000-8000-000000000001',contactId:'00000000-0000-4000-8000-000000000002'};
 const result=await build({stdin:{contents:patched(source,scope),sourcefile:target,loader:'ts',resolveDir:dirname(target)},bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
 const box={exports:{}},sandbox={module:box,exports:box.exports,AbortController,process:{argv:['node','synthetic','--notalone-dev'],env:{NOTALONE_DEV_IMAGE_RETRY_UI:'1',NOTALONE_BACKGROUND_PROCESSING:'manual',NOTALONE_IMAGE_ACCEPTANCE_CONTACT:scope.contactId}}};
 runInNewContext(result.outputFiles[0].text,sandbox);
 let selectedContactId=scope.contactId,scopeRevision=1,generation=1,enabled=false,available=true;const calls=[];
 const backend={getConnectionGeneration:()=>generation,requestJson:async request=>{
  calls.push({path:request.path,method:request.method});assert.equal(request.method,'GET');
  const data=request.path==='/api/runtime/status'?{state:'running',runtime:'dsh',hostRuntime:'typescript',storage:'sqlite',background_processing:'manual',storageIdentity:{ownerId:scope.ownerId,available}}
   :request.path==='/api/memory-processing/automatic'?{enabled}:request.path==='/api/memory-processing/schedule'?{acceptanceBudgetBound:true}:assert.fail('temporary_ui_unexpected_backend_request');
  return {generation,data};
 }};
 const controller=new box.exports.FixedMemoryProcessingController(backend,()=>{}, {getState:()=>({selectedContactId,scopeRevision})});
 const initial=await Promise.all([controller.read({contactId:scope.contactId}),controller.readAutomatic(),controller.read({contactId:scope.contactId})]);
 assert.equal(initial[0].run.isolated,1);assert.equal(initial[1].enabled,true);assert.equal(initial[2].run.isolated,1);assert.equal(enabled,false);
 assert.equal(calls.length,3,'并发首次健康审查只能各读取一次状态、开关和调度');
 await controller.read({contactId:scope.contactId});await controller.readAutomatic();assert.equal(calls.length,3,'同连接和范围的成功审查必须复用');
 await assert.rejects(controller.setAutomatic({connectionGeneration:1,enabled:true}));
 await assert.rejects(controller.start({connectionGeneration:1,requestKey:scope.ownerId}));
 await assert.rejects(controller.startHistory({connectionGeneration:1,contactId:scope.contactId,scopeRevision:1,requestKey:scope.ownerId}));
 const request={connectionGeneration:1,runId:'11111111-1111-4111-8111-111111111111',controlVersion:0,operationId:'00000000-0000-4000-8000-000000000003'};
 const retry=await controller.control('retry-images',request);assert.equal(retry.run.isolated,0);assert.equal(retry.run.pending,1);assert.equal(retry.run.succeeded,0);
 assert.equal((await controller.control('retry-images',request)).run.isolated,0);
 await assert.rejects(controller.control('retry-images',{...request,operationId:'00000000-0000-4000-8000-000000000004'}));
 assert.equal((await controller.read({contactId:scope.contactId})).run.isolated,0);
 await assert.rejects(controller.control('continue',request));
 generation=2;await assert.rejects(controller.control('retry-images',request));
 let before=calls.length;await controller.read({contactId:scope.contactId});assert.equal(calls.length-before,3,'连接变化必须重核');generation=1;
 before=calls.length;await controller.read({contactId:scope.contactId});assert.equal(calls.length-before,3);
 scopeRevision++;before=calls.length;await controller.readAutomatic();assert.equal(calls.length-before,3,'范围变化必须重核');
 selectedContactId=scope.ownerId;scopeRevision++;await assert.rejects(controller.control('retry-images',request));
 selectedContactId=scope.contactId;scopeRevision++;available=false;await assert.rejects(controller.read({contactId:scope.contactId}));available=true;
 before=calls.length;await controller.read({contactId:scope.contactId});assert.equal(calls.length-before,3,'失败审查不得缓存');
 enabled=true;scopeRevision++;await assert.rejects(controller.read({contactId:scope.contactId}));enabled=false;
 before=calls.length;await controller.readAutomatic();assert.equal(calls.length-before,3);
 assert.ok(calls.every(call=>call.method==='GET'));return {readOnlyRequests:calls.length,retryPosts:0,parallelInitialReads:3,cachedSuccess:true,generationRechecked:true,scopeRechecked:true,failureNotCached:true,syntheticAssertions:true};
}
if(command==='restore'){
 const directory=resolve(options['--backup-dir']??''),stat=await lstat(directory);
 if(!basename(directory).startsWith('notalone-image-retry-ui.')||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('temporary_ui_backup_invalid');
 const metaFile=join(directory,'manifest.json'),backupFile=join(directory,'original.ts');await privateFile(metaFile);await privateFile(backupFile);
 const meta=JSON.parse(await readFile(metaFile,'utf8')),original=await readFile(backupFile,'utf8'),current=await readFile(target,'utf8');
 if(meta.target!==target||hash(original)!==meta.before||hash(current)!==meta.after)throw Error('temporary_ui_restore_conflict');
 await atomicWrite(original,meta.mode);await rm(directory,{recursive:true});console.log(JSON.stringify({restored:true,sourceHash:hash(original)}));
}else{
 if(!['check','apply'].includes(command)||!options['--scope-file'])throw Error('temporary_ui_arguments_invalid');
 const scopeFile=resolve(options['--scope-file']);await privateFile(scopeFile);const value=JSON.parse(await readFile(scopeFile,'utf8'));
 if(!uuid(value.ownerId)||!uuid(value.contactId)||value.imageCount!==14)throw Error('temporary_ui_scope_invalid');
 const scope={ownerId:value.ownerId.toLowerCase(),contactId:value.contactId.toLowerCase()},source=await readFile(target,'utf8'),output=patched(source,scope);
 await build({stdin:{contents:output,sourcefile:target,loader:'ts',resolveDir:dirname(target)},bundle:false,write:false,platform:'node',format:'cjs',logLevel:'silent'});
 if(command==='check')console.log(JSON.stringify({syntaxChecked:true,applied:false,sourceHash:hash(source),...await checkSyntheticController(source)}));
 else{
  for(const args of [['diff','--quiet','--',target],['diff','--cached','--quiet','--',target]]){const result=spawnSync('git',args,{cwd:project,stdio:'ignore'});if(result.status!==0)throw Error('temporary_ui_target_has_other_changes');}
  const directory=await mkdtemp(join(tmpdir(),'notalone-image-retry-ui.'));await chmod(directory,0o700);
  const mode=(await lstat(target)).mode&0o777;
  await writeFile(join(directory,'original.ts'),source,{mode:0o600,flag:'wx'});
  await writeFile(join(directory,'manifest.json'),JSON.stringify({target,before:hash(source),after:hash(output),mode}),{mode:0o600,flag:'wx'});
  if(hash(await readFile(target,'utf8'))!==hash(source))throw Error('temporary_ui_target_changed');
  await atomicWrite(output,mode);console.log(JSON.stringify({applied:true,backupDirectory:directory,sourceHash:hash(output)}));
 }
}
