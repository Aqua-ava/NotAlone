import type { ContactSelection } from './contact-session-bridge';

export interface MessageMediaSelection extends ContactSelection { messageId: string; }
export interface MediaPreview {
  sessionId: string; mimeType: string; dataBase64: string;
}
/** 聊天图片的只读预览；页面先停止展示、移除 src 并释放 Blob，再调用 releasePreview 作为撤下确认。 */
export interface MessageMediaBridge {
  openHistoryImagePreview(request: MessageMediaSelection & { fileId: string; mimeType: string }): Promise<MediaPreview>;
  releasePreview(sessionId: string): Promise<void>;
  onPreviewRevoking(listener: (sessionId: string) => void): () => void;
}
