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
  if(!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id])).rowCount)throw new ReplyRejected('no_active_binding');
  // 历史行优先；显式逐绑定授权或账号版本1 accepted 下尚未建任务均视为未开始。
  const rows=await client.query(`SELECT coalesce(h.phase,'not_started') AS phase
    FROM public.conversation_binding b
    LEFT JOIN public.cli_history_sync_state h ON h.owner_id=b.owner_id AND h.contact_id=b.contact_id AND h.binding_id=b.id
    LEFT JOIN public.wechat_binding_history_authorization a ON a.owner_id=b.owner_id AND a.contact_id=b.contact_id AND a.binding_id=b.id
    LEFT JOIN public.wechat_history_sync_authorization g
      ON g.owner_id=b.owner_id AND g.channel=b.channel AND g.account_scope=b.account_scope
    WHERE b.owner_id=$1 AND b.contact_id=$2 AND b.status='active' AND b.channel='wechat'
      AND (h.binding_id IS NOT NULL OR a.version=1 OR (g.version=1 AND g.decision='accepted'))`,[scope.owner_id,scope.contact_id]);
  const phases=new Set(rows.rows.map(r=>r.phase));
  if(phases.has('not_started')||phases.has('syncing'))throw new ReplyRejected('history_sync_pending');
  if(phases.has('incomplete')&&!input.allow_incomplete_history)throw new ReplyRejected('history_incomplete_confirmation_required');
  if(scope.confirmation==='manual') {
    if(!(await client.query('SELECT 1 FROM public.manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR SHARE',[scope.owner_id,scope.contact_id,scope.conversation_binding_id])).rowCount)throw new ReplyRejected('manual_contact_unconfirmed');
  } else if(scope.confirmation==='desktop') {
    // 此处不从名称推断前台联系人，入口必须已完成真实前台会话核验。
    if(!(await client.query(`SELECT 1 FROM public.conversation_binding b WHERE b.owner_id=$1 AND b.contact_id=$2 AND b.id=$3 AND b.status='active' FOR SHARE`,[scope.owner_id,scope.contact_id,scope.conversation_binding_id])).rowCount)throw new ReplyRejected('no_active_binding');
  } else throw new ReplyRejected('invalid_verification');
}
