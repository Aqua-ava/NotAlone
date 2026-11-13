/** 图片补查按时间窗持久去重，不驱动微信下载；取失败按持久退避自动重试，次数有上限，确定性失败不自动重试。 */
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
export class ImagePreparationFailure extends StorageFailure{}
export const imageRefreshIntervalMs=60_000;
export const imageReconcilePrefix='image_reconcile_v1_';
export const imageInitialPrefix='image_sync_v5_';
export const imagePreparationVersion='image-preflight-v1';
export const imageRetryDelaysMs=[60_000,300_000,1_800_000,21_600_000,86_400_000] as const;
/** 同一消息的自动尝试上限（含首次）；用完后本次运行内停止，App 重启后只再试一次。 */
export const imageMaxAutomaticAttempts=imageRetryDelaysMs.length;
/** 重试不会改变结果的确定性失败：消息与资源无法唯一关联、格式不支持、元数据非法、内容核验失败。出现一次即停止自动重试。 */
export const imageFinalFailureCodes=['media_association_failed','media_format_unsupported','media_metadata_invalid','media_quality_unverified'] as const;
export const imageRefreshWindow=(now:number):number=>Math.floor(now/imageRefreshIntervalMs);
export const imageReconcileRequestKey=(messageId:string,generation:string,now:number):string=>
 `${imageReconcilePrefix}${messageId}_${generation}_${imageRefreshWindow(now)}`;
export function automaticImageGeneration(requestKey:string,messageId:string):string|null{
 const prefix=[imageInitialPrefix,imageReconcilePrefix].find(value=>requestKey.startsWith(value));
 if(!prefix)return null;
 const start=prefix+messageId+'_',tail=requestKey.slice(start.length);
 if(!requestKey.startsWith(start)||!(prefix===imageInitialPrefix?/^\d{1,20}$/:/^\d{1,20}_\d{1,20}$/).test(tail))return '';
 return tail.split('_')[0]!;
}
