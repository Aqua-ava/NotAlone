import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import type { MessageMediaSelection } from '../../shared/media-bridge';
import { MessageMediaController } from './controller';

function historyImageSelection(args:unknown[]):MessageMediaSelection&{fileId:string;mimeType:string} {
  const value=args[0];
  if(args.length!==1 || !value || typeof value!=='object' || Array.isArray(value))throw new Error('媒体操作不可用。');
  const input=value as Record<string,unknown>,keys=['contactId','messageId','scopeRevision','fileId','mimeType'];
  if(Object.keys(input).length!==keys.length || Object.keys(input).some(k=>!keys.includes(k)) || !isUuid(input.contactId) || !isUuid(input.messageId)
    || !Number.isSafeInteger(input.scopeRevision) || (input.scopeRevision as number)<0 || !isUuid(input.fileId)
    || !['image/png','image/jpeg','image/gif','image/bmp'].includes(input.mimeType as string))throw new Error('媒体操作不可用。');
  return {contactId:input.contactId.toLowerCase(),messageId:input.messageId.toLowerCase(),scopeRevision:input.scopeRevision as number,
    fileId:input.fileId.toLowerCase(),mimeType:input.mimeType as string};
}
export function installMessageMediaBridge(commands:PageCommands,backend:BackendHost,contacts:ContactSession):MessageMediaController {
  const media=new MessageMediaController(backend,contacts),roles=['manager','helper'] as const;
  media.onPreviewRevoking(sessionId=>commands.publish('media:preview-revoking',sessionId));
  commands.handle('media:open-history-image-preview',(...args:unknown[])=>media.openHistoryImagePreview(historyImageSelection(args)),roles);
  commands.handle('media:release-preview',(...args:unknown[])=>{
    if(args.length!==1 || !isUuid(args[0]))throw new Error('媒体预览不可用。');return media.releasePreview(args[0].toLowerCase());
  },roles);
  return media;
}
