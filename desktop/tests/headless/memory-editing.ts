import type { Browser } from '@playwright/test';
import { memoryOwnerCorrection } from '../memory-editing-page-scenarios';
import { PageHost } from './page-host';
import { withControllerEnvironment, withMemoryBackend } from './backend-fixture';

export async function memoryEditingOwner(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      await memoryOwnerCorrection(await host.open('manager'), fixture);
    } finally { await host.close(); }
  }));
}
