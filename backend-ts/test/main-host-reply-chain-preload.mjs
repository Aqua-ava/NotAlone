// 测试独有：只把固定官方Messages与strict Beta Chat transport转到本轮loopback；其它连接先拒绝。
import net from 'node:net';
const originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const opts=Array.isArray(args[0])?args[0][0]:args[0],target=typeof opts==='object'?opts:{port:opts,host:args[1]};const path=target.path??(typeof target.port==='string'&&target.port.startsWith('/')?target.port:undefined);if(path){if(path!=='/tmp/.s.PGSQL.5432'&&!/^(?:\/private)?\/tmp\/na-model-[^/]+\/p\.sock$/.test(path))throw Error('synthetic_unix_denied');}else if(target.host!=='127.0.0.1')throw Error('synthetic_network_denied');return Reflect.apply(originalConnect,this,args);};
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 if(url==='https://api.deepseek.com/anthropic/v1/messages')return originalFetch(process.env.NOTALONE_SYNTHETIC_PROVIDER_URL+'/anthropic/v1/messages',init);
 if(url==='https://api.deepseek.com/beta/chat/completions')return originalFetch(process.env.NOTALONE_SYNTHETIC_PROVIDER_URL+'/beta/chat/completions',init);
 if(!url.startsWith('http://127.0.0.1:'))throw Error('synthetic_fetch_denied');return originalFetch(input,init);};
