# 生产范围修改请求（尚未修改源码）

- 基点：`e60074b5946b8d1c990fcb75ba13bd58f789b2fb`。
- 原始失败：`host-launch.test.mjs:135` 在不到 3 秒返回 `false`，不是 20 秒等待超时。
- 最小命令：`node .scratch/dsh-ts-migration/final-host-fixture-regression/zombie-identity-probe.mjs`。
- 已复现：本轮专属 Python 父进程持有未 reap 的合成子进程，`/bin/ps` 状态为 `Z`、comm 为 `<defunct>`；`processIdentityState` 返回 `unknown`，预期 `gone`。父子均已正常 reap／退出。
- 精确建议：只修改 `backend-ts/src/process-identity.ts:14` 的校验顺序，让合法 PID 的 zombie 在绝对 executable 校验前被识别；存活进程的绝对路径、启动时间、PID 复用和 unknown 拒绝边界保持。
- 原因：当前 `inspect` 在检查 `match[4].includes('Z')` 前要求 `match[5].startsWith('/')`，所以 `<defunct>` 会先抛出身份未知，`launch.ts:68` 因而保守拒绝清理。
- 推断边界：这证明真实生产缺陷及相同失败机制；12 次原始 host 最小用例受控并发均绿，未声称已锁定原全量失败唯一原因。
- 待主协调明确授权／自行修复：本会话不改生产文件，不降低 `waitForExit === true` 断言，不扩大等待。

最小建议补丁见 `proposed-process-identity.patch`；它只保存在授权的 scratch 目录，尚未应用到生产文件。
