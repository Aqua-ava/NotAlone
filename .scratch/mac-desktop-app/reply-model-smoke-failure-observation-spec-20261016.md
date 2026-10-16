# cap1 App 冒烟失败观测补充规格

日期：2026-10-16。范围来自当前冻结 v9 唯一 cap1 场：供应商返回 200，但完成谓词 30 秒未成立。原失败见 [结果记录](reply-model-smoke-v9-failure-result-20261016.md)，不得覆盖或改签。

目标是在现有 `reply-model-smoke-app-acceptance.spec.ts` 的完成 poll 接缝保留足够区分状态的无正文观测；不修产品、不推根因、不改变完成条件或等待预算。

## 已确认的实现与测试接缝

- 复用同一实际完成 poll：通过小型可导出函数包住现有 read／Playwright poll／现有 backend inspect／本场文件持久化边界；只在验收测试与其离线测试修改，不增加 runner、harness 或产品 API。
- 每次实际 read 只把 `phase`、`errorCode`、`resultPresent` 布尔交出 renderer，附本地采样时间。phase 与错误码使用明确枚举；意外值保存固定 unknown，不原样保存任意字符串。读取失败单独记布尔，不保存异常正文。
- 每次采样后尝试持久化本场观察 JSON；poll 正常返回或抛错时再保存终态观察，并尽量调用现有 `inspect` 保存六类表计数、回复状态与供应商计数／状态码／模型匹配／固定失败分类。只存 allowlist；inspect 错误只存失败状态与时间，不保存错误正文或其他任意字段。
- poll 原有 `timeout:30_000`、`completed|failed` 谓词与后续 terminal 断言保持；观测不得生成 completed。原 poll／read 异常必须以同一对象重新抛出，inspect 或文件错误不能覆盖原失败。无原失败却无法保存观察时明确失败。
- cap1、零重试、显式生成一次、20 秒产品运行时、现有退出与清理不变。inspect 沿现有本地控制通道和原 10 秒命令超时，不发供应商请求；新增观测不延长 poll、测试或 lease。

离线 TDD 使用该实际导出接缝与真实临时文件；只在 renderer 读取、poll 调度、固定时间和后端 inspect 边界提供合成值。先证明原行为在 timeout 时没有记录真实 idle／waiting，再验证同一原异常仍被抛出且 JSON 保留采样、inspect；覆盖 inspect 失败和隐私字段负控、读失败、文件失败及成功完成。既有 Python Mock 继续验证真实 SDK／模型装配的 cap1、零重试与凭据边界。

验收为类型检查、该离线观测测试和既有 Python Mock 通过。此实现不启动 App、模型、CLI、浏览器或新真实预算；带观测的新 cap1 对照必须另由 Root 明确决定执行。

## 离线实施结果

实际导出接缝先复现等待超时仍缺观察文件（ENOENT），加入观测后同一负控通过。`node --test tests/reply-model-smoke-observation.test.mjs` 5／5，既有 Python SDK／预算 Mock 24／24、`npm run typecheck` 通过；Root另复核同5项通过，均未运行真实App或供应商请求。独立Standards／Spec对两份文档及测试增量均0项问题。没有改动产品、fixture后端、30秒谓词、180秒上限或cap1；旧失败及其缺失状态不由新代码回填。新增验收源码使配置摘要变化，未来若有新场，必须重新计算并独立绑定。

## 实现验证

实际调用的等待逻辑先等价抽到导出接缝，旧行为仍只执行 poll；第一条离线用例在保留原超时异常后读取观测文件，实际红灯为 `ENOENT`，证明原等待没有保存 idle／waiting。加入观测后该用例通过；最终 Node 5／5，覆盖逐样本存盘、inspect 失败、敏感额外字段与未知枚举、读取及持久化失败、成功与业务 failed 原谓词。既有真实 SDK／运行时 Mock 24／24（2.453 秒）；类型检查及 `git diff --check` 通过。

命令：`desktop/` 下 `node --test tests/reply-model-smoke-observation.test.mjs`、`npm run typecheck`；仓库根先激活 Conda `NotAlone`，执行 `PYTHONPATH=backend/src:backend NOTALONE_DISABLE_DOTENV=1 python -B -m unittest discover -s desktop/tests/fixtures -p test_reply_model_smoke_backend.py -v`。Mock 只使用临时 home／预算、受控合成 transport 及本机隔离 HTTP／PG；无真实供应商请求、真实预算、新 App 或 GUI 操作。红绿摘要留在忽略目录 `desktop/artifacts/reply-model-smoke-observation-offline-20261016/validation.json`。
