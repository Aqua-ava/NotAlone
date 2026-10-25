/** 测试专用网络边界：产品仍用正式launcher与provider，仅将官方URL导向本机。 */
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
export async function syntheticProvider(t,handle){
 const requests=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);await handle(body,res);
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const originalSpawn=cp.spawn;
 cp.spawn=function(command,args,options){return originalSpawn.call(this,command,args?.some(arg=>arg.endsWith('/@deepseek-ai/dsh/lib/bin.js'))?['--import',new URL('./main-host-reply-chain-preload.mjs',import.meta.url).pathname,...args]:args,options);};syncBuiltinESMExports();
 t.after(async()=>{cp.spawn=originalSpawn;syncBuiltinESMExports();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {requests,url:`http://127.0.0.1:${server.address().port}`};
}
export function actualEvidenceId(body){
 let id;const visit=value=>{if(Array.isArray(value))return value.forEach(visit);if(value&&typeof value==='object'){if(Array.isArray(value.evidence))id??=value.evidence.find(item=>item.kind==='user_draft')?.evidence_id;Object.values(value).forEach(visit);}if(typeof value==='string'){try{visit(JSON.parse(value));}catch{const a=value.indexOf('{'),b=value.lastIndexOf('}');if(a>=0&&b>a)try{visit(JSON.parse(value.slice(a,b+1)));}catch{}}}};visit(body);if(!id)throw new Error('合成供应商只能引用实际请求证据');return id;
}
