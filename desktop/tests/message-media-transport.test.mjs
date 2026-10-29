import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { build } from 'esbuild';
const result=await build({entryPoints:['src/main/backend/json-client.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const {JsonClient}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const contact='00000000-0000-4000-8000-000000000001',message='00000000-0000-4000-8000-000000000002',file='00000000-0000-4000-8000-000000000003',requestKey='00000000-0000-4000-8000-000000000004';
const mediaPath=`/api/contacts/${contact}/messages/${message}/media`;
test('媒体清除传递已校验的请求键，预览大响应只对精确具名端口开放',async t=>{
 const calls=[];
 const server=createServer((req,res)=>{calls.push({path:req.url,method:req.method,key:req.headers['idempotency-key']});assert.equal(req.headers.authorization,'Bearer synthetic_media_token');req.resume();
  res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(req.method==='POST'?{dataBase64:'A'.repeat(9*1024*1024)}:{state:'cleared'}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const client=new JsonClient({address:`127.0.0.1:${port}`,port,token:'synthetic_media_token',pid:process.pid});
 t.after(async()=>{client.cancelPending();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 await client.perform({method:'DELETE',path:mediaPath,idempotencyKey:requestKey});assert.equal(calls[0].key,requestKey);
 await assert.rejects(client.perform({method:'DELETE',path:mediaPath,idempotencyKey:'bad\r\nHeader: injected'}));assert.equal(calls.length,1);
 const preview=await client.perform({method:'POST',path:`${mediaPath}/files/${file}/preview`,body:{},maxResponseBytes:45*1024*1024});
 assert.equal(preview.data.dataBase64.length,9*1024*1024);
 for(const change of [{path:'/api/runtime/status'},{method:'GET'},{body:{fileId:file}},{path:`${mediaPath}/files/${file}/preview?extra=1`}]){
  await assert.rejects(client.perform({method:'POST',path:`${mediaPath}/files/${file}/preview`,body:{},maxResponseBytes:45*1024*1024,...change}));
 }
 assert.equal(calls.length,2);
});
test('预览释放固定原认证target，连接换代后只操作原session',async t=>{
 const bundled=await build({stdin:{contents:"export { BackendHost } from './src/main/backend/host';export { RuntimeClient } from './src/main/backend/runtime-client';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {BackendHost,RuntimeClient}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
 const calls=[];const servers=[];
 for(const token of ['synthetic_old','synthetic_new']){
  const server=createServer((req,res)=>{calls.push({token:req.headers.authorization,path:req.url,method:req.method});assert.equal(req.headers.authorization,`Bearer ${token}`);req.resume();res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({state:'revoking'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
 }
 t.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}});
 const target=(index,token)=>{const port=servers[index].address().port;return new RuntimeClient({address:`127.0.0.1:${port}`,port,token,pid:process.pid});};
 const host=new BackendHost('/unused/synthetic-media-preview');host.state={phase:'connected'};host.generation=1;host.target=target(0,'synthetic_old');
 const captured=host.captureMediaPreviewConnection({sessionId:file,connectionGeneration:1});assert.ok(captured);
 assert.equal(host.captureMediaPreviewConnection({sessionId:file,connectionGeneration:2}),undefined);
 assert.equal(host.captureMediaPreviewConnection({sessionId:'../other',connectionGeneration:1}),undefined);
 host.generation=2;host.target=target(1,'synthetic_new');
 assert.equal(await captured.status(),'revoking');await captured.release();
 assert.deepEqual(calls,[{token:'Bearer synthetic_old',path:`/api/media/previews/${file}`,method:'GET'},{token:'Bearer synthetic_old',path:`/api/media/previews/${file}`,method:'DELETE'}]);
});
test('预览打开在途换代先向原target释放，再拒绝晚到字节',{timeout:10000},async t=>{
 const bundled=await build({stdin:{contents:"export { BackendHost } from './src/main/backend/host';export { RuntimeClient } from './src/main/backend/runtime-client';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {BackendHost,RuntimeClient}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
 let response,entered;const ready=new Promise(resolve=>{entered=resolve;}),calls=[];
 const server=createServer((req,res)=>{calls.push({method:req.method,path:req.url});assert.equal(req.headers.authorization,'Bearer synthetic_open');req.resume();if(req.method==='POST'){response=res;entered();}else res.writeHead(200,{'Content-Type':'application/json'}).end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const port=server.address().port,host=new BackendHost('/unused/synthetic-media-open');host.state={phase:'connected'};host.generation=1;host.target=new RuntimeClient({address:`127.0.0.1:${port}`,port,token:'synthetic_open',pid:process.pid});
 const opening=host.openMediaPreview({contactId:contact,messageId:message,fileId:file,connectionGeneration:1}).then(value=>({value}),error=>({error}));await ready;
 host.generation=2;host.target={requestJson:async()=>{throw new Error('new_target_must_not_be_used');}};
 response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({sessionId:requestKey,mimeType:'image/png',dataBase64:'AA=='}));
 const outcome=await opening;assert.equal(outcome.value,undefined);assert.equal(outcome.error.kind,'cancelled');
 assert.deepEqual(calls,[{method:'POST',path:`${mediaPath}/files/${file}/preview`},{method:'DELETE',path:`/api/media/previews/${requestKey}`}]);
});
