/** 合成DSH宿主内建许可；HTTP仅替代隔离测试的持久账本边界，不进入产品。 */
import {join} from 'node:path';
import {startModelHost} from '../../src/platform/models/model-host.ts';
export async function syntheticModelHost(){
 const home=process.env.DSH_HOME!;
 const endpoint=new URL('/synthetic-accounting',process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!).href;
 async function invoke(op:string,args:unknown[]){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op,args})});
  if(!response.ok)throw new Error('synthetic_accounting_rejected');
  return await response.json();
 }
 return startModelHost({runtimeEnvironment:{},businessHome:home,infoPath:join(home,'model.info'),envFilePath:join(home,'model.env'),accounting:{
  reserve:async(...args)=>{await invoke('reserve',args);},recordReserved:async(...args)=>{await invoke('recordReserved',args);},
  unconfirmedRequests:scope=>invoke('unconfirmedRequests',[scope]),
 }});
}
