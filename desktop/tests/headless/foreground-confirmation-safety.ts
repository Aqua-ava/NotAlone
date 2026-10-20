import { expect, type Browser, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { withManualForegroundFixture } from '../foreground-backend-fixture';
import type { BindingFixture } from '../binding-backend-fixture';
import type { ForegroundConfirmation, ForegroundState } from '../../src/shared/foreground-bridge';
import type { ContactSessionState } from '../../src/shared/contact-session-bridge';
import { foregroundConfirmationSafetyFlow } from '../foreground-confirmation-safety-page-scenarios';
import { withForegroundPages } from './foreground-cases';
import { ownResource } from './cleanup';
import type { PageHost } from './page-host';
import type { PageTransportControl } from './renderer';

type ConfirmationRecord = { fixtureIndex: number; submittedScopeRevision: number; submittedForegroundRevision: number;
  returned: boolean | null; strictRejectedError: boolean | null; returnedScopeRevision: number | null; returnedFixtureIndex: number | null };
type GapReport = { requests: ConfirmationRecord[]; heldCount: number; invalid: boolean; deliveryRevision: number | null;
  renderedSuspendedBeforeChange: boolean | null; cleanupConfirmed: boolean };
type GapWindow = Window & { pageTransportControl?: PageTransportControl; pageEvent(channel: string, state: unknown): void;
  contactRenderGap?: { deliverThenSelect(): void; report(stop: boolean): GapReport } };

// 工程可控反例只作用测试传输；真实React、确认控制器及严格revision门保持原样。
async function foregroundRenderGap(manager: Page, helper: Page, host: PageHost, backend: BindingFixture) {
  const suspended = helper.getByText('小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。', { exact: true });
  host.foreground.notifyHelperLifecycle('blurred');
  await expect(suspended).toHaveCount(0);
  host.foreground.notifyHelperLifecycle('focused');
  await expect(suspended).toBeVisible();
  const beforeForeground = host.foreground.getState();
  const beforeContact = await helper.evaluate(() => window.notalone.contacts.getState());
  const [targetContact, currentContact] = backend.data.contact_ids;
  const rows = manager.getByRole('region', { name: '联系人目录', exact: true }).getByRole('button', { name: /^选择/ });
  const targetIndex = beforeContact.contacts.findIndex((contact) => contact.contactId === targetContact);
  const currentIndex = beforeContact.contacts.findIndex((contact) => contact.contactId === currentContact);
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  expect(currentIndex).toBeGreaterThanOrEqual(0);
  expect(beforeContact.selectedContactId).toBe(currentContact);
  await expect(rows.nth(currentIndex)).toHaveAttribute('aria-pressed', 'true');
  expect(beforeForeground.suspendedByHelperFocus).toBe(true);
  await writeFile('artifacts/headless-pages/contact-render-gap-owned.json', JSON.stringify({
    ...backend.cleanupOwnership(), fixtureDirectory: backend.directory,
  }), { mode: 0o600 });
  await helper.evaluate((contactIds) => {
    const owned = window as unknown as GapWindow;
    if (typeof owned.pageEvent !== 'function') throw new Error('本轮公开页面传输未就绪。');
    if (owned.pageTransportControl || owned.contactRenderGap) throw new Error('本轮拒绝覆盖已有传输控制。');
    let held: ForegroundState | null = null, holding = true, heldCount = 0, invalid = false;
    let deliveryRevision: number | null = null, renderedSuspendedBeforeChange: boolean | null = null;
    const requests: ConfirmationRecord[] = [];
    const natural = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const control: PageTransportControl = {
      receiveEvent(channel, state) {
        if (channel !== 'foreground:state-changed' || !holding) return false;
        heldCount += 1;
        const next = state as ForegroundState | null;
        if (held || !next || !natural(next.foregroundRevision) || typeof next.suspendedByHelperFocus !== 'boolean') invalid = true;
        else held = next;
        return true;
      },
      observeInvoke(channel, args, pending) {
        if (channel !== 'foreground:confirm') return;
        if (requests.length === 2) { invalid = true; return; }
        const selection = args[0] as ForegroundConfirmation | undefined;
        if (!selection || !natural(selection.contactScopeRevision) || !natural(selection.foregroundRevision)
          || !contactIds.includes(selection.contactId)) { invalid = true; return; }
        const entry: ConfirmationRecord = { fixtureIndex: contactIds.indexOf(selection.contactId),
          submittedScopeRevision: selection.contactScopeRevision, submittedForegroundRevision: selection.foregroundRevision,
          returned: null, strictRejectedError: null, returnedScopeRevision: null, returnedFixtureIndex: null };
        requests.push(entry);
        void pending.then((value) => {
          const state = value as ContactSessionState | null;
          entry.returned = true;
          if (!state || !natural(state.scopeRevision) || !contactIds.includes(state.selectedContactId ?? '')) { invalid = true; return; }
          entry.returnedScopeRevision = state.scopeRevision;
          entry.returnedFixtureIndex = contactIds.indexOf(state.selectedContactId ?? '');
        }, (error) => {
          entry.returned = false;
          entry.strictRejectedError = error instanceof Error && error.message === '联系人确认已失效，请重新选择本次联系人。';
        });
      },
    };
    owned.pageTransportControl = control;
    const diagnostic: NonNullable<GapWindow['contactRenderGap']> = {
      deliverThenSelect() {
        if (!held || heldCount !== 1) throw new Error('本轮前台传输输入未唯一保存。');
        const state = held;
        holding = false; held = null;
        deliveryRevision = state.foregroundRevision;
        owned.pageEvent('foreground:state-changed', state);
        // 同一JS任务内，真实订阅先收到新状态，再派发公开DOM change；不await或改React处理器。
        renderedSuspendedBeforeChange = [...document.querySelectorAll('p')].some((node) =>
          node.textContent === '小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。');
        const picker = document.querySelector('select[aria-label="本次联系人"]');
        if (!(picker instanceof HTMLSelectElement) || picker.disabled) throw new Error('本轮合成选择器尚未就绪。');
        picker.value = contactIds[0];
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      },
      report(stop) {
        let cleanupConfirmed = false;
        if (stop && owned.pageTransportControl === control && owned.contactRenderGap === diagnostic) {
          delete owned.pageTransportControl; delete owned.contactRenderGap;
          holding = false; held = null; cleanupConfirmed = true;
        }
        return { requests, heldCount, invalid, deliveryRevision, renderedSuspendedBeforeChange, cleanupConfirmed };
      },
    };
    owned.contactRenderGap = diagnostic;
  }, backend.data.contact_ids);
  let negativePassed = false, positivePassed = false, originalFailed = false;
  try {
    host.foreground.notifyHelperLifecycle('blurred');
    await expect.poll(() => helper.evaluate(() => (window as unknown as GapWindow).contactRenderGap!.report(false).heldCount)).toBe(1);
    const currentForeground = host.foreground.getState();
    expect(currentForeground.foregroundRevision).toBe(beforeForeground.foregroundRevision + 1);
    await helper.evaluate(() => (window as unknown as GapWindow).contactRenderGap!.deliverThenSelect());
    await expect(helper.getByRole('alert').filter({ hasText: '联系人确认已失效，请重新选择本次联系人。' }).first()).toBeVisible();
    const rejected = await helper.evaluate(() => (window as unknown as GapWindow).contactRenderGap!.report(false));
    expect(rejected.invalid).toBe(false);
    expect(rejected.renderedSuspendedBeforeChange).toBe(true);
    expect(rejected.deliveryRevision).toBe(currentForeground.foregroundRevision);
    expect(rejected.requests).toEqual([{ fixtureIndex: 0, submittedScopeRevision: beforeContact.scopeRevision,
      submittedForegroundRevision: beforeForeground.foregroundRevision, returned: false, strictRejectedError: true,
      returnedScopeRevision: null, returnedFixtureIndex: null }]);
    const afterRejected = await helper.evaluate(() => window.notalone.contacts.getState());
    expect(afterRejected.selectedContactId).toBe(currentContact);
    expect(afterRejected.scopeRevision).toBe(beforeContact.scopeRevision);
    expect(afterRejected.draft).toBe(beforeContact.draft);
    expect(host.foreground.getGenerationBlock()).toBe('foreground-confirmation-required');
    await expect(rows.nth(currentIndex)).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(targetIndex)).toHaveAttribute('aria-pressed', 'false');
    negativePassed = true;
    // 新的显式选择发生在公开DOM已反映新状态后，独立于前一次拒绝，不自动retry。
    await expect(suspended).toHaveCount(0);
    await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(targetContact);
    await expect(rows.nth(targetIndex)).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(currentIndex)).toHaveAttribute('aria-pressed', 'false');
    const accepted = await helper.evaluate(() => (window as unknown as GapWindow).contactRenderGap!.report(false));
    expect(accepted.invalid).toBe(false);
    expect(accepted.requests).toHaveLength(2);
    expect(accepted.requests[1]).toEqual({ fixtureIndex: 0, submittedScopeRevision: beforeContact.scopeRevision,
      submittedForegroundRevision: currentForeground.foregroundRevision, returned: true, strictRejectedError: null,
      returnedScopeRevision: beforeContact.scopeRevision + 1, returnedFixtureIndex: 0 });
    const afterAccepted = await helper.evaluate(() => window.notalone.contacts.getState());
    expect(afterAccepted.selectedContactId).toBe(targetContact);
    expect(afterAccepted.scopeRevision).toBe(beforeContact.scopeRevision + 1);
    expect(afterAccepted.draft).toBe('');
    expect(host.foreground.getGenerationBlock()).toBeNull();
    await expect(helper.getByText('本次联系人已由你确认。', { exact: true })).toBeVisible();
    expect(await backend.tails()).toEqual([]);
    positivePassed = true;
  } catch (error) { originalFailed = true; throw error; }
  finally {
    try {
      const report = await helper.evaluate(() => (window as unknown as GapWindow).contactRenderGap!.report(true));
      await writeFile('artifacts/headless-pages/contact-render-gap.json', JSON.stringify({ ...report, negativePassed, positivePassed,
        exactReactCommittedRevisionCertified: false, originalCFailureReproduced: false, productChanged: false,
      }), { mode: 0o600 });
      expect(report.cleanupConfirmed).toBe(true);
      expect(report.invalid).toBe(false);
      expect(report.requests).toHaveLength(2);
    } catch (cleanupError) {
      // 已失败时保留原断言；既有host／夹具仍沿外层finally清理，不能把缺收据称为已清。
      if (!originalFailed) throw cleanupError;
    }
  }
}

// 共用原认证生命周期，外部probe保持合成且总开关默认关闭。
export async function foregroundConfirmationSafety(browser: Browser, origin: string): Promise<void> {
  const name = '人工确认A后管理页换B，旧revision与错误角色不得恢复生成资格';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withManualForegroundFixture(async ({ backend }) => {
    await withForegroundPages(browser, origin, backend, async (manager, openHelper, host) => {
      await foregroundConfirmationSafetyFlow(manager, openHelper, backend);
      const helpers = manager.context().pages().filter((page) => page.url() === `${origin}/#helper`);
      expect(helpers).toHaveLength(1);
      await foregroundRenderGap(manager, helpers[0], host, backend);
    });
  }, released, 'single-account');
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
