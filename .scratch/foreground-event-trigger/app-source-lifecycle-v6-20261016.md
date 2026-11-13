# 当前 App 辅助源完整租期与续期实测

日期：2026-10-16。结论：当前v6签名App在正式单帧观察持续运行时，辅助源连续完成三次55秒租期并续起，整场约3.8分钟、1／1诊断用例通过、runner exit0。没有完成会话切换，`changed=0`；不认证名称、切换覆盖或显示延迟，事件票仍claimed。

## 本场范围

当前v6 ASAR为`7ed7f0c34f5c059cc848c59e2e6e0bfffb72fd61680fc781be8f7a43d9c3cd27`。使用已提交的`header-change-diagnostic-acceptance.spec.ts`，通过有限4分钟／最多1次App启动的`test:app`入口运行；独立userData、空授权CLI范围、合成联系人、随机隔离PG。正式探针包装器只exec同包正式探针，不改变输出，辅助源仍由主程序选择独立签名helper。使用私有0700目录内的新0600诊断文件，明确启用既有有界生命周期观测。

Agent从真实App开启同步并打开小窗，再通过Computer Use隐藏App和微信“隐藏其他”建立微信前台，保持原获授权私聊。没有导入或读取CLI正文、生成候选、调用模型、复制、发送、确认新联系人或修改系统权限。名称只由产品正式观察在端侧处理，诊断未持久化名称或画面。

## 源的真实生命周期

宿主共记录455行、133146字节，未达到512行／256KiB上限。各事件的相对时钟来自同一宿主对象；下面close时长为宿主从launch起的单调耗时，native自身finished时长独立列出。

| 顺序 | native结束原因／耗时 | 宿主close耗时 | exit／续期门 | close至下一launch |
| --- | --- | ---: | --- | ---: |
| 1 | lease_expired，55003.484ms | 55010.913ms | code0，paused=true，stopping=false，freshProof=true，renewalEligible=true | 23.124ms |
| 2 | lease_expired，55065.980ms | 55077.705ms | 同上 | 67.138ms |
| 3 | lease_expired，55086.314ms | 55096.278ms | 同上 | 33.066ms |
| 4 | context_changed，12983.384ms | 12993.776ms | code1，paused=true，stopping=false，renewalEligible=false，blocked=true | 未重启 |

这直接补齐[旧App采样](app-source-observation-20261016.md)缺少的close与续期证据。前三次均是完整租期后正常退出再启动下一子，没有把周期探针仍运行或采样间隙推作续期。第四次因上下文变化停止，随后同一连续许可被锁住；本场未归因是哪项OS上下文改变，也不把该拒绝写成产品故障或正常续期。全部host changed事件为0。

Computer Use可操作微信菜单；尝试坐标切换测试群聊时两次返回`AXError.notImplemented`，实际切换没有被确认，原私聊仍可见。未以“操作开始”时间戳推算切换延迟，未读取群聊正文或补写显示成功。输入源限制与产品行为分别保留。

## 资源与公开接缝

100个约0.75秒间隔的独立进程采样覆盖79.288秒，每次捕获1个辅助源，共2个先后PID；RSS范围21954560–89096192字节，`ps` CPU范围0.4%–14.0%。两个PID在各自被采样区间的累计CPU增量分别0.55秒／0.64秒；采样未覆盖本场所有源或每个完整租期，不把这些数值当平均CPU、总资源开销或峰值硬上界。

现有`foreground-change-source-http.test.mjs`两项鉴权HTTP／隔离PG检查已随最小观测实现跑过且通过：变化取消正常2秒等待，在途最多合并1轮，非前台丢弃旧提示，技术失败4／8秒退避不被变化绕过，关闭、助手获焦及连接代际失效停源。`header-change-source-process.test.mjs`另核实际合成子进程的旧子close后替换、晚事件拒绝、失败锁与新鲜proof续租；这些不是微信实机时延。类型和完整桌面安全67项结果沿用已记录本轮实现验证，本报告没有重复计测试次数。据这些公共接缝证据勾选事件票AC3，其余实机和接入条件保留。

## 正常退出与清理

有限协调器到期前15秒请求finish，真实App使用公开菜单退出、exit0。夹具取得认证stopped响应、后端exit0、`databaseDropped=true`、`unconfirmedResources=[]`。Root另核精确库不存在、已记录App／runner／worker／两采样源PID退场、App临时userData消失、共享租约不存在；未删除未知资源。诊断目录及脱敏收据保留在忽略的`desktop/artifacts/header-source-v6-diagnostic-1823e8ca-461d-485b-9f90-0db7da8d55d5/`，包括`run.log`、`host-lifecycle.jsonl`、`resource-samples.jsonl`及`root-closure.json`。

命令入口：激活Conda后，在`desktop/`运行`npm run test:app -- --interactive --coordinator root-header-source-v6 --from <本场开始> --until <四分钟截止> --max-launches 1 tests/header-change-diagnostic-acceptance.spec.ts --output artifacts/<本场目录>/playwright`，显式参数仅指定当前签名包、自有包装器、私有协调目录和新诊断文件。没有读凭据、模型HTTP、远端Git或新TCC授权。
