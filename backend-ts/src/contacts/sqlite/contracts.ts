/** 仅接收渠道适配器的核验证据；HTTP/renderer 无权提供这些字段。 */
export interface AccountEvidence {
  externalKey: string;
  identityScheme: string;
  sourceGeneration: string;
  assurance: 'verified' | 'unverified';
  supportProfile: string;
  /** 仅用于解释未通过的账号检测，不提升身份资格。 */
  unverifiedReason?: 'history_program_version_uncertified' | 'history_metadata_profile_unverified';
}
export interface PrivateSessionMetadata { externalKey: string; displayName: string; kind: string; identityAssurance: 'verified' | 'unverified' }
export interface ContactMetadataPort {
  account(signal?: AbortSignal): Promise<AccountEvidence>;
  sessions(account: AccountEvidence, signal?: AbortSignal): Promise<readonly PrivateSessionMetadata[]>;
  close?(): Promise<void>;
}
export interface ContactSelection {
  locator: string;
  observed_display_name: string;
  contact_id?: string;
  expected_selection_generation: string;
}
export interface ReadEligibility {
  owner_id: string; contact_id: string; account_id: string; conversation_id: string;
  binding_id: string; grant_id: string; verification_id: string;
  read_epoch: string; selection_generation: string; data_generation: string;
  identity_generation: string; scope_revision: string; barrier_generation: string;
  source_generation: string;
}
export interface SavedContactBinding {
  binding_id: string; contact_id: string; account_id: string; conversation_locator: string;
  display_name: string; status: 'active' | 'revoked'; selection_generation: string;
  grant_id: string | null;
}
