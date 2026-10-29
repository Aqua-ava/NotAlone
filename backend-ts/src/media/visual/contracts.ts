import type {MediaAssociationProof, ImageQuality} from '../sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySource} from '../../history/sqlite/contracts.ts';

export type VisualKind = 'image' | 'video';
export interface VisualRequest {
  contactId:string; messageId:string; kind:VisualKind; goal:'extract'|'original_upgrade';
  source:HistorySource; token:ReadEligibility; signal:AbortSignal; checkpoint():Promise<void>;
}
/** 由19认证的只读来源端口持有；不从HTTP、Tool或renderer反序列化。 */
export interface VisualResource {
  association: MediaAssociationProof;
  authority: ReadEligibility;
  envelope: 'plain' | 'wechat_dat';
  expectedBytes: number;
  expectedSha256: string;
  /** 必须是固定资源的完整快照读取；不能由本次读到的长度反推expectedBytes。 */
  complete: true;
  quality: {kind:Exclude<ImageQuality,'not_applicable'>; proof:string|null};
  bytes: AsyncIterable<Uint8Array>;
  /** 受控端口仅在当前账号核验后提供已有密钥；不刷新、不扫描、不搜索兄弟文件。 */
  withImageKey?<T>(consume:(key:{aesKey?:Uint8Array;xorKey?:number})=>T):Promise<T>;
  /** 等待读取及句柄结算；不能仅发取消就返回。 */
  close():Promise<void>;
}
export interface VisualResourcePort {
  /** 先核验当前账号/支持档及唯一映射才打开request指定资源；无法证明则不读字节并抛media_association_unverified。
   * bytes.next与open都必须响应signal；close必须排空同次操作的全部在途读取，不得留下全局缓存。
   */
  open(request:VisualRequest):Promise<VisualResource>;
}
export interface VisualValidation {
  format:string; mimeType:string; containerValid:true; viewable:boolean; playable:boolean;
}
export type VisualValidator=(localPath:string,kind:VisualKind,signal:AbortSignal)=>Promise<VisualValidation>;
