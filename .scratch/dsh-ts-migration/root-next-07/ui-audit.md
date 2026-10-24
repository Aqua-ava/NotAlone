# 07 UI 剩余实现与验收审计

日期：2026-10-25（Asia/Taipei）

## 状态

- 07 仍为 `claimed`。本会话完成剩余桌面展示缺口、合成 UI/状态回归和可执行 CUA 矩阵；真实 App 与微信只能由根会话统一操作，故不能由本次交付把 07 标成 `resolved`。
- 独立分支：`codex/task07-ui`；基线：`dd1f3070f21a4a37dd06d11c6ea5a504ea4fd9a7`。
- 源码提交：`fa4b5750480f6eb4a07e10bc2bc0454a34512c0a`（`修复恢复候选的回复方法显示`）。
- 未修改 `layered_memory.py`、L3 回复测试、10 extraction、21 foreground、正式主工作树或数据库 5432 的 `notalone_dev`。

## 实现结论

发现并修复一个恢复态合同缺口：候选原先只从 `state.result` 读取实际 Skill；重开已保存讨论后 `state.result === null`，虽然能从历史轮次恢复候选，却把实际 Skill 恒显示为未知。现在当前结果和恢复结果共同从 `displayedReply` 派生名称、版本、加载状态与范围，并在候选标题下直接显示：

- 实际 Skill：`本次实际回复方法：名称 · 版本 N`，含部分资源失败和发布范围状态。
- 未使用 Skill：`本次使用通用流程（未使用回复 Skill）。`
- 旧快照无字段：`本次快照未记录回复方法，无法确认是否使用 Skill。`

相关实现：[RewritePanel.tsx](../../../desktop/src/renderer/RewritePanel.tsx)

当前交互按 ADR-074 为自动选择零或一个 Skill，不恢复用户手选 Skill 的旧步骤；v2 `desktop-acceptance.md` 中“指定版本／不用 Skill”不能作为本轮产品手选验收。通用流程需由根在合成测试管理入口先停用唯一测试 Skill，或使用下一轮无匹配的受控测试状态。

本改动只消费既有公开回复状态，不新增 DSH 接口、插件、Tool 或核心修改。锁定版本仍为 DSH `0.2.1-rc.2`／官方提交 `687f282e8625c6b8d11ff58211a90524be2e4317`；依据见 [runtime-validation](../../../.scratch/dsh-ts-migration/runtime-validation/progress.md)、[07 evidence manifest](../../../.scratch/dsh-ts-migration/task07-implementation/v2/evidence-manifest.json)。

## 已运行验证

| 验证 | 结果 |
| --- | --- |
| `desktop && ./node_modules/.bin/tsc --noEmit` | 通过，0 错误 |
| 工作区/联系人切换/Skill 回执 38 项单测与 Chrome 组件回归 | 通过 38/38 |
| 工作区动作、Skill 冻结、候选版本、复制与来源合同 44 项 | 通过 44/44 |
| `test:pages --case understanding-direction --timeout-seconds 180` | 通过；输入连续性、联系人切换迟到结果隔离、候选失败、续改来源删除、保留历史依赖删除 |
| `test:pages --case reply-strategy-skills --case source-deletion-replies --timeout-seconds 240` | 通过；express/suggest 各自实际 Skill、通用流程、重试固定版本、来源撤销与晚结果 |

两组页面验收均只运行单个无头 Chrome、生产页面、隔离合成 HTTP/PG 和合成进程；Electron 未运行，原生验收未完成。两次 `cleanupConfirmed=true`，浏览器静默采样为 0 active、0 onscreen，合成库和临时资源查询为 0。

全量 `desktop/scripts/test-safe.mjs` 在启动前被基线未登记文件 `tests/expression-preferences/bigint.test.mjs` 阻断；该文件已跟踪但不在此前 `tests/inventory.json`，与本次改动无关。未擅自修改该无关分类，故全量安全集仍须由根或对应负责人修复登记后再跑。

## 根 CUA 操作矩阵

前置：根先复用已有 `npm run dev` 实例并确认是 `--notalone-dev` 热更新宿主；只用当前合成 namespace、合成甲/乙和临时 userData，不打包、不启动第二份 App、不发送微信消息。控制器仅由根操作；每项记录源 SHA、实际请求数、进程、数据库/目录清理。

| ID | 操作 | 预期观察 |
| --- | --- | --- |
| C0 | 用控制器 `snapshot` 核对正式 TS host、合成联系人甲/乙、`sync=false`、当前许可排空；CUA 确认输入小窗可见 | runtime 为 DSH、replies owner 为 TypeScript；无真实模型/微信请求 |
| C1 | “本次联系人”选择合成甲并确认；“有什么想说的”清空；点“帮我想想” | 出现“候选回复”和 1–3 条可编辑建议；“生成说明与更多操作”显示本次动作为“帮我想想（建议尚未代表你的立场）”，不出现旧回应/主动联系入口 |
| C2 | 在“有什么想说的”填合成想法；点“帮我表达”；把“候选1编辑文本”改成含唯一标记的合成句，Tab 失焦 | 显示“正在自动保存修改…”后出现“修改版本 1”；复制按钮可用；关闭并重开输入小窗后文字仍为已保存版本 |
| C3 | 在候选标题下读取“本次回复方法”；展开“本次参考” | 名称和版本与控制器实际 `read_file` 的不可变版本一致；参考抽屉“回复方法”为同名；不显示用户手选或把自动选择写成已确认 |
| C4 | 切到合成乙；填入“仅属于乙的合成想法”；再切回甲 | 乙看不到甲草稿/候选/编辑；回到甲恢复原草稿、已保存候选和“本次回复方法”；切换不触发自动生成 |
| C5 | 控制器 `hold-next reply`；甲点“帮我想想”发起一次生成；等待出现“正在等待本次生成结果…”后切到乙；控制器 `release`；再切回甲 | 乙不出现甲迟到候选；甲只恢复原会话候选；候选数不增加，页面不跨联系人显示“正在生成” |
| C6 | 展开“本次参考”；核对聊天、关系资料、表达偏好、回复方法和本次输入分组；执行合成来源删除后重新读取候选 | 抽屉只显示生成时快照，不补填后来资料；删除完成后候选/依据状态受控失效，不恢复被删正文；晚结果不重新发布 |
| C7 | 打开管理后台“Skill”页，核对“已有 Skill”和历史轮次的“本轮实际 Skill”仍可读；再核对设置中的用量/诊断入口可达 | Skill 名称、版本和编辑候选仍可回看；23 管理入口可达；无自动发送按钮或外发调用 |

C3/C7 的通用流程分支只有在根以公开合成管理入口停用唯一测试 Skill 后才执行；预期出现“本次使用通用流程（未使用回复 Skill）”。若根没有该受控前置，保持“通用流程 App 实测未覆盖”，不要把自动 Skill 结果代签为无 Skill。

## 剩余风险

- 真实 App 的分组点击、焦点与原生窗口恢复仍待根实测；本次组件和页面通过不能代替原生验收。
- 全量桌面安全测试被上述既有 inventory 登记缺口阻断，相关模块已通过，但不能宣称“全量安全测试通过”。
- 本会话未运行真实模型质量、真实微信、打包版、push 或 PR；07 的最终状态由根根据实际 App 证据决定。
