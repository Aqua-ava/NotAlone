# 固定 WCDB 核查检查点

日期：2026-10-13。执行状态：公开补核、最小静态验证和两轴修后评审已完成，本地提交待原聊天执行。完整来源验收未满足；同一外部材料缺件连续三个目标轮未解除，本轮已满足blocked判定门槛，准备调用目标工具记录。未宣称来源或整体交付完成。

## 已执行与新增事实

- 4 个公开搜索查询，无精确证明命中；首片13个新匿名GET，无重试，131,556 bytes 正文、请求计时总和10.367425876秒，时段Asia/Taipei 15:12:33.316–15:15:00.915。随后15:31:18.317–15:31:19.094追加1个官方发行资产查询；合计14 GET、135,086 bytes、请求计时总和11.144782543秒，不把间隔当作请求耗时。
- 发行仓初始 tree 只有 README，四个 v1.6 tags 不对应旧 CLI revision；发行仓精确 revision HTTP 422。
- Software Heritage 精确 revision 与 Go proxy 精确 revision／v1.6.25 info 都 HTTP 404，没有源快照。
- canonical 初始 clean tree 与 main 历史未取得旧源；初始 workflow 和 manifest 脚本两个 immutable blob 已核 SHA-1／SHA-256／bytes。workflow 通过未公开仓库变量获取预制 WCDB，没有当前 digest 对应源树或构建记录。
- rc.5 七份相关 blob 与既有材料相同，复用既有响应核 hash；不是固定库证明。
- [Tencent v2.1.15官方发行](https://api.github.com/repos/Tencent/wcdb/releases/tags/v2.1.15) HTTP200，仅列一个83,197,863-byte ZIP，其API digest与既有候选源码归档相同；超过16MiB上限，未下载。既有12771行归档路径索引未匹配常见WCDB二进制路径；这只是旧派生索引，未重新核归档，不能证明当前库来自它。
- ZIP、内外 manifest、13 artifacts／CRC、E/F 固定 CLI／库及九份材料复核通过。新提取 CLI Go buildinfo 和库 Mach-O 构建字段，只记声明，不还原完整构建或 BOM。

完整新响应 URL、状态、bytes、SHA、blob 身份、固定摘要和缺件见 [evidence-summary.json](evidence-summary.json)。端侧响应及静态抽取保留在 `desktop/artifacts/wcdb-exact-provenance-parallel-20261013/`；被忽略的研究笔记为 `research/wcdb-exact-provenance-parallel-20261013.md`。未改变两个 false 或 Mac20 状态、依赖、AC。

## 实际命令与数据影响

- Node 标准库：限定 GET 收据、SHA-256／Git blob 核验、Go buildinfo 静态读取；GET 总预算40、每请求20秒、文本2MiB／源ZIP16MiB／错误8KiB、总40MiB，无认证／重试。
- 先 source 本机 Conda 初始化脚本，再 `conda activate NotAlone && python`：标准库 zipfile／hashlib，仅读取固定归档、E/F helper 与许可字节；归档内容不执行。精确本机路径与完整命令只留端侧忽略收据。
- `otool -l`／`otool -L`：仅读取固定 Mach-O load commands 与依赖声明，不动态装载。
- `git rev-parse HEAD`、`git status --short`、`git check-ignore`：只读；开始基线 `9d702f7612dbc3a779afedfe05f6a8074303fcbe`。共享 index 不写。
- 核查脚本一次误取旧 receipt 的路径字段，ERR_INVALID_ARG_TYPE／exit1；改已知文件名后 blob 核验通过。子 Agent 一次未初始化 Conda、一次任务路径拼错，均在静态读取前失败；不充作产品 red／green。

App 启动、helper 执行／库装载、CUA、微信读取／发送、模型 HTTP、业务库、凭据、依赖安装、上游消息与 Git mutation 均0。无自有运行进程或服务需清理，仅保留忽略证据目录。公开摘要没有私人资料或原始第三方源码全文。

## 最小验证与两轴

Node已核六文件换行／尾随空白和本地Markdown链接、tracker合法字段、14份原始正文bytes／SHA与URL唯一性、既有失败URL无重复；ZIP和E/F字节验证另见摘要。六文件no-index diff --check没有空白输出，exit1仅表示新文件差异；最终链接数量在端侧final-validation.json记录。原门禁及其测试只读，不为文档核查重跑产品测试。

Standards独立评审发现一处公开检查点的本机用户名路径，已移到忽略收据；最小修后复核硬违规0、Fowler判断气味0、证据边界问题0。Spec独立评审missing／scope／error均0，明确四项来源缺件不等于交付错误。两轴没有联网、产品执行或Git修改；最终内容元数据更新另做格式检查。

追加Tencent官方资产片的Standards／Spec最小补审也均0，实际14份正文摘要与资产限额停止、旧索引派生边界已复核。任务文件已准备好，由原聊天串行提交；本聊天只读回收结果，没有代行Git。

## 三轮阻塞审计

第一轮实际完成14份新公开响应、静态核验及两轴后，四项来源仍缺；第二轮重新核生产manifest、固定helper和内容快照，同一缺件继续，没有新HTTP；第三轮再次核当前manifest、保留响应摘要和本任务Git状态，仍四项false／无新材料。没有已知授权内动作能补实际源树、修改、构建证明或BOM，未用GET额度和可能存在未知来源不作为具体下一步。独立只读审计确认连续三轮条件足够，端侧记录为 `goal-turn-03-blocked-audit.json`。

原聊天的工具权威状态仍active／inProgress，不据此认定它停止，也不把整体active推断为本任务提交正在执行。当前本任务仍untracked／无暂存或提交；该独立提交等待不改变上游来源缺件。按目标规则调用blocked后停止本聊天的自动核查；原聊天可继续共享Git串行收口。取得新可核材料或真实提交／公开历史结果后，从本检查点核验，不能把证据文档提交代签四项来源。

## 压缩后继续

1. 先读本文件、[任务](issues/01-exact-provenance.md)、[规格](spec.md)、[摘要](evidence-summary.json)和[交接](handoff.md)。不要重新请求已失败URL。
2. 两轴已回收；后续有实质新证据时只改本专属路径，重跑相应验证与两轴，不重查已失效路径。
3. 原聊天串行提交精确文件清单并运行公开历史检查；回收实际 commit 和结果，不能捎带其他工作区改动。
4. 四项来源缺件只能由新公开材料解除，出现后核到实际文件和摘要。本轮已完成第三次同一缺件审计，blocked门槛满足；不要为计轮或恢复重复无效HTTP。
