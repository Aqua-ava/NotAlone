/** 图片调用沿统一诊断写入有界元数据；原始内容和摘要不进入普通日志。 */
import {diagnose} from '../../diagnostics/context.ts';

export type ImageCallFailureCategory='none'|'socket_closed'|'reset'|'timeout'|'tls'|'dns'|'other'|'image_budget'|'image_invalid'|'model_budget'|'cancelled';
export interface ImageCallDiagnosticImage {id:string;originalBytes:number;sentBytes:number;width?:number;height?:number;mimeType?:string}
export interface ImageCallDiagnostic {
 callId:string;traceId:string;contactPrefix?:string;images:readonly ImageCallDiagnosticImage[];
 requestBytes:number;durationMs:number;stage:'before_send'|'awaiting_response'|'response_received';
 failureCategory:ImageCallFailureCategory;outcome:'succeeded'|'failed'|'unknown';
}
/** 一条调用汇总和至多八条图片元数据共享调用身份；写者仍执行白名单与本机留存合同。 */
export function recordImageCallDiagnostic(input:ImageCallDiagnostic):void {
 if(!input.images.length)return;
 const common={caller:'memory_processing',traceId:input.traceId,callId:input.callId,
  ...(input.contactPrefix?{contactPrefix:input.contactPrefix}:{}),imageCount:input.images.length,
  requestBytes:input.requestBytes,durationMs:input.durationMs,stage:input.stage,failureCategory:input.failureCategory,
  reasonCode:input.outcome==='succeeded'?'completed':input.outcome==='failed'?'failed':'receipt_unknown'};
 diagnose({event:'processing.model_call',...common,toState:input.outcome,
  originalBytes:input.images.reduce((total,image)=>total+image.originalBytes,0),sentBytes:input.images.reduce((total,image)=>total+image.sentBytes,0)});
 for(const image of input.images)diagnose({event:'processing.model_image',...common,imageId:image.id,
  originalBytes:image.originalBytes,sentBytes:image.sentBytes,...(image.width?{width:image.width}:{}),
  ...(image.height?{height:image.height}:{}),...(image.mimeType?{mimeType:image.mimeType}:{})});
}
