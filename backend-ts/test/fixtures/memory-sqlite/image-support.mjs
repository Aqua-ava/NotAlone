import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {fixture} from '../../media-support.mjs';
import {modelPort} from './support.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {ExtractionModelError} from '../../../src/memory/extraction/model.ts';
import {createBuiltinMemoryContentRegistry} from '../../../src/memory/content/builtins.ts';

const png=await sharp({create:{width:1200,height:1600,channels:3,background:'#aadd88'}}).png().toBuffer();
const adapter={version:'synthetic-image-recovery-v1',supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-image-recovery-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image-recovery'}};
}};

export async function imageFixture(t,count,fail){
 const f=await fixture(t,adapter);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:count-1},(_,i)=>({partition:'a',table:'one',localId:String(10+i),serverId:'0',sender:'contact',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);
 const messages=(await f.history.read(f.contact)).messages.filter(message=>message.kind==='image');
 const files=new Map();for(const message of messages){const saved=await f.media.extract(f.contact,message.id,{requestKey:`synthetic-recovery-${message.id}`,goal:'extract'});files.set(message.id,saved.files[0].fileId);}
 let service;const requests=[],receipts=new Map();
 const accounting=()=>({...service.accounting,reserve:async(receipt,claim)=>{receipts.set(receipt.attempt_id,receipt);return service.accounting.reserve(receipt,claim);}});
 const model=modelPort(accounting,async(request,input)=>{
  requests.push(request);
  if(fail(request)){
   const receipt={...receipts.get(input.attemptId),outcome:'failed',terminal_failure:'transport',latency_ms:1};
   await input.onReceipt(receipt);await service.accounting.recordReserved(receipt);
   throw new ExtractionModelError('extraction_model_call_failed',receipt,{name:'LlmError',code:'TRANSPORT',transport_category:'socket_closed',stage:'awaiting_response',elapsed_ms:1,request_bytes:100,image_count:request.images?.length??0});
  }
  return {blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};
 });
 service=new SqliteMemoryExtraction(f.storage,f.owner,model,f.media.holders,undefined,undefined,undefined,{registry:createBuiltinMemoryContentRegistry(),resources:{readImage:input=>f.media.readMemoryImage(input)}});
 t.after(()=>service.close());return {...f,service,requests,messages,files};
}
