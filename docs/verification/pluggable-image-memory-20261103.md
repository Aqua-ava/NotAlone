# 可插拔图文记忆接线（2026-11-03）

## 实现与当前结论

文字／图片内容插件、实际图文模型输入、类型化图片依据、固定文件版本、分批和删除闭包已实现。合成工程验证通过；真实模型已证明能读取图片独有内容，但两轮来源核验返回结构不合格，均未形成记忆。后续简化核验格式仅有离线验证，尚未完成新的真实模型验收，不能宣称完整图文记忆已可用。

插件接口与可信装配见 [内容插件说明](../../backend-ts/src/memory/content/README.md)。宿主与 Worker 共用插件模块；合成文件插件已贯通正常建轮、冻结及处理，不表示产品支持真实文件解析。新增类型仍须接好实际读取、证据及删除依赖。

追加迁移32冻结插件及文件身份，33为图片保留类型化依据，不伪造文字引句。每批最多8张、原始总量32MiB，目标优先，剩余额度才加入图片上下文。合法主图替换后重新排队，清除及未知调用保持保护。已有图片关系比较不能由旧文字核验认证时保留待确认，不自动合并或替换。

## 已运行验证

后台与桌面分别运行 `pnpm run typecheck`，均通过。Node 为24.22.1，未打包；复用热更新开发实例。

| 范围 | 命令或入口 | 结果 |
| --- | --- | --- |
| 插件、正常任务、晚到图片与多图分批 | `node --test test/sqlite-image-memory.test.mjs` | 5项通过；包含真实 Worker 和宿主共用新增文件插件、9张图片分批 |
| 媒体读取与派生删除 | `node --test test/sqlite-memory-image-lifecycle.test.mjs` | 10项通过；覆盖图片采纳、L2/L3、回复、运行记录、清除／替换、在途取消、换图自动重处理 |
| 旧库升级 | `node --test test/sqlite-memory-content-upgrade.test.mjs` | 31→33真实 Worker 升级、旧文字引用及后续编辑通过 |
| 模型与预算 | `sqlite-memory-model-port`、`model-input-budget`、`host-reply-config`、`model-provider-dispatch-cancellation`、`deepseek-strict-verification` | 27项通过；正式 DSH profile 与本机 HTTP 接收实际图片，提取与核验各一次，无 Files API 上传，坏图／超限／文字模型不外发 |
| 既有文字裁决 | `sqlite-memory-adjudication`、`sqlite-memory-adjudication-evidence`、`memory-adjudication-dsh` | 19项通过 |
| 控制、提取、删除、迁移与正式 profile | `node --test --test-skip-pattern='没有当前联系人处理记录\|策略升级恢复保留原授权\|已知模型回执至阶段提交之间' test/sqlite-memory-control.test.mjs test/sqlite-memory-extraction.test.mjs test/sqlite-memory-schema.test.mjs test/sqlite-memory-deletion.test.mjs test/sqlite-memory-dsh-flow.test.mjs` | 47项通过；下述3项既有失败／死等单列 |
| 桌面状态、来源、管理与界面 | `fixed-memory-processing`、`fixed-memory-processing-view`、`sqlite-memory-management`、`sqlite-memory-management-view` | 62项通过；另新增图片来源 DTO 1项通过 |

计数分别对应实际执行批次，不以相加后的数量冒充完整业务验收。新图文核验格式最终离线验证：`multimodal-memory-flow` 7项、图片生命周期10项、旧库升级1项通过；插件正常接线5项也通过。

Computer Use 实际打开当前仓库 Electron 开发版，检查记忆页和设置页；未选择真实联系人触发记忆，未发送微信消息。新增图文进度及图片依据通过合成页面检查并目检截图；该页面测试没有加载完整产品 CSS，不代替完整 App 的图文交互验收。

## 真实模型及停止条件

沿正常 `SqliteModelSetup`、官方 profile、共享 ModelHost／许可和正常图文提取／核验路径，使用独立合成数据库与一张日程卡。聊天文字不含图中的乐器和星期；两轮提取均读出“每周六练习吉他”，证明图片实际进入模型。

每轮固定1次提取＋1次核验，无自动重试。两轮核验的工具参数均有 JSON／层级错误，被完整来源门槛拒绝，最终没有候选或正式记忆。独立 Agent 判定两轮均为 `unchanged`；同一问题账本累计4/8，连续两轮无改善，真实发送守卫已确认拒绝继续预留。剩余额度不用于绕过停止条件。

原始回执及预算留在仓库外私有诊断目录，未提交聊天、凭据或私有模型追踪。停止外部实验后，继续离线修复；不得把已实现接线、真实识图或原回执回放写成新的在线核验成功。

## 停止后的格式修正与离线闭包

原核验合同包含多层命名对象；两轮真实返回均在闭合／层级上失败。新请求明确使用 `flat-fields-v2`，将相同15项核验改为 `checks` 列表，每项只有字段名、判断、实际证据索引和解释；结果另列主体与归属。程序仍要求15项完整、唯一，逐项引用有效证据，保持完整来源、主体及固定图片摘要门槛。

新 live 和 replay 严格解析该列表，不推测移动错误嵌套字段。旧无 `check_format` 的合法 nested 档案保留原 decoder；独立复验r1旧档案可确定性回放且原始回执摘要不变，r2错误嵌套仍拒绝。

另执行明确标注的离线语义回放：保留r1事实、图片证据及各项核验判断，记录新合成库的消息／文件UUID及指纹映射和nested→flat格式差异，以本地模型替身沿正常服务完成2/2目标、提取及核验各一次、自动采纳、类型化图片来源读取，再清图擦除正文和追踪，保留消息占位且完整性／外键通过。外部请求数为0；该结果只证明程序闭包，不是新的在线模型验收。

## 既有测试及其他限制

原始基线 `30843e8a` 的两条撤权测试期待保留旧当前轮次，但其 `contactView` 实际返回 `run:null`。独立 Agent 用固定 HEAD 旧模块、同一隔离数据库复现，新旧函数逐字一致。第9条提取并发测试在释放首轮屏障前等待第二轮，而原始 HEAD 已串行执行，因此既有死等；固定旧模块有界5秒复现，释放后仅调用一次。三项不是本次图片回归，未为通过测试修改撤权或串行调度契约。

依赖仅显式声明当前已锁定及安装的 `@deepseek-ai/dsh-attachment@0.2.1-rc.2`、`sharp@0.35.5`。离线完整安装因既有工作区供应链元数据缺失失败；制品、类型检查与实际模型传输测试通过，不宣称完整安装已验证。未推送远端。

DSH依据：声明／锁／安装版本均为0.2.1-rc.2，Cordis4.0.5；源码固定 `687f282e8625c6b8d11ff58211a90524be2e4317`。已核对 `ImageBlock.attachment`、公开 `AttachmentStore/readImageRequest`、`DeepSeekFileStore({fetch})` 及官方 inline fallback、预算 hook 和最终 fetch 顺序；安装制品以正式 profile 实际执行复核，不宣称全包可复现构建逐字一致。图片仅调用内存派生；原文件、模型请求变换及尺寸摘要保留可删除关联。
