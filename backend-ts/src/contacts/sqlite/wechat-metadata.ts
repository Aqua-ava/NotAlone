import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { NarrowWechatClient, type WechatAccountMetadata } from '../../history/wechat/native-client.ts';
import { loadNarrowWechatOptions } from '../../history/wechat/artifacts.ts';
import type { SharedWechatClient } from '../../history/wechat/shared-client.ts';
import type { AccountEvidence, ContactMetadataPort } from './contracts.ts';

const evidence = (account: WechatAccountMetadata): AccountEvidence => ({externalKey:account.accountKey, identityScheme:account.identityScheme,
  sourceGeneration:account.sourceGeneration, assurance:account.status, supportProfile:account.supportProfile,
  programVersion:account.programVersion, build:account.build,
  ...(account.status === 'unverified' && (account.reason === 'history_program_version_uncertified' || account.reason === 'history_metadata_profile_unverified')
    ? {unverifiedReason: account.reason} : {})});
/** 只认证已配置工具账号的窄元数据支持档，不表示微信前台登录核验或正文资格。 */
export function createWechatContactMetadata(executable?: string, shared?: SharedWechatClient): ContactMetadataPort {
  const owner={}, lifetime=new AbortController(), active=new Set<Promise<unknown>>();
  let pending: Promise<NarrowWechatClient> | undefined, closed = false;
  const client = (): Promise<NarrowWechatClient> => {
    if (closed) return Promise.reject(new StorageFailure('identity_closed'));
    if (!executable) return Promise.reject(new StorageFailure('wechat_tool_unavailable'));
    return pending ??= loadNarrowWechatOptions(executable).then(options => {
      if (closed) throw new StorageFailure('identity_closed');
      return new NarrowWechatClient(options);
    });
  };
  const read = async <T>(operation: (native: NarrowWechatClient, signal?:AbortSignal) => Promise<T>, signal?:AbortSignal): Promise<T> => {
    if(closed)throw new StorageFailure('identity_closed');
    if(shared){
      const combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
      const work=shared.run(owner,native=>operation(native,combined),undefined,combined);
      active.add(work);try{return await work;}finally{active.delete(work);}
    }
    const opening = client();
    try { return await operation(await opening,signal); }
    catch (error) {
      // 本次失败先排空旧读者；只有后续显式调用可以新建，迟到清理不得移除新实例。
      try { await opening.then(native => native.close(), () => {}); }
      finally { if (pending === opening) pending = undefined; }
      throw error;
    }
  };
  return {
    async account(signal) {
      return read(async (native,currentSignal) => evidence(await native.accountMetadata(currentSignal)),signal);
    },
    async sessions(expected, signal) {
      return read(async (native,currentSignal) => {
        const current = await native.accountMetadata(currentSignal);
        if (JSON.stringify(evidence(current)) !== JSON.stringify(expected)) throw new StorageFailure('metadata_identity_conflict');
        if (current.status !== 'verified') throw new StorageFailure('metadata_identity_unverified');
        const report = await native.privateSessionMetadata(current, currentSignal);
        return report.sessions.map(row => ({externalKey:row.username, displayName:row.displayName, kind:row.kind, identityAssurance:row.identityAssurance}));
      },signal);
    },
    async avatarUrl(expected, externalKey, signal) {
      return read(async (native,currentSignal) => {
        const current = await native.accountMetadata(currentSignal);
        if (current.status !== 'verified' || JSON.stringify(evidence(current)) !== JSON.stringify(expected)) throw new StorageFailure('metadata_identity_conflict');
        return (await native.contactAvatarMetadata(current, externalKey, currentSignal)).avatarUrl;
      },signal);
    },
    async close() { closed = true; lifetime.abort();await Promise.allSettled([...active]); const opening = pending; await (await opening?.catch(() => undefined))?.close(); if (pending === opening) pending = undefined; },
  };
}
