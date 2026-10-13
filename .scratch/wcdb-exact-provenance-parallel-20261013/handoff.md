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

## 精确提交清单

仅以下五个文件属于本次可提交交付：

1. `.scratch/wcdb-exact-provenance-parallel-20261013/spec.md`
2. `.scratch/wcdb-exact-provenance-parallel-20261013/issues/01-exact-provenance.md`
3. `.scratch/wcdb-exact-provenance-parallel-20261013/evidence-summary.json`
4. `.scratch/wcdb-exact-provenance-parallel-20261013/checkpoint.md`
5. `.scratch/wcdb-exact-provenance-parallel-20261013/handoff.md`

`research/wcdb-exact-provenance-parallel-20261013.md` 和 `desktop/artifacts/wcdb-exact-provenance-parallel-20261013/` 已被忽略，只在端侧保留，不强行加入提交。其他未提交变更归原聊天或其他 Agent。本聊天未触碰共享 index／Git 状态。

中文提交建议：`记录固定WCDB精确来源限定补核证据`。

补充公开资产路径：[Tencent官方发行API](https://api.github.com/repos/Tencent/wcdb/releases/tags/v2.1.15)只列既有候选源码ZIP摘要，83,197,863 bytes超过本轮16MiB上限，未重下；旧路径索引未匹配常见WCDB二进制路径，但未重新核归档，不宣称精确二进制对应。累计14 GET／135,086 bytes／11.144782543秒请求计时，无重试。

正文建议：

```text
1、发布Mac20既有来源子项的单一核查规格、任务与交接
2、记录14个限定新公开GET、4个搜索及两份不可变历史构建材料
3、核对固定ZIP、manifest、E/F helper和许可字节，保留四项精确来源缺件及两个false
4、记录静态摘要、链接格式检查和独立两轴结果；未运行App/helper或处理私人数据
```

## 验证与提交状态

静态字节、Markdown／摘要一致性验证已通过。独立Standards发现一处本机用户名路径并已移到端侧，修后硬违规／判断气味／证据边界问题均0；Spec可行动missing／scope／error均0。25条本地Markdown链接及14份原响应摘要通过，原始两份blob也通过Git SHA-1／bytes与SHA-256校验；追加Tencent资产片两轴补审均0，现可由原聊天串行提交。

原聊天随后只stage上述五文件，执行staged diff检查、本地中文提交和 `node scripts/check_public_history.mjs --ref main --working-tree`。本聊天不代替该提交；未回收commit与公开历史结果前，任务保持claimed／needs-info，整体交付未完成。即使证据文档提交成功，四项精确来源验收仍单独保持未满足。

同一外部来源缺件已连续三目标轮核对，第三轮独立审计确认无已知授权内动作可解除；本聊天将调用目标工具标blocked，等待新可核材料，不因原聊天仍active而伪造本任务提交执行。原聊天可继续上述串行提交；最新五文件只增加阻塞审计元数据，来源证据与两项false未改变。
