import type { ContactSelection } from './contact-session-bridge';

export type MediaGoal = 'extract' | 'original_upgrade' | 'audio_conversion';
export interface MessageMediaSelection extends ContactSelection { messageId: string; }
export interface MediaAttempt {
  attemptId: string; state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'revoked';
  outcome: 'full' | 'limited' | 'quality_unknown' | 'no_result'; errorCode: string | null;
}
export interface MediaFile {
  fileId: string; role: 'image_display' | 'video_playback' | 'audio_source' | 'audio_playback';
  imageQuality: 'original' | 'thumbnail' | 'unknown' | 'not_applicable';
  format: string; mimeType: string; byteSize: string; viewable: boolean; playable: boolean;
}
export interface MediaSnapshot {
  contactId: string; messageId: string; kind: 'image' | 'video' | 'voice';
  state: 'available' | 'active' | 'cleared' | 'invalidated' | 'deleting'; generation: string; headRevision: string;
  latestAttempt: MediaAttempt | null; files: MediaFile[];
  capabilities: { extract: boolean; originalUpgrade: boolean; audioConversion: boolean; reason: string | null };
  cleanup: { operationId: string; state: 'fenced' | 'cleaning' | 'verifying' | 'blocked' | 'completed' } | null;
}
export interface MediaPreview {
  sessionId: string; mimeType: string; dataBase64: string;
}
export interface MessageMediaState {
  revision: number; contactId: string | null; scopeRevision: number; messageId: string | null;
  phase: 'idle' | 'loading' | 'ready' | 'failed'; snapshot: MediaSnapshot | null;
  busy: MediaGoal | 'clear' | 'preview' | null; retryGoal: MediaGoal | null; error: string | null;
}
export interface MessageMediaBridge {
  getState(): Promise<MessageMediaState>;
  inspect(selection: MessageMediaSelection): Promise<void>;
  extract(request: MessageMediaSelection & { goal: MediaGoal }): Promise<void>;
  retry(selection: MessageMediaSelection): Promise<void>;
  clear(selection: MessageMediaSelection): Promise<void>;
  openPreview(request: MessageMediaSelection & { fileId: string }): Promise<MediaPreview>;
  // 页面先停止播放、移除src并释放Blob，再调用此操作作为撤下确认。
  releasePreview(sessionId: string): Promise<void>;
  onStateChanged(listener: (state: MessageMediaState) => void): () => void;
  onPreviewRevoking(listener: (sessionId: string) => void): () => void;
}
