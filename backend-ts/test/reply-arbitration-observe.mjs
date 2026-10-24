/** 测试只读观察：保留原参数、Promise和异常；不改变业务调度。 */
import {appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const backend=resolve(process.env.NOTALONE_ACCEPTANCE_BACKEND);
await import(pathToFileURL(join(backend,'test/host-model-network-guard.mjs')).href);
const {ModelPermitArbiter}=await import(pathToFileURL(join(backend,'src/model-permits.ts')).href);
const original=ModelPermitArbiter.prototype.acquire;
ModelPermitArbiter.prototype.acquire=function(...args){
 const result=Reflect.apply(original,this,args);
 appendFileSync(process.env.NOTALONE_ACCEPTANCE_OBSERVATIONS,JSON.stringify({kind:args[0],attempt_id:args[3]??null,pid:process.pid,snapshot:this.snapshot()})+'\n',{mode:0o600});
 return result;
};
