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
