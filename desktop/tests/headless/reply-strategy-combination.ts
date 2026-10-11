import type { Browser } from '@playwright/test';
import { assistantMessageOptIn } from './assistant-message-opt-in';
import { replyStrategyOptions } from './reply-strategy-options';
import { replyStrategyDialogue } from './reply-strategy-dialogue';
import { replyStrategySkills } from './reply-strategy-skills';
import { replyStrategyMessageGroups } from './reply-strategy-message-groups';
import { replyStrategyBoundedUpdates } from './reply-strategy-bounded-updates';
import { replyStrategyConfirmedLifecycle } from './reply-strategy-lifecycle';
import { replyStrategyContinuation } from './reply-strategy-continuation';
import { authenticExpressionTyped } from './authentic-expression-typed';

// 只顺序复用原具名producer；运行仍由唯一受限入口和单Chrome租约管理。
export async function replyStrategyCombination(browser: Browser, origin: string) {
  await replyStrategyOptions(browser, origin);
  await replyStrategyDialogue(browser, origin);
  await replyStrategySkills(browser, origin);
  await replyStrategyMessageGroups(browser, origin);
  await replyStrategyBoundedUpdates(browser, origin);
  await replyStrategyConfirmedLifecycle(browser, origin);
  await replyStrategyContinuation(browser, origin);
  await assistantMessageOptIn(browser, origin);
  await authenticExpressionTyped(browser, origin);
}
