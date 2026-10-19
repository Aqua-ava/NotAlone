# 修复同一标题行的片段顺序

Type: task
Triage: ready-for-human
State: resolved

## Answer

已修复。只在 `HeaderOcrResult` 校验共同纵向交叠及横向不重叠，再按 X 坐标组装标题；多行或坏框保留文字但不获完整性资格。正文排序、原始字符、最低分、绑定与读取授权不变。

红绿验证先复现同一行文字颠倒，以及多行/重叠错误获得完整性的失败，再修复。`swift test --package-path native/macos --filter HeaderOcrResultTests` 4项通过；复用构建运行 AutomaticSessionCapture、HeaderTextFallback、HeaderOcrResult、SessionCaptureSafety 共28项通过，`git diff --check` 通过。Standards／Spec 两轴各0项未解决问题。

另外用门控 `HeaderOCRCorpusTests.testScanExplicitPrivateCorpus` 对用户指出的两个私有样本、1×／2×共4次调用正式 Vision，验证左右顺序已恢复，原始分数不变；短名2×的原始漏检仍存在，不虚构文字。原始 Vision 文字框确认2×漏检发生在检测/识别阶段，内部模型原因未知。私人输入与 JSON 只留端侧0600目录，无图像落盘或上传。私人 HTML 的“通过”改成“边界通过”，注明它不表示识别正确或匹配通过。

复用开发实例，未打包、运行发布版、创建绑定或发送消息。Computer Use 已读取真实微信窗口及开发版管理窗口（服务已连接）；未声称完成自动切换验收。本任务未替换运行中的开发探针；通用名单匹配任务须在集成新开发探针后核验最终切换。

本轮 SwiftPM 编译缓存约249 MiB，结束时核对进程引用后清理，当前运行的开发探针保留。
