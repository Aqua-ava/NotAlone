# 02 桌面状态优化结果

State: resolved

目标已通过 `create_goal` 实际建立（无预算），范围为本 issue 的草稿传输、记忆页离页轮询和 Skill 稳定状态发布。基线为 `681fcc38eab77c8fe149b76705419971f3750a86`（产品基线 `abd65e6c` 加规划文档）。

- 本地分支：`codex/desktop-state-opt`。
- 受管工作树：`desktop-state-opt/NotAlone`；从本聊天 `list_artifacts` 获取绝对位置。
- 实现提交：`9e8f8d9c`；独立审查后的并发修复：`cf08f92f`。
- 未 push、创建远端分支或 PR、打包或运行打包版。默认测试清单由 05 负责。

## 实际变更

`contacts/session.ts`、`contacts/bridge.ts`、共享协议及 preload/renderer 改为草稿小包：事件和 invoke 确认只带修订、范围、选中联系人和草稿。初读、目录、联系人切换、断连及删除清草稿仍为完整快照。接收器拒绝旧修订和跨范围回包，并保留初读回包之前到达的新草稿。内部领域监听仍收到完整状态，未宣称消除所有目录克隆。

`memory/controller.ts` 和 `owner-layered.ts` 新增页面释放操作，经 manager 专用 preload 命令接入 React 卸载/范围变化。离页取消展示读取与定时器；来源删除监听保留。已经提交的写入及其权威复读继续结算。合法范围在写入或删除门禁内重入时先登记读取意图，门禁解除后权威刷新；原忙碌/删除错误继续拒绝立即读取。重入不会降低来源、连接或范围核验频率。优化针对页面卸载，不新增窗口隐藏状态的策略。

`skill-learning/controller.ts` 在发布前按显式变更字段深比较；语义相同时不增加 revision、不克隆广播。后端 GET、来源核验及错误/变化处理保持。

## 基线与候选证据

生产源码通过 esbuild 编译，基线从 Git 固定提交读取，候选直接读取本工作树；没有用替换产品方法的实验原型冒充候选。合成输入摘要、双方源码 SHA256、逐场景计数及等价断言见 [原始测量 JSON](evidence/02-measurements.json)，另有[基线源码摘要](evidence/02-baseline.txt)。测量经共享文件锁串行执行。

| 场景 | 基线 | 候选 | 含义 |
| --- | ---: | ---: | --- |
| 10 联系人，100 次输入 | 444,756 B | 80,856 B | 双窗口事件加 invoke 回包的累计 JSON |
| 100 联系人，100 次输入 | 3,711,756 B | 80,856 B | 同上，减少约 97.82% |
| 1000 联系人，100 次输入 | 36,921,756 B | 80,856 B | 同上；每次重建状态与 main 完整状态相等 |
| 联系人记忆页离开后 60 轮 | 60 GET / 60 发布 | 0 / 0 | 重入权威读取后状态相等 |
| 本人记忆页离开后 60 轮 | 60 GET / 60 发布 | 0 / 0 | 重入权威读取后状态相等 |
| Skill 稳定状态 20 轮 | 40 GET / 40 发布 / 18,258,559 B | 40 GET / 0 发布 / 0 B | 没有减少后端核验 |
| Skill 第 11 轮正文变化 | 40 发布 | 1 发布 | 每轮最终业务状态相等 |
| Skill 第 11 轮故障 | 58 发布 | 38 发布 | 错误/加载转换保留，每轮最终业务状态相等 |

这是操作次数和 JSON 体量代理，未测 IPC 实际序列化、输入延迟、CPU、RSS 或整个 App 延迟，因此不报告 p50/p95。当前没有为这些延迟指标建立测量证据。

## 真实验证命令与结果

以下从 `desktop/` 运行。源文件未修改第三方库 API，也没有调用外部模型。

```sh
npm run typecheck
node --test tests/desktop-state-optimization.test.mjs tests/layered-memory/view-release.test.mjs tests/layered-memory/view-release-react.test.mjs tests/skill-learning/*.test.mjs tests/layered-memory/controller.test.mjs tests/layered-memory/correction-caches.test.mjs tests/layered-memory/owner-deletion-opening.test.mjs tests/contact-restore-coalescing.test.mjs tests/workspace-local-draft.test.mjs
NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/desktop-interaction-view.test.mjs
node --test --test-name-pattern='本人保存后列表复读' tests/layered-memory/owner.test.mjs
```

类型检查通过，最终相关模块 **125/125 通过，0 skip**。额外 React 输入/Skill 慢 GET 两项通过；草稿事件改为生产 delta 后单跑 React 输入再次通过。原本人慢复读单例通过。新增离页套件 11 项覆盖写入在途、写后 GET 在途、重入、删除门禁、旧范围释放、disabled、断连和迟到响应；React 生命周期函数也实测卸载释放与重入读取。

计数脚本：`node scripts/measure-desktop-state.mjs`。实际运行使用 Python `fcntl.flock` 锁定 `/tmp/notalone-optimization-benchmark.lock` 后启动该命令，结果写入上述 JSON；没有测量运行时间。普通测试独立运行。

已覆盖：草稿初读竞态、旧修订/跨范围拒绝、清草稿通知、断连、当前输入立即用于生成、切换联系人、未保存编辑、Skill 来源/权限/错误/关闭动作、记忆页卸载及重入、来源删除后迟到数据不能复活、写入权威复验不被离页中断。

## 已复现的基线失败与缺口

- 旧 HTTP 夹具把 `migration_count` 固定为 89，当前基线真实返回 98：34 项都在业务断言前失败。使用同一 Conda 环境在临时固定基线工作树单跑“联系人 A → B → A”也为 `98 !== 89`；34 个合成数据库和基线单例数据库均确认清理。未修改这一跨任务夹具，也没有用这些失败声称生成/恢复 HTTP 验收通过。
- 基线有 5 项本人旧夹具只匹配 `/api/memories/owner`，而联系人范围生产读取走 `/api/contacts/<id>/owner-memories`，夹具错回分层资料，导致列表解析失败；另有 2 项旧文案正则失败。固定基线 20 项中 13 通过、7 失败，候选没有放宽来源合同或修改产品文案。它们交由 05 统一维护测试入口及夹具。
- 默认 npm test 清单、全量验证及实际 dev App/微信验收留给 05。本聊天未启动实际 App；工作树和共享主仓 `dev:status` 均为 stopped，未创建第二实例。

原始测试输出保留在仓库外，位置、大小和结果汇总见 [验证清单](evidence/02-verification.json)。首次公开检查指出原始日志含本机路径，故移出仓库；没有把这些日志提交进历史。

## Standards

独立审查最初未发现规范硬违反或单独需整改的 smell；发现本人写入期间离页重入丢刷新意图的 P2 正确性问题。`cf08f92f` 已修复，审查者独立运行离页套件 11/11 通过，定点复核未发现新问题。

## Spec

独立审查发现联系人在写入/删除门禁期间重入丢读取意图，违反“初读/重入必须权威刷新”。同一修复覆盖联系人及本人资料；无未要求的产品扩展。`cf08f92f` 定点复核确认已修复，独立运行离页套件11/11及另3个合成并发场景通过，未发现新增问题。

初审每轴各 1 项（同类问题），已修复；最终 Standards 0 项、Spec 0 项，均无未解决问题。

## 数据影响与资源

只改桌面进程内的状态传输、查看意图与订阅生命周期，不新增持久化、来源缓存、外部连接或授权范围。联系人确认、owner/contact 隔离、auto/manual、来源/时间/删除与人工发送边界保持。PG 操作仅来自原测试的隔离合成库，没有连接或迁移业务库，模型调用为 0。

没有创建开发服务、App 包、原生进程或预览页。无头 Chrome 均由测试 finally 关闭；两个临时基线源码目录已删除。复用依赖目录，不复制 439 MiB node_modules；没有新增 App/运行时构建缓存。小型 JSON 证据留在工作树，带本机路径的原始日志留在端侧临时目录；共享测量锁保留供其他实施聊天使用。
