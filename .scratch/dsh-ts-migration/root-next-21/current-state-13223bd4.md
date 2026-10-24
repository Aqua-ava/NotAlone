# 票21 当前状态复核（`13223bd4`）

日期：2026-10-25。隔离 worktree：`/private/tmp/notalone-21-vision3.fMrQuB`。本复核不触碰票14的 L3 路径、07 UI、真实资料、数据库、主树改动或 App／微信。

结构化状态：[current-state-13223bd4.json](current-state-13223bd4.json)。

## 当前事实

- 上一轮诊断已由主树 `f9381923` 签收；票保持 claimed。
- 当前 HEAD `13223bd41f4aca2c01449ba20f5e5f9c5e1dd592` 的 `CaptureSupport.swift`、`AutomaticSessionCapture.swift` 和核心动态库哈希与上一轮一致。产品仍是 `VNRecognizeTextRequest`、accurate、`zh-Hans/en-US`、关闭纠错，没有 VisionKit、entitlement 或其它已落地的 OCR 修复。
- 系统仍为 macOS `27.0.1 (26A434)`、arm64。开机时间仍为 2026-10-24 00:46:50，ANECompilerService 仍是从上一轮测试启动的同一进程；没有发生过可用于观察新状态的系统重启。
- `softwareupdate --list` 仍报告无可安装更新。公开 macOS 27.2 RC release notes 没有 Vision、ANECompilerService、TextRecognition 或 OCR 修复条目；这不能证明未来版本一定没有内部修复。
- 本机 provisioning profile 数量为 0，codesigning identity 数量为 0；因此当前环境无法对 macOS 27 Background Inference entitlement 做正确授权签名测试。临时 ad-hoc 权限试验会启动即被杀死，不能作为产品路径。

## 仍缺的唯一外部条件

没有可访问的健康 Mac，因此无法区分：

1. 本机 ANECompilerService 状态损坏：健康 Mac 上同一 fixed probe 在 2500ms 内返回且 confidence ≥ 0.90。
2. macOS 27／M6 的 Vision accurate 路径回归：健康 Mac 同样超时，需要 Apple 修复或产品架构改变。

当前没有证据支持直接修改产品代码。清缓存、重启／终止 ANECompilerService、安装 Rosetta、修改 entitlement 或放宽门槛都不构成本票可签收的修复；本会话均未执行。

## 最小健康 Mac 对照

只运行一个合成 OCR 请求，不打开 App／微信、不采屏、不读取真实资料、不保存图像、不访问数据库：

```sh
NOTALONE_ALLOW_ANE_PROBE=1 \
  ./.scratch/dsh-ts-migration/root-next-21/healthy-mac-check.sh
```

脚本输出 JSON；只有以下条件全部满足才 exit 0：

- macOS 27、arm64；
- 固定 800×72 内存图的像素 SHA-256 为 `2de93b11fa1b3cebd299528b3f057f8bf3d5aa9c5a64d50675ea31aa355009a9`；
- accurate、revision 3、`zh-Hans + en-US`、关闭语言纠错；
- 2500ms 内完成；
- 合成文字精确匹配；
- minimum candidate confidence ≥ 0.90。

任意一项不满足就保持红；不得以 VisionKit transcript、fast、延长预算或伪造 confidence 替代。通过后仍需由 root 在其唯一桌面窗口重新跑正式 `npm run dev` 的前台名称区反馈环，不能把合成结果直接当 21 完整验收。

脚本默认拒绝运行，避免在已知异常机器上重复增加 ANECompilerService 负载。本机只做了 shell／Swift 语法和默认拒绝路径验证，没有再次发起 OCR。
