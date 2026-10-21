import type { Locator } from '@playwright/test';
export function selectContact(picker: Locator, target: string | { label: string }): Promise<void>;
export function expectContactOption(picker: Locator, name: string, options?: { timeout?: number }): Promise<void>;
