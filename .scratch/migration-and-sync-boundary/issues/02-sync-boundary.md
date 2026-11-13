# 02 — 同步授权规则与默认选择

Triage: ready-for-agent
State: resolved
Blocked by: none

范围见 ../spec.md；保留 ADR-023 后台同步能力，以新 ADR 修订默认全选，并统一现行文字。

## Comments

2026-09-22 用户选择推荐方案：后台同步，首次手动选择联系人。

## Answer

- 首次选择为空，刷新仅保留有效用户选择；新增主动全选当前未绑定列表与清空选择入口，零选择不允许确认。没有更改已存在绑定、用户开关或同步引擎。
- ADR-030 修订 ADR-023 首次默认全选；根规则、现行隐私/流程/数据规格、领域术语、README 与 App 说明统一为后台 CLI 和前台 OCR 两条独立路径。历史 ADR 加后续决定指针，保留原始取舍。
- 恢复沿用 ADR-025：关闭时停读，重新开启后在已确认绑定与 baseline 范围内有界补齐；本次仅纠正文档，没有改变补齐实现。
- `swift build --package-path macos_app` 通过；`swift test --package-path macos_app` 19 项通过；全量 Python 979 项运行通过（3 项真实模型测试跳过），覆盖现有同步与绑定契约；`git diff --check` 通过。
- Standards 与 Spec 双轴只读评审均 0 项问题。此次仅构建、合成测试及静态核验，未打开真实微信或运行 App 采集；首次选择的真实界面操作与微信端到端体验尚未人工验收。
