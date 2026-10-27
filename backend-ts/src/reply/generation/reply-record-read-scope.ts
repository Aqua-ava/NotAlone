/** 同一client、owner的一次只读复验内去重记录读取；不得跨事务、SDK/存档IO、写入或独立复验。 */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Client} from 'pg';

interface RecordReadScope {client:Client;owner:string;live:boolean;reads:Map<string,Promise<unknown>>}
const scopes=new AsyncLocalStorage<RecordReadScope>();

export async function withReplyRecordReadScope<T>(client:Client,owner:string,work:()=>Promise<T>):Promise<T>{
 const parent=scopes.getStore();parent?.reads.clear();
 const scope:RecordReadScope={client,owner,live:true,reads:new Map()};
 try{return await scopes.run(scope,work);}
 // 独立嵌套入口也是失效边界；恢复外层上下文时不能恢复嵌套前的记录。
 finally{scope.live=false;scope.reads.clear();parent?.reads.clear();}
}

/** 仅缓存显式SQL原始行和UUID数组；调用方每次解析旧JSON，返回副本不污染后续验证。 */
export async function readReplyRecord<T>(client:Client,owner:string,key:string,read:()=>Promise<T>):Promise<T>{
 const scope=scopes.getStore();if(!scope?.live||scope.client!==client||scope.owner!==owner)return read();
 let pending=scope.reads.get(key) as Promise<T>|undefined;
 if(!pending){pending=read();scope.reads.set(key,pending);}
 try{return structuredClone(await pending);}
 catch(error){if(scope.reads.get(key)===pending)scope.reads.delete(key);throw error;}
}
