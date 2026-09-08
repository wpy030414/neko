# AIP 转换器映射表（人读）

> 本文件与 `rules/default.json`（机器规则）成对维护，二者不一致时以规则文件为准（协议 §10.1）。
> 协议契约：`../docs/agents-import-protocol.md` v0.2。命令行用法见 `aip --help`。

## 1. 包投影

| 规则键 | 含义 | 本仓库取值 |
|---|---|---|
| `formatVersion` | 协议格式版本 | `1` |
| `namespace` | 扩展命名空间（v1 固定） | `xrl.momoi` |
| `host` | 源宿主标识（可选，缺失视为通用） | 未设置（按需在规则中开启） |
| `plugin.name` | `plugin.json` 的 `name`，模板 `{skill}` | `neko` |
| `plugin.version` | `plugin.json` 的 `version` | `1.0.0` |
| `plugin.description` | 包描述，模板 `{skill}` | `NEKOPARA 猫娘人格包（源技能 neko）` |
| `plugin.license` | 许可证标识 | `Proprietary` |
| `plugin.author` / `homepage` / `repository` / `keywords` | 可选透传字段（不填则不写） | 未设置 |

生成的 `plugin.json` 顶层字段固定为：`$schema`、`name`、`version`、`description`、`license`、`extensions`。
`extensions."xrl.momoi"` = `{ formatVersion, manifest: "./xrl.momoi/plugin.json" }`。
`plugin.json` 不写除上述之外的字段（Agent Plugins 1.0 closed-schema 要求 `additionalProperties: false`）。

## 2. 载荷规则（`skill.payload`）

载荷 = 源技能树中「顶层白名单」减去「顶层黑名单」，逐字节拷贝到 `skills/<技能名>/`。

| 键 | 值 | 说明 |
|---|---|---|
| `include` | `*` | 除 `exclude` 外全部顶层条目进入包（§8.1.1「源树整体放入」，`references/`、`assets/` 等技能资源随包保留） |
| `exclude` | `docs`、`tools`、`.git`、`node_modules`、`dist`、`build`、`coverage`、`.cache`、`.github`、`.vscode`、`.idea`、`xrl.momoi`、`agents`、`*.tsbuildinfo`、`.DS_Store`、`Thumbs.db` | 兜底黑名单（含构建产物）；`*` 前缀为后缀通配 |

- 技能名 `{skill}` 取 `SKILL.md` frontmatter 的 `name`（须匹配 `[a-z0-9-]+`），否则回退目录名并给出警告。
- 黑名单只作用于顶层条目；载荷内部同名目录不会被剔除（避免误删技能自带资源）。
- 未进入载荷的顶层条目不得静默丢弃：不在黑名单内却被白名单挡下的条目逐条给出 `PAYLOAD_ENTRY_DROPPED` 警告；黑名单命中的条目视为有意裁剪（若同时出现在 `include` 中同样告警）。
- 符号链接/重解析点一律拒绝（`SYMLINK_UNSUPPORTED`），防止载荷引用插件根之外的内容。

## 3. 人格映射表（`personas.entries`）

| id | 显示名 | primary（源树 → 包内） | 头像（存在时） |
|---|---|---|---|
| `chocola` | 巧克力 | `personas/chocola.md` → `skills/neko/personas/chocola.md` | `skills/neko/personas/chocola.png` |
| `vanilla` | 香子兰 | `personas/vanilla.md` → `skills/neko/personas/vanilla.md` | `skills/neko/personas/vanilla.png` |
| `coconut` | 椰子 | `personas/coconut.md` → `skills/neko/personas/coconut.md` | `skills/neko/personas/coconut.png` |
| `azuki` | 红豆 | `personas/azuki.md` → `skills/neko/personas/azuki.md` | `skills/neko/personas/azuki.png` |
| `maple` | 枫 | `personas/maple.md` → `skills/neko/personas/maple.md` | `skills/neko/personas/maple.png` |
| `cinnamon` | 肉桂 | `personas/cinnamon.md` → `skills/neko/personas/cinnamon.md` | `skills/neko/personas/cinnamon.png` |
| `strawberry` | 草莓 | `personas/strawberry.md` → `skills/neko/personas/strawberry.md` | `skills/neko/personas/strawberry.png` |
| `shigure` | 时雨 | `personas/shigure.md` → `skills/neko/personas/shigure.md` | `skills/neko/personas/shigure.png` |

- `personas/special.md` **不是人格**：它是 R-18 档位的附加正文，随载荷保留但不进 `personas[]`。
- 模板：`personas.primary = personas/{id}.md`、`personas.avatar = personas/{id}.png`。
- `entries` 为空时退化为按约定发现：`personas/*.md` 全部视为人格，显示名取该文件 frontmatter 的 `name`（缺失则取 id）。
- 条目中的未知字段只产生警告；`model` 字段一律忽略（协议 §2.4，模型由消费端与用户决定）。

## 4. 档位映射（`personas.levels`）

| 档位 id | 文件组合（模板 `{id}`） | 说明 |
|---|---|---|
| `default` | `personas/{id}.md` | 基础档，与 `primary` 等价 |
| `r18` | `personas/{id}.md` + `personas/special.md` | 附加档；`special.md` 存在时才写入清单 |

- 档位文件缺失时跳过该档并给出 `LEVEL_FILE_MISSING` 警告；`primary` 始终是 `default` 的首个文件（协议 §7）。

## 5. 通用层（`--with-agents`）

- 为每个人格生成 `agents/<id>.md`：frontmatter `name`（显示名）+ `description`（`genericLayer.description` 模板，默认 `{name}`），正文 = `primary` 文件字节（逐字节一致，协议 §5）。
- 同时把头像复制为 `agents/<id>.<ext>`。
- 通用层与扩展层共存时以扩展清单为准，`validate` 会校验两者正文一致（协议 §6.3）。

## 6. 还原规则（`to-skill`）

| 情形 | 行为 |
|---|---|
| 清单含 `source.skill` | 取包内 `skills/<name>/` 子树逐字节写回目标目录，不改写任何文件内容（协议 §8.2） |
| 纯人格包（无 `source.skill`） | 生成 `SKILL.md`（frontmatter `name` = `toSkill.skillName` 模板，默认 `{pluginName}`；非合法 id 时确定性净化并给出 `SKILL_NAME_SANITIZED` 警告）与 `personas/<id>.md`（frontmatter `name` = 清单显示名 + `primary` 正文）；头像复制为 `personas/<id>.<ext>`；清单 `levels` 引用的其他文件按 `personas/<basename>` 一并还原（协议 §7「档位文件本身仍随包保留」），布局冲突时报 `RESTORE_CONFLICT` |
| 纯通用层包 | 以 `agents/*.md` 为源：显示名取 frontmatter `name`，正文取 frontmatter 之后的原文写入 `personas/<id>.md` |

- 默认输出目录：`build` → `./dist/<插件名>`；`to-skill` → `./out/<技能名>`。
- 已存在的输出目录只有在「由本工具生成的 AIP 包」时才被覆盖（幂等），否则拒绝。

## 7. 验证门（`validate`，协议 §10.1）

| 门 | 判定 | 失败码 |
|---|---|---|
| closed-schema | `plugin.json` 通过内置 Agent Plugins 1.0 schema（未知顶层字段被拒） | `SCHEMA_PLUGIN` |
| 扩展清单结构 | `formatVersion`、`namespace`、`source.skill`、`personas[]` 字段与类型 | `FORMAT_VERSION_UNSUPPORTED`、`NAMESPACE_INVALID`、`MANIFEST_INVALID` |
| 路径包含 | 清单内每个路径解析后仍在插件根内；拒绝绝对路径、`..`、反斜杠、控制字符；逐段 lstat 拒绝路径前缀中的符号链接/重解析点（含 Windows junction） | `PATH_INVALID`、`PATH_ESCAPE`、`SYMLINK_UNSUPPORTED` |
| id 命名 | 人格 id / 技能名 / 通用层文件名匹配 `[a-z0-9-]+`，且不重复 | `ID_INVALID`、`ID_DUPLICATE` |
| 文件存在性 | `primary`、`avatar`、`levels` 引用的文件存在 | `FILE_MISSING` |
| 双形态一致性 | 同一 id 的 `agents/<id>.md` 正文与清单 `primary` 一致 | `DUAL_FORM_MISMATCH` |
| 往返字节一致 | 包 → `to-skill` 还原 → `build` 重建，载荷/人格正文字节相同；纯人格包另比较 `persona.name` 与 `levels` 文件字节 | `ROUNDTRIP_MISSING`、`ROUNDTRIP_MISMATCH`、`ROUNDTRIP_EXTRA` |
| zip 解压规模 | 解压前按中央目录声明拦截超大条目（单条 128 MiB / 累计 512 MiB / 压缩比 1000:1 / 条目数 20000），超限条目跳过、不解压 | `ZIP_ENTRY_TOO_LARGE`、`ZIP_TOTAL_TOO_LARGE`、`ZIP_RATIO_EXCEEDED`、`ZIP_TOO_MANY_ENTRIES` |

- 出现任一 `error` 即退出码 1，并逐条打印 `ERROR [码] 路径: 说明`；警告不改变退出码。
- `model` 等未知 persona 字段按协议忽略，仅打印警告（`MODEL_IGNORED`、`UNKNOWN_PERSONA_FIELD`）。
- 往返门重建时使用「全收」载荷规则（`include: ["*"]`、`exclude: []`）：源树黑名单只作用于 `build` 的源树→包方向，施加到还原树会把包内 `docs/`、`tools/` 等合法条目误判为往返缺失；因此对第三方包同样可判定。

## 8. 内置 schema 与依赖

| 项 | 值 | 来源 |
|---|---|---|
| `plugin.schema.json` | Agent Plugins 1.0.0 | `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`（`schema/agent-plugins-1.0.0.plugin.schema.json` 为逐字节副本，2026-09-08 取回） |
| `ajv` | `8.20.0` | JSON Schema 校验（draft 2020-12） |
| `fflate` | `0.8.3` | zip 读写 |
| `typescript` | `5.9.3` | 构建/类型检查（devDependency） |
| `tsup` | `8.5.1` | 打包（devDependency） |
| `vitest` | `5.0.0` | 测试（devDependency） |
| `vite` | `8.2.2` | vitest 的 peer 依赖（devDependency，显式锁定） |
| `@types/node` | `24.13.3` | 类型（devDependency） |

## 9. 与协议的取舍记录

1. **`host` 默认不写**：规则支持该字段，但默认规则未设置（缺失即「通用」，协议 §6.1）。需要记录源宿主时在规则文件中补 `"host": "<标识>"`。
2. **`init` 产物仅作骨架**：写入源树的 `xrl.momoi/plugin.json` 与 `build` 的投影结果一致，供作者核对映射；`build` 只读规则文件，不读源树内清单，避免双事实源。
3. **上游锚定**：协议 §10.1 建议记录上游提交标识。清单顶层没有对应字段，需要时写入人格条目的 `metadata`（如 `"upstreamCommit"`），`validate` 不解释该值。
4. **`to-skill` 对含错清单的包拒绝还原**：先校验再写盘，避免产出半成品；纯 `source.skill` 还原语义不受影响。
5. **载荷默认全收**：默认规则改为 `include: ["*"]` + 黑名单，落实 §8.1.1/§8.3 的字节往返；黑名单只裁剪构建产物与工具目录，命中的顶层条目按有意裁剪处理，其余被白名单挡下的条目逐条告警（`PAYLOAD_ENTRY_DROPPED`），不静默丢文件。
6. **zip 解压规模上限**：默认单条 128 MiB、累计 512 MiB、压缩比 1000:1、条目数 20000，在解压前按中央目录声明的尺寸拦截；`readZip` / `materializePackage` 的 `zipLimits` 参数可覆盖。
7. **路径包含含链接判定**：词法包含之外逐段 lstat，符号链接/重解析点（含 Windows junction）一律拒绝；`skills/<name>`、`agents`、`xrl.momoi` 自身是链接时同样拒绝读写。
