# Skill 包窄只读器

范围、启停、修订、组合预算与原目录删除边界统一见[Skill Library](../../architecture/current/skill-library.md)。本组件只实现受控文件读取，不负责决定 Skill 是否可以使用。

本组件只供可信的 `SecureSkillDirectory` 调用，不注册模型 Tool。`root` 固定授权根身份，`list` 仅返回该根的合法直接子目录名，`identity` 返回指定包目录身份，`package` 返回有效身份下的一次文档/静态资源快照。根路径和预期 dev/ino 来自宿主业务配置与冻结修订，不来自模型输入；标准输出不含物理路径，错误仅有有限代码。

从 `/` 开始逐段 `openat(O_NOFOLLOW | O_DIRECTORY)`，绑定根与包目录 FD。`fdopendir`/`fstatat(AT_SYMLINK_NOFOLLOW)` 只枚举绑定目录；文件用相对 FD 的 `openat(O_NOFOLLOW | O_NONBLOCK)` 打开，拒绝符号链接、硬链接、非普通文件和不支持类型。包身份在正文读取之前复核；文件读完立即核验并关闭，目录通过显式队列逐项处理，只同时保留当前路径的父子 FD。返回前从绑定包 FD 逐段重新打开已记录条目，复核身份与纳秒修改元数据。祖先路径只承担授权根的逐段身份定位，不把兄弟目录增删造成的大小、链接数或修改时间变化当成包变化；包根、正文、资源及其子目录继续绑定完整快照。最终逐文件重新打开时也核对同次 `fstat`／`fstatat` 的完整元数据，拒绝该窗口内同 inode 的改写、权限变化或新增硬链接。根身份在每个库实例初始化后固定，替换根不被重新信任。Node 用这次快照的实际文档和资源字节生成清单、包摘要，再核对当前业务修订，不以先后两次相同状态代替实际字节绑定。

边界：文档/单资源各 1 MiB，资源最多 100 个/合计 4 MiB；目录与路径沿用操作系统限制，不新增目录深度、包目录数量或累计 FD 上限。现有格式/500行/估算5000 tokens/安全校验及每次模型输入预算继续适用。子进程只继承固定 PATH，无 shell、网络或任意环境；Node 墙钟限 5 秒、输出限 12 MiB，缺失服务或超时都拒绝，不回落 Node 路径读取。当前业务通过[异步目录适配器](../../backend-ts/src/skills/secure-directory-async.ts)在独立只读 Worker 中调用本组件；原生子进程的同步等待不占主宿主事件循环。异步返回、模型发送及提交仍须复验取消、账号、联系人、授权和版本，完成文件读取不等于模型出站授权。

显式构建：`bash native/skill-read/build.sh`。仅 arm64/macOS 15 部署目标，输出和临时卷均须至少 15 GiB。按源码 mtime 复用 `.build/skill-read`，更新使用随机临时文件原子替换，不原地覆写已有二进制。`desktop/scripts/dev.mjs` 和默认后台测试 runner 在启动前调用该入口；业务运行时不编译。直接运行单个 Node 测试前先执行该构建。`.build` 被忽略，尚未验证发布包或其他平台。

合成验证：`cd backend-ts && node --test test/sqlite-skill-file-safety.test.mjs test/sqlite-skills.test.mjs test/sqlite-skill-profile.test.mjs`。覆盖服务缺失、受控包身份校验、根/包同字节替换、祖先/正文/资源链接、硬链接、遍历、资源目录并发替换、50 目录/100 资源（含低 FD 额度）、48 层合法路径、超过 1024 包的目录发现、确定性祖先兄弟目录变化、最终逐文件复核窗口内正文／权限／硬链接变化、有效更新与停用/来源撤销，正式 profile 使用官方 registry 和隔离追踪/模型配置替身。

系统调用合同核对本机 SDK `sys/fcntl.h` 的 `O_NOFOLLOW`/`O_DIRECTORY`/`AT_SYMLINK_NOFOLLOW`、`sys/stat.h` 的 `fstatat` 和 `dirent.h` 的 `fdopendir`。Node v24.19.0 无公开 `openat`；macOS `/dev/fd/<目录FD>/文件` 无法遍历，Node/libuv 也拒绝 Darwin `O_NOFOLLOW_ANY`，故使用该窄组件。参考 [Apple open(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html)、[Node 子进程](https://nodejs.org/docs/latest-v24.x/api/child_process.html)。这些接口依据不代表真实 App、模型质量或发布验收。
