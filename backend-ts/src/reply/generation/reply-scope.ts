/** 前台/手动确认的授权由入口核验；每次生成再次核验原库范围与历史覆盖。 */
import type pg from 'pg';
import {ReplyError,type ReplyRequestInput} from './reply-contract.ts';
export interface VerifiedReplyScope {owner_id:string;contact_id:string;conversation_binding_id:string;confirmation:'manual'|'desktop'}
export class ReplyRejected extends ReplyError {
  readonly reason:string;
  constructor(reason:string){super('reply_rejected',409);this.reason=reason;}
}
export async function requireReplyScope(client:pg.Client,scope:VerifiedReplyScope,input:ReplyRequestInput):Promise<void> {
  if(scope.contact_id!==input.contact_id)throw new ReplyRejected('scope_mismatch');
  // 历史行优先；显式逐绑定授权或账号版本1 accepted 下尚未建任务均视为未开始。
  const verified=scope.confirmation==='manual'
    ? 'SELECT 1 FROM public.manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR SHARE'
    : scope.confirmation==='desktop'
      ? "SELECT 1 FROM public.conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='active' FOR SHARE"
      : 'SELECT 1 WHERE false AND $3::uuid IS NULL';
  // 每阶段重新读取资格与历史覆盖并持有原绑定共享锁，只合并本次往返。
  const current=(await client.query(`SELECT
    EXISTS(SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2) AS contact_exists,
    EXISTS(${verified}) AS binding_exists,
    ARRAY(SELECT coalesce(h.phase,'not_started')
    FROM public.conversation_binding b
    LEFT JOIN public.cli_history_sync_state h ON h.owner_id=b.owner_id AND h.contact_id=b.contact_id AND h.binding_id=b.id
    LEFT JOIN public.wechat_binding_history_authorization a ON a.owner_id=b.owner_id AND a.contact_id=b.contact_id AND a.binding_id=b.id
    LEFT JOIN public.wechat_history_sync_authorization g
      ON g.owner_id=b.owner_id AND g.channel=b.channel AND g.account_scope=b.account_scope
    WHERE b.owner_id=$1 AND b.contact_id=$2 AND b.status='active' AND b.channel='wechat'
      AND (h.binding_id IS NOT NULL OR a.version=1 OR (g.version=1 AND g.decision='accepted'))) AS phases`,[scope.owner_id,scope.contact_id,scope.conversation_binding_id])).rows[0];
  if(!current.contact_exists)throw new ReplyRejected('no_active_binding');
  const phases=new Set(current.phases);
  if(phases.has('not_started')||phases.has('syncing'))throw new ReplyRejected('history_sync_pending');
  if(phases.has('incomplete')&&!input.allow_incomplete_history)throw new ReplyRejected('history_incomplete_confirmation_required');
  if(scope.confirmation==='manual') {
    if(!current.binding_exists)throw new ReplyRejected('manual_contact_unconfirmed');
  } else if(scope.confirmation==='desktop') {
    // 此处不从名称推断前台联系人，入口必须已完成真实前台会话核验。
    if(!current.binding_exists)throw new ReplyRejected('no_active_binding');
  } else throw new ReplyRejected('invalid_verification');
}
