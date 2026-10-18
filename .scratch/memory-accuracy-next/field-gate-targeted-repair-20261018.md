# 字段门禁定点修复与唯一负责人

用户最新要求：停止改一句提示后重跑整场。先复用已保存响应做离线定点对照；仅在定点证据支持有效且必要时做最小有界真实调用。原目标、Gold、质量门及生产空放行表不变。

## 分工

| 范围 | 唯一负责人 | 当前动作 |
| --- | --- | --- |
| bounded P01、证据门禁、共享集成 | runtime 主线程 | 核对字段级检查与原响应；不改模型输出 |
| reference A07/A10/A16 | reference 线程 | 先最终结果及独立闭账，再离线定点诊断 |
| core 历史边界、speech_act/assertion_status | core 线程 | 只读诊断；B 原型不作为修复或关票依据 |

公共提示、编译器或验证器改动前先报具体文件，由 runtime 协调唯一写入者；三线不同时修改公共文件。各场分母分别保留。没有新机制依据，不重抽原配置、不自动补缺失依赖。

## 已捕获失败与当前可证伪链

1. 失败：bounded dependency-v3 P01 完成动作被编译为短时状态，V 返回 supported；正式语义审核失败，实际 pending。
2. 原因定位：模型 kind 选择错误，编译映射与输出一致；现有规则已要求按主断言阶段选择。未发现可据以修复的程序接线缺陷。不能推断调整 V 配置导致 E 改善。
3. 最小改动：当前不改产品。先检查程序是否错误签发了 semantic_basis；若原响应重放能签出依据，才构成新的程序缺陷。
4. 定点对照：既有实际记录为 UNKNOWN/pragmatics_not_supported、semantic_basis=None；与源码下述检查相符。正确/错误标签的合成原型仅说明确定性编译差异，不算模型修复。
5. 通过标准：字段错误不能得到有限语义正证；模型必须保留正确完整事实才算质量通过。pending、UNKNOWN、mock、测试数量均不抵扣原15窗及七轴义务。

## 当前源码门禁核对（a3e286ec）

- `backend/src/notalone/memory_extraction/verification.py:235–281`：核引用属于实际消息、引用子串存在、supported 至少含目标来源；这些检查不证明类别或事实正确。
- `backend/src/notalone/memory_extraction/bounded_proof.py:289–321`：有限图对照后按六规则核 category/speech_act/assertion_status、literal/alternatives，再核事实有效时间；不由来源存在直接推出字段正确。
- `backend/src/notalone/memory_extraction/bounded_proof.py:340–380`：实际作者、主体、全文来源及范围先检查；语用不匹配为 UNKNOWN，明确图/作者/时间差异为 unsupported；缺少或不匹配提案不签依据。
- `backend/src/notalone/memory_extraction/evidence.py:98–110`：V supported 仍须程序 verified 且确有 semantic_basis 才装配有限依据；不能用通用 supported 代签。
- `backend/src/notalone/memory_extraction/flow.py:373–422`：unsupported 拒绝、uncertain 追加风险，其余保留候选；保留不等于质量认证或自动采纳。
- `backend/src/notalone/memory_extraction/dimensions.py:335`：默认放行集合仍为空；六规则之外不自行扩正证。

reference 的 A07/A16 误判语用与 A10 类别漏检，以及 core 的正文历史边界/标签错误，须各自检查原协议、原标签及真实响应。不得假定 reference 已接 bounded 六规则，也不得把增加拒绝率称作提高提取准确性。各负责人交付同样五段链后才决定修复。

本次只读源码审计与执行标准记录，0模型调用、0生产修改、0业务数据处理；未重跑测试，未新增质量信用。reference 独立审计通过，结果811cf0c2已集成为c8b1aa11；16全审、一般3，质量仍失败。
