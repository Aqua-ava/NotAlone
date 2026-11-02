import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistorySource } from '../../history/sqlite/contracts.ts';

export interface MediaContactPort {
  readonly ownerId: string;
  eligibility(contactId: string): Promise<ReadEligibility>;
}
export interface MediaSourcePort {source(contactId: string, recordId: string): Promise<HistorySource>}

export type MediaKind = 'image' | 'video' | 'voice';
export type MediaGoal = 'extract' | 'original_upgrade' | 'audio_conversion';
export type MediaRole = 'image_display' | 'video_playback' | 'audio_source' | 'audio_playback';
export type ImageQuality = 'original' | 'thumbnail' | 'unknown' | 'not_applicable';
/** 已认证资源分类的窄依据；不保存路径、URL、XML、密钥或图片正文。 */
export interface ImageQualityEvidence {
  protocol: 'wechat-image-quality-v1';
  quality: 'original' | 'thumbnail' | 'unknown';
  sourceVariant: 'main' | 'thumbnail';
  resourceInfoId: string;
  resources: {resourceId: string; resourceTypeRaw: number}[];
  sourceSha256: string;
  contentSha256: string;
  originalProofDigest: string | null;
}
export type MediaOutcome = 'full' | 'limited' | 'quality_unknown' | 'no_result';
export interface MediaScope { contactId: string; messageId: string }
export interface MediaAttemptView {
  attemptId: string; state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'revoked';
  outcome: MediaOutcome; errorCode: string | null;
}
export interface MediaFileView {
  fileId: string; role: MediaRole; imageQuality: ImageQuality; format: string; mimeType: string;
  byteSize: string; viewable: boolean; playable: boolean;
}
export interface MediaSnapshot extends MediaScope {
  kind: MediaKind; state: 'available' | 'active' | 'cleared' | 'invalidated' | 'deleting';
  generation: string; headRevision: string; requestedAttempt?: MediaAttemptView; latestAttempt: MediaAttemptView | null; files: MediaFileView[];
  capabilities: {extract: boolean; originalUpgrade: boolean; audioConversion: boolean; reason: string | null};
  cleanup: {operationId: string; state: string} | null;
}
/** 窄证明只记录版本化资源身份；不得夹带XML、路径、URL、密钥或媒体字节。 */
export interface MediaAssociationProof {
  protocol: 'media-association-v1'; profileId: string; recordId: string; messageId: string;
  resourceIdentity: string;
}
export interface MediaValidation {
  format: string; mimeType: string; containerValid: true;
  viewable: boolean; playable: boolean; imageQuality: ImageQuality;
  qualityProof: string | null;
  imageQualityEvidence?: ImageQualityEvidence;
}
export interface MediaFileInput {
  role: MediaRole; parentFileId?: string;
  /** 仅新语音的播放件失败可保留本次已验证原件，失败文件仍须统一清理。 */
  failureMode?: 'retain_audio_source';
  expectedBytes: number; expectedSha256: string;
  bytes: AsyncIterable<Uint8Array>;
  /** 类型适配器校验实际落盘文件；完整性由保存服务另行核验。 */
  validate: (localPath: string, signal: AbortSignal) => Promise<MediaValidation>;
}
export interface MediaExecution extends MediaScope {
  goal: MediaGoal; kind: MediaKind; signal: AbortSignal;
  source: HistorySource | null; token: ReadEligibility | null;
  input: {fileId: string; localPath: string; expectedBytes:number; expectedSha256:string} | null;
  /** 每次外部读取/转换分段前后都应调用；服务还在写入和发布时复验。 */
  checkpoint(): Promise<void>;
  /** 外部读者须先登记；释放失败保留同一attempt holder，删除重试仍须实际复核。 */
  retainReader(close:()=>Promise<void>):void;
  save(input: MediaFileInput): Promise<{fileId: string}>;
}
export interface MediaAdapter {
  version: string;
  supports(kind: MediaKind, goal: MediaGoal): boolean;
  /** 仅受信任装配注入；HTTP及renderer不能注入实现、字节或证明。 */
  execute(context: MediaExecution): Promise<{association: MediaAssociationProof | null; errorCode?: string}>;
  close?(): Promise<void>;
}
export interface MediaPreview {sessionId: string; mimeType: string; dataBase64: string}
