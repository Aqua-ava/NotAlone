/** 首连历史同意覆盖当次完整元数据快照；后续运行时新绑定由范围入口按 ADR-100 授权。 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { HostStorageError } from './host-storage.ts';
import { grantBindingHistory } from './sync-scope-history.ts';
export interface HistorySession { username:string; display_name:string; chat_type:string }
export async function enrollHistorySnapshot(client:pg.Client, ownerId:string, accountScope:string,
  sessions:readonly HistorySession[] | undefined, at:Date, check:()=>void):Promise<void> {
  if (!Array.isArray(sessions) || sessions.length > 5000) throw new HostStorageError('setup_request_invalid');
  const seen = new Set<string>();
  for (const row of sessions) {
    if (!row || typeof row.username !== 'string' || !row.username.trim() || row.username.length > 255
      || typeof row.display_name !== 'string' || row.display_name.length > 4096 || typeof row.chat_type !== 'string'
      || seen.has(row.username)) throw new HostStorageError('setup_request_invalid');
    seen.add(row.username);
  }
  const existing = (await client.query("SELECT id,contact_id,conversation_locator,status FROM public.conversation_binding WHERE owner_id=$1 AND channel='wechat' AND account_scope=$2",[ownerId,accountScope])).rows;
  const excluded = new Set((await client.query("SELECT encode(locator_hash,'hex') AS hash FROM public.wechat_sync_exclusion WHERE owner_id=$1 AND channel='wechat' AND account_scope=$2",[ownerId,accountScope])).rows.map(row=>row.hash));
  const identities = (await client.query("SELECT external_id,contact_id,status FROM public.channel_identity WHERE owner_id=$1 AND channel='wechat' AND external_id=ANY($2)",[ownerId,[...seen]])).rows;
  const ids:string[]=[];
  const started=performance.now();
  for (const session of sessions) {
    check();
    if (performance.now()-started > 10_000) throw new HostStorageError('wechat_history_snapshot_budget');
    if (session.chat_type !== 'private' || excluded.has(createHash('sha256').update(session.username).digest('hex'))) continue;
    const bindings=existing.filter(row=>row.conversation_locator===session.username);
    const matches=identities.filter(row=>row.external_id===session.username);
    const active=new Set<string>(matches.filter(row=>row.status==='active').map(row=>row.contact_id));
    if (active.size>1 || bindings.filter(row=>row.status==='active').length>1) throw new HostStorageError('wechat_identity_conflict');
    if (bindings.some(row=>row.status!=='active') || matches.length && !active.size) continue;
    const bound=bindings[0];
    if (bound) {
      if (active.size && !active.has(bound.contact_id)) throw new HostStorageError('wechat_identity_conflict');
      ids.push(bound.id); continue;
    }
    const name=session.display_name || session.username;
    const contact=active.size ? [...active][0] : (await client.query('INSERT INTO public.contact(owner_id,display_name) VALUES($1,$2) RETURNING id',[ownerId,name])).rows[0].id;
    const id=(await client.query("INSERT INTO public.conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,display_name) VALUES($1,$2,'wechat',$3,$4,$5) RETURNING id",[ownerId,contact,accountScope,session.username,name])).rows[0].id;
    await client.query('INSERT INTO public.wechat_observation_baseline(owner_id,contact_id,binding_id,conversation_locator,baseline_at) VALUES($1,$2,$3,$4,$5)',[ownerId,contact,id,session.username,at]);
    ids.push(id);
  }
  await grantBindingHistory(client,{ownerId,accountScope},ids,at);
  check();
}
