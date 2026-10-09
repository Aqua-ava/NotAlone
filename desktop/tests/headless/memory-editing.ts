import type { Browser } from '@playwright/test';
import { memoryMutationFailures, memoryCandidateDiscard, memoryCandidateConfirmation, memoryContactCorrection, memoryManualAddition, memoryOwnerCorrection, memoryRemoval } from '../memory-editing-page-scenarios';
import { MemoryHttpProxy } from '../memory-http-proxy';
import { ownResource } from './cleanup';
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

export async function memoryEditingAddition(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      await memoryManualAddition(await host.open('manager'), fixture);
    } finally { await host.close(); }
  }));
}

export async function memoryEditingContactCorrection(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try { await host.backend.connect(); await memoryContactCorrection(await host.open('manager'), fixture); }
    finally { await host.close(); }
  }));
}

export async function memoryEditingRemoval(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try { await host.backend.connect(); await memoryRemoval(await host.open('manager'), fixture); }
    finally { await host.close(); }
  }));

}

export async function memoryEditingCandidateConfirmation(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try { await host.backend.connect(); await memoryCandidateConfirmation(await host.open('manager'), fixture); }
    finally { await host.close(); }
  }));
}

export async function memoryEditingCandidateDiscard(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try { await host.backend.connect(); await memoryCandidateDiscard(await host.open('manager'), fixture); }
    finally { await host.close(); }
  }));
}

export async function memoryEditingFailures(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => {
    const released = ownResource();
    const proxy = await MemoryHttpProxy.attach(fixture.infoPath);
    try { await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try { await host.backend.connect(); await memoryMutationFailures(await host.open('manager'), fixture, proxy); }
      finally { proxy.release(); await host.close(); }
    }); } finally { await proxy.close(); released(); }
  });
}
