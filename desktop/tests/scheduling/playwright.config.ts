import { defineConfig } from '@playwright/test';

// 这里只执行门禁拒绝检查；即使门禁回归，显式的 Node 路径也不能打开 Electron。
export default defineConfig({ testDir: '.', testMatch: 'launch-rejection.spec.ts', workers: 1, retries: 0, timeout: 5000 });
