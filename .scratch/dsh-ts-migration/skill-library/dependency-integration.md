# 06 共享依赖装配记录

2026-10-23，主会话按06集成请求加入直接依赖；此记录不表示Skill业务或运行profile已完成。

- `@deepseek-ai/dsh-skill` 精确 `0.2.1-rc.2`：核对[锁定官方README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/README.md)及同目录package.json，registry不含业务Skill内容，provider仍需实现范围和版本约束。
- `yaml` 精确 `2.9.1`：复用原消费锁已有制品，核对[官方解析文档](https://eemeli.org/yaml/)，重复键使用Document errors检查。默认YAML 1.2不能视为与旧PyYAML规则等价，格式差分交06文件层验证。
- 两项均已存在传递依赖锁，变更仅为直接声明和importer引用，不变制品integrity、不启用filesystem/tool-skill，不修改profile。

在backend-ts目录、固定Node24/pnpm11.25.0运行：

1. `pnpm add --save-exact --offline --ignore-scripts --no-optional @deepseek-ai/dsh-skill@0.2.1-rc.2 yaml@2.9.1`：成功，downloaded 0。
2. `pnpm install --offline --frozen-lockfile --ignore-scripts --no-optional`：成功。
3. Node ESM导入官方SkillRegistry及yaml、读取package版本：分别0.2.1-rc.2和2.9.1；`parseDocument`重复name探针准确返回一个DUPLICATE_KEY错误。

尚未验证业务YAML兼容、provider装配、真实官方profile Skill读取或用户界面；这些仍为06验收。未读个人资料、未调用模型、未运行App、未新增业务数据，未打包或推送。
