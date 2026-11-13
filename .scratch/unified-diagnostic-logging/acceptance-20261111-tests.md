# 统一诊断日志：最终后端验收（2026-11-11 至 2026-11-12）

本轮重新执行全量后，完成11个图片资格／生命周期用例的逐项固定版本对照及私有夹具因果验证。当前仓库图片文件未修改。

## 本轮运行点

- 全量与逐项命令的当前 HEAD 均为 `9304b8cece0f0b8f922231b6cb5af81b6bd3b016`。
- 工作区原有三处未提交修改保留，未修改、提交或还原：`backend-ts/test/sqlite-memory-adjudication-evidence.test.mjs`、`desktop/src/renderer/SqliteMemoryManagementPanel.tsx`、`desktop/tests/sqlite-memory-management-view.test.mjs`。
- 全量开始／结束及逐项验证结束后，图片资格测试、生命周期测试和图片规范化源码的 SHA-256 均一致。
- 未安装依赖、访问真实库、联网请求、操作 App、打包或执行远端操作；没有仓库提交。
- 全量真实退出码 `1`；墙钟 `312.962` 秒；原始输出权限 `0600`，不复制图片字节、业务正文、凭据或堆栈。

全量实际命令：

```bash
cd backend-ts && perl -e 'alarm 600;exec @ARGV' -- pnpm test
```

## 新全量结果

| tests | pass | fail | cancelled | skipped | duration_ms |
| --- | --- | --- | --- | --- | --- |
| 2301 | 2288 | 11 | 2 | 0 | 312677.753541 |

## 逐个未通过用例

| 测试名 | 来源 | 本轮失败类型 | 分组 |
| --- | --- | --- | --- |
| 已保存的标准图或高清图带入记忆模型 | `test/sqlite-memory-image-eligibility.test.mjs:36` | 断言：发送图片数0≠1 | image-eligibility |
| 图片清除后擦除实际看过旧图的记忆与追踪，同联系人独立文字保留 | `test/sqlite-memory-image-lifecycle.test.mjs:103` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 图片替换后擦除实际看过旧图的记忆与追踪，同联系人独立文字保留 | `test/sqlite-memory-image-lifecycle.test.mjs:103` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 实际图片证据可采纳为记忆，清除图片同时擦除图片引用和记忆正文 | `test/sqlite-memory-image-lifecycle.test.mjs:125` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 替换图片后历史自动队列会重新处理新文件版本 | `test/sqlite-memory-image-lifecycle.test.mjs:138` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 替换图片后增量自动队列会重新处理新文件版本 | `test/sqlite-memory-image-lifecycle.test.mjs:138` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 在途图文模型被清图中止，排空后不保留旧图追踪或重发未知调用 | `test/sqlite-memory-image-lifecycle.test.mjs:162` | 取消：test timed out after 10000ms | image-lifecycle |
| 在途图文模型被换图中止，排空后不保留旧图追踪或重发未知调用 | `test/sqlite-memory-image-lifecycle.test.mjs:162` | 取消：test timed out after 10000ms | image-lifecycle |
| 图片记忆无旧资料时可自动采纳，后续图文关系比较保留带类型来源并安静待确认 | `test/sqlite-memory-image-lifecycle.test.mjs:185` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 图片记忆与文字候选主题不同时不拦截自动裁决，主题相同才保留待确认 | `test/sqlite-memory-image-lifecycle.test.mjs:204` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 图片来源沿正式记忆、场景文档、回复及受管运行记录完整删除 | `test/sqlite-memory-image-lifecycle.test.mjs:232` | 断言：联系人任务 memory_extraction_failed | image-lifecycle |
| 官方DSH和真实ModelHost端口：用途、凭据、最终预算、未知禁重发与迟到资格 | `test/sqlite-memory-model-port.test.mjs:66` | 断言：实际image/jpeg，预期image/png | model-host |
| 正式SQLite profile的图文后台在途时前台已到共享供应商，来源图片和统一台账保持隔离 | `test/sqlite-reply-background-concurrency-profile.test.mjs:44` | 断言：实际规范化JPEG，预期原PNG字节快照 | profile |

## 图片组逐项固定版本对照

- 诊断前：`57b0c1611^`，独立解析为 `33b66ca7c3f68792a3088205c2dfef494f7cb257`。
- 当前：`9304b8cece0f0b8f922231b6cb5af81b6bd3b016`；直接运行当前工作区单例。
- 外部图片因果版本：`1f8f647043ab887685fefd8359e639567c0a7d3e`。
- 两个旧版本使用各自 `git archive` 导出的完整 `backend-ts`、根 `package.json` 和 `pnpm-lock.yaml`；真实临时目录 `0700`、文件 `0600`，仅将依赖目录链接到现有 `backend-ts/node_modules`；不安装。
- 全部单例使用同一 Node `v24.22.2`。两个图片测试文件在三个固定版本逐字相同（SHA-256 已核验）。
- 总指挥明确释放十次启动采样的独占窗口后才开始归档和逐项运行。每一行三树均实际执行，不以代表用例外推。

每项实际 argv 结构如下；测试名取下表完整名称，正则按完整名称转义并加首尾锚点，文件取上述来源列（移除行号）。

```bash
perl -e 'alarm 60;exec @ARGV' -- node --test --test-name-pattern='^<测试完整名称>$' test/<对应文件>.test.mjs
```

单元格格式为 `exit;pass/fail/cancelled`；每次仅运行该一个匹配用例。

| 测试名 | 诊断前33b | 当前9304 | 图片1f8 | 1f8仅修私有夹具 | 当前／1f8共同原因 |
| --- | --- | --- | --- | --- | --- |
| 已保存的标准图或高清图带入记忆模型 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：发送图片数0≠1 |
| 图片清除后擦除实际看过旧图的记忆与追踪，同联系人独立文字保留 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |
| 图片替换后擦除实际看过旧图的记忆与追踪，同联系人独立文字保留 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |
| 实际图片证据可采纳为记忆，清除图片同时擦除图片引用和记忆正文 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |
| 替换图片后历史自动队列会重新处理新文件版本 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |
| 替换图片后增量自动队列会重新处理新文件版本 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |
| 在途图文模型被清图中止，排空后不保留旧图追踪或重发未知调用 | `0;1/0/0` | `1;0/0/1` | `1;0/0/1` | `0;1/0/0` | 取消：10000ms等待未进入的图文模型 |
| 在途图文模型被换图中止，排空后不保留旧图追踪或重发未知调用 | `0;1/0/0` | `1;0/0/1` | `1;0/0/1` | `0;1/0/0` | 取消：10000ms等待未进入的图文模型 |
| 图片记忆无旧资料时可自动采纳，后续图文关系比较保留带类型来源并安静待确认 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |
| 图片记忆与文字候选主题不同时不拦截自动裁决，主题相同才保留待确认 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |
| 图片来源沿正式记忆、场景文档、回复及受管运行记录完整删除 | `0;1/0/0` | `1;0/1/0` | `1;0/1/0` | `0;1/0/0` | 断言：联系人任务 memory_extraction_failed |

共完成33条原始三树单例、11条私有夹具单例；两项10000ms取消保留为 `cancelled`，未归为断言失败。

## 逐项共同因果证据

1. 旧夹具仅由类型校验替身声明 `containerValid/viewable`，没有真实解码：`backend-ts/test/sqlite-memory-image-eligibility.test.mjs:11`、`:16`；`backend-ts/test/sqlite-memory-image-lifecycle.test.mjs:18`、`:23`。两常量分别70和68字节，同一图片规范化函数均实际拒绝。
2. 外部图片提交 `1f8f64704` 为记忆输入加入实际规范化调用：`backend-ts/src/memory/content/image.ts:43`。规范化在 `backend-ts/src/platform/models/image-normalization.ts:49` 至 `:51` 实际解码并转JPEG；两个旧PNG常量无法完成该步骤。因此资格用例没有向模型发送图片，8项生命周期用例转入 `memory_extraction_failed`。
3. 两项在途用例只在模型回调开始后释放门闩；`backend-ts/test/sqlite-memory-image-lifecycle.test.mjs:164` 定义门闩、`:174` 等待它。图片准备先失败，模型没有进入，故分别到10000ms取消；不是日志引起的业务请求超时。
4. 为直接隔离夹具因素，仅在1f8私有副本把上述两个常量改为 `sharp` 生成的可解码2×2合成PNG；保留全部生产源码、日志实现与其它测试内容。改正图片均被同一normalizer接受，11项逐个实际通过（每项exit0/pass1/fail0/cancel0），包括原两取消项。生产 `src` 整树哈希前后一致。
5. 上述每一个用例均在外部图片1f8与当前树同因失败／取消，在保留1f8全部生产代码的夹具因果验证通过。该组由图片规范化引入后的旧夹具未迁移解释；没有把诊断前通过这一事实单独当作排除日志回归的证据。

## 清理与剩余风险

- 两份临时源码副本及逐项原始输出均已删除，删除前已核验目录0700／文件0600；仅保留不含业务资料的统计、命令及哈希。主Agent已亲读全量原始统计和逐项JSON，核对后删除含准备阶段细节的原始全量输出，只保留0600统计输出、退出码和原始输出SHA-256。
- 当前仓库这11项仍红；本任务不修改外部图片生产／测试文件。私有夹具通过不代表当前全量通过。
- ModelHost和正式SQLite profile另2项由Standards负责人独立对照；本记录未冒领其旧结果。其本轮全量失败名、位置和类型已逐项列出。
- 本验收只使用合成资料和现有依赖；不涵盖图片生产逻辑的其它缺陷，也不替代实际 App 的独立验收。

主Agent复核补充：逐项读取并断言33条三树记录与11条夹具控制记录，每个用例在三树各有一条实际执行，诊断前pass1，当前与图片树fail/cancel逐项相同，私有有效夹具pass1。另已读取完整新全量footer：2301/2288/11/2/0，exit1。两特殊项的六次固定版本及四次双向控制由主Agent独立读取纯统计核对，结果与特殊验收记录一致，不是只采用子Agent结论。
