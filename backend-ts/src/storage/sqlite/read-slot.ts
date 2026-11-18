import type {StorageReader} from './contracts.ts';

/** 一条只读连接及其取消控制；`closing` 在退休后保留关闭责任。 */
export interface ReadSlot {reader:StorageReader;controller:AbortController;closing?:Promise<void>}

/** 在槽上执行一次读取；槽被退休（abort）时以 `cancelled()` 拒绝，且不残留监听。 */
export function readOnSlot<T>(slot:ReadSlot,name:string,input:unknown,cancelled:()=>Error):Promise<T>{
 const signal=slot.controller.signal;if(signal.aborted)return Promise.reject(cancelled());
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(cancelled());};
  signal.addEventListener('abort',abort,{once:true});
  try{slot.reader.execute<T>(name,input).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});}
  catch(error){signal.removeEventListener('abort',abort);reject(error);}
 });
}

/**
 * 撤销槽并关闭其连接。退休后仍保留关闭责任：明确失败允许调用方重试，
 * 确认关闭才从 `retiring` 移除。是否让出“当前槽”及版本推进由各通道自己先处理。
 */
export function retireSlot(slot:ReadSlot,retiring:Set<ReadSlot>):Promise<void>{
 slot.controller.abort();
 if(!slot.closing){
  retiring.add(slot);
  slot.closing=Promise.resolve().then(()=>slot.reader.close()).then(()=>{retiring.delete(slot);},error=>{slot.closing=undefined;throw error;});
 }
 return slot.closing;
}
