# Agents Import Protocol — 规范 v0.2（草案）

> 状态：草案，供评审。实现前字段仍可调整。
> 本文只定义协议契约，不含任何具体人格内容；示例均为占位。

## 1. 背景与目标

### 1.1 问题

人格类 skill（以「一组人格档案 + 一份切换/使用流程」为形态的技能）在宿主生态中运行良好，但无法直接迁移到以「持久化 agent」为模型的平台。迁移需要回答三个字段的出处：显示名、头像、系统提示词正文——而 skill 树里这些信息分散在 SKILL.md、档案文件与宿主流程中。

### 1.2 目标

1. 定义**分发包格式**：标准 Agent Plugins 客户端可识别为合法包；支持方完整读出人格内容。
2. 保证**双向无损**：skill → 包 → skill 的往返不丢失源信息（含 SKILL.md 前置元数据、正文与全部资源文件）。
3. 保证**渐进消费**：不支持人格语义的客户端把扩展当作普通数据忽略即可，不影响包加载。
4. 提供**通用层**：无需任何自定义扩展即可从包内 `agents/` 读出可导入的代理定义，兼容既有 `agents/` + 客户端扩展目录的产物形态。

### 1.3 外部约束

| 标准 / 实践 | 版本 | 与本协议的关系 |
|---|---|---|
| Agent Plugins | 1.0.0（agent-plugins.org/specification） | 外层包格式；本协议是它的客户端扩展 |
| Agent Skills | agentskills.io/specification | SKILL.md 格式基准；本协议引用而不重定义 |
| 既有 `agents/` 实践 | — | 顶层 `agents/` 目录 + 客户端扩展目录的既有产物形态，本协议通用层与之兼容 |

## 2. 设计原则

1. **正文即文件**。persona / agent 的正文一律指向包内文件，不内联进清单 JSON。
2. **清单只做描述**。扩展清单只描述「文件如何映射为人格」，从不承载或改写正文。
3. **双形态**。通用层（`agents/*.md`，零扩展依赖）与扩展层（富化元数据）可共存；共存时以扩展清单为准，并校验一致性。
4. **不含模型**。包不携带模型标识或模型档位；模型由消费端与用户决定。
5. **不定义编排**。协议不得定义任何影响宿主编排或调度的字段。宿主控制面（例如负责生成追问、决定发言顺序、驱动事件管线的中立角色）不属于人格命名空间，包不得声明、覆盖或影响它。
6. **档位是描述**。内容分级的档位组合只在清单中描述，消费端可以只读基础档；档位文件本身仍随包保留。
7. **路径受限**。包内所有引用必须落在插件根内。

## 3. 概念

| 术语 | 含义 |
|---|---|
| 源 skill 树 | 作者维护的人格 skill 目录（含 SKILL.md、personas/、scripts/ 等） |
| AIP 包 | 分发单元：合法 Agent Plugins 包，内含本协议定义的通用层与/或扩展层 |
| 通用层 | 顶层 `agents/*.md`：任何消费端无需扩展即可发现的代理定义 |
| 扩展层 | `xrl.momoi/` 命名空间目录内的清单：富化元数据（显示名、头像、档位、源技能映射） |
| persona | 一个人格：id、显示名、正文文件（可含档位组合）、可选头像 |
| 基础档 | persona 的默认正文组合，消费端无档位概念时读取它 |
| 源技能 | 包内承载人格正文的技能目录（由清单 `source.skill` 声明） |

## 4. 包结构

```
plugin-root/                     ← 插件根（Agent Plugins 约定）
├── plugin.json                  ← Agent Plugins 1.0 清单（必选）
├── skills/<name>/SKILL.md       ← 标准组件：技能（可选，可多个）
├── agents/<id>.md               ← 通用层：代理定义（可选，可多个）
├── agents/<id>.<ext>            ← 通用层资源，如头像（可选）
└── xrl.momoi/plugin.json    ← 扩展清单（可选）
```

约束：

- `plugin.json` 必须满足 Agent Plugins 1.0 的 closed-schema（未知顶层字段会被标准客户端忽略并警告，故除 `extensions` 外不得添加字段）。
- 包内所有路径相对插件根解析，不得以 `..` 越出插件根（沿用 Agent Plugins §4.1 路径包含规则）。
- 三种形态均合法：只有通用层；只有扩展层；两者共存（共存时以扩展层为准）。

### 4.1 plugin.json 示例

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example-persona-plugin",
  "version": "1.0.0",
  "description": "占位描述",
  "license": "Proprietary",
  "extensions": {
    "xrl.momoi": {
      "formatVersion": 1,
      "manifest": "./xrl.momoi/plugin.json"
    }
  }
}
```

`extensions."xrl.momoi"` 的值是对象：`formatVersion`（本协议版本，整数，当前为 1）、`manifest`（扩展清单相对路径，以 `./` 开头）。扩展目录本身也可作为唯一表示（Agent Plugins §8 允许目录或清单任一形式）。

## 5. 通用层契约（`agents/*.md`）

- 文件名（去扩展名）即代理 id，必须匹配 `[a-z0-9-]+`。
- YAML 前置元数据：
  - `name`（必填）：显示名，自由文本。
  - `description`（可选）：一句话描述。
- 正文（frontmatter 之后）即系统提示词原文，不做任何转换。
- 同一 id 的资源文件（如 `<id>.png`）为头像候选。
- 消费端在没有扩展清单时按本契约发现代理；有扩展清单时以清单为准。

示例：

```markdown
---
name: 示例人格
description: 占位描述
---

（此处为系统提示词正文）
```

## 6. 扩展清单契约（`xrl.momoi/plugin.json`）

### 6.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `formatVersion` | integer | 是 | 本协议格式版本，当前为 1 |
| `namespace` | string | 是 | 所属扩展命名空间，v1 固定为 `xrl.momoi` |
| `host` | string | 否 | 源宿主标识；缺失视为通用 |
| `upstream` | object | 否 | `{ "repository"?: "<url>", "commit"?: "<标识>" }`：上游锚定，记录生成该包所跟踪的上游仓库与提交标识（§10.1） |
| `source` | object | 否 | `{ "skill": "<name>" }`：声明承载人格正文的源技能目录 |
| `personas` | Persona[] | 是（可为空数组） | 人格清单 |

### 6.2 Persona 对象

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | `[a-z0-9-]+`，与通用层文件名、源档案文件基名一致 |
| `name` | string | 是 | 显示名 |
| `primary` | string | 是 | 基础档正文文件（插件根相对路径），消费端默认读取它 |
| `sourceFile` | string | 否 | 源树中该 persona 的原始路径，用于还原 |
| `avatar` | string | 否 | 头像文件（插件根相对路径） |
| `levels` | object | 否 | 档位组合描述（见 §7） |
| `metadata` | object | 否 | 任意附加元数据（字符串键值），消费端忽略未知键 |

**不包含 `model`**：模型由消费端与用户决定（见 §2.4）。

### 6.3 与通用层共存

同一 id 同时出现在 `agents/<id>.md` 与 `personas[]` 时：以扩展清单为准；校验门必须检查两者正文一致，不一致视为包缺陷。

## 7. 档位模型

档位用「正文文件组合」表达，不引入内容语义：

```json
{
  "id": "example",
  "name": "示例人格",
  "primary": "skills/example-personas/personas/example.md",
  "levels": {
    "default": ["skills/example-personas/personas/example.md"],
    "extended": ["skills/example-personas/personas/example.md", "skills/example-personas/personas/extra.md"]
  }
}
```

- `primary` 必须与某个档位组合等价，或为其首个文件；消费端**只读 `primary`**。
- 档位数组按序拼接即该档完整正文；同一文件可被多个档位引用。
- 消费端不支持档位时：忽略 `levels`，不报错，不删除包内文件，并应在界面上明示「N 个扩展档未导入」（不得静默）。
- 档位 id 无受控词表。

## 8. 往返语义

### 8.1 前向：源 skill 树 → 包

1. 源树整体放入 `skills/<name>/`（字节不变，含空目录）。
2. 生成 `plugin.json` 与 `xrl.momoi/plugin.json`，清单 `source.skill` 指向该技能目录。
3. 通用层 `agents/` 可选生成，仅当需要非 AIP 客户端也能读出代理时。

### 8.2 反向：包 → 源 skill 树

1. 清单声明 `source.skill` 时：取 `skills/<name>/` 子树写回目标目录，不改写任何文件内容。
2. 无 `source.skill` 的纯人格包：由清单生成标准 SKILL.md 与人格文件；生成规则固定，保证再次前向转换得到等价包。

### 8.3 验收判据

| 判据 | 含义 |
|---|---|
| 字节级一致 | 前向后源文件与其在包内副本逐字节一致；反向还原后与源树 diff 为空（忽略新增的包结构文件） |
| 元数据不丢 | SKILL.md 的前置元数据与正文未变 |
| 幂等 | 同一源树二次前向不产生冲突或重复；同一包二次反向结果一致 |
| 独立可读 | 包通过 Agent Plugins 校验，扩展层不影响其组件发现 |

## 9. 命名空间与治理

- `xrl.momoi` 是内部代号命名空间（非 ICANN 受控域名）。Agent Plugins §8 对命名空间的要求是 SHOULD（基于受控域名、保持稳定），故格式合规；跨实现唯一性依赖该前缀在体系内不与他方冲突。
- 迁移预案：若协议需公开给第三方并取得受控域名，保留 v1 读取路径不变，发布 v2 清单字段 `namespace` 指向新命名空间，并允许消费端同时读取新旧两处。

## 10. 转换器 CLI

落点：协议仓库 `tools/`，随协议同版本发布。技术形态：Node/TS，配置驱动。

| 命令 | 行为 |
|---|---|
| `aip init [dir] [--rules file]` | 在源 skill 树生成扩展清单骨架（按规则或默认约定填充映射） |
| `aip build [dir] [--out dir\|zip] [--with-agents]` | 源树 → 包（含 `plugin.json`）；`--with-agents` 额外生成通用层 |
| `aip to-skill [pkg] [--out dir]` | 包 → 源 skill 树（按 §8.2） |
| `aip validate [dir\|zip]` | 校验清单 schema、路径包含、文件存在性、id 命名、通用层与扩展层一致性 |

### 10.1 规则与验证门

- 机器规则（映射表、令牌替换、清单投影）与人类可读映射文档成对维护。
- 验证门至少覆盖：Agent Plugins closed-schema、路径包含、id 命名、`primary` 文件存在、通用层/扩展层一致性、往返字节一致。
- 上游锚定：若包由跟踪某个上游仓库生成，记录上游提交标识，便于复现。

## 11. 消费端契约（摘要）

1. **双形态发现**：优先扩展清单；无清单时按 §5 通用层约定发现。
2. **宿主保留标识不得被覆盖**：消费端的系统级角色（例如驱动编排的中立角色）不属于人格命名空间；导入不得创建、覆盖或影响它们，撞名必须报错。
3. **不含模型**：导入不得从包中读取模型；模型由消费端与用户决定。
4. **技能安装策略由消费端定义**：包只声明技能的存在与来源，是否安装、如何处理同名冲突由消费端决定。
5. **失败隔离**：单个 persona 或技能失败只跳过该项，不影响其余导入。

## 12. 安全与路径约束

- 插件根外不得有包内引用。
- zip 解包沿用消费端上传链路的防路径穿越检查，覆盖包内全文件。
- 清单与正文不承载凭据；头像与正文按普通资源处理。

## 13. 版本与演进

- 协议版本 = `formatVersion`（整数）。破坏性变更递增主版本；新增可选字段保持兼容并在变更日志记录。
- `plugin.json` 的 `$schema` 指向的 Agent Plugins 版本与包目标一致（v1 为 1.0.0）。

## 附录 A：完整扩展清单示例（占位）

```json
{
  "formatVersion": 1,
  "namespace": "xrl.momoi",
  "host": "example-host",
  "source": { "skill": "example-personas" },
  "personas": [
    {
      "id": "example",
      "name": "示例人格",
      "primary": "skills/example-personas/personas/example.md",
      "sourceFile": "personas/example.md",
      "avatar": "skills/example-personas/personas/example.png",
      "levels": {
        "default": ["skills/example-personas/personas/example.md"]
      },
      "metadata": {}
    }
  ]
}
```
