import type { MediaFile, MediaSnapshot, MediaAttempt } from '../../shared/media-bridge.ts';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const decimal = (v: unknown) => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v);
const code = (v: unknown) => v === null || typeof v === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(v);
const fail = (): never => { throw new Error('媒体状态格式无效。'); };
function readAttempt(a:unknown):MediaAttempt {
 if(!record(a)||!id(a.attemptId)||!['pending','running','completed','failed','interrupted','revoked'].includes(a.state as string)||!['full','limited','no_result'].includes(a.outcome as string)||!code(a.errorCode)||(a.state==='completed'?a.outcome==='no_result':a.outcome!=='no_result'))return fail();
 return {attemptId:a.attemptId,state:a.state,outcome:a.outcome,errorCode:a.errorCode} as MediaAttempt;
}
export function readMediaSnapshot(value: unknown, contactId: string, messageId: string): MediaSnapshot {
  if (!record(value) || value.contactId !== contactId || value.messageId !== messageId || !['image','video','voice'].includes(value.kind as string)
    || !['available','active','cleared','invalidated','deleting'].includes(value.state as string) || !decimal(value.generation) || !decimal(value.headRevision)
    || !Array.isArray(value.files) || value.files.length > 4 || !record(value.capabilities)
    || ['extract','audioConversion'].some(k => typeof (value.capabilities as Record<string,unknown>)[k] !== 'boolean') || !code(value.capabilities.reason)) return fail();
  const requestedAttempt=value.requestedAttempt===undefined?undefined:readAttempt(value.requestedAttempt);
  const a = value.latestAttempt;
  if (a !== null && (!record(a) || !id(a.attemptId) || !['pending','running','completed','failed','interrupted','revoked'].includes(a.state as string)
    || !['full','limited','no_result'].includes(a.outcome as string) || !code(a.errorCode)
    || (a.state === 'completed' ? a.outcome === 'no_result' : a.outcome !== 'no_result'))) return fail();
  const files: MediaFile[] = value.files.map(f => {
    if (!record(f) || !id(f.fileId) || !['image_display','video_playback','audio_source','audio_playback'].includes(f.role as string)
      || typeof f.format !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(f.format)
      || typeof f.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(f.mimeType) || !decimal(f.byteSize)
      || typeof f.viewable !== 'boolean' || typeof f.playable !== 'boolean') return fail();
    return {fileId:f.fileId,role:f.role,format:f.format,mimeType:f.mimeType,byteSize:f.byteSize,viewable:f.viewable,playable:f.playable} as MediaFile;
  });
  if (new Set(files.map(f => f.fileId)).size !== files.length || new Set(files.map(f => f.role)).size !== files.length) return fail();
  const c = value.cleanup;
  if (c !== null && (!record(c) || !id(c.operationId) || !['fenced','cleaning','verifying','blocked','completed'].includes(c.state as string))) return fail();
  return {contactId,messageId,...(requestedAttempt?{requestedAttempt}:{}),kind:value.kind,state:value.state,generation:value.generation,headRevision:value.headRevision,
    latestAttempt:a === null ? null : {attemptId:a.attemptId,state:a.state,outcome:a.outcome,errorCode:a.errorCode}, files,
    capabilities:{extract:value.capabilities.extract,audioConversion:value.capabilities.audioConversion,reason:value.capabilities.reason},
    cleanup:c === null ? null : {operationId:c.operationId,state:c.state}} as MediaSnapshot;
}
