/** 普通模块的启动门禁；正常/恢复/SDK关闭由官方profile合成用例验证。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startHostModelRuntime} from '../src/host-model-runtime.ts';
test('默认Python及无模型不安装模型宿主、读资料或改配置',async t=>{
 const home=await mkdtemp(join(tmpdir(),'na-default-model-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const environment=new Proxy({},{get(_target,key){if(key==='NOTALONE_DEEPSEEK_API_KEY')throw Error('不应读取模型凭据');return undefined;}});
 const allowed={environment,businessHome:home,infoPath:join(home,'backend.info'),envFilePath:join(home,'synthetic.env')};
 const options=new Proxy(allowed,{get(target,key){if(Object.hasOwn(target,key))return target[key];throw Error('不应读取storage、ctx或模型配置');}});
 assert.equal(await startHostModelRuntime(options),undefined);assert.deepEqual(await readdir(home),[]);
});
test('未知模式、私有配置冲突、无凭据及废除ECNU在资源创建前失败关闭',async()=>{
 for(const [environment,code] of [
  [{NOTALONE_REPLY_RUNTIME:'typo'},'reply_runtime_invalid'],
  [{NOTALONE_REPLY_REMOTE_URL:'http://127.0.0.1:12345'},'reply_runtime_ownership_conflict'],
  [{NOTALONE_MODEL_PERMIT_TOKEN:'synthetic'},'reply_runtime_ownership_conflict'],
  [{NOTALONE_REPLY_RUNTIME:'typescript'},'reply_model_unconfigured'],
  [{NOTALONE_REPLY_RUNTIME:'typescript',NOTALONE_DEEPSEEK_MODEL:'ecnu-max'},'ecnu_provider_retired'],
 ])await assert.rejects(startHostModelRuntime({environment}),{code});
});
