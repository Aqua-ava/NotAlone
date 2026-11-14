import type { SavedContactBinding } from './contracts.ts';

type AvatarSyncPort={syncDirectory():Promise<{read_enabled:boolean;bindings:readonly SavedContactBinding[]}>;
 syncAvatar(contactId:string,signal?:AbortSignal):Promise<boolean>};
/** 与会话同步共用启停入口；只处理已授权联系人，不由页面读取触发。 */
export class ContactAvatarSynchronizer {
 private requested=false;
 private closed=false;
 private paused=false;
 private pumping?:Promise<void>;
 private readonly active=new Map<string,{controller:AbortController;done:Promise<void>}>();
 private readonly stopped=new Set<string>();
 private readonly attempted=new Map<string,{key:string;at:number;success:boolean}>();
 private readonly contacts:AvatarSyncPort;
 private readonly now:()=>number;
 constructor(contacts:AvatarSyncPort,now=Date.now){this.contacts=contacts;this.now=now;}
 wake():void{
  if(this.closed)return;
  this.paused=false;this.stopped.clear();this.requested=true;
  this.pumping??=this.pump().catch(()=>{}).finally(()=>{this.pumping=undefined;if(this.requested&&!this.closed)this.wake();});
 }
 private async pump():Promise<void>{
  while(this.requested&&!this.closed){
   this.requested=false;
   const directory=await this.contacts.syncDirectory();
   if(this.closed||!directory.read_enabled)return;
   const jobs=directory.bindings.filter(row=>row.status==='active'&&row.grant_id).filter(row=>{
    const key=JSON.stringify([row.binding_id,row.grant_id,row.selection_generation]);
    const old=this.attempted.get(row.contact_id);
    return !old||old.key!==key||this.now()-old.at>=(old.success?30*60_000:60_000);
   });
   const run=async()=>{
    while(jobs.length&&!this.closed&&!this.paused){
     const binding=jobs.shift()!;if(this.stopped.has(binding.contact_id))continue;
     const key=JSON.stringify([binding.binding_id,binding.grant_id,binding.selection_generation]);
     const controller=new AbortController();
     const done=this.contacts.syncAvatar(binding.contact_id,controller.signal).then(success=>{
      if(!controller.signal.aborted)this.attempted.set(binding.contact_id,{key,at:this.now(),success});
     }).catch(()=>{if(!controller.signal.aborted)this.attempted.set(binding.contact_id,{key,at:this.now(),success:false});})
      .finally(()=>{this.active.delete(binding.contact_id);});
     this.active.set(binding.contact_id,{controller,done});await done;
    }
   };
   await Promise.all([run(),run()]);
  }
 }
 async stop(contactId?:string):Promise<void>{
  if(contactId)this.stopped.add(contactId);else{this.paused=true;this.requested=false;for(const id of this.active.keys())this.stopped.add(id);}
  const current=[...this.active].filter(([id])=>!contactId||id===contactId);
  for(const [,read]of current)read.controller.abort();
  await Promise.allSettled(current.map(([,read])=>read.done));
 }
 async close():Promise<void>{this.closed=true;this.requested=false;await this.stop();await this.pumping;}
}
