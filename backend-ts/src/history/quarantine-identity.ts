import { sha256 } from '../platform/sha256.ts';
import type { NarrowWechatClient } from './wechat/native-client.ts';
import { QuarantineVault } from './quarantine-vault.ts';

const failure = () => Object.assign(new Error('identity_unverified'), { code: 'identity_unverified' });

export interface VerifiedQuarantineIdentity {
  identity: 'matched';
  normalHistory: false;
  stateAssurance: 'unverified';
  continuity: 'not_verified_across_restarts';
}

type IdentityClient = Pick<NarrowWechatClient, 'accountMetadata' | 'resolveSelected' | 'close'>;

/** 只比较本机隔离仓身份摘要与当前 metadata；不读取任何隔离记录或消息正文。 */
export async function verifyQuarantineIdentity(client: IdentityClient, root: string): Promise<VerifiedQuarantineIdentity> {
  try {
    const initial = await QuarantineVault.inspect(root);
    const displayName = initial.displayName;
    const account = await client.accountMetadata();
    if (account.status !== 'verified') throw failure();
    const scope = await client.resolveSelected(displayName);
    if (scope.displayName !== displayName || scope.accountKey !== account.accountKey
      || scope.sourceGeneration !== account.sourceGeneration) throw failure();

    const scopeDigest = sha256(JSON.stringify([scope.accountKey, scope.conversationKey, scope.sourceGeneration]));
    const verified = await QuarantineVault.inspect(root, { scopeDigest });
    if (verified.displayName !== displayName) throw failure();
    return { identity: 'matched', normalHistory: false, stateAssurance: 'unverified', continuity: 'not_verified_across_restarts' };
  } catch {
    throw failure();
  } finally {
    try { await client.close(); } catch { throw failure(); }
  }
}
