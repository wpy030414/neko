# Agents Import Protocol — 规范草案 v0.1

> 状态：草案，供评审。实现前所有字段仍可调整。
> 本文档为协议契约；不含任何具体人格内容。示例中的 persona 均为占位。

## 1. 背景与目标

### 1.1 问题

人格类 skill（以「一组人格档案 + 一份切换/使用流程」为形态的技能，如本仓库）在宿主生态中运行良好，但无法直接迁移到以「持久化 agent 人格」为模型的平台（如 open-agent 的 Agent 管理）。迁移需要回答四个字段的出处：名称、头像、模型建议、系统提示词正文——而 skill 树里这些信息分散在 SKILL.md 正文、档案文件与宿主流程中。

### 1.2 目标

1. 定义一个**分发包格式**，把人格类 skill 打包为可移植单元：能被标准 Agent Plugins 客户端识别为合法包，同时被支持方完整读出人格内容。
2. 保证**双向无损**：skill → 包 → skill 的往返不丢失任何源信息（含 SKILL.md 的前置元数据、正文与全部资源文件）。
3. 保证**渐进消费**：不支持人格语义的客户端把本扩展当作普通数据忽略即可，不影响包加载。

### 1.3 外部约束

| 标准 | 版本 | 本协议的关系 |
|---|---|---|
| Agent Plugins | 1.0.0（agent-plugins.org/specification） | 外层包格式；本协议是它的客户端扩展 |
| Agent Skills | agentskills.io/specification | SKILL.md 格式基准；本协议镜像该文件而不重定义 |

## 2. 设计原则

1. **文件原样镜像，元数据只做描述**。扩展区内保存源 skill 树的文件字节；`agents.json` 只描述「这些文件如何映射为 persona」，从不承载或改写正文。转换的正确性不依赖对正文做语义解析。
2. **正文即文件，不内联**。任何 persona 的正文都指向包内文件，不写入清单 JSON。
3. **宿主语义分离**。SKILL.md 中的宿主专属流程（调用宿主工具、写宿主配置文件等）属于源宿主；协议将其标记（`host` 字段）而不是翻译。消费端自行决定是否展示该流程。
4. **档位是描述不是行为**。内容分级的档位组合只在清单中描述，消费端可以只读基础档。档位文件本身仍随包镜像，不因消费端不支持而删除。
5. **单层约定**。固定文件位置 + 可选清单：无清单时消费端也能按默认约定发现人格，有清单时获得精确映射。

## 3. 概念模型

| 术语 | 含义 |
|---|---|
| 源 skill 树 | 作者维护的人格 skill 目录（含 SKILL.md、personas/、scripts/ 等） |
| AIP 包 | 分发单元：合法 Agent Plugins 包，内含本协议的扩展区 |
| persona | 一个人格：id、显示名、正文文件（可含档位组合）、可选头像、可选模型建议 |
| 基础档 | persona 的默认正文组合，消费端无档位概念时读取它 |
| 清单 | `agents.json`：扩展区内的描述性元数据 |
| 规则配置 | 构建/发现时把源树映射到清单的可选规则文件（见 §10） |

## 4. 包结构

```
my-persona-plugin/            ← 插件根（Agent Plugins 约定）
├── plugin.json               ← Agent Plugins 1.0 manifest（必选）
└── xrl.openagent/            ← 扩展目录：扩展命名空间目录（Agent Plugins §8.2）
    ├── agents.json           ← 清单（可选；缺失时按 §7 默认约定发现）
    ├── SKILL.md              ← 源 SKILL.md 镜像（原样字节）
    ├── personas/             ← 人格档案镜像（原样字节）
    │   ├── vanilla.md
    │   └── …
    ├── scripts/              ← 源资源镜像（可选）
    └── references/           ← 源资源镜像（可选）
```

约束：

- `plugin.json` 必须满足 Agent Plugins 1.0 的 closed-schema（未知顶层字段会被标准客户端忽略并警告，故除 `extensions` 外不得添加字段）。
- 扩展区内的所有路径相对插件根解析，不得以 `..` 越出插件根（沿用 Agent Plugins §4.1 路径包含规则）。
- 扩展区可含源树没有的其他文件（如未来平台专用资源）；镜像还原时以清单的文件清单为准，忽略未知文件。

### 4.1 plugin.json 示例

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-persona-plugin",
  "version": "1.0.0",
  "description": "占位描述：人格示例包",
  "license": "Proprietary",
  "extensions": {
    "xrl.openagent": {
      "formatVersion": 1,
      "manifest": "./xrl.openagent/agents.json"
    }
  }
}
```

`extensions."xrl.openagent"` 的值是对象：`formatVersion`（本协议版本，整数，当前为 1）、`manifest`（清单相对路径，以 `./` 开头）。

## 5. 清单契约（agents.json）

### 5.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `formatVersion` | integer | 是 | 本协议格式版本，当前为 1 |
| `namespace` | string | 是 | 声明所属扩展命名空间；v1 固定为 `xrl.openagent` |
| `host` | string | 否 | 源宿主标识（如 `claude-code`）；缺失视为通用。消费端据此决定 SKILL.md 流程的语义 |
| `pluginName` | string | 否 | 源插件名（与 plugin.json.name 一致时省略） |
| `personas` | Persona[] | 是（可为空数组） | 人格清单 |

### 5.2 Persona 对象

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 档案标识：`[a-z0-9-]+`，全小写；与档案文件基名一致（`vanilla` ↔ `personas/vanilla.md`） |
| `name` | string | 是 | 显示名（消费端导入 agent 时的名称） |
| `primary` | string | 是 | 基础档正文文件（插件根相对路径，消费端默认读取它） |
| `sourceFile` | string | 否 | 源树中该 persona 的原始路径（用于还原）；默认等于 `personas/{id}.md` |
| `model` | string | 否 | 建议模型标识（消费端可预填、用户可改；不是强制值） |
| `avatar` | string | 否 | 头像文件（插件根相对路径） |
| `levels` | object | 否 | 档位组合描述（见 §6） |
| `metadata` | object | 否 | 任意附加元数据（字符串键值），消费端应忽略未知键 |

`levels` 之外的同名字段冲突时，以清单为准（清单是映射的权威，镜像文件是被映射对象）。

## 6. 档位模型

档位用「正文文件组合」表达，不引入内容语义：

```json
{
  "id": "vanilla",
  "name": "香子兰",
  "primary": "personas/vanilla.md",
  "levels": {
    "r15": ["personas/vanilla.md"],
    "r18": ["personas/vanilla.md", "personas/special.md"]
  }
}
```

- `primary` 必须与某个档位组合等价或为其首个文件；消费端**只读 `primary`**。
- 档位数组按序拼接即该档完整正文；同一文件可被多个档位引用。
- 消费端不支持档位时：忽略 `levels`，不报错，不删除包内文件；应在界面上明示「N 个扩展档未导入」（不得静默）。
- 档位 id 无受控词表；`r15`/`r18` 等仅为示例。

## 7. 默认约定（无清单时的发现规则）

清单缺失时，消费端按下列约定发现 persona：

- 目录 `personas/` 下每个 `{id}.md`（`id` 匹配 `[a-z0-9-]+`）是一个 persona。
- 显示名取 id；`personas/{id}.md` 是基础档正文。
- `personas/{id}.{ext}.md`（`ext` 非 `md` 的变形除外）不作为独立 persona；文件仍随包保留。
- 不产生档位描述与头像/模型建议。

该模式保证「只做目录约定」的最小包也能被消费，代价是没有显示名与建议值。

## 8. 往返（round-trip）语义

### 8.1 前向：源 skill 树 → AIP 包

1. 复制源树（含 SKILL.md 前置元数据原文、正文、personas/、scripts/ 等）进扩展区。
2. 生成 `plugin.json`（外层元数据）与 `agents.json`（映射描述）。
3. 产物：目录包或 zip 包。

### 8.2 反向：AIP 包 → 源 skill 树

1. 依 `agents.json` 的文件清单（或默认约定）把扩展区文件写回目标目录。
2. 不改写任何文件内容：SKILL.md 原样、档案原样。
3. `plugin.json`/`agents.json`/扩展目录是包结构，不写入还原后的源树。

### 8.3 验收判据

| 判据 | 含义 |
|---|---|
| 字节级一致 | build 后源文件与其在包内镜像逐字节一致；还原后与源树 diff 为空（忽略新增的包文件） |
| 元数据不丢 | SKILL.md 的前置元数据与正文未变（镜像保证） |
| 幂等 | 对同一源树二次 build 不产生冲突或重复文件；对同一包二次还原结果一致 |
| 独立可读 | 包能被标准 Agent Plugins 工具链识别（validate 通过），扩展区不影响其组件发现 |

## 9. 命名空间与治理

- `xrl.openagent` 是内部代号命名空间（非 ICANN 受控域名）。Agent Plugins §8 对命名空间的要求是 SHOULD（基于受控域名、保持稳定），故格式合规；跨实现唯一性依赖 xrl 前缀在体系内不与他方冲突。
- 迁移预案：若协议需要公开给第三方并取得受控域名，保留 v1 读取路径不变，发布 v2 清单字段 `namespace` 指向新命名空间，并允许消费端同时读取新旧两处（目录按 namespace 声明匹配，不再只按目录名）。

## 10. 转换工具（协议仓库内 tools/）

工具随协议同版本发布（`tools/` 目录），职责边界：

| 命令 | 行为 |
|---|---|
| `aip init [dir] [--rules file]` | 在源 skill 树生成 `agents.json` 骨架：按规则配置或默认约定填充映射 |
| `aip build [dir] [--out dir\|zip]` | 源树 → AIP 包（目录或 zip），含 `plugin.json` 生成 |
| `aip to-skill [pkg] [--out dir]` | AIP 包 → 源 skill 树（按 §8 还原） |
| `aip validate [dir\|zip]` | 校验外层 closed-schema、路径包含、清单字段、文件存在性与 id 命名 |

### 10.1 规则配置

映射的精确性（显示名、档位组合、插件元数据）由规则文件驱动。规则文件是 YAML 或 JSON，schema 与 `agents.json` 对齐，另含：

- 源宿主声明（`host`）与 SKILL.md 定位；
- persona 顺序与显示名表（不匹配时回退默认约定并警告）；
- 档位组合描述；
- `plugin.json` 元数据（name/version/description/license，可含占位符）。

规则文件建议存放于源树根（如 `agents-import.rules.yaml`）并随包镜像到扩展区，保证后续还原/重建使用同一映射。

## 11. 消费端语义（对 open-agent 的导入契约摘要）

正式契约以 open-agent 侧 `docs/specs/module-agent-import.md` 为准，此处只列协议层面的消费规则：

1. persona → agent 的字段映射：`name` → agent 名称；`primary` 文件全文 → system_prompt；`avatar` → 头像（平台内转 dataURL）；`model` → 模型建议（预填可改）。
2. `host` 非空且 SKILL.md 存在时，SKILL.md 流程**不导入** agent 系统提示词；消费端界面提示源宿主流程不可移植。
3. `levels` 中除 `primary` 对应的组合外均为扩展档：不导入、不删除、明示计数。
4. 单个 persona 失败（文件缺失、id 冲突）只跳过该 persona，不影响其他 persona 导入。
5. 导入落库时记录来源（包名/版本/persona id），用于追溯与重新导入。

## 12. 安全与路径约束

- 插件根外不得有包内引用（镜像文件与清单路径都必须落在扩展区与插件根内）。
- zip 解包沿用宿主上传链路的防路径穿越检查（Zip Slip），检查粒度覆盖扩展区全文件。
- 清单/正文不承载凭据。头像与正文文件按普通资源处理。

## 13. 版本与演进

- 本协议版本 = `formatVersion`（整数）。破坏性变更（字段删除/重定义、路径约定变更）递增主版本；新增可选字段只递增次版本（manifest 内 `formatVersion` 保持兼容策略记录于变更日志）。
- `plugin.json` 的 `$schema` 指向的 Agent Plugins 版本与包目标一致（v1 为 1.0.0）。

## 附录 A：完整清单示例（占位）

```json
{
  "formatVersion": 1,
  "namespace": "xrl.openagent",
  "host": "claude-code",
  "personas": [
    {
      "id": "sample",
      "name": "示例人格",
      "primary": "personas/sample.md",
      "sourceFile": "personas/sample.md",
      "model": null,
      "avatar": null,
      "levels": {
        "default": ["personas/sample.md"]
      },
      "metadata": {}
    }
  ]
}
```
