# 05：首启身份与模型配置

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 02
Spec: ../spec.md

## 交付行为

空白环境通过管理后台初始化本人并配置 DeepSeek，已有配置可以复用。

覆盖规格用户故事：5、6、7、47。

## 验收条件

- [x] 沿用已有 setup/credentials 公共接口，展示首次配置及已配置状态，并处理必要的后端重连或重启。
- [x] setup/status 的只读 runtime_owner_configured 验证当前实例身份在库中存在；全库已有其他 owner、缺失或不存在的运行身份不得被显示为本次配置完成，也不自动恢复他人身份。
- [x] App 首次初始化使用 create_only，在服务端原子检查与创建边界内拒绝并发出现的既有身份，拒绝发生在写受控配置之前；保留原有明确恢复调用的语义。
- [x] 初始化已写库和配置但响应丢失时，可显式重新加载受控配置；通过同一已验证目标认证停读再重启，不猜测身份或另启读取实例。失败刷新结束后再次验证原连接和操作，过期错误不覆盖新状态。
- [x] 密钥仅由受控提交路径传递，提交后清空输入，不回显已有密钥，不写入诊断日志。
- [x] 说明模型调用范围和本机存储事实，不宣称尚未实现的加密；用合成 owner 与隔离配置验收。

## 测试与范围

- 当前运行身份字段是本任务已批准首启就绪行为所需的最小公开契约补齐：由服务端受控 owner_id 注入同库存在查询，保留原三布尔字段的含义；不返回 owner_id/密钥，不接受客户端指定 owner，不新增表、迁移或身份合并。覆盖空库、正确运行身份、其他 owner 与不存在 UUID 的真实 HTTP/PG 场景。
- create_only 是既定禁止自动恢复他人身份所需的最小初始化保护，复用当前数据库事务和现有接口，不新增业务表或迁移。以真实 HTTP/PG 验证两个受控客户端并发初始化仅创建一个身份、失败方不改写配置，以及既有明确恢复仍可用；以实际 App 验证响应丢失后的显式重载和恢复查询期间断线不发布旧错误。
- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Answer

管理后台已接入本人首启、既有配置复用、DeepSeek 密钥提交与受控重载，见[实现说明](../../../desktop/README.md)、[配置控制器](../../../desktop/src/main/setup/controller.ts)和[具名桥接契约](../../../desktop/src/shared/setup-bridge.ts)。当前运行身份由服务端注入的 owner_id 做同库只读存在查询；原三个全库布尔值保持含义，缺失或不存在的运行身份不会被其他 owner 的存在误报为就绪。App 初始化固定 create_only，在现有表的同一事务中检查和创建，既有身份在配置写入前返回 409；既有明确恢复调用保留 created:false 语义。初始化响应丢失可明确重载实际配置，保存失败的恢复查询完成后再次复核连接代次与操作，旧结果不会覆盖断线或较新状态。

可复用的[主进程边界](../../../desktop/src/main/backend/host.ts)为 `BackendHost.requestJson(options: JsonRequest): Promise<{ generation: number; data: unknown }>`、`getConnectionGeneration(): number | undefined`、`restart(): Promise<boolean>`、`prepareConfiguration(): Promise<boolean>`；JsonRequest 含 method/path/body/signal/timeoutMs/maxResponseBytes。路径只由具名 main 模块构造，token 留在 main，异步成功与失败均复核已验证目标和 generation；generation 不作为 owner 身份证据。restart/prepare 共用同一原目标认证停读，未确认则保留 target/shutdown-failed，不猜 PID 或另启实例；prepare 成功后 disconnected，不自动连接。可选构造参数 `beforeConnect?: (config: BackendConfiguration, canStart: () => boolean) => Promise<void>` 保留，await 后复核 canStart，restart 仍走 initialize。新增 `SetupBridge.reloadControlledConfiguration(): Promise<void>` 只允许管理后台从未绑定状态明确重读配置，不接受路径、URL 或身份。

真实验证在 Conda NotAlone 与当前工作树模块下完成：[首启回归](../../../desktop/tests/setup.spec.ts)、[失败与迟到结果](../../../desktop/tests/setup-stale.spec.ts)、[响应丢失恢复](../../../desktop/tests/setup-recovery.spec.ts)和[真实并发初始化](../../../desktop/tests/setup-concurrency.spec.ts)均使用实际 App、真实本机 HTTP、随机正式迁移 `_test` PG；传输延迟与 PG 写入屏障只控制相应边界，不替换业务仓储。每项先 red 后 green，原始失败与夹具退场修正如 Comments 所记。最终在 `desktop/` 执行：

```bash
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
npm run typecheck
npm test -- --output=artifacts/review-full-source
npm run package
NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" \
  npx playwright test tests/setup.spec.ts tests/setup-stale.spec.ts tests/setup-recovery.spec.ts tests/setup-concurrency.spec.ts tests/windows.spec.ts --output=artifacts/review-packaged-final
```

类型检查通过，完整源码 56/56，重建签名包 20/20，package 内置严格 ad-hoc 签名校验通过；在 `backend/` 以 `PYTHONPATH="$PWD/src" PYTHONNOUSERSITE=1 python - <<'PY'` 运行隔离环境的 unittest loader，setup service、setup API、runtime shutdown 兼容 22/22。完整隔离脚本、命令和失败证据保留于未提交的 `desktop/artifacts/setup-verification.md`。完成记录阶段不重复这些已绿测试；`node /tmp/notalone-app-context.p9MPie/validate-tickets.mjs` 的 20 张任务字段/依赖/DAG/本地链接校验通过，`git diff --check` 通过。

两轴结果由主 Agent 统一组织：首次候选 `1b45b65aa5aed5dc8ea7000fda9974cbb5fe9f52` 以 `57d419a089ce51e32bf667ec2aafd6df9b07de41` 为基点，Standards 无硬违规但有一项 Duplicated Code 建议，Spec 三项 P2。已合入先明确范围的 `afe40b0fb6a60c3e1f1e656c8adde8ab75cde9a2` 并修复；固定修复候选 `aa95d0706c0d1b87a5f1a429bafc35484020e6cd` 相对旧候选的增量复审为 Standards 0 硬违规、0 新增判断，原重复代码已解决；Spec 缺失/越界/偏差各 0，原三项 P2 均修复。主 Agent 据此确认本任务 resolved，本次收尾提交只补记录，不修改已审实现。

数据影响仅为用户明确动作创建本人与写本机受控配置；密钥输入提交后清空，不回显已有密钥或进入诊断日志，界面如实说明长期存储、未提供静态加密和外部供应商副本的独立删除限制。验收只处理合成资料、独立配置/握手/userData 和本轮随机库，未访问私人 dotenv、业务库、微信或真实模型，没有新表、迁移、供应商、自动恢复他人身份或外部消息发送。实现验收末次只读清理核对为随机首启库 0、本工作树 App 进程 0、受控首启后端进程 0，不清理他人资源。03 的机器 gate/路径入口与 setup restart 联合验收待后续正式合入，本任务不宣称已经完成该联合验收。

保留本工作树忽略产物：`desktop/out/NotAlone-darwin-arm64/NotAlone.app`、`desktop/artifacts/setup-verification.md`、`desktop/artifacts/review-packaged-final/`（最终 configured.png）、`desktop/artifacts/review-recovery-red/`、`desktop/artifacts/review-failure-red/`、`desktop/artifacts/review-concurrency-red/` 与首次恢复 green 失败证据 `desktop/artifacts/review-recovery-green/`；均不加入提交。未 push、创建 PR 或自行修改集成工作树，后续由主 Agent 安排正式合入。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：在独立工作树按已批准 App 操作与真实 HTTP 接缝开始实现；本轮使用随机 `_test` PostgreSQL 库、独立配置与握手，先完成候选验证后由主 Agent 统一组织两轴评审。
- 2026-10-08：实现者核对发现已有状态仅代表全库、contacts 只检查运行 UUID 非空；主 Agent 在既定首启范围内明确补齐只读 runtime_owner_configured，不扩展身份创建/恢复授权。
- 2026-10-08：候选已合入集成 `57d419a089ce51e32bf667ec2aafd6df9b07de41`，以它为固定评审基点，保持 claimed 交由主 Agent 两轴评审。管理后台的具名初始化/密钥提交沿用真实 setup HTTP，已有身份直接复用；只读 `runtime_owner_configured` 注入当前服务实例身份并按同库存在性判断，不返回身份标识或密钥，不新增表或迁移。
- 2026-10-08：逐项 red → green 覆盖空库等待明确动作、初始化重启、密钥提交清空、迟到响应失效，以及库中其他 owner 已有而运行 UUID 不存在的阻塞。最终 `npm run typecheck`、源码 `npm test -- --output=artifacts/full-source` 50 项、源码增量 2 项、首启真实 HTTP/随机正式迁移 PG 组 11 项、重建打包 App 首启/窗口组 14 项、Python setup/认证停读兼容 22 项均通过；`npm run package` 内置严格签名校验和 `git diff --check` 通过。
- 2026-10-08：失败如实保留：早期源码全套 48/49 通过，安全错误页替换导致已关闭窗口断言竞态；早期打包首启/窗口 13/14 通过，复用断言误先读到点击前已配置状态，随后 5 秒等待截止时真实界面仍连接中。最小修正后相关增量与最终打包组通过，原复用进程在正常认证停读中 exit 0。全程只清理本轮随机库、配置、握手和自建进程，末次核对三项遗留计数均为 0；没有私人 dotenv、业务库、微信、模型调用或远端 Git 操作。
- 2026-10-08：供 06 复用的主进程边界已落定：`BackendHost.requestJson(options: JsonRequest): Promise<{ generation: number; data: unknown }>`、`getConnectionGeneration(): number | undefined`、`restart(): Promise<boolean>`、`prepareConfiguration(): Promise<boolean>`。`JsonRequest` 含 method/path/body/signal/timeoutMs/maxResponseBytes；路径仅由具名 main 模块构造，token 留在 main，共用限量/超时/取消逻辑，成功和失败异步结果均复核目标与代次。generation 只代表验证连接，不是 owner UUID 证据。restart/prepare 共用同一原目标认证停读；prepare 成功后 disconnected 不自动连接，失败保留 target/shutdown-failed。构造器可选 `beforeConnect(config, canStart): Promise<void>`，await 后复核 canStart，restart 仍走 initialize；本候选未临时借入 03 gate，联合验收由 03 正式合入后补做。
- 2026-10-08：可复用真实测试夹具为 `desktop/tests/setup-fixture.ts`：当前工作树后端、Conda NotAlone、独立配置/握手/userData、随机迁移 `_test` PG、受控解释器重读本轮配置；HTTP 延迟夹具只控制真实后端传输。源码截图与包截图保留于本工作树 `desktop/artifacts/`，App 产物为 `desktop/out/NotAlone-darwin-arm64/NotAlone.app`，均未加入提交。详细命令与原始失败位置见 `desktop/artifacts/setup-verification.md`。
- 2026-10-08：两轴初审后，主 Agent 在本任务既定身份与恢复边界内明确 create_only 原子保护、显式重载及失败刷新后的有效性校验，供实现者修复三项 P2 行为缺口；本项不授权自动恢复其他身份。
- 2026-10-08：已合入范围补充 `afe40b0fb6a60c3e1f1e656c8adde8ab75cde9a2`，修复候选以旧候选 `1b45b65aa5aed5dc8ea7000fda9974cbb5fe9f52` 为固定增量评审基点，继续 claimed。三项 P2 均先在实际 App/真实 HTTP/随机迁移 PG 证明 red，再修正：初始化响应丢失后提供具名明确重载；App 固定 create_only，现有 owner 表事务内互斥检查与创建，冲突返回 409 且拒绝前不写配置，既有明确恢复仍 created:false；本人和密钥写操作共用保存生命周期，失败恢复查询结束后复核连接代次与操作，较新状态或断线不会被旧错误覆盖。
- 2026-10-08：修正后的 `npm run typecheck` 与完整源码 `npm test -- --output=artifacts/review-full-source` 56/56、Python setup/认证停读兼容 22/22 通过；`npm run package` 内置严格 ad-hoc 签名校验通过，重建包的首启/恢复/并发/窗口组 20/20 通过。最小 green 组分别为响应丢失恢复 1/1、失败刷新失效与恢复 4/4、并发保护 2/2；新增本人写失败失联场景也由最终源码与包覆盖。首次恢复 green 尝试曾因传输代理早于真实旧后端退场而失败，修正为等待自建上游进程正常退出后才关闭代理，再通过；详细红例、失败与命令保留在未提交的 `desktop/artifacts/setup-verification.md`。
- 2026-10-08：末次只读清理核对为随机首启测试库 0、本工作树 App 进程 0、受控首启后端进程 0；不清理他人资源。新增 `SetupBridge.reloadControlledConfiguration(): Promise<void>` 只允许管理后台从未绑定状态明确重读受控配置，不传入路径或身份。Host 的 requestJson/getConnectionGeneration/restart/prepareConfiguration 与可选 beforeConnect 签名保持，03 联合 gate 验收仍待正式合入。不新增表、迁移、模型调用、业务读取范围或外部消息。
- 2026-10-08：主 Agent 对固定 `aa95d0706c0d1b87a5f1a429bafc35484020e6cd` 的增量两轴复审通过：Standards 0 硬违规/0 新增判断，原重复代码建议已解决；Spec 缺失/越界/偏差各 0，原三项 P2 已修复。按确认补 Answer 和 resolved，只提交任务完成记录；保留忽略产物及真实失败证据，03 联合 gate 待后续，不重复已绿的 56/22/20 验证。
