# 06 文件存储与清洗验证

2026-10-24。仅匿名临时目录与合成 UUID；未访问真实 Skill、业务库、凭据或桌面，未调用模型。未执行 Git 暂存或提交。

## 固定依据

- DSH `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；本层为普通 TS 业务模块，不调用 DSH API。官方 registry/provider 与 filesystem 不承担 SQL103 文件完整性，依据 `contract-audit.md` 的锁定官方接口表。实际官方 runtime 验收由 runtime 子任务负责，不以本单测替代。
- 旧业务基线 `3c168296e9e8edaa43b8b323ff693e790e709069`；Python 实际解析器及序列化函数来自当前未修改的 `backend/src/notalone/skills/package.py`、`persistence/skill_files.py`、`skill_manifest.py`、`skill_methods.py`。
- `yaml@2.9.1` 显式 YAML1.1，拒绝重复键、plain merge 键及未知 tag；跨语言案例覆盖 bool、日期、显式字符串、前后锚点/alias、merge、自定义tag及多行字符串。不宣称所有 YAML 结构完全等价；alias 展开保留物理预算。

## 改动与证据

- 不可变版本位置继续为 `.versions/<owner>/<skill>/<version>/<name>/SKILL.md`，manifest 与 methods 索引仍在版本根，方法与资源独立校验字节 SHA256。
- 新增由 Python 真实生成快照/manifest/methods 的合成夹具，TS 直接读取并重试发布相同版本；验证原 UUID、方法索引顺序、既存字节和哈希不变。无重新赋 ID、迁库或真实资料重写。
- 红灯复现非 BMP 路径按 UTF-16 排序导致包哈希偏差；改为 Unicode 码点等价 UTF-8 字节排序，manifest 资源顺序同步修正。
- 红灯复现 CR-only 文档不识别及 Unicode 分隔符绕过 500 行约束；按 Python splitlines 保留原始正文分行，并单独将 YAML CR/NEL 规范化给解析器。清洗逐行处理亦覆盖全部分隔符，阻止上一行否定词掩盖下一行危险指令。
- 红灯复现 canonicalRoot 对整个父目录 realpath 会掩盖用户 symlink；仅允许 macOS `/tmp`、`/var` 两个已知系统别名，其他祖先链接由逐段检查拒绝。
- 既有测试继续覆盖发现排除项、资源单项/总量预算、外部 URL/私人导出/脚本清洗、SVG、工作副本显式写入、不可变冲突、owner 路径错配、方法允许子集、被篡改资源/方法、删除目录及导出链接保护。

## 实际命令与结果

- `$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test backend-ts/test/skill-files.test.mjs`：15/15，通过，无跳过；新案例先红后绿。
- `$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node backend-ts/node_modules/typescript/bin/tsc --noEmit -p backend-ts/tsconfig.json`：通过。
- Python 夹具使用 `$HOME/miniconda3/envs/NotAlone/bin/python`，仅导入解析/序列化模块，数据源为测试刚创建的临时目录，测试结束删除。

## 验证边界

本证据只覆盖文件业务层；未证明 HTTP/事务移交、来源撤销、删除队列重试、公开 runtime 或实际 App。文件操作包含逐段链接检查、NOFOLLOW、inode/mtime 校验，但不声称抵御拥有同目录写权限的恶意进程对所有父目录进行并发替换；跨文件导出也不声称整包事务原子性。这些边界不能拿单测通过替代整票验收。

## 独立合同复核补充

管理层发现器需要区分非法包与瞬时 IO 故障。`readPackage` 现在将文件系统错误转换为不含原路径的 `SkillPackageReadError(code=file_unavailable)`，非法包仍用 `SkillPackageError`；既有 library 可将前者归入 failedNames 保留上一有效目录状态。新增 `scanSnapshotDirectories(owner)` 只读枚举 `.versions/<owner>/<skill UUID>/<version UUID>`，返回 skill_id/version_id/relative_path 供持 owner 锁的清理层与数据库比对；根/祖先/子项链接和未知目录均拒绝，不自行删除、不查询数据库。对应故障、隔离及不改写测试先红后绿；文件层总计17/17通过，TypeScript检查通过。孤立快照真正回收、备份依赖强制和管理API故障恢复仍需管理/清理层集成验证。

追加只读 `scanStagingDirectories(owner)`（仅 owner 下技能 UUID 一级目录）供清理层核对 pending job；不改写内部暂存。`exportPackage` 保持覆盖指定目录中同名文件、保留无关文件的旧行为，返回 `{package_sha256,resource_paths,destination}`；哈希由本次已核验并导出的 SKILL.md 与按 Python 顺序排列的资源字节构造，不使用可能来自原始未规范化导入文档的 package hash。新增回归后文件层19/19通过，TypeScript检查通过。

规范审查收敛：新增无 IO 的 `matchesSkillPackage(row,manifest,pkg)` 供管理发现与只读目录资格共用；保留旧 `_matches` 的 name、正文 hash、描述和资源五元组比较，资源按 Unicode 顺序规范化且不修改输入。测试包含非 BMP 资源倒序与每个字段变动；文件层20/20通过，TypeScript检查通过。调用方替换由各模块负责人执行。
