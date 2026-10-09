import path from 'node:path';
import { test as appTest } from './app-fixture';
import { ContactFixture, type ContactDatabase } from './contact-backend-fixture';
export { ContactFixture } from './contact-backend-fixture';
import { withSyntheticBackendFixture } from './synthetic-backend-fixture';
const project = path.resolve('..');

export async function readContactHttp(fixture: ContactFixture): Promise<unknown> {
  const response = await fixture.request('/api/contacts');
  if (response.status !== 200) throw new Error('本轮联系人 HTTP 查询未成功。');
  return response.data;
}

export const test = appTest.extend<{ contactBackend: ContactFixture; databaseMode: string; backendMode: 'owned' | 'reused' }>({
  databaseMode: ['ready', { option: true }],
  backendMode: ['owned', { option: true }],
  contactBackend: async ({ databaseMode, backendMode }, use) => {
    await withSyntheticBackendFixture<ContactDatabase, ContactFixture>({
      directoryPrefix: 'notalone-contact-session-',
      databaseScript: path.join(project, 'desktop/tests/fixtures/contact-database.py'),
      createArguments: [databaseMode], prepareTimeoutMs: 70_000, reuseBackend: backendMode === 'reused',
      createFixture: (directory, pythonExecutable, data) => new ContactFixture(directory, pythonExecutable, data),
    }, use);
  },
  appEnvironment: async ({ contactBackend }, use) => {
    await use(contactBackend.environment());
  },
  launchConfiguration: async ({ contactBackend }, use) => {
    await use({ pythonExecutable: contactBackend.pythonExecutable, projectDirectory: project,
      envFilePath: contactBackend.envPath, backendInfoPath: contactBackend.infoPath });
  },
});
