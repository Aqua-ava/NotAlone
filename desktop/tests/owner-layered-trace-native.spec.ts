import { test as appTest } from './app-fixture';
import { withSyntheticBackendFixture } from './synthetic-backend-fixture';
import { MemoryFixture, type MemoryDatabase } from './memory-backend-fixture';
import { requestFixtureHttp } from './fixture-transport';
import { cuaReceiptDirectory, waitForCuaReceipt } from './cua-receipt';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = path.resolve('..');
type TraceData = MemoryDatabase & { trace_id: string; traced_memory_id: string; trace_text: string };
class OwnerTraceFixture extends MemoryFixture {
  declare readonly data: TraceData;
  backendPid: number | undefined;
}
const test = appTest.extend<{ traceBackend: OwnerTraceFixture }>({
  traceBackend: async ({}, use) => withSyntheticBackendFixture<TraceData, OwnerTraceFixture>({
    directoryPrefix: 'notalone-owner-layered-trace-',
    databaseScript: path.join(project, 'desktop/tests/fixtures/trace-database.py'),
    createArguments: ['deletion-owner'], prepareTimeoutMs: 70_000, reuseBackend: false,
    createFixture: (directory, python, data) => new OwnerTraceFixture(directory, python, data),
  }, async (fixture) => {
    fixture.backendPid = (await fixture.startBackend()).pid;
    await use(fixture);
  }),
  appEnvironment: async ({ traceBackend }, use) => use(traceBackend.environment()),
  launchConfiguration: async ({ traceBackend }, use) => use({
    pythonExecutable: traceBackend.pythonExecutable, projectDirectory: project,
    envFilePath: traceBackend.envPath, backendInfoPath: traceBackend.infoPath,
  }),
});

test('实际 App 的新本人删除清理旧提取过程 CUA 验收', async ({ runningApp, traceBackend }) => {
  test.setTimeout(7 * 60_000);
  const directory = await cuaReceiptDirectory(project);
  const requestId = randomUUID();
  const requiredChecks = ['owner_trace_detail_primed', 'new_owner_delete_clears_trace_cache', 'trace_reread_has_no_body'];
  await runningApp.app.firstWindow();
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify({
    request_id: requestId, pid: runningApp.appProcess.pid, user_data: runningApp.userData,
    backend_pid: traceBackend.backendPid, database_name: traceBackend.data.database_name,
    contact_ids: traceBackend.data.contact_ids, memory_id: traceBackend.data.traced_memory_id,
    trace_id: traceBackend.data.trace_id, trace_text: traceBackend.data.trace_text,
    project, native_app: true, final_signed_package: false, external_model_calls: 0, required_checks: requiredChecks,
  }), { mode: 0o600, flag: 'wx' });
  await waitForCuaReceipt(directory, requestId, requiredChecks, 6 * 60_000);
  const owner = await traceBackend.readMemorySection(traceBackend.data.contact_ids[0], 'owner');
  const trace = await requestFixtureHttp(traceBackend.infoPath,
    `/api/contacts/${traceBackend.data.contact_ids[0]}/memory-traces/${traceBackend.data.trace_id}`);
  if (owner.status !== 200 || JSON.stringify(owner.data).includes(traceBackend.data.traced_memory_id)
      || trace.status !== 200 || trace.data.availability !== 'deleted') {
    throw new Error('本人记忆删除或提取过程正文清理未收口。');
  }
  await writeFile(path.join(directory, 'runtime-proof.json'), JSON.stringify({
    owner_memory_deleted: true, trace_availability: trace.data.availability, external_model_calls: 0,
  }), { mode: 0o600, flag: 'wx' });
});
