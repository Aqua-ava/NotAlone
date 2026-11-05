/** 图片补查按时间窗持久去重，不驱动微信下载；缩略图仅有或取失败时按持久退避重试。 */
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
export class ImagePreparationFailure extends StorageFailure{}
export const imageRefreshIntervalMs=60_000;
export const imageReconcilePrefix='image_reconcile_v1_';
export const imageInitialPrefix='image_sync_v5_';
export const imagePreparationVersion='image-preflight-v1';
export const imageRetryDelaysMs=[60_000,300_000,1_800_000,21_600_000,86_400_000] as const;
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
