import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekAdapter, PUBLIC_BASE_URL} from '@deepseek-ai/dsh-llm-deepseek';
import {resolveHostReplyConfiguration} from '../src/host-reply-config.ts';

const syntheticKey = 'synthetic-host-config-key';
const configured = (environment = {}, options = {}) => {
  const result = resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY: syntheticKey, ...environment}, options);
  assert.equal(result.status, 'configured');
  return result;
};

test('旧生产默认值全部显式覆盖DSH默认值，认证仅保存在回调中', async () => {
  const result = configured();
  const {model, provider} = result;
  assert.deepEqual(model, {provider: 'notalone-deepseek', model: 'deepseek-flash',
    maxTokens: 4096, temperature: 0, reasoningEffort: 'off', physical_limit: 24,
    deadline_ms: 20000, warning_ratio: 0.8,
    budgetProfile: {context_window_tokens: 1048576, safety_margin_tokens: 65536}});
  assert.equal(provider.connection.baseURL, 'https://api.deepseek.com/anthropic');
  assert.deepEqual(provider.connection.defaults, {thinking: 'disabled', reasoningEffort: 'off'});
  assert.equal(provider.connection.maxTokens, 4096);
  assert.equal(provider.connection.defaultContextWindow, 1048576);
  assert.equal(provider.connection.streamIdleTimeoutMs, 60000);
  assert.equal(provider.connection.retryPolicy.mode, 'normal');
  assert.equal(provider.connection.retryPolicy.maxRetries, 0);
  assert.deepEqual(provider.connection.models, [{id: 'deepseek-flash', contextWindow: 1048576,
    maxTokens: 4096, inputModalities: ['text']}]);
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
    [{NOTALONE_DEEPSEEK_BASE_URL: 'https://custom.invalid/v1'}, 'input_budget_unavailable'],
    [{NOTALONE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic'}, 'input_budget_unavailable'],
    [{NOTALONE_DEEPSEEK_BASE_URL: 'https://api.deepseek.com/beta'}, 'input_budget_unavailable'],
    [{NOTALONE_DEEPSEEK_BASE_URL: `https://user:${syntheticKey}@api.deepseek.com`}, 'input_budget_unavailable'],
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
      {type: 'message_start', message: {id: 'synthetic-config', model: 'deepseek-flash', usage: {input_tokens: 1, output_tokens: 0}}},
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
  for (const effort of [null, 'high']) {
    const configuration = configured({}, {replyThinkingEffort: effort});
    const {provider, model} = configuration;
    const adapter = new DeepSeekAdapter({options: () => provider.connection,
      resolveAuth: provider.resolveAuth, resolveUserId: () => 'synthetic-config-anonymous',
      prepareExtensions: async () => ({fields: {}})});
    const chunks = [];
    for await (const chunk of adapter.stream({provider: model.provider, model: model.model,
      maxTokens: model.maxTokens, temperature: model.temperature, reasoningEffort: model.reasoningEffort,
      messages: [{role: 'user', content: [{type: 'text', text: '合成配置验收'}]}]})) chunks.push(chunk);
    assert.ok(chunks.some(chunk => chunk.type === 'finish'));
  }
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(request.headers.get('x-api-key'), syntheticKey);
    assert.equal(request.body.model, 'deepseek-flash');
    assert.equal(request.body.max_tokens, 4096);
    assert.equal(request.body.temperature, 0);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.messages[0].content[0].text, '合成配置验收');
  }
  assert.deepEqual(requests[0].body.thinking, {type: 'disabled'});
  assert.ok(!Object.hasOwn(requests[0].body, 'output_config'));
  assert.deepEqual(requests[1].body.thinking, {type: 'enabled'});
  assert.equal(requests[1].body.output_config.effort, 'high');
});
