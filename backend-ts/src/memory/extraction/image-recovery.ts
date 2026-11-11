import {MODEL_IMAGE_LIMITS} from '../../platform/models/image-normalization.ts';

/** 图片降级只计划不同请求；调用、回执、占用释放与最终提交仍由现有业务端口执行。 */
export interface ImageRecoveryAttempt {slot:number;tier:'primary'|'degraded';includeImageContext:boolean}
export interface ImageRecoveryOptions<T,R> {
 targets:readonly T[];isImage(target:T):boolean;signal:AbortSignal;previouslyDegraded?:ReadonlySet<number>;
 unavailable?(target:T):boolean;
 run(targets:readonly T[],attempt:ImageRecoveryAttempt):Promise<R>;
 canRecover(error:unknown):boolean;
 supersede(attempt:ImageRecoveryAttempt&{targets:readonly T[]}):Promise<void>;
 isolate?(target:T,error:unknown,attempt:ImageRecoveryAttempt):Promise<void>;
}
/** 旧运行已耗尽的小版本没有可安全重放的请求，交由业务层保留失败或登记隔离。 */
export class ImageRecoveryExhaustedError extends Error {
 readonly code='media_model_input_unavailable';readonly slot:number;
 constructor(slot:number){super('media_model_input_unavailable');this.slot=slot;}
}
export interface ImageRecoveryResult<T,R> {results:{targets:readonly T[];value:R;slot:number}[];isolated?:T[]}
export async function recoverImageTargets<T,R>(options:ImageRecoveryOptions<T,R>):Promise<ImageRecoveryResult<T,R>> {
 options.signal.throwIfAborted();
 if(options.targets.filter(options.isImage).length>MODEL_IMAGE_LIMITS.maxImagesPerMessage)throw new Error('memory_image_recovery_plan_invalid');
 const results:ImageRecoveryResult<T,R>['results']=[];
 const isolated:T[]=[];
 async function visit(targets:readonly T[],slot:number,includeImageContext:boolean,tier:ImageRecoveryAttempt['tier']='primary'):Promise<void>{
  options.signal.throwIfAborted();
  let failure:unknown;
  if(options.previouslyDegraded?.has(slot)){
   if(slot===128)throw new ImageRecoveryExhaustedError(slot);
   failure=new ImageRecoveryExhaustedError(slot);
  }else{
   try{
    const value=await options.run(targets,{slot,tier,includeImageContext});
    results.push({targets,value,slot});return;
   }catch(error){
    options.signal.throwIfAborted();if(!options.canRecover(error))throw error;
    await options.supersede({slot,targets,tier,includeImageContext});options.signal.throwIfAborted();failure=error;
   }
  }
  const positions=targets.flatMap((target,index)=>options.isImage(target)?[index]:[]);
  const unavailable=positions.length===1&&options.unavailable?.(targets[positions[0]!]!);
  if(tier==='degraded'||unavailable){
   if(!options.isolate)throw failure;
   const image=targets.find(options.isImage);if(!image)throw failure;
   await options.isolate(image,failure,{slot,tier,includeImageContext});isolated.push(image);
   const remaining=targets.filter(target=>target!==image);
   if(remaining.length)await visit(remaining,slot+(tier==='degraded'?32:96),false);
   return;
  }
  if(positions.length===1){await visit(targets,slot+64,false,'degraded');return;}
  if(positions.length===0){if(includeImageContext){await visit(targets,128,false);return;}throw failure;}
  const cut=positions[Math.ceil(positions.length/2)-1]!+1;
  await visit(targets.slice(0,cut),slot*2+1,false);await visit(targets.slice(cut),slot*2+2,false);
 }
 await visit(options.targets,0,true);return {results,...(isolated.length?{isolated}:{})};
}
