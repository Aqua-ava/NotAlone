import test from 'node:test';
import assert from 'node:assert/strict';
import {layeredFailureDiagnostic,withLayeredFailureOperation} from '../src/diagnostics/layered-failure-diagnostic.ts';
import {L2ScenarioModelError} from '../src/memory/scenarios/model.ts';

test('分层任务诊断只保留错误分类、HTTP状态和代码位置，清除正文与凭据',()=>{
  const cause=Object.assign(new TypeError('合成聊天原文 sk-synthetic-secret'),{
    code:'NO_ADAPTER',failure:{code:'NO_ADAPTER',status:503,message:'合成提示词',requestId:'synthetic-request-secret'},
    stack:`TypeError: 合成聊天原文 sk-synthetic-secret\n    at call (${new URL('../src/memory/scenarios/model.ts',import.meta.url).pathname}:124:31)\n    at 合成正文 (/private/secret.ts:1:2)`,
  });
  const error=Object.assign(new Error('合成上游响应与密钥'),{code:'l2_scenario_model_failed',cause});
  const diagnostic=layeredFailureDiagnostic(error,'proposal');
  assert.equal(diagnostic.phase,'proposal');
  assert.equal(diagnostic.errors[0].code,'l2_scenario_model_failed');
  assert.equal(diagnostic.errors[1].name,'TypeError');
  assert.deepEqual(diagnostic.errors[1].provider_failure,{code:'NO_ADAPTER',status:503});
  assert.deepEqual(diagnostic.errors[1].frames,[{file:'memory/scenarios/model.ts',line:124,column:31}]);
  const encoded=JSON.stringify(diagnostic);
  for(const secret of ['合成聊天','synthetic-secret','合成提示词','request-secret','合成上游','/private/secret'])assert.ok(!encoded.includes(secret),secret);
});

test('模型准备异常保留同一错误身份，并记录尚未调用供应商的具体操作',async()=>{
  const error=new TypeError('合成敏感错误');
  await assert.rejects(withLayeredFailureOperation('model_prepare',async()=>{throw error;}),value=>value===error);
  assert.equal(layeredFailureDiagnostic(error,'proposal').errors[0].operation,'model_prepare');
  const modelError=new L2ScenarioModelError('l2_scenario_model_failed',null,undefined,{code:'RATE_LIMIT',status:429});
  assert.deepEqual(layeredFailureDiagnostic(modelError,'proposal').errors[0].provider_failure,{code:'RATE_LIMIT',status:429});
});
