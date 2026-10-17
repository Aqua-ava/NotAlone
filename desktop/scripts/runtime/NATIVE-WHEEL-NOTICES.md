# 原生 wheel 来源与通知核验（2026-10-17）

先前核验只读取了 SDist 的 Cargo.lock，遗漏了六个固定 wheel 内已有的原始 CycloneDX SBOM；本轮已补查并纠正相应缺项。构建锁现固定 **294 份来源文件（291 份归档、3 份固定 Git 原文）、667 段原始许可／通知和 7 份原始 SBOM**，另有一份固定 tiktoken 扩展的 native 观察证据。本轮只更新归因材料及其校验，没有改写 wheel、冻结包或用户资料，也没有重建 PostgreSQL、tiktoken 或 App，没有运行 GUI。新材料需经新运行时的 licenses／库存更新带入，不能冒称已经修改正在试用的包。

## 固定 wheel 的实际 SBOM

七份 SBOM 分别从 `python-wheels.lock.json` 指定的原始 wheel ZIP 读取：先核对整个 wheel SHA256，再核对 member 的原字节及 SHA256，并与已有安装副本逐字节比较。`attribution-sources.lock.json` 的 `sbomEvidence` 保存具体 member、摘要、同版本 SDist／Cargo.lock 指针和 scope 数量；构建会重新读取并验证这些材料，将原始 JSON 保留在 `licenses/attribution/evidence/wheel-sboms/`。SBOM JSON 与许可／通知文本分别计数。

| 固定 wheel | Rust SBOM required | excluded | 与同版本 SDist Cargo.lock 的核对 |
| --- | ---: | ---: | --- |
| cryptography 50.0.2 | 32 | 7 | 32 个 registry 项摘要一致，另 7 个本项目 local crate 名称／版本匹配 |
| jiter 0.17.0 | 33 | 4 | 36 个 registry 项摘要一致，另 1 个本项目 local crate 名称／版本匹配 |
| orjson 3.13.0 | 15 | 5 | 20 个 registry 项摘要一致；原有 `include/cargo/` 源码及通知继续保留 |
| ormsgpack 1.13.0 | 25 | 4 | 29 个 registry 项摘要一致 |
| pydantic_core 2.50.1 | 95 | 4 | 99 个 registry 项摘要一致 |
| uuid_utils 0.17.1 | 31 | 5 | 36 个 registry 项摘要一致 |

六份 Rust SBOM 共 260 个组件引用，去重为 202 个 Cargo 组件：177 个 registry required、17 个 registry excluded 构建材料、8 个 local crate。前两类的 **194 份官方 crates.io 归档**全部下载，原字节 SHA256 同时匹配固定 SBOM 与同版本 SDist 锁，合计 20,701,846 字节；没有执行 cargo、build.rs 或其中的包代码。8 个 local crate 继续引用已有 cryptography／jiter 完整 SDist，没有伪造 registry 下载。

来源记录分别使用 `rust-sbom-required` 与 `rust-sbom-excluded-build`，并保留每个 wheel/member/scope 引用。上游 `required` 声明包含跨平台 superset；例如材料中出现 UEFI／Wasm 项，不能将它们全部算作 macOS 最终二进制。`excluded` 构建材料也不计作最终 native 依赖。SBOM 证明固定版本、摘要和上游声明范围；实际 target/features 与链接器选择未精确还原。已保留 required／excluded 的来源及原始通知 superset，这一证据边界不单独构成当前材料缺项，不要求为此重新构建六个 wheel。

## 实际取得的原始通知

194 个 registry crate 中，193 个归档自身共提供 368 份原始许可／版权／通知文件，全部保留原字节及独立文件摘要。r-efi 5.2.0／5.3.0 的许可和版权位于 `AUTHORS`，已原样纳入；没有因缺少名为 LICENSE 的文件而误报为空，也没有从 SPDX 表达式生成通知。

wit-bindgen-rt 0.39.0 的 crate 没有许可全文，但 `.cargo_vcs_info.json` 指定官方提交 `f2393e6e98fa5f9236cac580db8a3fc9de6a4b70` 和 `crates/guest-rust/rt` 路径。本轮只额外保留该固定提交的一份[官方源码归档](https://codeload.github.com/bytecodealliance/wit-bindgen/tar.gz/f2393e6e98fa5f9236cac580db8a3fc9de6a4b70)：对应 Cargo.toml 与 crate 内 Cargo.toml.orig 逐字节相同，workspace 版本为 0.39.0。根 `LICENSE-APACHE`、`LICENSE-Apache-2.0_WITH_LLVM-exception`、`LICENSE-MIT` 原文均已保存，其 Git blob SHA1 分别为：

- `16fe87b06e802f094b3fbb0894b137bca2b16ef1`
- `f9d81955f4bcb8f96a025e2ecc46f39ec536d465`
- `31aa79387f27e730e33d871925e152e35e428031`

上述 blob 摘要来自官方固定提交的 tree API，并按 Git `blob <长度>\0<原字节>` 重新核对；归因 pipeline 继续验证每段文本的 SHA256 及这些 Git blob 摘要。归档 SHA256 `ee4f61950cfe2e96ca9715dfe4fc19c85a4fb7a63c1919400c4eace8107ffb9d` 是本机计算值，锁中明确标记为 `locally-computed-not-upstream-published`，没有写成上游发布的归档摘要。

## OpenSSL 与 libyaml 已有材料的进一步核对

cryptography wheel 的第七份 SBOM `sboms/sbom.json` 明确声明 OpenSSL 4.0.3、源码 SHA256 `325b5c806167c13b40b1ffeadfe0248197c00eccc4cf123ec1e28d2d2fd216d9`，与此前保存的官方归档及[官方独立摘要](https://www.openssl.org/source/openssl-4.0.3.tar.gz.sha256)一致。上游 metadata 声明 macOS/arm64 和 `no-zlib no-shared no-module no-comp no-apps no-docs no-sm2-precomp no-atexit enable-ec_nistp_64_gcc_128`。这补齐了先前未读取的上游构建参数证据；前轮同一冻结运行时也实际返回 OpenSSL 4.0.3。当前保留该源码、原始 LICENSE 及源码内 Perl 工具许可，同时保留 PBS 所用 OpenSSL 3.5.8。上述记录不认证完整工具链重现或全部 native 链接范围。

PyYAML 6.0.3 的前轮实际探针返回 libyaml 0.2.5，SDist 构建脚本显式关闭 shared library；[官方 libyaml 0.2.5 归档](https://pyyaml.org/download/libyaml/yaml-0.2.5.tar.gz)与原始 License 已随源固定。归档 SHA256 `c642ae9b75fee120b2d96c712538bd2cf283228d2337df2cf2988e3c02678ef4` 为本机固定值，未取得该归档的上游独立摘要；具体 wheel 的构建 ref 和源文件范围仍需分项核对。

## tiktoken 的观察来源与保守材料

固定 tiktoken 0.14.0 wheel SHA256 为 `d6cebe67765569df3dafac8474e4eccf5c19d24140492567a5e58a11445732a4`，内扩展 `tiktoken/_tiktoken.cpython-312-darwin.so` SHA256 为 `53533787cd22e02c0469e1423b54286334131b1549891636bbc6b545113cedb5`。其本体 SDist 与 wheel 的 LICENSE 原文已在库存，SHA256 同为 `418cb499b436128d653d79941333a5437b7be2ea9213dcc2f04d15d5d2c51d86`。

静态读取扩展得到 16 个含具体版本的 crate 源码路径；其中 6 个版本的完整来源和通知已由其他 SBOM 覆盖，本轮不重复下载。其余 10 个版本的官方 crate 均按 crates.io 独立发布摘要核验后保留，共 1,612,091 字节：

| 来源范围 | 本轮补齐的观察版本 |
| --- | --- |
| tiktoken 普通依赖 | aho-corasick 1.1.5、bit-set 0.8.0、bit-vec 0.8.0、bstr 1.13.1、fancy-regex 0.19.0、memchr 2.8.3 |
| Rust std 回溯材料 | addr2line 0.25.1、gimli 0.32.3、object 0.37.3、rustc-demangle 0.1.27 |

这 10 份归档共提供 23 个原始通知成员，其中部分 Apache／MIT 等原文字节已在其他来源中存在；本轮补齐每个观察版本的明确映射。没有因路径字符串而断言完整依赖图或最终功能可达范围。扩展含 rustc 完整提交 `8bab26f4f68e0e26f0bb7960be334d5b520ea452`；该[固定提交的 library/Cargo.lock](https://github.com/rust-lang/rust/blob/8bab26f4f68e0e26f0bb7960be334d5b520ea452/library/Cargo.lock) 对应四个 std 版本及摘要，`library/std/Cargo.toml` 声明相应回溯依赖，`src/version` 为 1.97.1。固定提交的根 LICENSE-MIT、LICENSE-APACHE、COPYRIGHT 共 12,362 字节，按官方 tree blob SHA1 与原文 SHA256 核验后作为三个独立 Git 原文保存；来源标记为 `locally-computed-git-blob-verified`，没有虚构上游 tar 摘要或下载整个 Rust 源码包。

扩展符号存在 `rustc_hash`，SDist Cargo.toml 只声明 `rustc-hash = "2"`，未提供可确定实际解析版本的锁。本轮保留 wheel 上传前已发布的全部五个 2.x 归档：2.0.0、2.1.0、2.1.1、2.1.2、2.1.3，共 69,726 字节，明确标为 `tiktoken-rustc-hash-major2-superset`。五版本 LICENSE-MIT 与 LICENSE-APACHE 原文分别逐字节相同，保留全部十个对应通知成员；它们不是五个已被证明链接的组件，也不宣称已识别实际版本。

`nativeEvidence` 只针对这一固定扩展：重新核对原 wheel／member SHA256、16 个实际 crate 版本路径、rustc 提交、同一 SDist 的 Cargo.toml 摘要及 major2 声明、扩展符号和五归档许可等同关系。通过后才能与 SBOM 一起登记已用来源，原有未引用 Cargo 来源拒绝门继续保留。三个固定 Git 原文另核对提交／路径 URL、文件 SHA256 与 Git blob SHA1，不执行源码或包代码。

[官方 tiktoken 0.14.0 提交](https://github.com/openai/tiktoken/tree/4e71bbe0c078468e00fefbf94b39849389f346e5) 的 Cargo.toml、LICENSE、setup.py、pyproject.toml 与固定 SDist 逐字节相同。固定 wheel 无 SBOM，SDist 与该提交均无 Cargo.lock；本轮读取的 wheel／SDist PyPI provenance 接口均返回 404（按[官方 API 语义](https://docs.pypi.org/api/integrity/)表示没有该文件的 provenance）。这些事实保留为精确重现边界，不意味着必须换 wheel 才能补齐已经观察到的原始材料。本轮没有自建新 wheel，也不以新构建追补原 wheel 的证明。

## 仍需分项核验的范围

- tiktoken 观察到的 10 个缺失版本、rustc-hash 五版本保守集合和 Rust std 根原文已补齐；实际 rustc-hash 版本及未观察到的完整解析图仍未证明，不把保守集合写成已链接清单。
- 六个 Rust wheel 的固定 SBOM、源码锁、194 份 registry 源及其原始通知已经形成可核验映射；精确 target/features 留作证据边界，当前材料收口不以全部功能还原或重新构建为门槛。
- 默认 psycopg-binary 3.3.6 的 libpq 18.6、OpenSSL、Kerberos、LDAP 等材料仍须与该默认 wheel 分别核对；修改库探针链接 PG16.15 的证据见[独立记录](PSYCOPG-VALIDATION.md)，不能替代默认 wheel 的构建材料。
- zstandard 0.25.0 的实际 wheel 有 C/CFFI 两个扩展；SDist 的 zstd 原始通知已在库存，其 Cargo.lock 不能被算成实际 wheel 的 Rust 依赖。xxhash 的 vendored LICENSE 也已在库存，余项是固定 wheel 与具体 vendored 构建的对应。
- regex 的生成 Unicode 数据范围、charset-normalizer 的生成器运行时代码、websockets speedups 的实际构建范围继续沿各自固定 wheel 核对。本轮没有据文件名认定存在某个额外静态库。
- cffi 2.1.1 的 arm64 扩展实际动态引用系统 `/usr/lib/libffi.dylib`；源码中的 Windows libffi 文件不据此算入本 macOS wheel。

## 实际验证与边界

最高归因接缝先在 SBOM 尚未保留时失败，实现后，原始 SBOM、SDist lock 和 crate 来源共同验证通过；来源名不对应、Git blob 摘要错误及 513 项来源输入均被拒绝，过量输入在下载前失败。仅将来源条目上限从 256 调至 512，以容纳现有 357 个来源记录（其中 294 个随包保留）；单 member 8MiB、通知 4096、运行时单文件／总字节与库存预算未放宽。

完整 `prepareRuntimeAttribution` 实际提取并验证 294 份来源文件、667 段原始通知、7 份原始 SBOM 和一份 native 观察证据，随后使用 `runtimeInventory` 核对 969 个文件。最小回归先因 Git 原文不能读取、native 来源被遗漏门拒绝而失败，实现后通过；错误 blob／URL、扩展摘要／crate 路径／rustc 提交、major2 声明／版本及许可等同关系仍被拒绝。新材料由后续 licenses／库存更新带入新包；已有冻结 App、GUI、数据库、密钥、默认 wheel 和依赖锁未改写。此记录不作完整法律义务或正式发行认证。
