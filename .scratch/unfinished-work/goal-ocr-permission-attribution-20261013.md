# OCR 录屏权限条目归属核查（2026-10-13）

Root 在系统设置的录屏权限页读取已开启的 `NotAloneApp` 条目，并用“在访达中显示”核对实际路径。该条目指向 `macos_app/build/NotAloneApp.app`，bundle identifier 为 `com.notalone.app`，具有开发证书。当前 D 候选为 `desktop/artifacts/goal-final-package-20261013-d/NotAlone-darwin-arm64/NotAlone.app`，identifier 为 `com.notalone.desktop`，ad-hoc 签名、无 Team。两者路径及身份不同。

这个实际 UI 结果不能证明当前 Electron App 或其 Resources 探针拥有该权限。F 场权限预检成功及最小采集成功只证明该次路径可用，责任进程与签名的 TCC 归属仍未知；原18第三项验收继续未完成。没有切换权限、重新签名或申请授权，也没有运行新 App、微信正文读取、模型请求、采集或消息发送。

端侧收据为 `/private/tmp/notalone-ocr-permission-ui-20261013-readonly01/root-readonly-observation-v1.json`，SHA `c8817ec13e0f308da5bff63a29b8b4a7a92f1bd9b4fb5dda291b0cdb83c1b2bc`。只保存目标条目的状态、路径、必要身份及摘要，没有保存录屏图像、完整 UI 树、其它 App 列表、证书主体或账号标识。独立单调时长未认证。首次旧 UI 操作因用户界面变化被拒绝，重新读取后完成导航，失败保留。

“在访达中显示”后出现的 build 窗口没有场前归属记录，Root 未关闭该未知归属窗口。系统设置停留在录屏页，没有修改系统安全设置。后续须在最终新包的有限 `test:app` 场分别验证可用性与实际责任归属；旧版权限条目、静态签名和成功预检不能相互代替。

关联：[原18](../mac-desktop-app/issues/18-foreground-locator.md)、[权限台账](../../docs/macos-app-permissions-and-errors.md)、[既有四场结果](goal-ocr-front-context-20261013.md)。
