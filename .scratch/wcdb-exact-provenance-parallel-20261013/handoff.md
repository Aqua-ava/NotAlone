# 固定 WCDB 来源核查交接

当前限定补核没有取得能改变两个 false 的证明。原 Mac20 票、状态、依赖和 AC 均未修改；没有换库、重包或 App 验收。新增事实和逐请求摘要见 [evidence-summary.json](evidence-summary.json)，继续点见 [checkpoint](checkpoint.md)。

## 四项完成条件

| 条件 | 结果／缺件 |
| --- | --- |
| 精确稳定 CLI 来源、固定依赖／发布脚本 | 内嵌旧 revision、Go版本／依赖和两个安装／manifest脚本身份已核；完整旧源树、go.mod／go.sum、真实编译发布脚本未取得 |
| 当前库实际源树、子模块、补丁 | 未取得；候选 Tencent tag 和初始 v2 workflow 不绑定当前库 digest |
| 编译器／Xcode／SDK、命令／crypto／链接输入和日志 | 仅新确认 Mach-O SDK等声明；实际完整输入、日志或输出证明未取得 |
| 当前库实际 BOM与逐组件许可 | 未取得；九份既有材料同字节不代签覆盖 |

最少解除条件：新公开可核查的稳定源快照，以及绑定库 `279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3` 的实际源树／修改、全构建输入和日志或发布证明、编译链接 BOM／适用许可及完整原文。不要重查已知失败路径、用当前2.1.16／ZSTD OFF替代或将字符串声明写成验证通过。

## 本轮依赖源码补充

最后5GET使累计40GET／12搜索，原预算耗尽，不再追加网络。两项精确Go proxy info均200；purego v0.10.0官方源ZIP取得，219025 bytes，按官方HashZip/Hash1文档静态核h1与固定CLI嵌入声明完全一致，许可成员摘要保留。compress v1.18.5源ZIP302未跟随、正文0 bytes，只取得metadata，未核源码h1。两个Origin commit只是proxy声明，未独立核Git对象。源码不提取目录／安装／执行。

35GET切片六文件已由原聊天提交8c9ff9e6b079f6ac07b1b463570bebdc52438633，实际字节与该片冻结快照一致。现有旧checker收据仍是a6，不据此认证8c或本轮；首片实际提交和旧两轴结果按所属切片保留，本轮七文件格式、30本地链接、40响应摘要通过，两轴问题均0，purego h1获独立静态重算确认。新增依赖内容证据不证明旧CLI完整来源或实际编译，也不补WCDB构建／BOM，四完成条件及生产两false保持。用户拒绝上游发送的决定保持，不再主动提议发送。

## 最后五文件待提交清单

最后5GET依赖核验新增的实际变更为以下五文件；索取稿已在8c9ff9e6提交且本轮未改。当前五文件快照与本轮验证结果交原聊天串行提交，新checker结果再回收。

1. `.scratch/wcdb-exact-provenance-parallel-20261013/spec.md`
2. `.scratch/wcdb-exact-provenance-parallel-20261013/issues/01-exact-provenance.md`
3. `.scratch/wcdb-exact-provenance-parallel-20261013/evidence-summary.json`
4. `.scratch/wcdb-exact-provenance-parallel-20261013/checkpoint.md`
5. `.scratch/wcdb-exact-provenance-parallel-20261013/handoff.md`

建议标题：`补充固定CLI声明依赖的官方源码核验`。建议正文：

```text
1、记录两项精确Go proxy来源声明与purego源码内容h1匹配，实际编译和WCDB BOM仍缺
2、保留compress源ZIP302未跟随，原预算累计40GET与12搜索已用完
3、回收35GET切片真实六文件提交，明确最后依赖核验的五文件和新checker结果另算
4、记录七文件格式、30本地链接、40响应摘要及两轴均0；未执行源码、App/helper或处理私人资料
```

## 上一次继续核查补充

新增10 GET／4搜索后累计35 GET／12搜索。四条repo CLI／ZIP证明查询均404，User固定库证明GET返回401后停止，无登录／凭据／POST／DELETE；组织入口因owner.type=User不适用。三份此前未读的rc.5发布脚本已核Git blob与正文摘要，只含v2发布及schema2验证，无固定旧构建证明；未执行。剩5 GET不重置预算，搜索已到顶。

最新补充仍只提交下列同一六文件；用户拒绝发布索取稿的决定保持，没有待确认对外动作。14GET／4搜索及25GET／8搜索分别对应首片和上一次恢复，按所属切片保留，本轮最小验证通过七文件格式、30本地链接、35响应摘要，两轴修后均0；来源四条件和生产两false不放行。

## 首片实际提交与最新补充清单

首片五文件已由原聊天在15:53:07提交 `a6bae6b49853295226dfd22a5166742818f3b825`，逐字节复核与评审快照相符。真实公开历史命令completed／exit0，报告6085历史blob、1102commit、1751当前文件、issues0；收据已回收。此项等待已解除，完整来源仍未满足。

首片已提交以下五个文件：

1. `.scratch/wcdb-exact-provenance-parallel-20261013/spec.md`
2. `.scratch/wcdb-exact-provenance-parallel-20261013/issues/01-exact-provenance.md`
3. `.scratch/wcdb-exact-provenance-parallel-20261013/evidence-summary.json`
4. `.scratch/wcdb-exact-provenance-parallel-20261013/checkpoint.md`
5. `.scratch/wcdb-exact-provenance-parallel-20261013/handoff.md`

本次恢复追记修改以上五文件，并新增第六文件 `.scratch/wcdb-exact-provenance-parallel-20261013/upstream-material-request.md`。最新补充提交清单为这六文件；第六文件是未发布的公开材料索取稿；用户已明确拒绝发布，仅端侧保留，不主动再次提议或请求发布。research及artifacts仍忽略。

`research/wcdb-exact-provenance-parallel-20261013.md` 和 `desktop/artifacts/wcdb-exact-provenance-parallel-20261013/` 已被忽略，只在端侧保留，不强行加入提交。其他未提交变更归原聊天或其他 Agent。本聊天未执行共享 index 写入或 Git 修改命令。

首片提交标题：`记录固定WCDB精确来源限定补核证据`。补充提交建议：`补记WCDB历史索引核查与未发送材料索取稿`。

首片补充公开资产路径：[Tencent官方发行API](https://api.github.com/repos/Tencent/wcdb/releases/tags/v2.1.15)只列既有候选源码ZIP摘要，83,197,863 bytes超过本轮16MiB上限，未重下；旧路径索引未匹配常见WCDB二进制路径，但未重新核归档，不宣称精确二进制对应。首片累计14 GET／135,086 bytes／11.144782543秒请求计时，无重试。

首片正文（已实际提交）：

```text
1、发布Mac20既有来源子项的单一核查规格、任务与交接
2、记录14个限定新公开GET、4个搜索及两份不可变历史构建材料
3、核对固定ZIP、manifest、E/F helper和许可字节，保留四项精确来源缺件及两个false
4、完成25条链接、14份响应摘要与两轴静态核查；本次App、helper、私人数据处理均为0
```

补充提交正文建议：

```text
1、回收首片a6bae6b4五文件及真实公开历史issues0，明确旧提交等待已解除
2、累计追加26个新公开GET与8搜索，总40GET与12搜索，保留搜索不完整、归档429、证明401与源ZIP302停止边界
3、保留仅含公开身份和摘要的未发送材料索取稿，记录用户拒绝发布及不主动再次请求的决定
4、核对声明依赖的官方源ZIP h1、追记格式与响应摘要及两轴；未运行App/helper、依赖源码或处理私人业务数据
```

## 验证与提交状态

首片静态字节、Markdown／摘要一致性验证已通过。独立Standards发现一处本机用户名路径并已移到端侧，修后硬违规／判断气味／证据边界问题均0；Spec可行动missing／scope／error均0。25条本地Markdown链接及14份原响应摘要通过，原始两份blob也通过Git SHA-1／bytes与SHA-256校验；追加Tencent资产片两轴补审均0，首片已由原聊天串行提交。

首片五文件提交和公开历史已回收。上一次恢复后追加11新GET／4搜索，累计25 GET／8搜索；额外索引均未提供固定旧源或构建证明，精确commit搜索不完整、归档429均如实保留。新追记两轴补审修后均0，两处交接P3文案已修复；七文件格式、30条本地链接、25份响应正文摘要验证通过。最新六文件由原聊天串行提交并跑公开历史；不让旧issues0认证新未提交文件。整体交付及四项精确来源仍未完成。

旧运行已按三轮缺件调用blocked；用户再次要求推进后从新的有限路径及真实提交结果继续，不继承旧阻塞计数。用户已明确拒绝发布[索取稿](upstream-material-request.md)，当前publication_declined_not_sent；不联系上游，不主动再次提议或请求发布，取消待确认状态。只有用户日后主动明确要求时才重新核对范围。原Mac20、二进制、两个false和原任务图未由本聊天修改。
