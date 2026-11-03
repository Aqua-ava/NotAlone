import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekAdapter, PUBLIC_BASE_URL} from '@deepseek-ai/dsh-llm-deepseek';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';

const syntheticKey = 'synthetic-host-config-key';
const configured = (environment = {}, options = {}) => {
  const result = resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY: syntheticKey, NOTALONE_OPENCODE_API_KEY: syntheticKey, ...environment}, options);
  assert.equal(result.status, 'configured');
  return result;
};

test('OpenCode Go模型使用独立容量、Bearer认证及同一Go套餐的核验接口', async()=>{
  for(const [base,strict] of [
    ['https://opencode.ai/inference/go/anthropic','https://opencode.ai/inference/go/openai/v1/chat/completions'],
    ['https://opencode.ai/inference/go/anthropic/v1','https://opencode.ai/inference/go/openai/v1/chat/completions'],
    ['https://opencode.ai/zen/go/v1','https://opencode.ai/zen/go/v1/chat/completions'],
  ]) {
    const c=configured({NOTALONE_OPENCODE_API_KEY:syntheticKey,NOTALONE_DEEPSEEK_BASE_URL:base,NOTALONE_DEEPSEEK_MODEL:'deepseek-v4.1-flash'});
    assert.equal(c.model.model,'deepseek-v4.1-flash');
    assert.equal(c.model.maxTokens,384000);
    assert.equal(c.model.budgetProfile.context_window_tokens,1000000);
    assert.equal(c.provider.connection.models[0].id,c.model.model);
    assert.equal(c.provider.strictVerificationEndpoint,strict);
    const auth=await c.provider.resolveAuth(c.provider.connection);
    assert.equal(auth.headers.authorization,`Bearer ${syntheticKey}`);
    assert.equal(auth.headers['user-agent'],'NotAlone/0.1');
    await assert.rejects(c.provider.resolveAuth({...c.provider.connection,baseURL:PUBLIC_BASE_URL}),/route_mismatch/);
  }
  for(const base of ['https://api.deepseek.com','https://opencode.ai.evil.invalid/inference/go/anthropic','https://opencode.ai/inference/anthropic'])
    assert.equal(resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:syntheticKey,NOTALONE_DEEPSEEK_BASE_URL:base,NOTALONE_DEEPSEEK_MODEL:'deepseek-v4.1-flash'}).status,'unavailable');
  assert.equal(resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:syntheticKey,NOTALONE_DEEPSEEK_BASE_URL:'https://opencode.ai/inference/go/anthropic',NOTALONE_DEEPSEEK_MODEL:'deepseek-v4.1-flash',NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS:'384001'}).status,'unavailable');
});

test('宿主显式配置覆盖DSH默认值，输出采用供应商上限，认证仅保存在回调中', async () => {
  const result = configured();
  const {model, provider} = result;
  assert.deepEqual(model, {provider: 'notalone-deepseek', model: 'deepseek-flash',
    maxTokens: 393216, temperature: 0, reasoningEffort: 'off', physical_limit: 24,
    deadline_ms:90_000, warning_ratio: 0.8,
    budgetProfile: {context_window_tokens: 1048576, safety_margin_tokens: 65536}});
  assert.equal(provider.connection.baseURL, 'https://api.deepseek.com/anthropic');
  assert.deepEqual(provider.connection.defaults, {thinking: 'disabled', reasoningEffort: 'off'});
  assert.equal(provider.connection.maxTokens, 393216);
  assert.equal(provider.connection.defaultContextWindow, 1048576);
  assert.equal(provider.connection.streamIdleTimeoutMs, 60000);
  assert.equal(provider.connection.retryPolicy.mode, 'normal');
  assert.equal(provider.connection.retryPolicy.maxRetries, 0);
  assert.deepEqual(provider.connection.models, [{id: 'deepseek-flash', contextWindow: 1048576,
    maxTokens: 393216, inputModalities: ['text','image'],imageMaxBytes:2097152}]);
  assert.deepEqual(await provider.resolveAuth(provider.connection), {headers: {'x-api-key': syntheticKey}});
  assert.ok(!JSON.stringify(result).includes(syntheticKey));
  await assert.rejects(provider.resolveAuth({...provider.connection, baseURL: 'https://untrusted.invalid'}),
    /^Error: reply_auth_route_mismatch$/);
});

test('只接收宿主环境快照，官方root和v1含尾斜杠均映射同一Messages路由', async () => {
  for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/',
    'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/']) {
    assert.equal(configured({NOTALONE_DEEPSEEK_BASE_URL: base}).provider.connection.baseURL, PUBLIC_BASE_URL);
  }
  const environment = {NOTALONE_DEEPSEEK_API_KEY: ` ${syntheticKey} `,
    NOTALONE_DEEPSEEK_MODEL: '', DEEPSEEK_BASE_URL: 'https://untrusted.invalid',
    DEEPSEEK_API_KEY: 'another-synthetic-key'};
  const result = resolveHostReplyConfiguration(environment);
  assert.equal(result.status, 'configured');
  environment.NOTALONE_DEEPSEEK_API_KEY = 'changed-synthetic-key';
  assert.deepEqual(await result.provider.resolveAuth(result.provider.connection),
    {headers: {'x-api-key': syntheticKey}});
  assert.equal(resolveHostReplyConfiguration({DEEPSEEK_API_KEY: syntheticKey}).code, 'reply_model_unconfigured');
});

test('显式思考实验只接受旧生产公开支持的low/high/max', () => {
  for (const effort of ['low', 'high', 'max']) {
    const result = configured({}, {replyThinkingEffort: effort});
    assert.equal(result.model.reasoningEffort, effort);
    assert.deepEqual(result.provider.connection.defaults, {thinking: 'enabled', reasoningEffort: effort});
  }
  assert.equal(configured({}, {replyThinkingEffort: null}).model.reasoningEffort, 'off');
  for (const effort of ['', 'off', 'medium', 'ultra', false]) {
    assert.deepEqual(resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY: syntheticKey},
      {replyThinkingEffort: effort}), {status: 'unavailable', code: 'reply_thinking_configuration_invalid'});
  }
});

test('缺凭据、非法字符、空配置、未知模型或路由均有脱敏失败结果', () => {
  const cases = [
    [{}, 'reply_model_unconfigured'],
    [{NOTALONE_DEEPSEEK_API_KEY: ' \t '}, 'reply_model_unconfigured'],
    [{NOTALONE_DEEPSEEK_API_KEY: 'synthetic\nkey'}, 'reply_model_configuration_invalid'],
    [{NOTALONE_DEEPSEEK_MODEL: ' '}, 'reply_model_configuration_invalid'],
    [{NOTALONE_DEEPSEEK_BASE_URL: ''}, 'reply_model_configuration_invalid'],
    [{NOTALONE_DEEPSEEK_MODEL: 'other-model'}, 'input_budget_unavailable'],
    [{NOTALONE_DEEPSEEK_MODEL: ' deepseek-flash'}, 'input_budget_unavailable'],
    [{NOTALONE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com/beta'}, 'input_budget_unavailable'],
    [{NOTALONE_DEEPSEEK_BASE_URL: `https://user:${syntheticKey}@api.deepseek.com`}, 'reply_model_configuration_invalid'],
  ];
  for (const [environment, code] of cases) {
    const input = Object.keys(environment).length ? {NOTALONE_DEEPSEEK_API_KEY: syntheticKey, ...environment} : {};
    const result = resolveHostReplyConfiguration(input);
    assert.deepEqual(result, {status: 'unavailable', code});
    assert.ok(!JSON.stringify(result).includes(syntheticKey));
  }
});

test('已废除ECNU配置返回明确retired，不自动切换供应商', () => {
  const environment = {NOTALONE_DEEPSEEK_API_KEY: syntheticKey, NOTALONE_DEEPSEEK_MODEL: 'ecnu-max',
    NOTALONE_DEEPSEEK_BASE_URL: 'https://chat.ecnu.edu.cn/open/api/v1/'};
  assert.deepEqual(resolveHostReplyConfiguration(environment),
    {status: 'unavailable', code: 'ecnu_provider_retired'});
  assert.deepEqual(resolveHostReplyConfiguration(environment, {replyThinkingEffort: 'low'}),
    {status: 'unavailable', code: 'ecnu_provider_retired'});
  assert.deepEqual(resolveHostReplyConfiguration({...environment, NOTALONE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com'}),
    {status: 'unavailable', code: 'ecnu_provider_retired'});
  assert.deepEqual(resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_BASE_URL: environment.NOTALONE_DEEPSEEK_BASE_URL}),
    {status: 'unavailable', code: 'ecnu_provider_retired'});
});

test('公开官方adapter实际生成的路由、凭据、输出和思考字段符合宿主配置；fetch全程拦截', async t => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({url: String(input), headers: new Headers(init?.headers), body: JSON.parse(init.body)});
    const events = [
      {type: 'message_start', message: {id: 'synthetic-config', model: JSON.parse(init.body).model, usage: {input_tokens: 1, output_tokens: 0}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: '合成'}},
      {type: 'content_block_stop', index: 0},
      {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 1}},
      {type: 'message_stop'},
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      {status: 200, headers: {'content-type': 'text/event-stream'}});
  };
  t.after(() => {globalThis.fetch = previousFetch;});
  const cases=[{effort:null,maxTokens:393216},{effort:'high',maxTokens:393216},{effort:null,maxTokens:65536},
    {effort:null,maxTokens:8192,base:'https://gateway.invalid/proxy/v1'},
    {effort:null,maxTokens:384000,base:'https://opencode.ai/inference/go/anthropic/v1',modelId:'deepseek-v4.1-flash'}];
  for (const {effort,maxTokens,base,modelId} of cases) {
    const configuration = configured({NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS:String(maxTokens),...(base?{NOTALONE_DEEPSEEK_BASE_URL:base}:{}),...(modelId?{NOTALONE_DEEPSEEK_MODEL:modelId}:{})}, {replyThinkingEffort: effort});
    const {provider, model} = configuration;
    const adapter = new DeepSeekAdapter({options: () => provider.connection,
      resolveAuth: provider.resolveAuth, resolveUserId: () => 'synthetic-config-anonymous',
      prepareExtensions: async () => ({fields: {}})});
    const chunks = [];
    for await (const chunk of adapter.stream({sessionId:'synthetic-config-session',provider: model.provider, model: model.model,
      maxTokens: model.maxTokens, temperature: model.temperature, reasoningEffort: model.reasoningEffort,
      messages: [{role: 'user', content: [{type: 'text', text: '合成配置验收'}]}]})) chunks.push(chunk);
    assert.ok(chunks.some(chunk => chunk.type === 'finish'));
  }
  assert.equal(requests.length, cases.length);
  for (const [index,request] of requests.entries()) {
    assert.equal(request.url, cases[index].base?`${cases[index].base}/messages`:'https://api.deepseek.com/anthropic/v1/messages');
    if(cases[index].modelId){
      assert.equal(request.headers.get('authorization'),`Bearer ${syntheticKey}`);
      assert.equal(request.headers.get('x-api-key'),null);
      assert.equal(request.headers.get('user-agent'),'NotAlone/0.1');
    }else assert.equal(request.headers.get('x-api-key'), syntheticKey);
    assert.equal(request.headers.get('x-deepseek-harness-session-id'),'synthetic-config-session');
    assert.equal(request.body.model, cases[index].modelId??'deepseek-flash');
    assert.equal(request.body.max_tokens, cases[index].maxTokens);
    assert.equal(request.body.temperature, 0);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.messages[0].content[0].text, '合成配置验收');
  }
  assert.deepEqual(requests[0].body.thinking, {type: 'disabled'});
  assert.ok(!Object.hasOwn(requests[0].body, 'output_config'));
  assert.deepEqual(requests[1].body.thinking, {type: 'enabled'});
  assert.equal(requests[1].body.output_config.effort, 'high');
});

 test('自填接收地址实际装配Messages及同源核验路由，密钥只绑定选定地址', async()=>{
  for(const [base,messages,strict] of [
    ['https://gateway.invalid','https://gateway.invalid','https://gateway.invalid/beta/chat/completions'],
    ['https://gateway.invalid/proxy/v1/','https://gateway.invalid/proxy/v1','https://gateway.invalid/proxy/beta/chat/completions'],
    ['https://gateway.invalid/proxy/anthropic','https://gateway.invalid/proxy/anthropic','https://gateway.invalid/proxy/beta/chat/completions'],
    ['http://127.0.0.1:12345/v1','http://127.0.0.1:12345/v1','http://127.0.0.1:12345/beta/chat/completions'],
  ]){
    const result=configured({NOTALONE_DEEPSEEK_BASE_URL:base});
    assert.equal(result.provider.connection.baseURL,messages);
    assert.equal(result.provider.strictVerificationEndpoint,strict);
    assert.equal(result.model.model,'deepseek-flash');
    assert.deepEqual(await result.provider.resolveAuth(result.provider.connection),{headers:{'x-api-key':syntheticKey}});
    await assert.rejects(result.provider.resolveAuth({...result.provider.connection,baseURL:PUBLIC_BASE_URL}),/reply_auth_route_mismatch/);
  }
  assert.equal(configured({NOTALONE_DEEPSEEK_BASE_URL:PUBLIC_BASE_URL}).provider.connection.baseURL,PUBLIC_BASE_URL);
  for(const base of ['http://gateway.invalid/v1','https://gateway.invalid/?key=private','https://gateway.invalid/#private','https://gateway.invalid/\\bad']){
    assert.equal(resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:syntheticKey,NOTALONE_DEEPSEEK_BASE_URL:base}).code,'reply_model_configuration_invalid');
  }
 });

test('OpenCode与官方DeepSeek密钥按接收方隔离，不相互回落',async()=>{
 const keys={NOTALONE_DEEPSEEK_API_KEY:'synthetic-official-key',NOTALONE_OPENCODE_API_KEY:'synthetic-opencode-key'};
 const official=resolveHostReplyConfiguration(keys);assert.equal(official.status,'configured');
 assert.equal((await official.provider.resolveAuth(official.provider.connection)).headers['x-api-key'],'synthetic-official-key');
 const route={NOTALONE_DEEPSEEK_BASE_URL:'https://opencode.ai/inference/go/anthropic',NOTALONE_DEEPSEEK_MODEL:'deepseek-v4.1-flash'};
 const opencode=resolveHostReplyConfiguration({...keys,...route});assert.equal(opencode.status,'configured');
 assert.equal((await opencode.provider.resolveAuth(opencode.provider.connection)).headers.authorization,'Bearer synthetic-opencode-key');
 assert.equal(resolveHostReplyConfiguration({...route,NOTALONE_DEEPSEEK_API_KEY:keys.NOTALONE_DEEPSEEK_API_KEY}).status,'unavailable');
 assert.equal(resolveHostReplyConfiguration({NOTALONE_OPENCODE_API_KEY:keys.NOTALONE_OPENCODE_API_KEY}).status,'unavailable');
});
