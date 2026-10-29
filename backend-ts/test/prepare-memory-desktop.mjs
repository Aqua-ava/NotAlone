/** 仅准备独立合成资料及环回供应商；实际桌面仍从 pnpm run dev 启动。 */
import {createServer} from 'node:http';
import {watch} from 'node:fs';
import {readFile,writeFile,access,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';
import {positiveSupplier} from './fixtures/sqlite-memory-profile-supplier.mjs';

const modes=new Set(['positive','no_new','protocol_failed','unknown']);
function stream(res,body,output,protocolFailure=false){
 const events=[{type:'message_start',message:{id:'synthetic-desktop-extraction',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:protocolFailure?{type:'text',text:''}:{type:'tool_use',id:'synthetic-desktop-tool',name:'DirectMemoryExtractionOutput',input:{}}},
  {type:'content_block_delta',index:0,delta:protocolFailure?{type:'text_delta',text:'合成协议不完整返回'}:{type:'input_json_delta',partial_json:JSON.stringify(output)}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:protocolFailure?'end_turn':'tool_use'},usage:{output_tokens:7}},{type:'message_stop'}];
 res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
async function control(file){
 const value=JSON.parse(await readFile(file,'utf8'));
 if(Object.keys(value).sort().join(',')!=='hold,mode'||!modes.has(value.mode)||typeof value.hold!=='boolean')throw Error('synthetic_desktop_control_invalid');
 return value;
}
function released(file,res){
 return new Promise((resolveValue,reject)=>{
  let ended=false,running=false,dirty=false;
  const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);watcher.close();res.off('close',closed);error?reject(error):resolveValue(value);};
  const closed=()=>finish(Error('synthetic_desktop_response_closed'));
  const load=async()=>{if(ended)return;if(running){dirty=true;return;}running=true;try{const value=await control(file);if(!value.hold)finish(null,value);}catch(error){finish(error);}finally{running=false;if(dirty&&!ended){dirty=false;void load();}}};
  const watcher=watch(file,()=>{void load();});const timer=setTimeout(()=>finish(Error('synthetic_desktop_hold_expired')),30000);
  res.once('close',closed);void load();
 });
}

export async function prepareMemoryDesktop({mode='positive',hold=false}={}){
 if(!modes.has(mode)||typeof hold!=='boolean')throw Error('synthetic_desktop_mode_invalid');
 const cleanups=[];const f=await fixture({after:cleanup=>cleanups.push(cleanup)});let provider;
 try{
  const contactIds=f.saved.map(binding=>binding.contact_id);
  f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[
   record('1',{text:scope.token.contact_id===contactIds[0]?'我长期住在高雄。':'我长期住在台南。'}),
   record('2',{sender:'owner',text:scope.token.contact_id===contactIds[0]?'我长期偏好绿茶。':'我长期偏好红茶。'}),
  ],completedPartitions:['shard-a'],exhausted:true});
  for(const contactId of contactIds)await f.service.synchronize(contactId);
  await f.contacts.setReading(false);const databaseId=f.storage.status.databaseId;
  await f.service.close();await f.contacts.close();await f.storage.close();
  const root=f.root,envFilePath=join(root,'synthetic.env'),infoPath=join(root,'managed/sqlite-backend.info');
  const auditPath=join(root,'synthetic-network.jsonl'),receiptPath=join(root,'synthetic-desktop-receipts.jsonl'),modeFile=join(root,'synthetic-supplier-control.json');
  for(const [file,value] of [[envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n'],[auditPath,''],[receiptPath,''],[modeFile,JSON.stringify({mode,hold})]])await writeFile(file,value,{mode:0o600,flag:'wx'});
  const positive=positiveSupplier();const counts={requests:0,noNew:0,protocolFailed:0,unknown:0,errors:0};
  provider=createServer(async(req,res)=>{
   try{
    counts.requests++;let choice=await control(modeFile);if(choice.hold)choice=await released(modeFile,res);
    if(!['/anthropic/v1/messages','/beta/chat/completions'].includes(req.url))throw Error('synthetic_desktop_path_invalid');
    const key=req.headers['x-api-key'],authorization=req.headers.authorization;
    if(!((key==='synthetic-only'&&authorization===undefined)||(authorization==='Bearer synthetic-only'&&key===undefined)))throw Error('synthetic_desktop_auth_invalid');
    if(choice.mode==='positive'){await positive.handler(req,res);return;}
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
    if(choice.mode==='unknown'){counts.unknown++;res.destroy();return;}
    if(req.url!=='/anthropic/v1/messages')throw Error('synthetic_desktop_unexpected_verification');
    if(choice.mode==='no_new'){counts.noNew++;stream(res,body,{scenes:[]});return;}
    counts.protocolFailed++;stream(res,body,null,true);
   }catch{counts.errors++;if(!res.destroyed){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic_desktop_supplier_failed'}));}}
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const projectDirectory=await realpath(fileURLToPath(new URL('../../',import.meta.url)));
  const plan={formatVersion:1,role:'test',userData:root,databaseId,projectDirectory,envFilePath,infoPath,providerUrl:`http://127.0.0.1:${provider.address().port}`,auditPath,receiptPath};
  const planPath=join(root,'synthetic-desktop-plan.json');
  await writeFile(planPath,JSON.stringify(plan),{mode:0o600,flag:'wx'});
  await writeFile(join(root,'sqlite-development.json'),JSON.stringify({formatVersion:1,intent:'open',role:'test',expectedDatabaseId:databaseId,capabilities:['contacts','history','memory']}),{mode:0o600,flag:'wx'});
  await writeFile(join(root,'backend-launch.json'),JSON.stringify({projectDirectory,envFilePath,backendInfoPath:infoPath}),{mode:0o600,flag:'wx'});
  const close=async()=>{provider.closeAllConnections();await new Promise(done=>provider.close(done));};
  const cleanup=async()=>{
   await access(root);
   for(const file of [infoPath,infoPath+'.dsh-lock']){
    try{await access(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    throw Error('synthetic_desktop_host_must_close_before_cleanup');
   }
   await close();for(const cleanup of cleanups.reverse())await cleanup();
  };
  return {root,planPath,modeFile,counts,positive,close,cleanup};
 }catch(error){if(provider){provider.closeAllConnections();await new Promise(done=>provider.close(done));}await f.service.close();await f.contacts.close();for(const cleanup of cleanups.reverse())await cleanup();throw error;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const f=await prepareMemoryDesktop({mode:process.argv[2]||'positive',hold:process.argv[3]==='hold'});
 console.log(JSON.stringify({synthetic:true,userData:f.root,planPath:f.planPath,modeFile:f.modeFile,reading:false}));
 let closing;
 const close=()=>{closing??=f.close().then(()=>console.log(JSON.stringify({supplierStopped:true,counts:f.counts,positiveCalls:f.positive.windows.length+f.positive.verifications.length,positiveErrors:f.positive.errors.length})));return closing;};
 process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
}
