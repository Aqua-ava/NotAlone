/** 逐绑定授权不可借用展示名；账号快照只作用于当时绑定，运行时纳入另按 ADR-100 追加。 */
import type pg from 'pg';
export interface HistoryScope { ownerId:string; accountScope:string; channel?:string }
const notExcluded = `NOT EXISTS (SELECT 1 FROM public.wechat_sync_exclusion e
  WHERE e.owner_id=b.owner_id AND e.channel=b.channel AND e.account_scope=b.account_scope
  AND e.locator_hash=sha256(convert_to(b.conversation_locator,'UTF8')))`;
export async function grantBindingHistory(client: pg.Client, scope: HistoryScope, bindingIds: readonly string[] | undefined, at: Date): Promise<number> {
  // 明确选择的绑定可重新获得历史授权；账号批量快照不能覆盖自动发现排除。
  const result = await client.query(`INSERT INTO public.wechat_binding_history_authorization(owner_id,contact_id,binding_id,version,authorized_at)
    SELECT b.owner_id,b.contact_id,b.id,1,$4 FROM public.conversation_binding b
    WHERE b.owner_id=$1 AND b.channel=$2 AND b.account_scope=$3 AND b.status='active'
    AND ($5::uuid[] IS NOT NULL OR ${notExcluded})
    AND ($5::uuid[] IS NULL OR b.id=ANY($5::uuid[]))
    ON CONFLICT(owner_id,contact_id,binding_id) DO NOTHING`,[scope.ownerId,scope.channel ?? 'wechat',scope.accountScope,at,bindingIds ?? null]);
  return result.rowCount ?? 0;
}
export async function authorizedHistoryBindings(client: pg.Client, scope: HistoryScope): Promise<string[]> {
  // 快照证明具体绑定已获授权；撤销由 active 门禁生效，排除摘要继续供自动发现使用。
  return (await client.query(`SELECT b.id FROM public.conversation_binding b
    JOIN public.wechat_binding_history_authorization a ON a.owner_id=b.owner_id AND a.contact_id=b.contact_id AND a.binding_id=b.id
    WHERE b.owner_id=$1 AND b.channel=$2 AND b.account_scope=$3 AND a.version=1 AND b.status='active'
    ORDER BY b.id`,[scope.ownerId,scope.channel ?? 'wechat',scope.accountScope])).rows.map(row=>row.id);
}
