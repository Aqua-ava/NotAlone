# 冻结M2之后的main并行变化

2026-10-16只读核对快照`2826d44601f72048106aef897bb0e76c076e7783`；这不是最终签收时的最新main。固定M2仍为`08c4d48e719353492f37620f4fb2aabd8710efc6`，没有自动吸收、重置或修改其他工作树。

## 产品差异及集成接缝

从M2到此快照有4个产品路径变化：

- `backend/src/notalone/front_sync/full_sync_engine.py`
- `desktop/src/main/foreground/header-change-diagnostics.ts`
- `desktop/src/main/foreground/native-change-source.ts`
- `desktop/src/main/index.ts`

与固定B→S的产品修改路径交集只有共享装配`index.ts`。此交集仍需核验，不能用其他路径无交集代替运行兼容性证据。

`6ce64a7e`让后台cycle、批量授权刷新及诊断状态读取不触发视觉，也不复用旧前台身份作为隐式优先联系人；未观察时返回`foreground_not_observed`、UNAVAILABLE及`probe_available=false`，显式fresh/manual观察路径保留。这一行为未搬入本候选，不能用M2测试认证新main行为。未来若更新基线，需另验后台CLI启停、绑定范围、去重及前台联系人来源事件。

`b8b30626`增加可选的host诊断：仅显式私有新文件、固定字段及枚举、最多512记录/256KiB；native stderr最多32行/3840字节。`NativeHeaderChangeSource`新增可选sink参数，原permit、epoch、租期和stdout协议仍是行为门禁；`index.ts`创建sink并在退出时关闭。本批保留M2原装配接口，最终15应核对这一个共享装配接缝，不能据本次静态读取宣称新诊断已运行或已集成。

从`b8b30626`到上述快照的后续变化是文档及一个实际App回复冒烟测试规格，没有进一步产品路径变化；这里只读Git元数据与上述产品差异，未读取其他会话的私有模型载荷、配置或凭据，也未采纳其运行结论。

## 最终复核

正式15签收时重新记录main引用、产品差异及共享接口；本快照不替代最终核对。没有执行新main的数据库、CLI、App、模型或原生探针，没有连接S分叉库或清理未知资源。
