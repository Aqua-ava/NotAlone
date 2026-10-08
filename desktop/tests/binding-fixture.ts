import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';
import { ContactFixture } from './contact-fixture';

const execute = promisify(execFile);
const project = path.resolve('..');
const databaseScript = path.join(project, 'backend/tests/integration/server/binding_consent_support.py');
type BindingData = ConstructorParameters<typeof ContactFixture>[2] & {
  foreign_bindings: { contact_id: string; binding_id: string }[];
};
export type CliState = { sessions: { username: string; display_name: string; chat_type: string; last_timestamp: number }[];
  messages: Record<string, { local_id: number; text: string; create_time: number }[]> };
export const initialCliState = (): CliState => ({ sessions: ['wxid_synthetic_a', 'wxid_synthetic_b'].map((username) =>
  ({ username, display_name: '同名会话', chat_type: 'private', last_timestamp: 1_700_000_000 })), messages: {} });

export class BindingFixture extends ContactFixture {
  constructor(directory: string, pythonExecutable: string, readonly bindingData: BindingData) {
    super(directory, pythonExecutable, bindingData);
  }
  override environment(ownerId = this.data.owner_id): NodeJS.ProcessEnv {
    return { ...super.environment(ownerId), NOTALONE_WECHAT_CLI: path.join(this.directory, 'controlled-cli'),
      NOTALONE_TEST_BINDING_DIRECTORY: this.directory };
  }
  override request(endpoint: string, body?: object) { return super.request(endpoint as '/api/contacts', body); }
  async setCli(state: CliState): Promise<void> {
    const location = path.join(this.directory, 'cli-state.json');
    await writeFile(`${location}.tmp`, JSON.stringify(state));
    await rename(`${location}.tmp`, location);
  }
  async tails(): Promise<string[]> {
    try { return (await readFile(path.join(this.directory, 'tail-calls.jsonl'), 'utf8')).trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line).locator); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}

export const test = appTest.extend<{ bindingBackend: BindingFixture; bindingMode: 'ready' | 'no-channel' }>({
  bindingMode: ['ready', { option: true }],
  bindingBackend: async ({ bindingMode }, use) => {
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('绑定验收须激活 Conda NotAlone。');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-binding-app-'));
    const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
    const env = isolatedAppEnvironment(directory, { PYTHONPATH: path.join(project, 'backend/src') });
    let data: BindingData | undefined;
    let fixture: BindingFixture | undefined;
    try {
      data = JSON.parse((await execute(python, [databaseScript, 'create', bindingMode], { env, timeout: 70_000 })).stdout);
      fixture = new BindingFixture(directory, python, data!);
      const cli = await readFile(path.join(project, 'backend/tests/fixtures/binding_cli.py'), 'utf8');
      await writeFile(path.join(directory, 'controlled-cli'), `#!${python}\n${cli}`, { mode: 0o700 });
      await fixture.setCli(initialCliState());
      await use(fixture);
    } finally {
      try { await fixture?.cleanup(); }
      finally {
        try { if (data) await execute(python, [databaseScript, 'drop', data.database_name], { env, timeout: 15_000 }); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  },
  appEnvironment: async ({ bindingBackend }, use) => { await use(bindingBackend.environment()); },
  launchConfiguration: async ({ bindingBackend }, use) => { await use({ pythonExecutable: bindingBackend.pythonExecutable,
    projectDirectory: project, envFilePath: bindingBackend.envPath, backendInfoPath: bindingBackend.infoPath }); },
});
