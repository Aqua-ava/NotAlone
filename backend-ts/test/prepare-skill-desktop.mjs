/** 独立合成开发验收：只准备本轮资料与环回供应商，不启动App、不接触微信。 */
import {createServer} from 'node:http';
import {once} from 'node:events';
import {access,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fixture,record,owner} from './fixtures/memory-sqlite/support.mjs';
import {TestSkillLibrary} from './fixtures/sqlite-skills/test-library.mjs';

const modes=new Set(['skill','resource','none','readfail']);
const skillDocument='---\nname: gentle\ndescription: 用于温和回应合成对话，先回应感受再说明本意\n---\n先回应感受。\n保持本次表达方向。\n需要补充例子时查看 references/guide.md。\n';
const resourceText='合成辅助说明：用一句话说明愿意倾听，然后清楚表达自己的安排。';
function stream(res,body,{tool,args,text}){
 const id=randomUUID(),events=[
  {type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:'synthetic-'+id,name:tool,input:{}}:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:8}},
  {type:'message_stop'},
 ];
 res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
export async function prepareSkillDesktop({mode='resource'}={}){
 if(!modes.has(mode))throw Error('synthetic_skill_mode_invalid');
 const cleanups=[],f=await fixture({after:cleanup=>cleanups.push(cleanup)}),root=f.root,contactIds=f.saved.map(item=>item.contact_id);
 const skillRoot=join(root,'user-skills'),skillPath=join(skillRoot,'gentle/SKILL.md');
 await mkdir(join(skillRoot,'gentle/references'),{recursive:true,mode:0o700});
 await writeFile(skillPath,skillDocument,{mode:0o600});await writeFile(join(skillRoot,'gentle/references/guide.md'),resourceText,{mode:0o600});
 const library=new TestSkillLibrary(f.storage,owner,skillRoot);let skill=await library.discover('gentle');skill=await library.setEnabled(skill.id,skill.headRevision,'enabled');
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:scope.token.contact_id===contactIds[0]?'我最近想找你聊聊，这周末有空吗？':'我周末准备休息，我们下次再约。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of contactIds)await f.service.synchronize(contactId);
 await f.contacts.setReading(false);const databaseId=f.storage.status.databaseId;
 await f.service.close();await f.contacts.close();await f.storage.close();
 const projectDirectory=await realpath(fileURLToPath(new URL('../../',import.meta.url))),envFilePath=join(root,'synthetic.env'),infoPath=join(root,'managed/sqlite-backend.info');
 const auditPath=join(root,'synthetic-network.jsonl'),receiptPath=join(root,'synthetic-desktop-receipts.jsonl'),modeFile=join(root,'synthetic-skill-mode.json'),requestsFile=join(root,'synthetic-skill-requests.jsonl');
 for(const [file,value] of [[envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n'],[auditPath,''],[receiptPath,''],[requestsFile,''],[modeFile,JSON.stringify({mode})]])await writeFile(file,value,{mode:0o600,flag:'wx'});
 const counts={requests:0,skill:0,resource:0,final:0,readfail:0,errors:0},errors=[];
 const readMode=async()=>{const value=JSON.parse(await readFile(modeFile,'utf8'));if(Object.keys(value).join(',')!=='mode'||!modes.has(value.mode))throw Error('synthetic_skill_mode_invalid');return value.mode;};
 const supplier=createServer(async(req,res)=>{
  try{
   let raw='';for await(const bytes of req)raw+=bytes;
   if(req.url==='/synthetic-mode'&&req.method==='POST'){
    const value=JSON.parse(raw);if(Object.keys(value).join(',')!=='mode'||!modes.has(value.mode))throw Error('synthetic_skill_mode_invalid');
    await writeFile(modeFile,JSON.stringify(value));if(value.mode!=='readfail')await writeFile(skillPath,skillDocument,{mode:0o600});
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));return;
   }
   if(req.url!=='/anthropic/v1/messages'||req.method!=='POST'||req.headers['x-api-key']!=='synthetic-only')throw Error('synthetic_skill_supplier_request_invalid');
   const body=JSON.parse(raw),choice=await readMode();counts.requests++;
   await writeFile(requestsFile,JSON.stringify({mode:choice,body})+'\n',{flag:'a'});
   const available=new Set((body.tools??[]).map(tool=>tool.name)),last=body.messages?.at(-1),blocks=Array.isArray(last?.content)?last.content:[],results=blocks.filter(block=>block.type==='tool_result');
   const previousCalls=(body.messages??[]).flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(block=>block.type==='tool_use');
   const lastCall=previousCalls.at(-1)?.name;
   if(choice!=='none'&&available.has('skill')&&results.length===0){
    if(choice==='readfail'){await rm(skillPath);counts.readfail++;}
    counts.skill++;stream(res,body,{tool:'skill',args:{name:'gentle'}});return;
   }
   if(choice==='resource'&&available.has('skill_resource')&&results.length&&lastCall==='skill'){
    counts.resource++;stream(res,body,{tool:'skill_resource',args:{name:'gentle',path:'references/guide.md'}});return;
   }
   counts.final++;
   const text=choice==='resource'?'合成资源候选：我愿意听你说，也想先确认一下周末安排。':choice==='none'?'合成普通候选：可以呀，我们先约一个方便的时间。':choice==='readfail'?'合成降级候选：我看到你的消息了，我们找个合适的时间聊聊。':'合成策略候选：听起来你想找人聊聊，我愿意听。';
   stream(res,body,{text:JSON.stringify({candidates:[{parts:[text],basis:[1]}]})});
  }catch(error){counts.errors++;errors.push(error.message);if(!res.destroyed){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic_skill_supplier_failed'}));}}
 });
 supplier.listen(0,'127.0.0.1');await once(supplier,'listening');
 const plan={formatVersion:1,role:'test',userData:root,databaseId,projectDirectory,envFilePath,infoPath,providerUrl:`http://127.0.0.1:${supplier.address().port}`,auditPath,receiptPath},planPath=join(root,'synthetic-desktop-plan.json');
 await writeFile(planPath,JSON.stringify(plan),{mode:0o600,flag:'wx'});
 await writeFile(join(root,'sqlite-development.json'),JSON.stringify({formatVersion:1,intent:'open',role:'test',expectedDatabaseId:databaseId,capabilities:['contacts','skills','history','discussions','memory'],skillPackageRoot:skillRoot}),{mode:0o600,flag:'wx'});
 await writeFile(join(root,'backend-launch.json'),JSON.stringify({projectDirectory,envFilePath,backendInfoPath:infoPath,wechatCliPath:join(root,'unavailable-cli'),syncProbePath:join(root,'unavailable-probe')}),{mode:0o600,flag:'wx'});
 const close=async()=>{supplier.closeAllConnections();await new Promise(done=>supplier.close(done));};
 const cleanup=async()=>{for(const file of [infoPath,infoPath+'.dsh-lock']){try{await access(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}throw Error('synthetic_desktop_host_must_close_before_cleanup');}await close();for(const cleanup of cleanups.reverse())await cleanup();};
 return {root,planPath,modeFile,requestsFile,providerUrl:plan.providerUrl,contactIds,skillId:skill.id,counts,errors,close,cleanup};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const f=await prepareSkillDesktop({mode:process.argv[2]??'resource'});
 console.log(JSON.stringify({synthetic:true,userData:f.root,planPath:f.planPath,modeFile:f.modeFile,requestsFile:f.requestsFile,providerUrl:f.providerUrl,contactIds:f.contactIds,skillId:f.skillId,reading:false}));
 let closing;const close=()=>closing??=f.close().then(()=>console.log(JSON.stringify({supplierStopped:true,counts:f.counts,errors:f.errors})));
 process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
}
