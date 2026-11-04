import {randomUUID} from 'node:crypto';
const nativeFetch=globalThis.fetch;
const target=process.env.NOTALONE_PRECALL_PROVIDER_URL;
if(!target)throw new Error('NOTALONE_PRECALL_PROVIDER_URL is required');
let calls=0;
globalThis.fetch=async(input,init={})=>{
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 if(!url.startsWith(target))return nativeFetch(input,init);
 let raw='';for await(const part of init.body??[])raw+=typeof part==='string'?part:Buffer.from(part).toString();
 const body=JSON.parse(raw);
 const call={index:++calls,at:performance.now(),bytes:Buffer.byteLength(raw,'utf8'),tools:(body.tools??[]).map(tool=>tool.name),hasSkillCatalog:JSON.stringify(body.messages??[]).includes('available_skills'),hasSkillBody:typeof body.system==='string'&&body.system.includes('<skill_content name="gentle">')};
 process.stdout.write(`PRECALL_MODEL_CALL ${JSON.stringify(call)}\n`);
 const answer=JSON.stringify({candidates:[{parts:['正式 profile 合成候选。'],basis:[1]}]});
 const events=[
  {type:'message_start',message:{id:randomUUID(),model:body.model,usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}},
  {type:'message_stop'},
 ];
 return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{status:200,headers:{'content-type':'text/event-stream'}});
};
