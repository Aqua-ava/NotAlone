# 自动 Skill 版本回执验收（2026-10-21）

## 根因与修复

用户报告的失败请求已完成准备与两次模型调用，约9.4秒后在结构化结果核验阶段失败；模型声明的 Skill 版本UUID与实际读取版本不一致。此前合成联系人关闭关系背景的验收没有覆盖此路径。

自动模式只向模型提供名称、整数版本号与正文，却要求输出实际版本UUID。受控读取现在在原正文切片前提供已核验版本的身份回执，系统提示及输出字段说明要求原样复制。offset/limit继续只作用于正文，空页同样返回回执。

未放宽范围、单版本、失效版本及错误声明拒绝逻辑，未扩大工具权限。回执随实际ToolMessage纳入逐轮完整输入预算；不修改生成时限、同步范围或人工发送边界。

## 自动验证

- 原有公开生成用例新增模型实际可见UUID断言，旧返回正文行为确认失败，修复后通过。
- 新增动态模型仅从下一轮实际ToolMessage读取版本身份，覆盖两种合成UUID并完成候选保存；进程内移除回执模拟旧行为时两组均失败，恢复后通过。
- 五页读取覆盖非零offset、空行、缩进及真正空页；各页回执一致。模型读取正确回执后谎报另一UUID仍拒绝且不保存。
- NotAlone Python环境运行 `python -m unittest tests.unit.reply.test_langchain_vertical_slice tests.unit.reply.test_skill_runtime_resources tests.unit.reply.test_runtime_limits tests.unit.reply.test_input_budget_runtime -v`：32项通过。
- 新模块 `python -m unittest tests.unit.reply.test_skill_version_receipt -v`：3项通过。与原有vertical slice、Skill资源模块组合27项通过。
- Standards与Spec并行只读审查通过；空页覆盖建议已补齐。`git diff --check`通过。

## Computer Use

复用既有 `npm run dev`，核验开发实例后在实际输入小窗选择用户报告的同一已确认联系人，以手动输入范围点击空草稿「帮我想想」，保留关系背景。

App显示「生成已完成」，3条候选编辑框可见，未出现本次生成失败。未复制或向微信发送，未更改后台同步开关或授权。保留候选供用户查看。

只读元数据核验发现首轮未使用Skill，因此另加仅本次要求「如果有适合当前会话的 Skill，请先读取再生成。」验收自动读取路径。再次显示3条候选；数据库中讨论轮次、请求、尝试均为completed，failure_reason为空，used_skill_auto与版本归属校验均为true，候选数量为3。该校验不读取或记录私人正文，版本归属布尔不冒充当时内存回执的重放证明。验收要求随后清空，候选保留。

## 数据与限制

没有数据库迁移、资料删除或新增出站目标；本次实际模型验收沿用用户已配置服务及当前联系人范围。临时诊断仅记录异常类别和代码位置，诊断代码与临时文件在收尾时移除；私人正文、联系人身份、凭据及截图未加入仓库。

未打包、未推送，未重跑整个后端套件。这次修复针对自动Skill身份缺失，不代表模型或其他运行时失败都已消除。磁盘可用空间约49GiB，保留活动开发dist约3.7MiB，未创建App或运行时副本。
