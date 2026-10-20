# 04 原生定位优化结果

State: claimed
分支：`codex/native-capture-opt`；固定基线：`681fcc38eab77c8fe149b76705419971f3750a86`（产品合并基线 `abd65e6c` 之后仅增加规划文档）。本聊天已通过目标工具真实建立无预算目标；完成与提交编号见本文件后续记录。

## 具体变更

- `CaptureSupport.swift` 保持原 DeviceRGB、8位预乘RGBA、copy绘制及 `(54R+183G+19B)/256` 整数截断；通过 `LuminanceSampler` 只计算访问点的亮度，旧纯函数的完整亮度输出复用同一绘制与公式。
- `AutomaticSessionCapture.swift` 的顶部和历史双名称纯布局共用当轮采样闭包。`HeaderLayout` 只返回几何，不携带像素；正式矩形路径返回前释放RGBA，不让原实验候选的4倍返回缓冲区跨越布局阶段。不跨轮缓存图像或身份。
- 删除 `WeChatCaptureProbe` 及其正文／侧栏预览捕获；CLI默认只显示帮助，旧watch/crop/interval/独立show-text参数立即失败。历史Swift菜单栏目标已按ADR-039退役，仅保留无App初始化的退出提示。正式session、worker、顶部名称预览和显式权限入口保持原协议。
- 新增逐像素回归、诊断参数测试、实际CLI合成检查及提取真实生产函数的可重放基准；未修改默认Desktop测试清单，由05统一纳入。

## 基线与原始结果

[输入及源码摘要](native-evidence/baseline.json)、[31组交错原始样本及工具链](native-evidence/layout-results.json)、[red摘要](native-evidence/red-summary.txt)。驱动提取固定Git基线和当前工作树的完整生产布局，不使用手写替代候选；12张合成图覆盖3种比例及正常、缺竖线、缺标题线和竞争竖线。逐图布局几何或具体失败相等，并抽样比对亮度。

所有计时使用 `/tmp/notalone-optimization-benchmark.lock` 的 `fcntl.flock` 串行执行；每种尺寸先3次热身，31组前后交错。单位ms，以下只度量合成CGImage的RGBA绘制及布局；不含捕获、OCR、IPC、HTTP或App。

| 合成尺寸 | 基线 p50 / p95 | 候选 p50 / p95 | p50下降 |
| --- | --- | --- | --- |
| 1200×800 | 2.621 / 3.137 | 0.537 / 0.949 | 79.5% |
| 2400×1600 | 10.385 / 36.062 | 1.742 / 2.847 | 83.2% |
| 3600×2400 | 20.615 / 21.875 | 3.121 / 3.816 | 84.9% |
| 5120×2880 | 35.431 / 36.207 | 4.691 / 5.658 | 86.8% |

2400×1600基线p95有较大离散，原始31点全部保留，未剔除离群值。局部收益不等于端到端识别加速。没有测RSS，不能把少一份灰度数组或缓冲区生命周期解释成进程内存下降；候选在布局期间仍需整帧RGBA。

## 实际验证

1. `swift test --package-path native/macos --filter ProbeDiagnosticInvocationTests`：先因政策不存在编译失败，再实现，2项通过。
2. `swift test --package-path native/macos --filter LuminanceSamplerTests`：3项通过。独立固定主线转换对照，覆盖sRGB／Display P3／linear sRGB、预乘透明度、带填充的行跨度、不对称尺寸和灰度输入的每个像素；纯色已知整数结果也通过。
3. `swift test --package-path native/macos --filter 'HeaderBannerLayoutTests|AutomaticSessionCaptureTests|SessionCaptureSafetyTests|SessionObservationWorkerTests|LuminanceSamplerTests|ProbeDiagnosticInvocationTests'`：33项通过，含明暗／比例／横幅、模糊与未知布局不调用OCR、上下文变化拒绝、单帧与worker政策。
4. `node --test native/macos/Tests/DiagnosticEntrypoints.test.mjs`：4项通过。实际运行无参数、help、合成self-test和旧参数拒绝；先静态核对正文捕获器已不存在，不运行正文OCR或历史App。
5. `perl -e 'alarm 600; exec @ARGV' -- swift test --package-path native/macos`：132项，4项按既有条件跳过，0失败。跳过私有名称扫描、真实微信窗口和两项未预注册Vision实验；未读取私人资料。
6. `$HOME/miniconda3/envs/NotAlone/bin/python native/macos/scripts/benchmark_layout.py --output .scratch/system-optimization-20261021/native-evidence/layout-results.json`：12图等价，4尺寸各31组；源码SHA256、编译优化参数和工具链可核对。
7. `git diff --check` 通过。公开历史检查首次发现red原始日志的本机绝对路径，已移出仓库并保留脱敏摘要；最终提交后复查。

## 数据与验证边界

只使用合成CGImage、合成文本和端侧源码；不捕获真实微信、不请求系统权限、不连接业务库或外部模型、不发送消息。不改变联系人确认、owner/contact隔离、来源/删除/时间核验、auto/manual、完整追踪、固定上下文限制和人工发送。没有打包、运行打包版、push或远端操作。

正式路径仍只对当前前台唯一微信窗口进行内存布局分析，再识别自动定位的顶部名称；没有扩大OCR范围或持久化／上传原始帧。布局与像素等价属于合成证据，真实微信窗口、特殊色彩管理和真实捕获→识别→绑定延迟由05集成验收。CGContext资源分配失败未强行制造；创建失败仍按原可选值／layoutUnverified回退，不降级正文OCR。

## 资源与待交接

工作树开发状态检查为stopped，未启动App、开发服务或浏览器，无需争用桌面；真实App/微信由05统一协调。编译前卷可用约53GiB，原生构建缓存本轮峰值236MiB；最终清理情况及独立审查见后续记录。合成基准临时可执行文件由TemporaryDirectory自动回收；共享锁文件保留供其他优化聊天复用。
