# M2测试基底修复与实际缺口

范围：固定M2 `08c4d48e719353492f37620f4fb2aabd8710efc6` 的测试支持修复，不领取或提前签收正式15，不改变产品、原生源码或main。来源是首批01/02实施时暴露的既有失败，三项均由主集成在尚未合入产品成果的独立树复核。

## 正式单帧计量缺失

M2的两处TypeScript引用依赖未提交的`observation-measurements-fixture`。Git树与可达历史没有该文件。已提交的[原验收记录](../../foreground-contact-follow/acceptance-06-final-20261015.md)说明测量夹具和原生计量修改仍在当时未提交快照；其历史计数不证明固定M2源码包含这些设施。

正式`AutomaticSessionCapture.observeHeader`没有capture请求、完成、帧、header OCR四项计数协议；独立持续源的`HeaderChangeDiagnostics`也不是正式单帧计量。不能根据recognized/paused状态或源码预期填1/0，不能从其他会话未提交文件取回快照。

本次只补明确不可用的测试适配器：prepare/read及能力检查统一抛`native_observation_measurements_unavailable`，不读环境或目录，不写installed、sitecustomize、计数或任何hook。显式视觉验收在租约、私有范围和数据库准备前失败；默认关闭和旧入口路径保持。实际原生计量尚未恢复，必须单独取得已提交实现及运行证据；本次不尝试原生修改或实际验收。

原第五项“受控Python启动器安装测量器”没有被恢复；改为能力缺失的公开夹具回归，证明失败早于资源操作且不留下文件。前四项证据判定/默认关闭合同保留。合成5项通过仅表示4项合同及1项能力缺口保护通过。

## 有界队列夹具

`assistant-generation-preparation.test.mjs`的一项用例将五类不同命令和legacy/live/实际回执/当前请求一次放进同owner队列，在第九项先触发生产八项上限，未到预期的关联断言。固定M2产品上15项中14通过、该项失败。

本次每类命令使用新的真实队列，仍逐项验证不同task/input/action/suggestion/operation、跨连接、legacy、live和实际回执不会被未领取证明错误释放。不提高生产上限，不减少待核对对象种类。

## 替换失败公开错误

固定M2的公开replace入口将`ReplyError`映射为500 `reply_generation_failed`，既有替换重试测试仍期望`internal_error`。使用新建随机合成_test库、正式001–058迁移和生产HTTP/脚本模型复现该精确断言失败，未修改产品。

将期望对齐已实现公开错误后，同一用例继续验证新键第二次attempt成功、旧租约/旧键不能复活、失败状态、幂等重放，1/1通过。失败旧模型的存储失效日志是合成晚返回反例，不包含正文；未调用外部模型。

## 实际验证

- 独立树离线安装锁定缓存依赖：`npm ci --offline --ignore-scripts`，不执行安装脚本或App。
- `npm run typecheck`：通过；原2个缺模块和2个衍生any已消除。
- `node --test --test-reporter=dot tests/assistant-generation-preparation.test.mjs tests/real-sync-visual-independence.test.mjs`：20项通过，无App/CLI/探针/Python启动。
- 后端先激活Conda `NotAlone`，关闭dotenv，仅设置本轮合成库。通过`python -m notalone.database_migrations --migrations database/migrations`迁移，然后运行`tests.integration.server.test_assistant_generation_replacement.AssistantGenerationReplacementHttpTest.test_failed_replacement_retries_the_same_new_key_without_reviving_the_old_lease`：原断言失败1项，修正期望后1/1通过。
- 临时复验脚本初次准备曾遗漏必填迁移参数、backend模块路径及超过PG标识符63字节上限；均在实际行为前失败。已修正命令和库名长度断言，每轮自有库均在finally删除，没有触及默认库或业务库。
- 本报告未声称完整npm test通过；需在无头页面调度释放后单独跑完整安全组。真实视觉测量、App/微信、真实CLI/模型、S库及业务升级均未执行。

数据影响仅为测试源码和工程文档；创建并删除自有合成库，未改变迁移或业务数据。新计量实现、真实运行配置与端到端签收仍是缺口，不以静态检查代替。

## 独立审查与集成

固定候选`8a93c40e726f3158e797eaa687fbd17c00c3c832`已分别完成Standards与Spec独立审查，两轴均为0项发现。按原范围合入`codex/memory-skill-integration`，仅包含上述测试基底和相应工程记录；正式15仍为open，验收标准与任务图未改。本次合并执行`git diff --cached --check`，没有重新调度测试；主集成另在来源工作树运行完整npm组，其结果独立记录。

合并时只读观察到main在固定M2之后另有`e47ad396`（4个验收文件）及`6ce64a7e`（后台CLI与视觉观察独立性的3个后端文件）。本候选仍以`08c4d48e`为产品基座，未吸收这两项新增，也未改动main；它们的行为与证据不计入本候选通过范围。

## 集成后补验

测试基底已由合并提交`64930dee`进入独立集成分支。随后在同一固定来源树、Conda `NotAlone`且dotenv关闭环境执行完整`npm test`：类型检查通过，安全调度65/65项通过、0失败、0跳过，Node组21.846秒。该默认安全清单没有包含全部桌面测试；另行执行的20项合同也不混作默认清单成绩。

macOS安全组包含自有探针快照的编译及签名校验/搬运，不执行探针二进制、不启动浏览器、Electron、微信或App，不构建正式App包。通过不代表原生计量、签名identity/TCC、联系人身份或真实CLI/App集成通过。安全组退出后无头页面调度才交给01，避免与其共享状态并发。
