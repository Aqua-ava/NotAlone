/** 仅为开发 App 准备自有合成库与环回供应商；不得加载真实配置或资料。 */
import {createServer} from 'node:http';
import {once} from 'node:events';
import {writeFile,access,realpath} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,record} from '../memory-sqlite/support.mjs';
import {documentProfileSupplier} from './profile-supplier.mjs';
const cleanups=[],f=await fixture({after:cleanup=>cleanups.push(cleanup)}),contactIds=f.saved.map(item=>item.contact_id);
f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:scope.token.contact_id===contactIds[0]?'我长期喜欢合成园艺甲。':'我长期喜欢合成烹饪乙。'})],completedPartitions:['shard-a'],exhausted:true});
for(const contactId of contactIds)await f.service.synchronize(contactId);
await f.contacts.setReading(false);
const contacts=[];for(const contactId of contactIds){const message=(await f.service.read(contactId)).messages.find(m=>m.kind==='text');contacts.push({contactId,sourceId:message.sourceRecordIds[0]});}
const databaseId=f.storage.status.databaseId;
await f.service.close();await f.contacts.close();await f.storage.close();
const root=f.root,projectDirectory=await realpath(fileURLToPath(new URL('../../../../',import.meta.url))),envFilePath=join(root,'synthetic.env'),infoPath=join(root,'managed/sqlite-backend.info'),auditPath=join(root,'synthetic-network.jsonl'),receiptPath=join(root,'synthetic-desktop-receipts.jsonl');
for(const [file,value] of [[envFilePath,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only\n'],[auditPath,''],[receiptPath,'']])await writeFile(file,value,{mode:0o600,flag:'wx'});
const supplier=documentProfileSupplier(),hold=process.argv.includes('--hold-scene');let release,held=false;
const gate=new Promise(resolve=>{release=resolve;});
const server=createServer(hold?async(req,res)=>{
 if(req.url==='/synthetic-release'&&req.method==='POST'){release();res.writeHead(204);res.end();return;}
 let raw='';for await(const chunk of req)raw+=chunk;
 let body;try{body=JSON.parse(raw);}catch{res.writeHead(400);res.end();return;}
 if(!held&&raw.includes('合成园艺甲')&&(body.tools??[]).some(tool=>tool.name==='ScenarioVerificationOutput')){
  held=true;await writeFile(join(root,'synthetic-hold.json'),JSON.stringify({stage:'scene_verification'}),{mode:0o600,flag:'wx'});await gate;
 }
 const copy=Readable.from([raw]);copy.url=req.url;copy.headers=req.headers;await supplier.handler(copy,res);
}:supplier.handler);server.listen(0,'127.0.0.1');await once(server,'listening');
const plan={formatVersion:1,role:'test',userData:root,databaseId,projectDirectory,envFilePath,infoPath,providerUrl:`http://127.0.0.1:${server.address().port}`,auditPath,receiptPath},planPath=join(root,'synthetic-desktop-plan.json');
await writeFile(planPath,JSON.stringify(plan),{mode:0o600,flag:'wx'});
await writeFile(join(root,'sqlite-development.json'),JSON.stringify({formatVersion:1,intent:'open',role:'test',expectedDatabaseId:databaseId,capabilities:['contacts','history','memory']}),{mode:0o600,flag:'wx'});
await writeFile(join(root,'backend-launch.json'),JSON.stringify({projectDirectory,envFilePath,backendInfoPath:infoPath}),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({synthetic:true,userData:root,planPath,contacts,reading:false}));
let closing;
async function close(){
 closing??=(async()=>{
  for(const file of [infoPath,infoPath+'.dsh-lock']){try{await access(file);throw Error('synthetic_desktop_host_still_running');}catch(error){if(error.code!=='ENOENT')throw error;}}
  release();server.closeAllConnections();await new Promise(done=>server.close(done));
  console.log(JSON.stringify({supplierStopped:true,documents:supplier.documents.length,errors:supplier.errors.length+supplier.base.errors.length}));
  for(const cleanup of cleanups.reverse())await cleanup();
 })();return closing;
}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
