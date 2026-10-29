/** 测试专用：两个固定官方地址转本轮环回，其余出站及非自有socket全部拒绝。 */
import net from 'node:net';
import {readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const launch=JSON.parse(readFileSync(process.env.NOTALONE_HOST_CONFIG,'utf8'));
const origin=new URL(process.env.NOTALONE_SYNTHETIC_PROVIDER_URL);
if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('synthetic_supplier_origin_invalid');
const audit=resolve(process.env.NOTALONE_SYNTHETIC_NETWORK_AUDIT);
if(audit!==join(launch.sqlite.userData,'synthetic-network.jsonl'))throw Error('synthetic_audit_not_owned');
const identity=createHash('sha256').update(JSON.stringify([resolve(launch.infoPath),resolve(launch.envFilePath)])).digest('hex').slice(0,24);
const socketDirectory=join('/tmp',`na-model-${process.getuid?.()??'local'}-${identity}`),socket=join(socketDirectory,'p.sock');
const originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const first=Array.isArray(args[0])?args[0][0]:args[0],target=typeof first==='object'&&first!==null?first:{port:first,host:args[1]};
 const address=target.path??(typeof target.port==='string'&&target.port.startsWith('/')?target.port:undefined);
 const allowed=address!==undefined?address===socket:(target.host==='127.0.0.1'&&String(target.port)===origin.port);
 if(!allowed){appendFileSync(audit,JSON.stringify({kind:'blocked_network'})+'\n');throw Error('synthetic_profile_network_denied');}
 return Reflect.apply(originalConnect,this,args);
};
const originalFetch=globalThis.fetch;
const official=new Set(['https://api.deepseek.com/anthropic/v1/messages','https://api.deepseek.com/beta/chat/completions']);
globalThis.fetch=(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url);
 const apiKey=request.headers.get('x-api-key'),authorization=request.headers.get('authorization');
 if(!official.has(url.href)||request.method!=='POST'||!((apiKey==='synthetic-only'&&authorization===null)||(authorization==='Bearer synthetic-only'&&apiKey===null))){
  appendFileSync(audit,JSON.stringify({kind:'blocked_fetch'})+'\n');throw Error('synthetic_profile_fetch_denied');
 }
 appendFileSync(audit,JSON.stringify({kind:'redirect',officialPath:url.pathname,syntheticAuthentication:true})+'\n');
 return originalFetch(new Request(new URL(url.pathname,origin),request));
};
