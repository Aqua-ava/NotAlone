import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySource} from '../../history/sqlite/contracts.ts';
import type {MediaAssociationProof} from '../sqlite/contracts.ts';

/** 渠道适配器提供唯一消息资源；缺少经认证实现时不安装新读取能力。 */
export interface VoiceResourcePort {
  /** 先核验当前账号、支持档与唯一资源；read/bytes/finish响应signal，close等待全部在途读取结算。 */
  read(request: {contactId:string; messageId:string; source:HistorySource; token:ReadEligibility; signal:AbortSignal; checkpoint():Promise<void>}): Promise<VoiceResourceRead>;
}
export interface VoiceResourceRead {
  authority:ReadEligibility;
  /** 固定源快照的独立长度/摘要，不能由返回的部分字节补造。 */
  expectedBytes:number;
  expectedSha256:string;
  bytes:AsyncIterable<Uint8Array>;
  /** 不是仅发取消；须排空此资源句柄及原生读取，失败可重试并保持删除未完成。 */
  close():Promise<void>;
  /** 流结束后，确认同一稳定资源完整读取且唯一关联仍有效。 */
  finish():Promise<{protocol:'voice-complete-read-v1'; complete:true; expectedBytes:number; association:MediaAssociationProof}>;
}
export interface VoiceDecoder {
  decode(silk:Uint8Array, signal:AbortSignal):Promise<Uint8Array>;
  close():Promise<void>;
}
