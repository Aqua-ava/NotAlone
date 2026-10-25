/** 单功能切换：先拒收及排空，再核验原结构/事务，最后只启用一个责任方。 */
import { setTimeout as delay } from 'node:timers/promises';
import { ContactContextError } from './contact-context.ts';
import type { HostStorage } from './host-storage.ts';
import type { LegacyBackend } from './legacy-backend.ts';
type Owner = 'python'|'typescript';
export class ContactHandoff {
  private owner: Owner = 'python';
  private accepting = true;
  private transitioning = false;
  private closed = false;
  private revision = 0;
  private pending = new Set<Promise<void>>();
  private readonly storage: HostStorage;
  private readonly legacy: LegacyBackend|undefined;
  constructor(storage: HostStorage,legacy?: LegacyBackend) {
    this.storage=storage;this.legacy=legacy;
    if(!legacy){this.owner='typescript';this.accepting=false;}
  }
  status() { return {owner:this.owner,state:this.accepting?'running':this.transitioning?'transferring':'stopped',active_requests:this.pending.size,revision:this.revision}; }
  enter() {
    if(!this.accepting)throw new ContactContextError('contact_context_transferring',503);
    const revision=this.revision;
    let resolve!:()=>void;
    const pending=new Promise<void>(done=>{resolve=done;});this.pending.add(pending);
    return {owner:this.owner,assertCurrent:()=>{
      if(!this.accepting || revision!==this.revision)throw new ContactContextError('contact_context_changed');
    },finish:()=>{this.pending.delete(pending);resolve();}};
  }
  async transfer(target: Owner) {
    if(!this.legacy&&target!=='typescript')throw new ContactContextError('contact_context_runtime_unavailable',503);
    if(this.closed)throw new ContactContextError('runtime_stopping',503);
    if(this.transitioning)throw new ContactContextError('contact_context_transferring');
    this.transitioning=true;this.accepting=false;this.revision++;
    try {
      await this.legacy?.control('/api/runtime/contact-context/stop','POST');
      for(let i=0;this.legacy;i++) {
        const status=await this.legacy.control('/api/runtime/contact-context/status','GET');
        if(status.state==='stopped' && status.active_requests===0 && this.pending.size===0)break;
        if(i===100)throw new ContactContextError('contact_context_drain_timeout',503);
        await delay(25);
      }
      await Promise.all([...this.pending]);
      // 04只有同步事务，没有可领取的后台任务；不修改或重新认领其他功能租约。
      // 旧HTTP排空后，取得功能租约和原范围锁证明投影写事务已退出。
      await this.storage.businessTransaction(async client=>{
        const lock=(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('notalone:contact-context-handoff',0)) AS locked")).rows[0];
        if(!lock.locked)throw new ContactContextError('contact_context_lease_busy',503);
        const owner=this.storage.runtimeOwnerId?.toLowerCase();
        if(owner) {
          const contacts=(await client.query('SELECT id FROM public.contact WHERE owner_id=$1 ORDER BY id',[owner])).rows;
          for(const contact of contacts)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contact.id}`]);
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
        }
      });
      if(this.closed)throw new ContactContextError('runtime_stopping',503);
      if(target==='python') {
        const status=await this.legacy!.control('/api/runtime/contact-context/start','POST');
        if(status.state!=='running')throw new ContactContextError('contact_context_resume_failed',503);
      }
      if(this.closed)throw new ContactContextError('runtime_stopping',503);
      this.owner=target;this.accepting=true;
      return this.status();
    } finally {this.transitioning=false;}
  }
  async close() {this.closed=true;this.accepting=false;this.revision++;await Promise.all([...this.pending]);}
}
