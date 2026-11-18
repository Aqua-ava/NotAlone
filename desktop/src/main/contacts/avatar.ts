import type { BackendHost } from '../backend/host';
import type { ContactAvatarData, ContactSelection } from '../../shared/contact-session-bridge';
import type { ContactSession } from './session';
import { isRecord } from '../../shared/record';

const maxAvatarBytes = 256 * 1024;
const unavailable = () => new Error('联系人头像暂不可用。');

export function parseContactAvatar(value: unknown): ContactAvatarData | null {
  if (!isRecord(value) || Object.keys(value).join(',') !== 'avatar') throw unavailable();
  if (value.avatar === null) return null;
  const avatar = value.avatar;
  if (!isRecord(avatar) || Object.keys(avatar).sort().join(',') !== 'base64,mime_type'
    || typeof avatar.base64 !== 'string' || !avatar.base64.length || avatar.base64.length > Math.ceil(maxAvatarBytes / 3) * 4
    || avatar.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(avatar.base64)) throw unavailable();
  const bytes = Buffer.from(avatar.base64, 'base64');
  if (bytes.length > maxAvatarBytes || bytes.toString('base64') !== avatar.base64) throw unavailable();
  const mimeType = avatar.mime_type;
  const valid = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    : mimeType === 'image/webp' ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    : false;
  if (!valid) throw unavailable();
  return { mimeType: mimeType as ContactAvatarData['mimeType'], dataBase64: avatar.base64 };
}

export async function readContactAvatar(backend: BackendHost, contacts: ContactSession, selection: ContactSelection): Promise<ContactAvatarData | null> {
  const generation = backend.getConnectionGeneration();
  const current = () => {
    const state = contacts.getState();
    return generation !== undefined && backend.getConnectionGeneration() === generation
      && state.scopeRevision === selection.scopeRevision && state.directoryPhase === 'ready'
      && state.contacts.some(contact => contact.contactId === selection.contactId);
  };
  if (!current()) throw unavailable();
  // 仅读取本机已同步的头像，不触发微信查询或外网下载。
  const response = await backend.requestJson({ method: 'GET', path: `/api/contacts/${selection.contactId}/avatar`,
    maxResponseBytes: Math.ceil(maxAvatarBytes / 3) * 4 + 1024 });
  if (response.generation !== generation || !current()) throw unavailable();
  return parseContactAvatar(response.data);
}
