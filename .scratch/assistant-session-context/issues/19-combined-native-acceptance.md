# 19：持续会话组合与真实App生命周期验收

State: resolved
Triage: ready-for-agent
Blocked by: [assistant-session-context/08 重新连接后恢复已保存会话](08-saved-session-recovery.md)；[assistant-session-context/09 用户删除一段助手会话](09-delete-assistant-session.md)；[assistant-session-context/13 连续要求、改口与明确编号指代](13-continuous-intent-reference.md)；[assistant-session-context/15 新消息提醒与用户触发重新生成](15-new-message-opt-in.md)；[assistant-session-context/16 切换会话或关闭小窗时保持生成归属](16-background-result-ownership.md)；[assistant-session-context/17 退出停止与重开后的中断恢复](17-quit-and-interrupted-recovery.md)；[assistant-session-context/18 显式携候选新开与满会话分流](18-carry-selected-candidate.md)

拆分标识：C13（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧06；Q1–Q18组合。读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置；本票合成交叉及有限源App生命周期验收已完成，原始失败与最终通过分别记录于Answer。

## What to build

组合验证双联系人、多会话、预算、修改及删除，再以有限真实App窗口核对关闭/退出/恢复。

## Acceptance criteria

- [x] 以双合成联系人、多会话串联恢复、版本、连续修改、消息更新、预算、新开及删除；仅增加组合场景，复用前票回归。
- [x] 验证多来源、后继候选及携候选的传递删除，重读/恢复/再生成不取得已删内容，无关讨论仍存在。
- [x] 按项目门禁在有限真实App窗口验证小窗关闭继续、真正退出停止及重开中断；记录实际命令、清理和原生结果。
- [x] 没有真实App证据时原生验收保持未完成，不能仅凭页面通过关闭本票；不读取微信、不恢复OCR、不调用外部模型。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

复用前票回归，仅增加交叉场景；无真实App证据时保持原生项未完成，不重复制造新功能。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-12：用户要求冻结新增功能，优先完成19／17收尾，能自行验证的先执行，OCR继续暂停。领取本票，只新增原规格的交叉验收场景，复用公开页面／具名生产桥接→HTTP→隔离PostgreSQL；合成联系人与受控模型，不读取真实微信或调用外部模型。原生停止／重开仍须工程要求的有限test:app窗口，本次先准备可审阅入口与检查点，未运行不勾选。

## Answer

最新结果（2026-10-12）：原6条验收全部达成，State resolved／ready-for-agent。下方准备、三次失败及授权等待均为历史实录；最终源App整场通过与精确清理见末尾，不抹去旧失败。

2026-10-12：自动范围完成，本票保持claimed／ready-for-human，待确认有限原生窗口。只新增验收用例、受限具名调度和记录；`backend/src`、`desktop/src`、原生产品源码均无变更，新增功能冻结。

- `desktop`在Conda NotAlone、PGHOST=/tmp、PGPORT=55441、dotenv和外部tracing关闭下执行 `npm run test:pages -- --case assistant-session-combination --timeout-seconds 240`，最后固定用例1／1、exit0。双合成联系人串联完整消息组编辑／保存／续改、其他联系人通知不串入、当前新消息显式采用、目录及公开页面重建恢复、完整100000码点历史预算拒绝、空新开与只携已选版本、原会话删除及携入副本清理。模型4次；恢复／提醒／预算拒绝／新开／携入／删除零自动增量，跨联系人及外来联系人读取404，乙的完整讨论保持。页面静默25次均active0／onscreen0，单Chrome，cleanupConfirmed=true；原生未运行。
- `backend`同环境执行 `python -m unittest tests.integration.server.test_assistant_combination -v`，最后1／1、3.700秒、exit0、模型5次。一个目标消息具有两份独立原始来源；删除第一份保消息而失效原候选及消费携入的后继，明确新请求可使用剩余来源，删除最后来源再清新候选／携入／后继。重读、旧键重放和依据读取不得恢复已删内容，独立讨论和另一联系人的完整会话保留；CURRENT被删除后清空，不自动回退或恢复旧意愿。实际正式迁移及随机库由既有FidelityHttpFixture创建／清理，类清理另查库不存在。
- 复用17原公开HTTP／生产Main退出来路，`node --test --test-name-pattern='^受控退出等待|^真实运行退出后|^真实已可靠完成|^真实来源删除先赢' tests/assistant-generation-quit-http.test.mjs`：4／4、16.267秒、skip0、三个模型调用，四份真实55迁移／repeat0／自有库0。
- `npm test`：完整TypeScript及40／40安全调度／helper检查、13.625秒、exit0；后续完整TypeScript及diff检查通过。安全检查只编译合成helper及仓库探针源码，不执行其二进制、OCR或App。

失败历史保留：首轮页面在选择保存尚未结束时错误比较临时phase，后续三个预算观察失败及一次CURRENT观察失败源于同一会话目录选择不会强制重读外部预置输入；测试改为明确“查看已保存讨论”并等待真实CURRENT、已保存选择，未改产品或放宽5秒门禁。多来源首次把异步DELETE的202错断为200，另一次错误要求删除CURRENT后自动回退独立旧输入；均按既有协议修正测试期望，没有产品RED或生产修复。此前页面5次失败、随后通过与本次最后通过分列，不合成同一次全绿；后端2次断言失败及通过分别保留。

最后页面的精确自有库1份经Root新连接SQL确认不存在，12个PID／PPID／PGID三元身份均无存活；页面与App租约随后分别查询absent。日志和清理回执仅保存在忽略目录 `desktop/artifacts/assistant-session-closeout-20261012/`，无私人资料或截图提交。

原生用例[assistant-native-lifecycle.spec.ts](../../../desktop/tests/assistant-native-lifecycle.spec.ts)及[运行入口](../../../desktop/README.md)已准备并通过类型检查，默认跳过；预计源App两次启动、同一隔离userData／随机库，单场180秒，验证真实小窗close继续、公开菜单quit停止、可靠完成保留、迟到不复活、重开只读及显式重试。当前没有新约定的有限test:app窗口，真正App未启动，第3条仍未勾选，17／19不关闭。源App即使通过也不代签最终签名包／Finder交付、真实微信或模型语义质量；OCR、外部模型、发送、push、发布及部署均未执行。

### 原生接续实录（2026-10-12）

固定自动增量 `a9821b3d → e32027b4` 两轴只读审查：Standards硬违反0／重要possible0，Spec新增missing／wrong／creep均0；不代替运行证据。用户随后明确批准台北时间09:59:34–10:09:34的有限原生窗口，最初最多2次启动；首次失败后另批准本窗口总计3次。

第一轮实际1次源App启动、13.1秒、exit1：真正BrowserWindow.close由生产close事件隐藏，小窗隐藏期间第二轮生成已HTTP可靠completed、旧完成保留；用例随后错误要求旧编辑框被后台新候选直接覆盖而失败。改为公开“查看已保存讨论”重读新候选，符合原16的不覆盖当前视图边界；补充Spec只读0及类型通过，没有生产改动。该失败保留，不算整个原生场通过。

第二轮实际又1次源App启动、8.7秒、exit1：上述公开重读及真正菜单quit均达到，App进程正常exit0；测试随后向已关闭的原HTTP读取而ECONNRESET。既有BackendHost.shutdown允许成功后服务关闭，测试修为先释放旧模型、原夹具restart同库HTTP，再严格核对failed／app_quit、旧完成和迟到，再实际App重开。补充Spec只读0及类型通过；不直接改写turn或伪造中断。

两轮自有App PID、测试库、userData均由Root精确核验无剩余，第二轮夹具目录也不存在；App租约分别为absent。日志、失败上下文和仅合成的清理回执保留于忽略产物目录。本段累计用了2次启动，真正App重开仍未执行，原第3条不勾、整票claimed；不以两个部分结果制造一次原生全绿。后续启动须同时满足尚有效的截止及用户明确批准的累计次数。

窗口于10:09:34到期时，申请总预算4次的询问尚未获回复，没有再启动。用户随后明确批准累计4次启动，目前已用2次、还余2次；预算确认不延长已到期时段，已只补问新的10分钟窗口，尚未收到时段确认。原生用例的两处观察修正、两次失败及部分检查点均保留；修正后完整TypeScript、diff及两次补充Spec审查通过，尚未取得修正后整场运行结果。需要新的有限窗口才能继续真实重开／零自动模型／显式重试；19仍claimed／ready-for-human，第3条不勾。


新窗口10:15:52–10:25:52由用户明确确认，剩余2次启动于固定源码`7bcbee1c`实际运行 `NOTALONE_ASSISTANT_LIFECYCLE_ACCEPTANCE=1 npm run test:app -- --interactive --coordinator main-agent --from 2026-10-12T02:15:52.000Z --until 2026-10-12T02:25:52.000Z --max-launches 2 tests/assistant-native-lifecycle.spec.ts --output artifacts/assistant-native-closeout-final`。第三场12.9秒、exit1，实际2次源App启动，累计已用4次；同目录真实重开已发生，但finally在已关闭ElectronApplication上调用`process()`抛出`_object`错误，覆盖原失败，不能据此认定重开后全部断言及最终退出通过。未产生`assistant-native-acceptance.json`，原生整场继续未完成。

仅测试最窄修正：受限启动后立即保留自有ChildProcess，真实菜单退出的exit0轮询与finally清理复用它，沿用既有app-fixture模式，不在已关闭的Playwright通道重新索取进程。已核对实际安装Playwright 1.64.0及[官方process接口](https://playwright.dev/docs/api/class-electronapplication#electron-application-process)；完整TypeScript、diff检查通过，Standards硬性／重要判断0，Spec新增偏差／缺失0。严格退出、中断、迟到、重开模型delta0及显式重试delta1断言均保留，无生产改动；修正后尚未重新执行原生。

Root以第三场owned-app和owned-reopened-app记录精确核对：两个自有PID均不存在，随机隔离数据库剩余0，userData与夹具目录均不存在，App租约absent。日志及`native-third-cleanup.json`只保留在忽略产物目录。累计4次预算用尽，未再启动；已向用户申请当前窗口内再2次（累计6次、截止不延长），等待回复。OCR、真实微信、外部模型和外部发送均未运行。19／17继续claimed／ready-for-human，原生AC保持未勾。


### 最终收口（2026-10-12）

用户明确批准当前窗口累计最多6次启动，随后要求A19／A17后续收尾连续执行、不再逐项询问；新增功能冻结、OCR和微信暂停仍保持。固定源码`39f0ce4f`在10:15:52–10:25:52窗口内执行修正后的完整入口：

```bash
NOTALONE_ASSISTANT_LIFECYCLE_ACCEPTANCE=1 npm run test:app -- --interactive --coordinator main-agent \
  --from 2026-10-12T02:15:52.000Z --until 2026-10-12T02:25:52.000Z --max-launches 2 \
  tests/assistant-native-lifecycle.spec.ts --output artifacts/assistant-native-closeout-complete
```

Conda NotAlone、PGHOST=/tmp、PGPORT=55441、dotenv及外部tracing关闭。**1／1通过、test 11.3秒／runner 11.7秒、exit0，实际2次源App启动；本轮四场累计6次，前三场失败分别保留。** 真实BrowserWindow.close触发生产隐藏，隐藏期间第二轮完成并可由公开保存区读回；真实菜单退出使在途请求failed／app_quit，既有完成保持，释放旧模型后迟到候选不能复活；同一隔离userData和PG重开后显示“上次生成中断”，重开模型增量0，明确点击重试增量1；两次自有App均经公开菜单正常exit0。完整受控模型共4次。`assistant-native-acceptance.json`真实回执全部相符，不用兜底回收代替产品退出。

Root再以最后owned记录及新PG连接精确核验：本轮随机库剩余0，两自有App PID均不存在，userData与夹具目录不存在；`npm run test:app:status`及`npm run test:pages -- --status`均absent。合成日志、真实回执和`native-complete-cleanup.json`仅留忽略产物目录；仓库保存无身份／凭据／正文的[结果摘要](../../unfinished-work/assistant-session-closeout-20261012.json)。原6条验收文本保持，最后原生条据实勾选；17原第1、3条同步收口。Standards及Spec两轴对测试观察修正和最终证据文档均0；原验收文本、相对链接、真实回执／清理及30票172／172汇总核验通过，自动保存本地提交，不push／部署。

数据影响：只处理双合成联系人和随机测试库，模型只替换外部provider，真实业务保存／删除与App生命周期均执行；没有读取私人资料、真实微信、OCR、调用外部模型或发送消息，没有产品源码变更。**该源App生命周期通过不代表最终签名包／Finder交付、微信渠道或真实模型语义质量通过**；这些既有边界继续保留，不在冻结期间扩展功能。
