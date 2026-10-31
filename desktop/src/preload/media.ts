import type { PageTransport } from './transport';
import type { MediaGoal, MessageMediaBridge, MessageMediaSelection, MessageMediaState } from '../shared/media-bridge';

export function createMessageMediaBridge(transport: PageTransport): MessageMediaBridge {
  const single = (channel: string, args: unknown[]) => args.length === 1 ? transport.invoke(channel,args[0]) : Promise.reject(new Error('媒体操作不可用。'));
  return Object.freeze({
    getState: (...args:unknown[]) => args.length ? Promise.reject(new Error('媒体操作不可用。')) : transport.invoke('media:get-state'),
    inspect: (...args:[MessageMediaSelection]) => single('media:inspect',args),
    extract: (...args:[MessageMediaSelection & {goal:MediaGoal}]) => single('media:extract',args),
    retry: (...args:[MessageMediaSelection]) => single('media:retry',args),
    clear: (...args:[MessageMediaSelection]) => single('media:clear',args),
    openPreview: (...args:[MessageMediaSelection & {fileId:string}]) => single('media:open-preview',args),
    openHistoryImagePreview: (...args:[MessageMediaSelection & {fileId:string;mimeType:string}]) => single('media:open-history-image-preview',args),
    releasePreview: (...args:[string]) => single('media:release-preview',args),
    onStateChanged: (listener:(state:MessageMediaState)=>void) => {
      if(typeof listener!=='function')throw new Error('媒体操作不可用。');
      const receive=(_event:unknown,state:MessageMediaState)=>listener(state);transport.on('media:state-changed',receive);
      return ()=>transport.removeListener('media:state-changed',receive);
    },
    onPreviewRevoking: (listener:(sessionId:string)=>void) => {
      if(typeof listener!=='function')throw new Error('媒体操作不可用。');
      const receive=(_event:unknown,sessionId:string)=>listener(sessionId);transport.on('media:preview-revoking',receive);
      return ()=>transport.removeListener('media:preview-revoking',receive);
    },
  });
}
