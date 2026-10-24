// 仅审计本轮进程内传输；业务存储与授权模块保持原件。
import net from 'node:net';import dns from 'node:dns';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const log=process.env.NOTALONE_SYNTHETIC_NETWORK_AUDIT_NODE;
function record(v){if(log)fs.appendFileSync(log,JSON.stringify({pid:process.pid,...v})+'\n');}
const local=v=>typeof v==='string'&&(v.startsWith('/')||['localhost','127.0.0.1','::1','0.0.0.0'].includes(v));
record({type:'guard_load'});
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];const target=typeof a==='object'?(a.path??a.host??'localhost'):typeof a==='string'&&a.startsWith('/')?a:typeof args[1]==='string'?args[1]:'localhost';const permitted=local(target);record({type:permitted?'local_connect':'external_attempt',target});if(!permitted)throw Error('合成验收禁止外网连接');return Reflect.apply(original,this,args);};
const lookup=dns.lookup;dns.lookup=function(host,...args){if(!local(host)){record({type:'external_attempt',target:host,transport:'dns'});throw Error('合成验收禁止外网解析');}return lookup(host,...args);};syncBuiltinESMExports();
