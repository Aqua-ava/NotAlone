import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { NarrowWechatClientOptions } from './native-client.ts';

const manifestLimit = 64 * 1024;
const reject = (): never => { throw new StorageFailure('history_artifact_unverified'); };
async function regular(file: string) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || await realpath(file) !== file) return reject();
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return reject();
  return stat;
}
/** 只读取显式制品旁的固定manifest；版本、补丁与实际制品hash仍由窄客户端复验。 */
async function readNarrowWechatManifest(executable: string): Promise<{options:NarrowWechatClientOptions;originalImageProtocol:unknown;originalImageQualityProof:unknown;quoteProtocol:unknown;quoteReader:unknown;sharedProcessProtocol:unknown}> {
  try {
    if (typeof executable !== 'string') return reject();
    await regular(executable);
    const file = path.join(path.dirname(path.dirname(executable)), 'manifest.json');
    const before = await regular(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageFailure('history_artifact_manifest_missing');
      throw error;
    });
    if (before.size > manifestLimit) return reject();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > manifestLimit) return reject();
      const bytes = Buffer.alloc(manifestLimit + 1); let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat(), current = await regular(file);
      if (length > manifestLimit || length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || current.dev !== opened.dev || current.ino !== opened.ino) return reject();
      const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return reject();
      const row = manifest as Record<string, unknown>;
      if (typeof row.cliSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.cliSha256)
        || typeof row.wcdbSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.wcdbSha256)) return reject();
      const imageKeyChannel=row.originalImageProtocol==='wechat-original-image-v1'&&['wechat-cdn-big-hd-exact-content-v4','wechat-message-image-content-v1','wechat-message-image-content-v2'].includes(row.originalImageQualityProof as string);
      const inlineQuotes=row.quoteProtocol==='wechat-quote-message-v1'&&row.quoteReader==='wechat-quote-normal-tail-v2'&&row.quoteInline==='wechat-quote-inline-sync-v1';
      return {options:{ executable, expectedCliSha256: row.cliSha256, expectedWcdbSha256: row.wcdbSha256,...(imageKeyChannel?{imageKeyChannel:true as const}:{}),...(inlineQuotes?{inlineQuotes:true as const}:{}) },originalImageProtocol:row.originalImageProtocol,originalImageQualityProof:row.originalImageQualityProof,quoteProtocol:row.quoteProtocol,quoteReader:row.quoteReader,sharedProcessProtocol:row.sharedProcessProtocol};
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof StorageFailure && error.code === 'history_artifact_manifest_missing') throw error;
    return reject();
  }
}

export async function loadNarrowWechatOptions(executable:string):Promise<NarrowWechatClientOptions>{
 return (await readNarrowWechatManifest(executable)).options;
}
/** 共享宿主在启动进程前要求明确的切换协议；独立旧读取器仍可用于升级对照。 */
export async function loadSharedNarrowWechatOptions(executable:string):Promise<NarrowWechatClientOptions>{
 const manifest=await readNarrowWechatManifest(executable);
 if(manifest.sharedProcessProtocol!=='wechat-shared-process-v1')return reject();
 return manifest.options;
}
export async function supportsWechatQuotes(executable?:string):Promise<boolean>{
 if(!executable)return false;
 try{const manifest=await readNarrowWechatManifest(executable);return manifest.quoteProtocol==='wechat-quote-message-v1'
  &&manifest.quoteReader==='wechat-quote-normal-tail-v2';}catch{return false;}
}

/** 旧组件继续使用原消息同步能力，不把不支持的新协议误记成某张图片缺失。 */
export async function supportsWechatOriginalImages(executable?:string):Promise<boolean>{
 if(!executable)return false;
 try{const manifest=await readNarrowWechatManifest(executable);return manifest.originalImageProtocol==='wechat-original-image-v1'
  &&['wechat-message-image-content-v1','wechat-message-image-content-v2'].includes(manifest.originalImageQualityProof as string);}
 catch{return false;}
}

/** fd3只为明确支持内存密钥通道的图片制品启用。 */
export async function supportsWechatImageKeyChannel(executable?:string):Promise<boolean>{
 if(!executable)return false;
 try{const manifest=await readNarrowWechatManifest(executable);return manifest.originalImageProtocol==='wechat-original-image-v1'
  &&['wechat-cdn-big-hd-exact-content-v4','wechat-message-image-content-v1','wechat-message-image-content-v2'].includes(manifest.originalImageQualityProof as string);}
 catch{return false;}
}
