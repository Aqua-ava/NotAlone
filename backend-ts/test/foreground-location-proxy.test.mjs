import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {LegacyBackend} from '../src/legacy-backend.ts';

for(const status of [200,503])test(`授权代理下游断连仍等完整上游${status}才确认完成`,async t=>{
 let complete,started;
 const began=new Promise(resolve=>{started=resolve;});
 const upstream=createServer((_req,res)=>{complete=()=>{res.writeHead(status);res.end('{}');};started();});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 // 只注入连接地址；HTTP流、断连和完成处理都运行真实代理实现。
 const legacy=Object.assign(Object.create(LegacyBackend.prototype),{connection:{address:`127.0.0.1:${upstream.address().port}`,token:'synthetic'}});
 let outcome;const ended=new Promise(resolve=>{outcome=resolve;});let settled=false;
 const host=createServer((req,res)=>legacy.proxy(req,res,{settled:()=>{settled=true;outcome('settled');},uncertain:()=>outcome('uncertain')}));
 host.listen(0,'127.0.0.1');await once(host,'listening');
 t.after(()=>{host.closeAllConnections();host.close();upstream.closeAllConnections();upstream.close();});
 const client=request(`http://127.0.0.1:${host.address().port}/synthetic`,{method:'POST'});client.on('error',()=>{});client.end('{}');
 await began;const closed=new Promise(resolve=>client.once('close',resolve));client.destroy();await closed;
 assert.equal(settled,false);complete();assert.equal(await ended,'settled');
});

test('授权代理上游响应中断只能报告未知，不能伪装业务完成',async t=>{
 const upstream=createServer((_req,res)=>{res.writeHead(200,{'Content-Length':'100'});res.write('{}');res.socket.destroy();});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const legacy=Object.assign(Object.create(LegacyBackend.prototype),{connection:{address:`127.0.0.1:${upstream.address().port}`,token:'synthetic'}});
 let outcome;const ended=new Promise(resolve=>{outcome=resolve;});
 const host=createServer((req,res)=>legacy.proxy(req,res,{settled:()=>outcome('settled'),uncertain:()=>outcome('uncertain')}));
 host.listen(0,'127.0.0.1');await once(host,'listening');
 t.after(()=>{host.closeAllConnections();host.close();upstream.closeAllConnections();upstream.close();});
 await fetch(`http://127.0.0.1:${host.address().port}/synthetic`,{method:'POST',body:'{}'});
 assert.equal(await ended,'uncertain');
});
