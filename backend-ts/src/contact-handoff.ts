/** TS 联系人请求门禁：先拒收及排空，再核验原结构与事务。 */
import { ContactContextError } from './contact-context.ts';
import type { HostStorage } from './host-storage.ts';
export class ContactHandoff {
  private readonly owner = 'typescript';
  private accepting = false;
  private transitioning = false;
  private closed = false;
  private revision = 0;
  private pending = new Set<Promise<void>>();
  private readonly storage: HostStorage;
  private transition: Promise<unknown>|undefined;
  constructor(storage: HostStorage) { this.storage=storage; }
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
  async activate() {
    if(this.closed)throw new ContactContextError('runtime_stopping',503);
    if(this.transitioning)throw new ContactContextError('contact_context_transferring');
    this.transitioning=true;this.accepting=false;this.revision++;
    const operation=this.performActivation();this.transition=operation;
    try { return await operation; }
    finally {this.transitioning=false;this.transition=undefined;}
  }
  private async performActivation() {
    await Promise.all([...this.pending]);
    // 04只有同步事务，没有可领取的后台任务；不修改或重新认领其他功能租约。
    // 取得功能租约和原范围锁，证明投影写事务已退出。
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
    this.accepting=true;
    return this.status();
  }
  async close() {this.closed=true;this.accepting=false;this.revision++;await Promise.allSettled([...(this.transition?[this.transition]:[]),...this.pending]);}
}
