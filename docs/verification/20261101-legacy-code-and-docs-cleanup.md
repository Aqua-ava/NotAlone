# 2026-11-01 旧代码与文档清理

## 范围与判断规则

基线：`4d25443ad2e14f8292df18623a011bbcca6be1ec`。本次核查当前启动入口、静态及具名动态引用、package scripts、profile、测试发现规则和后继 ADR；不是按文件年龄或单次无搜索命中批量删除。仅处理有充分证据的孤立实现及误导性文档状态，不修复另一次审查发现的业务问题，不改依赖、业务资料或远端。

当前产品链为根 `pnpm run dev` → 桌面开发入口 → `backend-ts/src/launch.ts` → `profile/sqlite.patch.yml` → `sqlite-host-plugin.ts`。`launch.ts` 明确指定插件，不按源码目录自动发现插件。

## 可移除：本次已删除

| 文件／组 | 依据与替代入口 |
| --- | --- |
| `backend-ts/src/plugin.ts`、`host/business.ts`、`host/runtime.ts`、`host/service.ts`（后三者相对 `backend-ts/src/`） | 旧合成 validation 孤岛，仅组内引用，硬编码合成身份；当前 profile 和产品入口不装配。保留现行 `sqlite-host-plugin.ts`。 |
| `backend-ts/src/host/pure-ts-public-pages.ts` | 导出 `sessionReadPayload`、`candidateHistoryPayload`、`PublicTransportError` 没有消费者。旧 `read_part/read_id` 协议不在当前 SQLite HTTP 路径；现行讨论及候选适配器分别位于 `reply/sqlite/http.ts` 和 `reply/sqlite/candidates/http.ts`。 |
| `backend-ts/src/host/pure-ts-runtime.ts` | `pureTsRuntimeEnvironment` 没有当前调用或配置入口；不影响仍使用的 `pure-ts-events.ts`。 |
| `backend-ts/test/reply-service-runtime-support.mjs`、`assistant-runtime-faults.mjs`、`assistant-runtime-lock-holder.mjs`（后两者同目录） | 旧宿主辅助文件无当前测试调用；support 默认插件已不存在，faults 仅由该孤儿 helper 使用，lock-holder 无消费者。当前 runner 只发现 `*.test.mjs`，不会按目录自动执行这些 helper。 |
| `desktop/scripts/test-dsh-host.mjs`、`test-dsh-contact-context.mjs`（同目录） | 不在 package scripts、测试清单或动态发现路径；静态导入已删除的 `host-storage-fixture.mjs`，继续依赖退役 PG 账本和旧配置。未执行这些旧脚本。 |

共 11 个文件。删除前版本仍可从上述基线提交查询。历史测试 runner 从其登记的固定 Git 整树恢复；未改写历史清单，也不声称这些文件全部被 `test:historical` 登记或可直接执行。

## 仍在使用：明确保留

- `native/skill-read`：当前安全 Skill 读取、开发启动与后台测试依赖。
- `native/media-validation`：当前媒体校验、解码及测试依赖。
- `native/macos`：当前原生探针与测试入口；非云端可替代验证。
- `host/host-json.ts`、`host/host-reply-config.ts`、`host/pure-ts-events.ts`：现行 SQLite 及模型装配仍引用。
- 根／桌面／后台 README、CONTEXT、`architecture/current`、工作流文档、已采纳 ADR：仍是操作或设计入口，不能整目录退役。

## 应标明历史或修正当前状态：本次已调整

- 三份运行时、持续会话、记忆与 Skill 草案：纠正“迁移未实现／尚未开始”的当前口吻，指向已存在的 TypeScript／DSH 说明；保留旧方案及后继 ADR 边界。
- `architecture/current/memory-extraction-trace.md`：旧 Python 实现表标为历史，新增 SQLite 执行与追踪、切换记录入口；保留上文来源和隐私要求，不把历史验收改写成当前通过。
- `architecture/current/privacy-deletion.md`：旧追踪服务／页面状态标历史；受管 PG 实现引用替换成当前 SQLite 开发核验；Skill 默认启用按 ADR-135 修正，并保留用户停用、来源撤销和冲突边界。
- `architecture/current/domain-data.md`：前台瞬时投影引用指向现存 `ForegroundObservation` 类型。
- 两份旧环境／微信接入排障记录：加历史版本提示，不删除当时的命令、范围或结果。
- `desktop/prototype/README.md`：标明独立原型而非当前 Electron 产品界面；`prototype:replies` 仍可显式调用，不删除。
- 根 README：不存在的迁移采集 JSON 改为明确的历史证据标识，另链现存说明；没有伪造或重新生成该证据。

## 不确定或有追溯价值：保留原因

- 未发现足以整份删除的 Markdown。已采纳／被替代 ADR、冻结评测、调研和旧任务仍可能承担决策、来源摘要或历史运行引用。
- `experiments/hindsight` 已明确为冻结历史证据；非当前服务不等于可丢弃。
- `.scratch` 中未随当前检出提供的材料、私有证据与旧源码链接，不补造内容、不把缺失解释成需求已撤销。
- 原生 README 中旧 locator 任务链接等未确认替代的引用保留待核查；本次只修正已确认的当前入口错误。
- Markdown 扫描只检查内联本地路径，不检查锚点、引用式链接或语义正确性。基线 432 个缺失路径命中，修改后 429 个；无新增缺失。剩余命中混有历史源码、未提交证据及待核查引用，不能宣称全部有效或全部可删除。

## 验证

- 新增退役名单与必须保留模块的回归断言。删除前该断言失败；删除后 `node --test backend-ts/test/sqlite-cutover-retirement.test.mjs desktop/tests/test-inventory.test.mjs` **10/10 通过**。
- `node backend-ts/test/run-current.mjs --list`：170 个当前测试、90 个历史登记；只枚举，不执行。
- `node backend-ts/test/run-historical.mjs --list`：214 个文件、27 个用例；只枚举，不执行旧代码。
- 源码相对 import 路径扫描：`backend-ts/src` 与 `desktop/src` 无未解析的本地路径。该检查是正则路径核对，不等同 TypeScript 编译。
- 包配置直接 Node 脚本入口仍存在；本次无 package／锁文件修改。
- Markdown 相对路径检查无新增缺失；`git diff --check` 通过。
- 公开历史检查基线及本轮实现提交后检查均通过（0 issues）；执行命令为 `node scripts/check_public_history.mjs --ref HEAD --working-tree`。

### 既有问题及未执行验证

桌面真实测试清单仍有 5 个既有漏登记文件，默认测试入口会报错；本次没有通过删除这些现行测试来掩盖问题，也未将其混入旧代码清理。缺少已安装 DSH 等依赖，未运行 typecheck／全量后台集成测试。未安装依赖、构建产品、启动 Electron／微信、调用真实模型、修改用户资料或推送远端。安全源码测试通过不代表原生或端到端验收。

## 第二轮：继续核查（基线 51b75c84）

第一轮已正常快进推送到 `main`；本节记录其后的独立清理批次，不能把第一轮推送结果当成第二轮已发布。

### 已移除的 14 个文件

| 文件／组 | 证据与保留边界 |
| --- | --- |
| `memory/overview/evidence/{semantic,legacy-semantic,legacy-grammar}.ts` | `reverifySemantic` 无当前调用，后两文件仅供该孤岛使用。当前提取核验用 `memory/extraction/verification/bounded-proof.ts`；`bounded-body/graph/contract.ts` 仍被正式代码导入，保留。 |
| `memory/processing/reason.ts` | `processingReason` 仅定义。当前处理 API 与桌面投影走 SQLite HTTP 和 fixed-processing，不加载该文件。 |
| `memory/records/documents/target.ts` | 导出没有外部消费者。当前文档阶段冻结由 `memory/sqlite/documents/{inputs,stages}.ts` 负责。 |
| `reply/generation/{reply-candidate-prompt,reply-prepared-schema,reply-prompts}.ts` | 旧提示常量及 prepared schema 无当前消费者。当前普通讨论与候选各自构造系统提示；仍被宿主引用的 `reply-execution-budget.ts` 保留。 |
| `skills/skills-root.ts` | `resolveSkillsRoot` 仅定义；现行宿主使用 `capabilities.skillPackageRoot` 创建受控 Skill 库。 |
| `sync/{sync-incremental-cli-stream,sync-incremental-cli-history,sync-incremental-normalize,wechat-scope-json}.ts` | stream 和两个 CLI 解析文件形成无外部消费者的孤岛，scope JSON 导出仅定义；正式同步使用 SQLite 增量协调器。保留正在使用的 `wechat-http-body.ts`。 |
| `desktop/src/renderer/SourceDeletionPanel.tsx` | 唯一挂载页 `ImportPage.tsx` 已在 `52ab1a6f` 删除；当前无导入、测试或动态挂载入口。来源删除 main/preload/shared API 仍在使用并保留，不能因面板孤立而一并移除。 |

除最后一项外，上表路径相对 `backend-ts/src/`。文件名、公开符号、配置、测试、具名动态引用与当前 SQLite 入口共同核查，不以孤立的静态图结论单独作删除依据。

唯一指向本轮删除文件的 Markdown 引用在 `.scratch/wechat-media-extraction/spec.md`；已改为历史快照并标明当时结论，不篡改旧规格。固定历史测试清单未修改。

### 文档对齐与历史来源

- Skill 库文档不再把 Python／LangChain 写成当前实现，也不指示在当前树执行旧 Python 测试；指向 SQLite Skill 说明及后台验证入口。
- 原生 README 对齐实际 `automatic-header-v4` 输出及 ADR-132，明确顶部名称、v4 文字回退、旧 v2 各自质量规则；没有取消质量门或修改探针代码。
- 桌面 README 按 ADR-136 修正多 Skill 组合说明；旧 JSONL 正常导入和首次连接自动授权全部私聊的段落标为历史，当前入口按 ADR-142 选择联系人再授权。
- 旧 Python 追踪／排障源码链接使用已核验 Git 快照 `23a76733`；旧规范化实现引用第一轮基线 `51b75c84`。快照可定位旧代码，不等同每条历史日期的验收版本，也不代表当前运行。
- 原生 README 的缺失任务链接改为现存采集源码与安全测试入口，明确源码不替代历史或当前实机验收。

### 继续保留

- `BackgroundTasksPanel.tsx` 虽没有普通组件导入，却有 esbuild 字符串测试入口，保留。
- `measure-desktop-state.mjs` 是独立合成 benchmark；无产品调用不足以证明废弃，保留。
- quarantine、diagnostics、model-host 与来源删除桥接均有当前调用，保留。
- 范围内缺失的 `.scratch` 资料对应“停止跟踪 .scratch 本地资料并保留历史”的提交 `553b6698`；不擅自恢复、删除历史需求或批量改成其他版本的规格。
- 没有删除 Markdown 整篇或重新生成历史评测证据。

### 第二轮验证

- 新增孤立模块退役／活跃依赖保留断言；删除前失败、删除后与现有清单单测合计 **11/11 通过**。
- 相比第二轮基线，内联本地路径缺失 **429 → 397**，无新增缺失；**29 条固定 SHA 源码链接、24 个唯一 Git 对象路径全部存在**。只验证本地 Git 对象及相对路径，不声称已联网检查每个网页、锚点或每条历史验收。
- 运行源码相对 import、package 入口及 `git diff --check` 继续核对；未变更 package 或锁文件。
- 原有 5 项桌面测试清单漏登记和缺少安装依赖的验证限制继续保留；未启动原生 App、微信、真实模型，也未修改业务数据。

### 后续补充验证（f991f948）

以上“缺少安装依赖／未运行 typecheck”保留为当时状态。随后执行 `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir ../notalone-pnpm-store`，冻结锁文件且不执行安装脚本；package 清单与锁文件未变化。已核实安装及编译日志：`pnpm run typecheck` 的后台和桌面 `tsc --noEmit` 均完成，解除此前缺依赖及未编译的验证限制。

相关验证按不同测试计共 **26 项：25 通过、1 项环境阻断**，不重复计数安装前后的重跑：

- 仓库根运行 `node --test backend-ts/test/sqlite-cutover-retirement.test.mjs desktop/tests/test-inventory.test.mjs`：11/11 通过。
- 在 `backend-ts/` 运行 `timeout 45s node --test --test-name-pattern='未经确认|预算只投影|完整Messages|第二轮工具|真实配置漂移|工具选择必须' test/model-ledger-contract.test.mjs test/model-input-budget.test.mjs`：6/6 通过，未选择需要模型适配器的 HTTP 用例。
- 在 `desktop/` 运行 `timeout 30s node --test --test-name-pattern='只复用当前项目|已有打包宿主|常用启动入口|孤立宿主|开发 CDP' tests/development-policy.test.mjs`：4 通过，1 项合成开发租约测试因 Unix socket 监听被环境以 `EPERM` 拒绝而阻断；清理前 `4d25443a` 的同一用例亦复现该限制，未提权或改写测试规避。
- 在 `backend-ts/` 运行 `timeout 45s node --test --test-name-pattern='来源删除立即封禁旧写入|文件身份错误不误删替换件|错误owner目标|联系人和账户删除清理' test/sqlite-deletion.test.mjs`：安装依赖后 4/4 通过，取代此前缺少 DSH 导致的 `worker_failed`，覆盖隔离临时库中的删除围栏、文件身份保护、所有者隔离和墓碑。

这些是有界的相关验证，不是全量测试或 CI 通过证明；原有 5 项桌面测试漏登记及上述 socket 限制仍保留。未运行真实 App／微信、原生构建或真实模型，未接触或修改用户业务资料。

## 第三轮：旧宿主辅助文件与当前状态校准（基线 f991f948）

### 有依据的清理与保留

本轮移除以下 7 个孤立文件：

- `backend-ts/src/memory/records/json.ts`
- `backend-ts/test/diagnostic-scenario-budget-plugin.ts`
- `backend-ts/test/extraction-model-plugin.ts`
- `backend-ts/test/host-model-network-guard.mjs`
- `backend-ts/test/stalled-tool.ts`
- `backend-ts/test/pure-ts-provider-fixture.mjs`
- `backend-ts/test/main-host-reply-chain-preload.mjs`

旧消费者已随 `b3830bf6` 的 PostgreSQL 退役清理移除；本轮同时核对静态引用、动态 profile、`--import` 预加载链及测试入口，不以普通 import 搜索为空作为唯一依据。历史整树 runner 与固定历史清单继续保留，不恢复旧执行栈到当前默认入口。现行 JSON 处理、SQLite HTTP、模型夹具和 profile 支持入口保留，并以退役／保留清单断言约束。`prepare-memory-desktop.mjs`、`prepare-memory-management-desktop.mjs`、`prepare-skill-desktop.mjs` 等独立手工验收 helper 不因无普通调用而删除；`prepare-visual-desktop.mjs` 同样保留。

### 文档校准

- 架构索引、ADR-128、现行核心流程与隐私文档区分“去重及旧正文副本清理已实施”与“撤回状态的新展示／使用规则暂缓”，不将实现存在写成所有用户数据已迁移或实机验收通过。
- SQLite 历史 README 对齐重复读取复用来源及版本 22 的单正文副本迁移；按 ADR-131 修正历史覆盖未完成时的生成资格，仍冻结实际覆盖与限制，不扩大读取授权。
- 桌面 README 将 PostgreSQL 测试准备及旧文件导入／来源管理步骤明确标为历史，保留数据保护说明，不暗示当前提供静态加密。

### 第三轮验证

- 删除后 `pnpm run typecheck`：后台、桌面两端 `tsc --noEmit` 均通过。
- `node --test backend-ts/test/sqlite-cutover-retirement.test.mjs desktop/tests/test-inventory.test.mjs backend-ts/test/sqlite-single-text-copy.test.mjs`：**13 通过、0 失败、0 跳过**，覆盖退役／保留清单、测试清单校验器及单正文副本合成迁移；不是完整桌面测试清单通过。
- 相对第三轮独立基线 `f991f948`，1,987 条 Markdown 内联本地路径中既有缺失 **397 → 397**，无新增；29 条固定 SHA 链接、24 个不同 Git 路径全部存在。未检查远端网页、标题锚点及 reference-style 链接。
- 运行源码相对导入候选 1,995 条，无缺失路径；此正则检查含字符串字面量动态 import／require，但不证明变量构造动态路径或完整运行可达性，不能替代上述编译。
- `git diff --check` 通过。提交前 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 通过，0 issues；覆盖当时 HEAD 的 3,114 个历史提交、22,744 个 blob 与当前文件，不等同新提交生成后的检查。
- 本轮未安装或升级依赖，未运行 App／微信、原生构建或真实模型；既有桌面测试漏登记及 socket 环境限制未在本轮修复。补充验证与前两轮结果分别报告，不把重复执行累计为新增覆盖。
