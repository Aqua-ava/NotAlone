import {INCREMENTAL_IDENTITY_LIMIT} from '../../history/limits.ts';
import type {SavedContactBinding} from './contracts.ts';

/** 同步报告共用的授权事实和能力未核验时的状态。 */
export function projectContactSyncBase(enabled:boolean,boundCount:number,avatarRevision:string) {
  return {identity_protocol:'sqlite-selected-v1',sync_mode:'cli_background',sync_enabled:enabled,sync_scope:'selected',sync_scope_failure_code:null,
    contact_avatar_revision:avatarRevision,cli_available:false,probe_available:false,wechat_in_front:false,cli_sync_phase:enabled?'degraded':'disabled',
    foreground_phase:enabled?'unavailable':'sync_disabled',cli_failure_code:'wechat_body_unavailable',foreground_failure_code:null,
    cli_bound_count:boundCount};
}

/** 只提供联系人能力的宿主和授权写入回执仅读取名单。 */
export function projectContactSyncStatus(directory: {
  read_enabled: boolean;
  bindings: readonly Pick<SavedContactBinding, 'binding_id'|'contact_id'|'status'>[];
}, avatarRevision: string) {
  const active = directory.bindings.filter(binding => binding.status === 'active');
  return {...projectContactSyncBase(directory.read_enabled,active.length,avatarRevision),body_available:false,
    cli_backfill_phase:'not_required',cli_backfill_failure_code:null,cli_backfill_total_contacts:0,cli_backfill_completed_contacts:0,
    cli_backfill_succeeded_contacts:0,cli_backfill_skipped_contacts:0,cli_backfill_failed_contacts:0,cli_backfill_incomplete_contacts:0,
    cli_backfill_pending_contacts:0,cli_backfill_total_message_count:0,cli_backfill_total_non_text_count:0,
    cli_incremental_identity_limit:INCREMENTAL_IDENTITY_LIMIT,cli_history_coverages:active.map(binding=>({binding_id:binding.binding_id,contact_id:binding.contact_id,phase:'not_started',failure_code:'wechat_body_unavailable',message_count:0,non_text_count:0,page_count:0}))};
}
