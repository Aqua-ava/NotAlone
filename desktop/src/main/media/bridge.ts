import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { noArguments, type PageCommands } from '../page-commands';
import { isUuid } from '../uuid';
import type { MediaGoal, MessageMediaSelection } from '../../shared/media-bridge';
import { MessageMediaController } from './controller';

function selection(args:unknown[],extra?:'goal'|'fileId'):MessageMediaSelection & {goal?:MediaGoal;fileId?:string} {
  const value=args[0];
  if(args.length!==1 || !value || typeof value!=='object' || Array.isArray(value))throw new Error('媒体操作不可用。');
  const input=value as Record<string,unknown>,keys=['contactId','messageId','scopeRevision',...(extra?[extra]:[])];
  if(Object.keys(input).length!==keys.length || Object.keys(input).some(k=>!keys.includes(k)) || !isUuid(input.contactId) || !isUuid(input.messageId)
    || !Number.isSafeInteger(input.scopeRevision) || (input.scopeRevision as number)<0
    || extra==='fileId'&&!isUuid(input.fileId) || extra==='goal'&&!['extract','original_upgrade','audio_conversion'].includes(input.goal as string))throw new Error('媒体操作不可用。');
  return {contactId:input.contactId.toLowerCase(),messageId:input.messageId.toLowerCase(),scopeRevision:input.scopeRevision as number,
    ...(extra==='goal'?{goal:input.goal as MediaGoal}:{}),...(extra==='fileId'?{fileId:(input.fileId as string).toLowerCase()}:{})};
}
export function installMessageMediaBridge(commands:PageCommands,backend:BackendHost,contacts:ContactSession):MessageMediaController {
  const media=new MessageMediaController(backend,contacts),roles=['manager','helper'] as const;
  media.onStateChanged(state=>commands.publish('media:state-changed',state));
  media.onPreviewRevoking(sessionId=>commands.publish('media:preview-revoking',sessionId));
  commands.handle('media:get-state',(...args:unknown[])=>{noArguments(args);return media.getState();},roles);
  commands.handle('media:inspect',(...args:unknown[])=>media.inspect(selection(args)),roles);
  commands.handle('media:extract',(...args:unknown[])=>media.extract(selection(args,'goal') as MessageMediaSelection&{goal:MediaGoal}),roles);
  commands.handle('media:retry',(...args:unknown[])=>media.retry(selection(args)),roles);
  commands.handle('media:clear',(...args:unknown[])=>media.clear(selection(args)),roles);
  commands.handle('media:open-preview',(...args:unknown[])=>media.openPreview(selection(args,'fileId') as MessageMediaSelection&{fileId:string}),roles);
  commands.handle('media:release-preview',(...args:unknown[])=>{
    if(args.length!==1 || !isUuid(args[0]))throw new Error('媒体预览不可用。');return media.releasePreview(args[0].toLowerCase());
  },roles);
  return media;
}
