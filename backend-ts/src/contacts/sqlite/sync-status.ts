import {INCREMENTAL_IDENTITY_LIMIT} from '../../history/limits.ts';
import type {SavedContactBinding} from './contracts.ts';

/** 仅投影本次授权目录；覆盖进度由历史模块补充，不触发渠道读取。 */
export function projectContactSyncStatus(directory: {
  read_enabled: boolean;
  bindings: readonly Pick<SavedContactBinding, 'binding_id'|'contact_id'|'status'>[];
}, avatarRevision: string) {
  const active = directory.bindings.filter(binding => binding.status === 'active');
  return {identity_protocol:'sqlite-selected-v1',body_available:false,sync_mode:'cli_background',sync_enabled:directory.read_enabled,sync_scope:'selected',sync_scope_failure_code:null,
    contact_avatar_revision:avatarRevision,cli_available:false,probe_available:false,wechat_in_front:false,cli_sync_phase:directory.read_enabled?'degraded':'disabled',
    foreground_phase:directory.read_enabled?'unavailable':'sync_disabled',cli_failure_code:'wechat_body_unavailable',foreground_failure_code:null,
    cli_bound_count:active.length,
    cli_backfill_phase:'not_required',cli_backfill_failure_code:null,cli_backfill_total_contacts:0,cli_backfill_completed_contacts:0,
    cli_backfill_succeeded_contacts:0,cli_backfill_skipped_contacts:0,cli_backfill_failed_contacts:0,cli_backfill_incomplete_contacts:0,
    cli_backfill_pending_contacts:0,cli_backfill_total_message_count:0,cli_backfill_total_non_text_count:0,
    cli_incremental_identity_limit:INCREMENTAL_IDENTITY_LIMIT,cli_history_coverages:active.map(binding=>({binding_id:binding.binding_id,contact_id:binding.contact_id,phase:'not_started',failure_code:'wechat_body_unavailable',message_count:0,non_text_count:0,page_count:0}))};
}
