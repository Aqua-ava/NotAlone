/** 普通模块的启动门禁；正常/恢复/SDK关闭由官方profile合成用例验证。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {startHostModelRuntime} from '../src/host-model-runtime.ts';
test('未知模式、私有配置冲突及废除ECNU在资源创建前失败关闭',async()=>{
 for(const [environment,code] of [
  [{NOTALONE_REPLY_RUNTIME:'typo'},'reply_runtime_invalid'],
  [{NOTALONE_REPLY_REMOTE_URL:'http://127.0.0.1:12345'},'reply_runtime_ownership_conflict'],
  [{NOTALONE_MODEL_PERMIT_TOKEN:'synthetic'},'reply_runtime_ownership_conflict'],
  [{NOTALONE_REPLY_RUNTIME:'typescript',NOTALONE_DEEPSEEK_MODEL:'ecnu-max'},'ecnu_provider_retired'],
 ])await assert.rejects(startHostModelRuntime({environment}),{code});
});
