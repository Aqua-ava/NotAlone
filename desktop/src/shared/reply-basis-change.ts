export interface ReplyBasisChange {
  evidenceId: string;
  kind: 'confirmed_memory' | 'owner_memory' | 'pending_candidate' | 'reply_skill';
  reason: 'memory_generation_forbidden' | 'memory_revised' | 'memory_expired' | 'memory_not_yet_valid' | 'memory_time_changed' | 'skill_policy_changed';
}
