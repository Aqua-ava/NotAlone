import { requestAppTestLease } from '../../scripts/app-test-lease.mjs';

// 固定的合成 Node 孩子：只检验调度，永远没有 Electron、窗口或系统对话框入口。
const [id, hold] = process.argv.slice(2);
const permit = await requestAppTestLease('probe', undefined, id);
let finishing = false;
async function finish(stopped = false) {
  if (finishing) return;
  finishing = true;
  if (stopped) {
    await requestAppTestLease('probe', undefined, id).then(() => { process.exitCode = 1; })
      .catch((error) => process.stdout.write(`${error.message}\n`));
  }
  await requestAppTestLease('release', permit.launchId, id).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
process.on('SIGINT', () => { void finish(true); });
process.on('SIGTERM', () => { void finish(true); });
process.on('disconnect', () => { void finish(); });
await requestAppTestLease('probe', undefined, id).then(() => { throw new Error('启动预算没有拒绝第二次领取'); })
  .catch((error) => {
    if (!error.message.startsWith('app_test_budget:')) throw error;
    process.stdout.write(`${error.message}\n`);
  });
process.stdout.write(`app_test_lease_acquired: 仅合成 Node 孩子；App 未运行。\napp_test_probe_child:${process.pid}\n`);
setTimeout(() => { void finish(); }, Number(hold));
