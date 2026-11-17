import {randomUUID} from 'node:crypto';

/** 合成供应商返回真实工具请求；实际加载仍由官方 DSH Tool 和业务 provider 完成。 */
export function modelToolResponse(res,name,input){
 return respond(res,{type:'tool_use',id:randomUUID(),name,input},'tool_use');
}
export function modelTextResponse(res,text){return respond(res,{type:'text',text},'end_turn');}
function respond(res,content,stopReason){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:content},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:stopReason},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');
 res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 return true;
}
