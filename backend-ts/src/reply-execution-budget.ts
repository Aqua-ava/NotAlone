/** 前台回复的有界执行预算；运输层120秒，租约同时覆盖循环前后的资格核验。 */
export const REPLY_EXECUTION_DEADLINE_MS=90_000;
export function replyExecutionLeaseMs(deadlineMs:number):number{
 return Math.max(30_000,deadlineMs+30_000);
}
