# Zombie 进程身份修复

状态：已在本轮明确授权的两文件范围完成并冻结，待 root 集成提交。此新增记录取代旧记录中的生产待办状态；旧 manifest、旧红例与旧建议补丁继续保留原字节，不能重复应用旧建议补丁。

## 修改与边界

- 基点 `dbc59a6b78dadbfd10e24d354e46c5ed665da0a4`；修改前 `process-identity.ts` SHA 与此前 e600 的原文件一致。
- `backend-ts/src/process-identity.ts:14` 先校验完整 ps 行及 PID，再识别 zombie，仅对非 zombie 要求 executable 为绝对路径；其余逻辑不变。
- 实际 macOS zombie 的 `comm` 为 `<defunct>`，现在已核验的旧实例状态为 `gone`，不会在 launcher 退出清理时被当成 `unknown`。`captureProcessIdentity` 仍明确拒绝 zombie，不能建立新的可信身份。
- 存活相对路径、非法 identity、错误 PID 与不可解析 ps 行仍为 `unknown`；同 PID 但启动时间或 executable 已变化仍为 `gone`，原存活进程保持 `same`。
- 新增 `backend-ts/test/process-identity-zombie.test.mjs`：真实未 reap 的合成 Python 子进程由本轮父进程控制并最终 reap；另外只在测试进程内替换 ps 外部边界，先验证有效对照，再检查拒绝分支，最后恢复 builtin exports。
- 未修改 `launch.ts`、原 host 测试、旧四个夹具冻结文件；未增加产品等待或放宽断言。

## 实际验证

- 新真实 zombie 单例先 RED：`unknown !== gone`；本轮父子进程均正常回收，未发送终止信号。
- 修复前的三个拒绝／存活对照：3/3 通过。
- 修复后同一真实 zombie 单例 GREEN；新增模块 4/4 通过，覆盖 capture 仍拒绝 zombie。
- 原始 `zombie-identity-probe.mjs` 重新运行 GREEN，结果为 `gone`；新日志另存，旧 RED 文件未覆盖。
- `node --test --test-name-pattern='^真实DSH被SIGKILL' test/host-launch.test.mjs`：1/1，5021.07825ms。
- `node --test --test-concurrency=4 test/process-identity-zombie.test.mjs test/host-launch.test.mjs test/model-permits.test.mjs test/model-mode-recovery.test.mjs`：50/50，0 fail，8004.525292ms。包含 PID 复用不发送清理信号、存活 Python 不接管、unknown 不重放与回退拒绝等既有断言。
- `node_modules/.bin/tsc --noEmit` 与两文件空白检查通过；未跑 backend 全量。
- Node 24.19.0；测试以 `env -i` 仅传 HOME、USER 和 bundled runtime PATH；Python 使用既有 Conda NotAlone。命令与退出码见 `commands.json`。

## 证据、清理和限制

所有新增 raw 日志端侧目录 0700／文件 0600，公开副本移除本机路径；两者 SHA 见 `evidence-index.json`。原日志与旧 manifest 的 hash 校验通过；旧 26/26 记录是历史验证，本次单独记录 50/50。
合成父子进程均 reap／退出；相关生命周期测试的退出、正常 PG DROP 与清理 hooks 均通过。未触碰其他会话进程、真实资料、外部模型、实际 App／微信、index、commit、push 或 PR。仅更新身份观察的 zombie 分类，无业务资料处理影响。
已证明并修复可稳定复现的真实 zombie 错判，原全量 host 失败样本未保留当时 ps 状态，不能唯一归因到本缺陷；本轮通过不代表 Ticket25 或完整迁移验收完成。
集成仅使用本目录 `changes.patch`／`commit-files.txt`／`manifest.json`。生产修改与旧四测试修复的合并提交和全量回归仍由 root 负责。
