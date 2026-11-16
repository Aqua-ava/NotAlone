/** 图片补查按时间窗持久去重，不驱动微信下载；暂缺标准图按独立策略持久退避，查看重试不抬高自动退避。 */
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
export class ImagePreparationFailure extends StorageFailure{}
export const imageRefreshIntervalMs=60_000;
export const imageReconcilePrefix='image_reconcile_v1_';
export const imageInitialPrefix='image_sync_v5_';
export const imageRetryPrefix='image_retry_v1_';
export const imagePreparationVersion='image-preflight-v1';
export const imageRetryDelaysMs=[60_000,300_000,1_800_000,21_600_000,86_400_000] as const;
export const imageRefreshWindow=(now:number):number=>Math.floor(now/imageRefreshIntervalMs);
export const imageReconcileRequestKey=(messageId:string,generation:string,now:number):string=>
 `${imageReconcilePrefix}${messageId}_${generation}_${imageRefreshWindow(now)}`;
export const imageRetryRequestKey=(messageId:string,generation:string,now:number):string=>
 `${imageRetryPrefix}${messageId}_${generation}_${imageRefreshWindow(now)}`;
export function automaticImageGeneration(requestKey:string,messageId:string):string|null{
 const prefix=[imageInitialPrefix,imageReconcilePrefix,imageRetryPrefix].find(value=>requestKey.startsWith(value));
 if(!prefix)return null;
 const start=prefix+messageId+'_',tail=requestKey.slice(start.length);
 if(!requestKey.startsWith(start)||!(prefix===imageInitialPrefix?/^\d{1,20}$/:/^\d{1,20}_\d{1,20}$/).test(tail))return '';
 return tail.split('_')[0]!;
}
