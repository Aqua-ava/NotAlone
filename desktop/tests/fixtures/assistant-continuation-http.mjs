import { build } from 'esbuild';

// 默认 JsonClient 连接 Python 管理的真实 HTTP/隔离数据库；只替换外部模型。
let input = '';
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
const bundle = await build({ stdin: { contents: `
  export { JsonClient, BackendRequestFailure } from './src/main/backend/json-client';
  export { continueAssistantSession, captureDisplayedCandidateGroup,
    requirementChangeFromClarification } from './src/main/reply/assistant-continuation';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { JsonClient, BackendRequestFailure, continueAssistantSession, captureDisplayedCandidateGroup,
  requirementChangeFromClarification } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const transport = new JsonClient({ port: fixture.port, token: fixture.token });
let requests = 0;
let status;
const backend = { requestJson: async (options) => {
  requests += 1;
  const response = await transport.perform(options);
  status = response.status;
  return { generation: 7, data: response.data };
} };
try {
  const command = fixture.command;
  const frame = command.displayed_group;
  const requirementChanges = fixture.confirmedOptions ? fixture.confirmedOptions.map((option) =>
    requirementChangeFromClarification(option, 'keep')) : fixture.replacement ? [requirementChangeFromClarification({
    requirement: fixture.replacement.previous, origin: 'existing', actions: ['keep', 'replace', 'remove'],
  }, 'replace', fixture.replacement.text)] : command.requirement_changes;
  const result = await continueAssistantSession(backend, fixture.contactId, fixture.sessionId, {
    requestKey: command.idempotency_key, expectedInputVersionId: command.expected_input_version_id,
    instruction: command.instruction,
    displayedGroup: captureDisplayedCandidateGroup(frame.session_id, frame.candidate_group_id,
      frame.candidates.map((item) => ({ number: item.number, candidateId: item.candidate_id, versionId: item.version_id }))),
    ...(command.intention_update === undefined ? {} : { intentionUpdate: command.intention_update }),
    ...(requirementChanges === undefined ? {} : { requirementChanges }),
  }, new AbortController().signal);
  process.stdout.write(JSON.stringify({ ok: true, requests, status, result }));
} catch (error) {
  // 错误只输出安全类别，不回传异常正文、认证信息或原 HTTP 响应。
  process.stdout.write(JSON.stringify({ ok: false, requests, kind: error.constructor.name,
    ...(error instanceof BackendRequestFailure ? { status: error.status, code: error.code } : {}) }));
} finally { transport.cancelPending(); }
