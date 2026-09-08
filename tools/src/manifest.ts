/**
 * 清单投影与校验（协议 §4、§6）。
 * - 投影：规则 → plugin.json / xrl.momoi/plugin.json，绝不内联正文，绝不写入 model。
 * - 校验：plugin.json 走 Agent Plugins 1.0 closed-schema（随包内置副本）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { AipError, errorFinding, warningFinding, type Finding } from './errors.js';
import { isSafeRelativePath, resolveInside } from './paths.js';
import { PLUGIN_SCHEMA_FILE_URL, PLUGIN_SCHEMA_URL, PROTOCOL_FORMAT_VERSION, PROTOCOL_NAMESPACE, expandTemplate, type Rules } from './rules.js';
import type { PersonaSpec } from './skill.js';

export interface ManifestPersona {
  id: string;
  name: string;
  primary: string;
  sourceFile?: string;
  avatar?: string;
  levels?: Record<string, string[]>;
  metadata?: Record<string, string>;
}

const PERSONA_KEYS = ['id', 'name', 'primary', 'sourceFile', 'avatar', 'levels', 'metadata'];

export function projectPluginJson(rules: Rules, tokens: Record<string, string>): Record<string, unknown> {
  const plugin: Record<string, unknown> = {
    $schema: PLUGIN_SCHEMA_URL,
    name: expandTemplate(rules.plugin.name, tokens, 'plugin.name'),
  };
  if (rules.plugin.version !== undefined) plugin['version'] = rules.plugin.version;
  if (rules.plugin.description !== undefined) plugin['description'] = expandTemplate(rules.plugin.description, tokens, 'plugin.description');
  if (rules.plugin.license !== undefined) plugin['license'] = rules.plugin.license;
  if (rules.plugin.author !== undefined) plugin['author'] = rules.plugin.author;
  if (rules.plugin.homepage !== undefined) plugin['homepage'] = rules.plugin.homepage;
  if (rules.plugin.repository !== undefined) plugin['repository'] = rules.plugin.repository;
  if (rules.plugin.keywords !== undefined) plugin['keywords'] = rules.plugin.keywords;
  plugin['extensions'] = {
    [rules.namespace]: {
      formatVersion: rules.formatVersion,
      manifest: `./${rules.namespace}/plugin.json`,
    },
  };
  return plugin;
}

export function projectExtensionManifest(
  rules: Rules,
  skillName: string,
  personas: readonly PersonaSpec[],
): Record<string, unknown> {
  const prefix = `skills/${skillName}/`;
  const manifest: Record<string, unknown> = {
    formatVersion: rules.formatVersion,
    namespace: rules.namespace,
  };
  if (rules.host !== undefined) manifest['host'] = rules.host;
  manifest['source'] = { skill: skillName };
  manifest['personas'] = personas.map((persona) => {
    const projected: Record<string, unknown> = {
      id: persona.id,
      name: persona.name,
      primary: `${prefix}${persona.sourceFile}`,
    };
    projected['sourceFile'] = persona.sourceFile;
    if (persona.avatarSource !== undefined) projected['avatar'] = `${prefix}${persona.avatarSource}`;
    if (persona.levels !== undefined) {
      const levels: Record<string, string[]> = {};
      for (const [levelId, files] of Object.entries(persona.levels)) {
        levels[levelId] = files.map((file) => `${prefix}${file}`);
      }
      projected['levels'] = levels;
    }
    if (persona.metadata !== undefined) projected['metadata'] = persona.metadata;
    return projected;
  });
  return manifest;
}

let ajvInstance: Ajv2020 | null = null;

function getAjv(): Ajv2020 {
  if (ajvInstance === null) {
    const schema = JSON.parse(fs.readFileSync(PLUGIN_SCHEMA_FILE_URL, 'utf8')) as AnySchemaObject;
    ajvInstance = new Ajv2020({ allErrors: true, strict: false });
    ajvInstance.addSchema(schema, PLUGIN_SCHEMA_URL);
  }
  return ajvInstance;
}

/** Agent Plugins 1.0 closed-schema 校验（unknown 顶层字段会因 additionalProperties:false 被拒）。 */
export function validatePluginJson(data: unknown, at: string): Finding[] {
  const validate = getAjv().getSchema(PLUGIN_SCHEMA_URL);
  if (validate === undefined) throw new AipError('SCHEMA_MISSING', '内置 plugin.schema.json 未注册', at);
  if (validate(data)) return [];
  return (validate.errors ?? []).map((err) =>
    errorFinding('SCHEMA_PLUGIN', `${err.instancePath === '' ? '/' : err.instancePath} ${err.message ?? ''}`.trim(), at),
  );
}

export interface ManifestLocation {
  /** 扩展清单文件绝对路径；无扩展层时为 null。 */
  file: string | null;
  findings: Finding[];
}

/** 定位扩展清单：优先 plugin.json 的 extensions 声明，其次 xrl.momoi/plugin.json 目录形态。 */
export function locateExtensionManifest(root: string, pluginDoc: unknown): ManifestLocation {
  const findings: Finding[] = [];
  let declared: string | undefined;
  if (isPlainObject(pluginDoc)) {
    const extensions = pluginDoc['extensions'];
    if (isPlainObject(extensions)) {
      const namespaceEntry = extensions[PROTOCOL_NAMESPACE];
      if (namespaceEntry !== undefined) {
        if (!isPlainObject(namespaceEntry)) {
          findings.push(errorFinding('EXTENSION_DECL_INVALID', `plugin.json extensions.${PROTOCOL_NAMESPACE} 必须是对象`, 'plugin.json'));
        } else {
          const formatVersion = namespaceEntry['formatVersion'];
          if (formatVersion !== undefined && formatVersion !== PROTOCOL_FORMAT_VERSION) {
            findings.push(errorFinding('FORMAT_VERSION_UNSUPPORTED', `扩展声明 formatVersion 必须为 ${PROTOCOL_FORMAT_VERSION}，实际为 ${JSON.stringify(formatVersion)}`, 'plugin.json'));
          }
          const manifest = namespaceEntry['manifest'];
          if (manifest !== undefined) {
            if (typeof manifest !== 'string') {
              findings.push(errorFinding('EXTENSION_DECL_INVALID', 'extensions 的 manifest 必须是字符串路径', 'plugin.json'));
            } else {
              declared = manifest;
            }
          }
        }
      }
    } else if (extensions !== undefined) {
      findings.push(errorFinding('EXTENSION_DECL_INVALID', 'plugin.json extensions 必须是对象', 'plugin.json'));
    }
  }

  // 目录形态同样走 resolveInside：xrl.momoi 本身若是符号链接/重解析点，读清单即越出插件根。
  const directoryRelative = path.posix.join(PROTOCOL_NAMESPACE, 'plugin.json');
  let directoryForm: string | null = null;
  try {
    directoryForm = resolveInside(root, directoryRelative, directoryRelative);
  } catch (err) {
    findings.push(asFinding(err));
  }

  let file: string | null = null;
  if (declared !== undefined) {
    try {
      const absolute = resolveInside(root, declared, 'plugin.json extensions.manifest');
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
        file = absolute;
      } else {
        findings.push(errorFinding('MANIFEST_MISSING', `声明的扩展清单不存在：${declared}`, 'plugin.json'));
      }
    } catch (err) {
      findings.push(asFinding(err));
    }
    if (file !== null && directoryForm !== null && fs.existsSync(directoryForm) && path.resolve(file) !== path.resolve(directoryForm)) {
      const declaredDoc = readJsonFile(file, findings);
      const directoryDoc = readJsonFile(directoryForm, findings);
      if (declaredDoc !== null && directoryDoc !== null && JSON.stringify(declaredDoc) !== JSON.stringify(directoryDoc)) {
        findings.push(errorFinding('EXTENSION_AMBIGUOUS', '扩展清单同时以两种形式存在且内容不一致（extensions 声明 vs xrl.momoi/plugin.json）', 'plugin.json'));
      }
    }
  } else if (directoryForm !== null && fs.existsSync(directoryForm) && fs.statSync(directoryForm).isFile()) {
    file = directoryForm;
  }
  return { file, findings };
}

export function readJsonFile(file: string, findings: Finding[]): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    findings.push(errorFinding('FILE_UNREADABLE', `无法读取：${err instanceof Error ? err.message : String(err)}`, file));
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    findings.push(errorFinding('JSON_INVALID', `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`, file));
    return null;
  }
}

export interface ExtensionManifestResult {
  personas: ManifestPersona[];
  findings: Finding[];
}

/** 扩展清单结构校验 + 路径包含 + 文件存在性（协议 §6、§10.1、§12）。 */
export function validateExtensionManifestDoc(doc: unknown, root: string, at: string): ExtensionManifestResult {
  const findings: Finding[] = [];
  const personas: ManifestPersona[] = [];
  if (!isPlainObject(doc)) {
    findings.push(errorFinding('MANIFEST_INVALID', '扩展清单必须是对象', at));
    return { personas, findings };
  }
  if (doc['formatVersion'] !== PROTOCOL_FORMAT_VERSION) {
    findings.push(errorFinding('FORMAT_VERSION_UNSUPPORTED', `formatVersion 必须为 ${PROTOCOL_FORMAT_VERSION}，实际为 ${JSON.stringify(doc['formatVersion'])}`, at));
  }
  if (doc['namespace'] !== PROTOCOL_NAMESPACE) {
    findings.push(errorFinding('NAMESPACE_INVALID', `namespace 必须为 ${PROTOCOL_NAMESPACE}，实际为 ${JSON.stringify(doc['namespace'])}`, at));
  }
  const host = doc['host'];
  if (host !== undefined && typeof host !== 'string') {
    findings.push(errorFinding('MANIFEST_INVALID', 'host 必须是字符串', at));
  }
  const source = doc['source'];
  if (source !== undefined) {
    if (!isPlainObject(source) || typeof source['skill'] !== 'string') {
      findings.push(errorFinding('MANIFEST_INVALID', 'source 必须是 { skill: string }', at));
    } else if (!/^[a-z0-9-]+$/.test(source['skill'])) {
      findings.push(errorFinding('ID_INVALID', `source.skill 必须匹配 [a-z0-9-]+，实际为 ${JSON.stringify(source['skill'])}`, at));
    }
  }
  const personasRaw = doc['personas'];
  if (!Array.isArray(personasRaw)) {
    findings.push(errorFinding('MANIFEST_INVALID', 'personas 必须是数组（可为空数组）', at));
    return { personas, findings };
  }

  const seen = new Set<string>();
  personasRaw.forEach((entry, index) => {
    const where = `${at}#/personas/${index}`;
    if (!isPlainObject(entry)) {
      findings.push(errorFinding('MANIFEST_INVALID', 'persona 必须是对象', where));
      return;
    }
    for (const key of Object.keys(entry)) {
      if (PERSONA_KEYS.includes(key)) continue;
      if (key === 'model') {
        findings.push(warningFinding('MODEL_IGNORED', 'persona 的 model 字段被忽略：模型由消费端与用户决定（协议 §2.4）', where));
      } else {
        findings.push(warningFinding('UNKNOWN_PERSONA_FIELD', `persona 的未知字段 ${JSON.stringify(key)} 被忽略`, where));
      }
    }
    const id = entry['id'];
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
      findings.push(errorFinding('ID_INVALID', `id 必须匹配 [a-z0-9-]+，实际为 ${JSON.stringify(id)}`, where));
      return;
    }
    if (seen.has(id)) {
      findings.push(errorFinding('ID_DUPLICATE', `人格 id 重复：${id}`, where));
      return;
    }
    seen.add(id);
    const name = entry['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      findings.push(errorFinding('MANIFEST_INVALID', 'name 必须是非空字符串', where));
    }
    const primary = entry['primary'];
    const persona: ManifestPersona = { id, name: typeof name === 'string' ? name : '', primary: typeof primary === 'string' ? primary : '' };
    if (typeof primary !== 'string') {
      findings.push(errorFinding('MANIFEST_INVALID', 'primary 必须是字符串路径', where));
    } else {
      checkContainedFile(root, primary, `${where}/primary`, findings);
      const base = path.posix.basename(primary, path.posix.extname(primary));
      if (base !== id) {
        findings.push(warningFinding('ID_FILENAME_MISMATCH', `primary 文件基名 ${JSON.stringify(base)} 与 id ${JSON.stringify(id)} 不一致（协议 §6.2）`, where));
      }
    }
    const sourceFile = entry['sourceFile'];
    if (sourceFile !== undefined) {
      if (typeof sourceFile !== 'string') {
        findings.push(errorFinding('MANIFEST_INVALID', 'sourceFile 必须是字符串路径', where));
      } else if (!isSafeRelativePath(sourceFile)) {
        findings.push(errorFinding('PATH_INVALID', `sourceFile 不是安全的相对路径：${JSON.stringify(sourceFile)}`, where));
      } else {
        persona.sourceFile = sourceFile;
      }
    }
    const avatar = entry['avatar'];
    if (avatar !== undefined) {
      if (typeof avatar !== 'string') {
        findings.push(errorFinding('MANIFEST_INVALID', 'avatar 必须是字符串路径', where));
      } else {
        checkContainedFile(root, avatar, `${where}/avatar`, findings);
        persona.avatar = avatar;
      }
    }
    const levels = entry['levels'];
    if (levels !== undefined) {
      if (!isPlainObject(levels)) {
        findings.push(errorFinding('MANIFEST_INVALID', 'levels 必须是对象', where));
      } else {
        const projected: Record<string, string[]> = {};
        for (const [levelId, files] of Object.entries(levels)) {
          if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string')) {
            findings.push(errorFinding('MANIFEST_INVALID', `levels.${levelId} 必须是非空字符串数组`, where));
            continue;
          }
          for (const file of files as string[]) checkContainedFile(root, file, `${where}/levels/${levelId}`, findings);
          projected[levelId] = files as string[];
        }
        if (Object.keys(projected).length > 0) {
          persona.levels = projected;
          const primaryValue = persona.primary;
          const coherent = Object.values(projected).some((files) => files[0] === primaryValue);
          if (typeof primary === 'string' && !coherent) {
            findings.push(errorFinding('LEVELS_PRIMARY_MISMATCH', `primary 必须是某个档位组合的首个文件（协议 §7）：${primary}`, where));
          }
        }
      }
    }
    const metadata = entry['metadata'];
    if (metadata !== undefined) {
      if (!isPlainObject(metadata) || Object.values(metadata).some((value) => typeof value !== 'string')) {
        findings.push(errorFinding('MANIFEST_INVALID', 'metadata 必须是字符串键值对象', where));
      } else {
        persona.metadata = metadata as Record<string, string>;
      }
    }
    personas.push(persona);
  });
  return { personas, findings };
}

/** 路径必须落在插件根内且指向存在的文件。 */
function checkContainedFile(root: string, relative: string, where: string, findings: Finding[]): void {
  let absolute: string;
  try {
    absolute = resolveInside(root, relative, where);
  } catch (err) {
    findings.push(asFinding(err));
    return;
  }
  if (!fs.existsSync(absolute)) {
    findings.push(errorFinding('FILE_MISSING', `清单引用的文件不存在：${relative}`, where));
  } else if (!fs.statSync(absolute).isFile()) {
    findings.push(errorFinding('NOT_A_FILE', `清单引用的路径不是文件：${relative}`, where));
  }
}

export function asFinding(err: unknown): Finding {
  if (err instanceof AipError) {
    return err.path === undefined
      ? { code: err.code, severity: 'error', message: err.message }
      : { code: err.code, severity: 'error', message: err.message, path: err.path };
  }
  return { code: 'INTERNAL', severity: 'error', message: err instanceof Error ? err.message : String(err) };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
