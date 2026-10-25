/** 公开事件只承载有界刷新提示；权威业务状态继续从 HTTP 重读。 */
import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {stringifyJson} from './host-json.ts';
export class PureTsEvents {
 private closed=false;
 private subscribers=new Set<ServerResponse>();
 private hints=new Map<string,string>();
 private readonly owner:string|undefined;
 constructor(owner:string|undefined){this.owner=owner;}
 publish(type:'message.created'|'sync.status_changed'|'task.progress',contact:string,payload:Record<string,unknown>,occurredAt=new Date().toISOString()){
  if(this.closed||!this.owner)return;
  const id=randomUUID();
  const body=stringifyJson({id,type,owner_id:this.owner,contact_id:contact,occurred_at:occurredAt,payload});
  const encoded=`id: ${id}\nevent: ${type}\ndata: ${body}\n\n`;
  if(type!=='message.created'){
   const key=`${contact}:${type}:${payload.task_id??''}`;this.hints.delete(key);this.hints.set(key,encoded);
   if(this.hints.size>256)this.hints.delete(this.hints.keys().next().value!);
  }
  for(const res of this.subscribers){
   // 慢消费者断连后由桌面重读，不能无限保存敏感事件或静默丢事件。
   if(res.writableLength>256*1024){res.destroy();this.subscribers.delete(res);continue;}
   res.write(encoded);
  }
 }
 open(req:IncomingMessage,res:ServerResponse){
  if(!this.owner){res.writeHead(503,{'Content-Type':'application/json'}).end('{"error":"owner_uninitialized"}');return;}
  if(this.closed){res.writeHead(503,{'Content-Type':'application/json'}).end('{"error":"runtime_stopping"}');return;}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-NotAlone-Event-Replay':'bounded-hints'});
  res.write(': connected\n\n');
  for(const hint of this.hints.values())res.write(hint);
  this.subscribers.add(res);
  const timer=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15_000);timer.unref();
  const close=()=>{clearInterval(timer);this.subscribers.delete(res);req.removeListener('aborted',close);};
  req.once('aborted',close);res.once('close',close);
 }
 forgetTask(task:string){for(const key of this.hints.keys())if(key.endsWith(`:task.progress:${task}`))this.hints.delete(key);}
 forgetContact(contact:string){for(const key of this.hints.keys())if(key.startsWith(`${contact}:`))this.hints.delete(key);}
 clear(){this.hints.clear();}
 close(){this.closed=true;for(const res of this.subscribers)res.end();this.subscribers.clear();this.hints.clear();}
}
