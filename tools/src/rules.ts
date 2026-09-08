/**
 * 机器规则（tools/rules/*.json）的加载与校验。
 * 人读映射见 tools/MAPPING.md，两者成对维护（协议 §10.1）。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AipError, warningFinding, type Finding } from './errors.js';
import { assertSafeRelativePath, assertTopLevelName, assertValidId, describeValue } from './paths.js';

export const PROTOCOL_NAMESPACE = 'xrl.momoi';
export const PROTOCOL_FORMAT_VERSION = 1;
export const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/** 内置默认规则：随包发布，也可用 --rules 覆盖。 */
export const DEFAULT_RULES_URL = new URL('../rules/default.json', import.meta.url);
/** 随包内置的 Agent Plugins 1.0 closed-schema 副本（来源见 MAPPING.md）。 */
export const PLUGIN_SCHEMA_FILE_URL = new URL('../schema/agent-plugins-1.0.0.plugin.schema.json', import.meta.url);

export interface PluginRules {
  name: string;
  version?: string;
  description?: string;
  license?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  keywords?: string[];
}

export interface PayloadRules {
  /** 顶层条目白名单；"*" 表示「除 exclude 外全部」。 */
  include: string[];
  /** 顶层条目黑名单，支持 `*` 后缀通配。 */
  exclude: string[];
}

export interface SkillRules {
  name: string;
  payload: PayloadRules;
}

export interface PersonaEntryRules {
  id: string;
  name: string;
  metadata?: Record<string, string>;
}

export interface PersonasRules {
  /** 人格正文模板，含 {id} 令牌。 */
  primary: string;
  /** 头像模板，含 {id} 令牌。 */
  avatar: string;
  /** 档位模板：档位 id → 正文文件模板数组（协议 §7）。 */
  levels?: Record<string, string[]>;
  /** 映射表：id → 显示名。为空时退化为从 personas/*.md 发现。 */
  entries?: PersonaEntryRules[];
}

export interface Rules {
  formatVersion: number;
  namespace: string;
  host?: string;
  plugin: PluginRules;
  skill: SkillRules;
  personas: PersonasRules;
  genericLayer?: { description?: string };
  toSkill?: { skillName?: string; description?: string };
}

export interface LoadedRules {
  rules: Rules;
  findings: Finding[];
}

export function loadRules(file?: string): LoadedRules {
  const at = file === undefined ? fileURLToPath(DEFAULT_RULES_URL) : file;
  let text: string;
  try {
    text = fs.readFileSync(file === undefined ? DEFAULT_RULES_URL : file, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AipError('RULES_UNREADABLE', `无法读取规则文件（${reason}）`, at);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AipError('RULES_INVALID_JSON', `规则文件不是合法 JSON（${reason}）`, at);
  }
  return parseRules(data, at);
}

const TOP_LEVEL_KEYS = ['formatVersion', 'namespace', 'host', 'plugin', 'skill', 'personas', 'genericLayer', 'toSkill'];
const PLUGIN_KEYS = ['name', 'version', 'description', 'license', 'author', 'homepage', 'repository', 'keywords'];
const SKILL_KEYS = ['name', 'payload'];
const PAYLOAD_KEYS = ['include', 'exclude'];
const PERSONAS_KEYS = ['primary', 'avatar', 'levels', 'entries'];
const ENTRY_KEYS = ['id', 'name', 'metadata'];

export function parseRules(data: unknown, at: string): LoadedRules {
  const findings: Finding[] = [];
  const root = requireObject(data, at, '规则根');
  checkKeys(root, TOP_LEVEL_KEYS, at, '规则根');

  const formatVersion = root['formatVersion'];
  if (formatVersion !== PROTOCOL_FORMAT_VERSION) {
    throw new AipError('RULES_FORMAT_VERSION', `规则 formatVersion 必须为 ${PROTOCOL_FORMAT_VERSION}，实际为 ${describeValue(formatVersion)}`, at);
  }
  const namespace = root['namespace'];
  if (namespace !== PROTOCOL_NAMESPACE) {
    throw new AipError('RULES_NAMESPACE', `规则 namespace 必须为 ${PROTOCOL_NAMESPACE}，实际为 ${describeValue(namespace)}`, at);
  }

  const pluginRaw = requireObject(root['plugin'], at, 'plugin');
  checkKeys(pluginRaw, PLUGIN_KEYS, at, 'plugin');
  const plugin: PluginRules = { name: requireString(pluginRaw['name'], at, 'plugin.name') };
  assignString(plugin, 'version', pluginRaw['version'], at, 'plugin.version');
  assignString(plugin, 'description', pluginRaw['description'], at, 'plugin.description');
  assignString(plugin, 'license', pluginRaw['license'], at, 'plugin.license');
  assignString(plugin, 'homepage', pluginRaw['homepage'], at, 'plugin.homepage');
  assignString(plugin, 'repository', pluginRaw['repository'], at, 'plugin.repository');
  if (pluginRaw['author'] !== undefined) {
    const authorRaw = requireObject(pluginRaw['author'], at, 'plugin.author');
    checkKeys(authorRaw, ['name', 'email', 'url'], at, 'plugin.author');
    const author: { name?: string; email?: string; url?: string } = {};
    assignString(author, 'name', authorRaw['name'], at, 'plugin.author.name');
    assignString(author, 'email', authorRaw['email'], at, 'plugin.author.email');
    assignString(author, 'url', authorRaw['url'], at, 'plugin.author.url');
    plugin.author = author;
  }
  if (pluginRaw['keywords'] !== undefined) {
    const keywords = pluginRaw['keywords'];
    if (!Array.isArray(keywords) || keywords.some((item) => typeof item !== 'string')) {
      throw new AipError('RULES_FIELD_TYPE', 'plugin.keywords 必须是字符串数组', at);
    }
    plugin.keywords = keywords as string[];
  }

  const skillRaw = requireObject(root['skill'], at, 'skill');
  checkKeys(skillRaw, SKILL_KEYS, at, 'skill');
  const skillNameTemplate = requireString(skillRaw['name'], at, 'skill.name');
  const payloadRaw = requireObject(skillRaw['payload'], at, 'skill.payload');
  checkKeys(payloadRaw, PAYLOAD_KEYS, at, 'skill.payload');
  const include = requireNameArray(payloadRaw['include'], at, 'skill.payload.include');
  const exclude = requireNameArray(payloadRaw['exclude'], at, 'skill.payload.exclude');

  const personasRaw = requireObject(root['personas'], at, 'personas');
  checkKeys(personasRaw, PERSONAS_KEYS, at, 'personas');
  const personas: PersonasRules = {
    primary: assertSafeRelativePath(requireString(personasRaw['primary'], at, 'personas.primary'), 'personas.primary'),
    avatar: assertSafeRelativePath(requireString(personasRaw['avatar'], at, 'personas.avatar'), 'personas.avatar'),
  };
  if (personasRaw['levels'] !== undefined) {
    const levelsRaw = requireObject(personasRaw['levels'], at, 'personas.levels');
    const levels: Record<string, string[]> = {};
    for (const [levelId, files] of Object.entries(levelsRaw)) {
      if (levelId.trim() === '') throw new AipError('RULES_FIELD_TYPE', 'personas.levels 的档位 id 不得为空', at);
      if (!Array.isArray(files) || files.length === 0) {
        throw new AipError('RULES_FIELD_TYPE', `personas.levels.${levelId} 必须是非空数组`, at);
      }
      levels[levelId] = files.map((file) =>
        assertSafeRelativePath(file, `personas.levels.${levelId}`),
      );
    }
    personas.levels = levels;
  }
  if (personasRaw['entries'] !== undefined) {
    const entriesRaw = personasRaw['entries'];
    if (!Array.isArray(entriesRaw)) throw new AipError('RULES_FIELD_TYPE', 'personas.entries 必须是数组', at);
    const entries: PersonaEntryRules[] = [];
    for (const [index, entryRaw] of entriesRaw.entries()) {
      const where = `personas.entries[${index}]`;
      const entry = requireObject(entryRaw, at, where);
      for (const key of Object.keys(entry)) {
        if (ENTRY_KEYS.includes(key)) continue;
        if (key === 'model') {
          findings.push(warningFinding('RULES_MODEL_IGNORED', `条目 ${describeValue(entry['id'])} 的 model 字段被忽略：模型由消费端与用户决定（协议 §2.4）`, where));
        } else {
          findings.push(warningFinding('RULES_UNKNOWN_ENTRY_KEY', `条目 ${describeValue(entry['id'])} 的未知字段 ${describeValue(key)} 被忽略`, where));
        }
      }
      const id = assertValidId(entry['id'], '人格 id', where);
      const name = requireString(entry['name'], at, `${where}.name`);
      const spec: PersonaEntryRules = { id, name };
      if (entry['metadata'] !== undefined) {
        const metadataRaw = requireObject(entry['metadata'], at, `${where}.metadata`);
        const metadata: Record<string, string> = {};
        for (const [key, value] of Object.entries(metadataRaw)) {
          if (typeof value !== 'string') throw new AipError('RULES_FIELD_TYPE', `${where}.metadata.${key} 必须是字符串`, at);
          metadata[key] = value;
        }
        spec.metadata = metadata;
      }
      entries.push(spec);
    }
    personas.entries = entries;
  }

  const rules: Rules = {
    formatVersion: PROTOCOL_FORMAT_VERSION,
    namespace: PROTOCOL_NAMESPACE,
    plugin,
    skill: { name: skillNameTemplate, payload: { include, exclude } },
    personas,
  };
  if (root['host'] !== undefined) rules.host = requireString(root['host'], at, 'host');
  if (root['genericLayer'] !== undefined) {
    const genericRaw = requireObject(root['genericLayer'], at, 'genericLayer');
    checkKeys(genericRaw, ['description'], at, 'genericLayer');
    const genericLayer: { description?: string } = {};
    assignString(genericLayer, 'description', genericRaw['description'], at, 'genericLayer.description');
    rules.genericLayer = genericLayer;
  }
  if (root['toSkill'] !== undefined) {
    const toSkillRaw = requireObject(root['toSkill'], at, 'toSkill');
    checkKeys(toSkillRaw, ['skillName', 'description'], at, 'toSkill');
    const toSkill: { skillName?: string; description?: string } = {};
    assignString(toSkill, 'skillName', toSkillRaw['skillName'], at, 'toSkill.skillName');
    assignString(toSkill, 'description', toSkillRaw['description'], at, 'toSkill.description');
    rules.toSkill = toSkill;
  }
  return { rules, findings };
}

export function expandTemplate(template: string, tokens: Record<string, string>, where: string): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
    const value = tokens[key];
    if (value === undefined) {
      throw new AipError('RULE_TEMPLATE_TOKEN', `模板引用了未知令牌 {${key}}：${template}`, where);
    }
    return value;
  });
}

function requireObject(value: unknown, at: string, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AipError('RULES_FIELD_TYPE', `${where} 必须是对象，实际为 ${describeValue(value)}`, at);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, at: string, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AipError('RULES_FIELD_TYPE', `${where} 必须是非空字符串，实际为 ${describeValue(value)}`, at);
  }
  return value;
}

function assignString<T extends object>(target: T, key: keyof T & string, value: unknown, at: string, where: string): void {
  if (value === undefined) return;
  (target as Record<string, unknown>)[key] = requireString(value, at, where);
}

function requireNameArray(value: unknown, at: string, where: string): string[] {
  if (!Array.isArray(value)) throw new AipError('RULES_FIELD_TYPE', `${where} 必须是数组`, at);
  return value.map((item) => assertTopLevelName(item, where));
}

function checkKeys(object: Record<string, unknown>, allowed: readonly string[], at: string, where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new AipError('RULES_UNKNOWN_KEY', `${where} 出现未知字段 ${describeValue(key)}（允许：${allowed.join(', ')}）`, at);
    }
  }
}
