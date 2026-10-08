# 05：首启身份与模型配置

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 02
Spec: ../spec.md

## 交付行为

空白环境通过管理后台初始化本人并配置 DeepSeek，已有配置可以复用。

覆盖规格用户故事：5、6、7、47。

## 验收条件

- [ ] 沿用已有 setup/credentials 公共接口，展示首次配置及已配置状态，并处理必要的后端重连或重启。
- [ ] setup/status 的只读 runtime_owner_configured 验证当前实例身份在库中存在；全库已有其他 owner、缺失或不存在的运行身份不得被显示为本次配置完成，也不自动恢复他人身份。
- [ ] App 首次初始化使用 create_only，在服务端原子检查与创建边界内拒绝并发出现的既有身份，拒绝发生在写受控配置之前；保留原有明确恢复调用的语义。
- [ ] 初始化已写库和配置但响应丢失时，可显式重新加载受控配置；通过同一已验证目标认证停读再重启，不猜测身份或另启读取实例。失败刷新结束后再次验证原连接和操作，过期错误不覆盖新状态。
- [ ] 密钥仅由受控提交路径传递，提交后清空输入，不回显已有密钥，不写入诊断日志。
- [ ] 说明模型调用范围和本机存储事实，不宣称尚未实现的加密；用合成 owner 与隔离配置验收。

## 测试与范围

- 当前运行身份字段是本任务已批准首启就绪行为所需的最小公开契约补齐：由服务端受控 owner_id 注入同库存在查询，保留原三布尔字段的含义；不返回 owner_id/密钥，不接受客户端指定 owner，不新增表、迁移或身份合并。覆盖空库、正确运行身份、其他 owner 与不存在 UUID 的真实 HTTP/PG 场景。
- create_only 是既定禁止自动恢复他人身份所需的最小初始化保护，复用当前数据库事务和现有接口，不新增业务表或迁移。以真实 HTTP/PG 验证两个受控客户端并发初始化仅创建一个身份、失败方不改写配置，以及既有明确恢复仍可用；以实际 App 验证响应丢失后的显式重载和恢复查询期间断线不发布旧错误。
- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

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
