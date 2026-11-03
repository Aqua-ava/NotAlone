/** 仅复查已保存缩略图；按时间窗持久去重，不驱动微信下载。 */
export const imageRefreshIntervalMs=60_000;
export const imageRefreshPrefix='image_refresh_v1_';
export const imageRefreshWindow=(now:number):number=>Math.floor(now/imageRefreshIntervalMs);
export const imageRefreshRequestKey=(messageId:string,generation:string,now:number):string=>
 `${imageRefreshPrefix}${messageId}_${generation}_${imageRefreshWindow(now)}`;
