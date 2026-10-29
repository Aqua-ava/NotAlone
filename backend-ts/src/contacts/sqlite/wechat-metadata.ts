import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { WechatSetupProbe } from '../../sync/wechat-setup-probe.ts';
import type { ContactMetadataPort } from './contracts.ts';

/** 当前真实支持档尚未认证来源连续性；status 候选不能升级成身份或正文资格。 */
export function createWechatContactMetadata(executable?: string): ContactMetadataPort {
  const probe = executable ? new WechatSetupProbe({executable}) : undefined;
  return {
    async account(signal) {
      if (!probe) throw new StorageFailure('wechat_tool_unavailable');
      const account = await probe.detect(signal);
      return {externalKey:account, identityScheme:'wechat.account.v1', sourceGeneration:'unverified',
        assurance:'unverified', supportProfile:'wechat-metadata-unverified'};
    },
    async sessions() { throw new StorageFailure('metadata_identity_unverified'); },
    async close() { await probe?.close(); },
  };
}
