import {Readable} from 'node:stream';
import {positiveSupplier} from '../sqlite-memory-profile-supplier.mjs';

/** 正常DSH模型协议的唯一外部替身，只接受本轮合成资料。 */
export function documentProfileSupplier(){
 const base=positiveSupplier(),documents=[],replies=[],errors=base.errors;let serial=0;
 function respond(res,tool,value){
  const id=`synthetic-document-${++serial}`,events=[{type:'message_start',message:{id,type:'message',role:'assistant',model:'synthetic',content:[],usage:{input_tokens:3,output_tokens:0}}}];
  if(tool){events.push({type:'content_block_start',index:0,content_block:{type:'tool_use',id:`${id}-tool`,name:tool,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(value)}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}});}
  else {events.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:typeof value==='string'?value:'完成'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:7}});}
  events.push({type:'message_stop'});res.setHeader('Content-Type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 }
 const handler=async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;let body;
  try{body=JSON.parse(raw);}catch{res.writeHead(400);res.end();return;}
  const names=(body.tools??[]).map(tool=>tool.name??tool.function?.name);
  const core=names.some(name=>['DirectMemoryExtractionOutput','SourceVerificationOutput','BatchMemoryAdjudicationOutput','BatchMemoryRelationVerificationOutput'].includes(name));
  const document=names.includes('ScenarioVerificationOutput')||names.includes('ProfileVerificationOutput')||names.includes('ProfileProposalComplete')||!core&&names.includes('read')&&names.includes('write')&&names.includes('edit');
  if(!document){
   if(!names.length&&req.url!=='/beta/chat/completions'){
    const text=body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==='text').map(block=>block.text):[message.content??'']).join('\n');
    const match=text.match(/\[(\d+)\] document\n/);if(match){replies.push({text});respond(res,null,JSON.stringify({candidates:[{parts:['结合合成资料的候选。'],basis:[Number(match[1])]}]}));return;}
   }
   const copy=Readable.from([raw]);copy.url=req.url;copy.headers=req.headers;return base.handler(copy,res);
  }
  try{
   const initial=body.messages.find(message=>message.role==='user'),content=Array.isArray(initial.content)?initial.content.find(block=>block.type==='text').text:initial.content,payload=JSON.parse(content);
   const initialCall=body.messages.length===1;let tool=null,value;
   if(names.includes('ScenarioVerificationOutput')){
    tool='ScenarioVerificationOutput';value={results:payload.proposal.scenarios.flatMap((scene,si)=>scene.paragraphs.map((paragraph,pi)=>{const ref=paragraph.references[0],memory=payload.memories.find(m=>m.memory_id===ref.memory_id);return {scenario_index:si,paragraph_index:pi,supported:true,evidence:[{memory_id:ref.memory_id,quote:memory.text}]};}))};
   }else if(names.includes('ProfileVerificationOutput')){
    tool='ProfileVerificationOutput';value={results:payload.proposal.entries.map((entry,entry_index)=>{const ref=entry.references[0],memory=payload.memories.find(m=>m.memory_id===ref.memory_id);return {entry_index,supported:true,evidence:[{memory_id:ref.memory_id,quote:memory.verbatim_text}]};})};
   }else if(names.includes('ProfileProposalComplete')){
    if(initialCall){tool='write';value={path:'profile.md',content:'# 长期背景\n\n'+payload.memories.map(m=>`<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'正式记忆直接记载。',temporal_status:'stable',uncertainty:'',references:[{memory_id:m.memory_id,revision:m.revision}]})} -->\n${m.text}`).join('\n\n')};}
    else {tool='ProfileProposalComplete';value={};}
   }else if(initialCall){
    tool='write';value={path:'synthetic.md',content:`<!-- META ${JSON.stringify({topic_key:'synthetic',title:'合成主题',hint:'本轮合成资料'})} -->\n\n`+payload.memories.map(m=>`${m.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:m.memory_id,revision:m.revision}])} -->`).join('\n\n')};
   }
   documents.push({names,layer:payload.layer??'verify',tool});respond(res,tool,value);
  }catch(error){errors.push(error instanceof Error?error.message:'synthetic_document_supplier_failed');res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic_document_supplier_failed'}));}
 };
 return {...base,handler,documents,replies,errors,base};
}
