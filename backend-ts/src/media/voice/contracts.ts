import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySource} from '../../history/sqlite/contracts.ts';
import type {MediaAssociationProof} from '../sqlite/contracts.ts';

/** 渠道适配器提供唯一消息资源；缺少经认证实现时不安装新读取能力。 */
export interface VoiceResourcePort {
  read(request: {contactId:string; messageId:string; source:HistorySource; token:ReadEligibility; signal:AbortSignal}): Promise<VoiceResourceRead>;
}
export interface VoiceResourceRead {
  /** 固定源快照的独立长度/摘要，不能由返回的部分字节补造。 */
  expectedBytes:number;
  expectedSha256:string;
  bytes:AsyncIterable<Uint8Array>;
  /** 流结束后，确认同一稳定资源完整读取且唯一关联仍有效。 */
  finish():Promise<{protocol:'voice-complete-read-v1'; complete:true; expectedBytes:number; association:MediaAssociationProof}>;
}
export interface VoiceDecoder {
  decode(silk:Uint8Array, signal:AbortSignal):Promise<Uint8Array>;
  close():Promise<void>;
}
