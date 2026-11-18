import { pageInvokers, type PageTransport } from './transport';
import type { MessageMediaBridge, MessageMediaSelection } from '../shared/media-bridge';

export function createMessageMediaBridge(transport: PageTransport): MessageMediaBridge {
  const { single } = pageInvokers(transport, '媒体操作不可用。');
  return Object.freeze({
    openHistoryImagePreview: (...args:[MessageMediaSelection & {fileId:string;mimeType:string}]) => single('media:open-history-image-preview',args),
    releasePreview: (...args:[string]) => single('media:release-preview',args),
    onPreviewRevoking: (listener:(sessionId:string)=>void) => {
      if(typeof listener!=='function')throw new Error('媒体操作不可用。');
      const receive=(_event:unknown,sessionId:string)=>listener(sessionId);transport.on('media:preview-revoking',receive);
      return ()=>transport.removeListener('media:preview-revoking',receive);
    },
  });
}
