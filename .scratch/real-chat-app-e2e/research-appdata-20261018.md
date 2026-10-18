# macOS AppData 授权与无提示行为：限时官方资料核查

日期：2026-10-18。范围：Apple 官方文档、WWDC 与身份已核验的 Apple DTS 原帖。仅记录公开技术资料；未操作 App、CLI、权限或数据库，未读取私人配置。

## 官方事实

1. **FDA 不是 Apple 描述的唯一授权方式。** WWDC23 在“其他开发者的 App 数据容器”语境中说明：默认访问可请求用户许可，许可在 App 退出时重置；随后明确列出 `NSOpenPanel` 作为针对所选文件或文件夹的替代许可方式。已有 FDA 或符合默认同 Team ID 条件时不再额外提示。这段说明从 macOS Sonoma 引入，不能替代对 macOS 15 实际责任链的验证。[Apple：What’s new in privacy，WWDC23 10053，17:46 起](https://developer.apple.com/videos/play/wwdc2023/10053/)

2. **缺少用途描述键不能直接解释无提示。** `NSAppDataUsageDescription` 用于说明读取其他 App 沙箱容器文件的理由；Apple 明确说，未填写该键时系统展示默认文字。[Apple：NSAppDataUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappdatausagedescription)

3. **AppData 与 FDA 是不同的受保护资源类别。** Apple 的重置参考将 `SystemPolicyAppData` 定义为其他 App 沙箱容器文件，将 `SystemPolicyAllFiles` 定义为 Full Disk Access。重置文档不是授权成功或适用性保证，本轮未执行重置。[Apple：Resetting access to protected resources in macOS](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos)

4. **一般沙箱授权不覆盖所有 MAC。** DTS 说明，选择上层目录并不覆盖其内部独立 MAC 保护；MAC 可能弹窗，也可能直接拒绝，行为随路径和系统版本变化。该帖还说明 helper 的归属依赖 responsible-code 启发式。作者为页面标记 Apple Staff／DTS Engineer 的 Quinn “The Eskimo!”，署名 Developer Technical Support @ Apple。[Apple DTS：On File System Permissions，App Sandbox、Mandatory Access Control 与 responsible code 段落](https://developer.apple.com/forums/thread/678819)

5. **macOS 15 有明确记录的“不提示”场景，但不能套用到本场。** 发行说明将 App Group 容器纳入类似 App 数据容器的保护，并说明 App Extension 不会触发许可提示、访问直接被拒绝。这不证明主 App 或 CLI 子进程适用同一条件。[Apple：macOS 15 Release Notes，System Integrity Protection](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)

## 可以得出的推断及其边界

- 可把用户明确选择最小必要文件或目录，作为比 FDA 范围更小、值得验证的官方候选设计；**不能据此承诺任意 `sandbox-exec` 子进程获得相同权限**。跨进程授权如何传递、所选范围是否覆盖全部必需文件及独立 MAC 检查，仍需分别验证。[WWDC23 的容器访问替代方式](https://developer.apple.com/videos/play/wwdc2023/10053/)、[DTS 的动态扩展与 MAC 边界](https://developer.apple.com/forums/thread/678819)
- Apple 的沙箱文档提供通过隐式安全范围书签向另一进程传递所选资源权限的方式；由此推断，仅传文件路径不能当成已经完成授权传递的证据。该机制能否适用于当前调用链及目标文件，仍需实验，不是本轮已验证能力。[Apple：Accessing files from the macOS App Sandbox](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- 责任链是需要核实的诊断方向；DTS 的一般性说明不证明本场责任链已经损坏，也不证明某个进程标志会使 AppData 不提示。[DTS responsible-code 段落](https://developer.apple.com/forums/thread/678819)
- DTS 对“一次提示”“GUI login session”的具体说明位于 Files and Folders 语境；不能无条件推广为 `SystemPolicyAppData` 的完整提示规则。[同一 DTS 原帖](https://developer.apple.com/forums/thread/678819)

## 未知与不可宣称

- 本轮未找到 Apple 公开文档、官方源码或已核身份的 DTS 回复，将 `userapproval` 的数值错误 4 映射为特定含义；也未找到把约十秒等待、无提示与该错误组合解释为固定 AppData 条件的一手来源。不得把它写成“用户拒绝”“缺少用途描述”“必须 FDA”或“固定系统超时”的已证结论。
- 未找到能保证本场多层子进程责任链获得 AppData 提示的官方调用或配置。FDA 未授权本身不能证明它是必要根因。
- 本笔记没有验证 `NSOpenPanel`、书签或 FDA 对实际链路的效果，也没有根据普通论坛用户经验作结论。

检索在约五分钟预算内结束；没有延长预算或进行权限实验。
