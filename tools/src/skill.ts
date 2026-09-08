/**
 * 源技能树扫描：确定技能名、载荷文件集合、人格映射（协议 §8.1）。
 * 人格映射以规则文件中的 entries 为准；entries 为空时退化为 personas/*.md 发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AipError, warningFinding, type Finding } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { assertSafeRelativePath, ID_PATTERN } from './paths.js';
import { expandTemplate, type Rules } from './rules.js';
import { matchesPattern, walkEmptyDirs, walkFiles } from './fsutil.js';

export interface PersonaSpec {
  id: string;
  name: string;
  /** 源树内的 POSIX 相对路径（= 包内 primary 去掉 skills/<name>/ 前缀）。 */
  sourceFile: string;
  avatarSource?: string;
  levels?: Record<string, string[]>;
  metadata?: Record<string, string>;
}

export interface SourceSkill {
  root: string;
  name: string;
  description?: string;
  /** 载荷文件的源树相对路径（POSIX，已排序）。 */
  payloadFiles: string[];
  /** 载荷内空目录的源树相对路径（POSIX，已排序）；空目录无文件承载，需显式记录才能往返。 */
  emptyDirs: string[];
  personas: PersonaSpec[];
}

export function inspectSource(root: string, rules: Rules): { skill: SourceSkill; findings: Finding[] } {
  const findings: Finding[] = [];
  const stat = safeStat(root);
  if (stat === null || !stat.isDirectory()) {
    throw new AipError('DIR_MISSING', `源技能目录不存在或不是目录：${root}`, root);
  }
  const skillMd = path.join(root, 'SKILL.md');
  if (!fs.existsSync(skillMd) || !fs.statSync(skillMd).isFile()) {
    throw new AipError('SKILL_MISSING', `源技能树缺少 SKILL.md：${root}`, root);
  }
  const parsed = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
  const name = resolveSkillName(root, parsed.data['name'], findings);
  const payload = selectPayload(root, rules, findings);
  const personas = discoverPersonas(root, rules, payload.files, name, findings);
  const skill: SourceSkill = { root, name, payloadFiles: payload.files, emptyDirs: payload.emptyDirs, personas };
  const description = parsed.data['description'];
  if (description !== undefined) skill.description = description;
  return { skill, findings };
}

function resolveSkillName(root: string, declared: string | undefined, findings: Finding[]): string {
  if (declared !== undefined && declared !== '' && ID_PATTERN.test(declared)) return declared;
  const base = path.basename(path.resolve(root));
  if (declared !== undefined && declared !== '') {
    findings.push(
      warningFinding('SKILL_NAME_FALLBACK', `SKILL.md 的 name ${JSON.stringify(declared)} 不是合法技能名（[a-z0-9-]+），改用目录名 ${JSON.stringify(base)}`, 'SKILL.md'),
    );
  }
  if (!ID_PATTERN.test(base)) {
    throw new AipError('SKILL_NAME_INVALID', `无法确定合法技能名：SKILL.md 的 name 与目录名都不匹配 [a-z0-9-]+`, root);
  }
  return base;
}

export interface PayloadSelection {
  files: string[];
  emptyDirs: string[];
}

/** 载荷 = 顶层白名单（或全部）减去黑名单；黑名单只作用于顶层条目。空目录单独记录以便往返还原。 */
export function selectPayload(root: string, rules: Rules, findings: Finding[]): PayloadSelection {
  const { include, exclude } = rules.skill.payload;
  const includeAll = include.includes('*');
  const topEntries = fs
    .readdirSync(root, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (!includeAll) {
    for (const wanted of include) {
      if (!topEntries.includes(wanted)) {
        findings.push(warningFinding('PAYLOAD_ENTRY_MISSING', `payload.include 中的条目在源树中不存在，已跳过：${wanted}`, root));
      }
    }
  }

  const selected: string[] = [];
  const emptyDirs: string[] = [];
  for (const entryName of topEntries) {
    const excluded = matchesPattern(entryName, exclude);
    const included = includeAll || include.includes(entryName);
    if (!included || excluded) {
      // 不得静默丢文件：黑名单命中的条目按映射文档视为有意裁剪，其余顶层条目逐条告警。
      if (excluded) {
        if (!includeAll && include.includes(entryName)) {
          findings.push(warningFinding('PAYLOAD_ENTRY_DROPPED', `顶层条目 ${entryName} 同时命中 payload.include 与 payload.exclude，已按 exclude 丢弃`, root));
        }
      } else {
        findings.push(warningFinding('PAYLOAD_ENTRY_DROPPED', `顶层条目未进入载荷（不在 payload.include 白名单中），已丢弃：${entryName}`, root));
      }
      continue;
    }
    const absolute = path.join(root, entryName);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new AipError('SYMLINK_UNSUPPORTED', `载荷中不支持符号链接：${entryName}`, absolute);
    }
    if (stat.isDirectory()) {
      if (fs.readdirSync(absolute).length === 0) emptyDirs.push(entryName);
      for (const nested of walkFiles(absolute, absolute)) selected.push(`${entryName}/${nested}`);
      for (const nested of walkEmptyDirs(absolute, absolute)) emptyDirs.push(`${entryName}/${nested}`);
    } else if (stat.isFile()) {
      selected.push(entryName);
    }
  }
  return {
    files: selected.sort((a, b) => a.localeCompare(b)),
    emptyDirs: emptyDirs.sort((a, b) => a.localeCompare(b)),
  };
}

function discoverPersonas(
  root: string,
  rules: Rules,
  payloadFiles: readonly string[],
  skillName: string,
  findings: Finding[],
): PersonaSpec[] {
  const entries = rules.personas.entries;
  if (entries !== undefined && entries.length > 0) {
    const specs: PersonaSpec[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const id = entry.id;
      if (seen.has(id)) throw new AipError('ID_DUPLICATE', `规则中人格 id 重复：${id}`, 'personas.entries');
      seen.add(id);
      const tokens = { id, skill: skillName };
      const sourceFile = assertSafeRelativePath(
        expandTemplate(rules.personas.primary, tokens, 'personas.primary'),
        'personas.primary',
      );
      if (!payloadFiles.includes(sourceFile)) {
        throw new AipError(
          'PERSONA_PRIMARY_NOT_IN_PAYLOAD',
          `人格 ${id} 的 primary 不在载荷内：${sourceFile}（检查 personas.primary 与 skill.payload.include）`,
          sourceFile,
        );
      }
      const name = expandTemplate(entry.name, tokens, `personas.entries[${id}].name`);
      const avatarTemplate = assertSafeRelativePath(
        expandTemplate(rules.personas.avatar, tokens, 'personas.avatar'),
        'personas.avatar',
      );
      const spec: PersonaSpec = { id, name, sourceFile };
      if (payloadFiles.includes(avatarTemplate)) spec.avatarSource = avatarTemplate;
      const levels = projectLevels(rules.personas.levels, tokens, id, payloadFiles, findings);
      if (levels !== undefined) spec.levels = levels;
      if (entry.metadata !== undefined) spec.metadata = entry.metadata;
      specs.push(spec);
    }
    return specs;
  }
  return discoverPersonasByConvention(root, rules, payloadFiles, skillName, findings);
}

/** 兜底发现：personas/<id>.md，显示名取前置元数据 name，头像取同名图片。 */
function discoverPersonasByConvention(
  root: string,
  rules: Rules,
  payloadFiles: readonly string[],
  skillName: string,
  findings: Finding[],
): PersonaSpec[] {
  const personasDir = path.join(root, 'personas');
  if (!fs.existsSync(personasDir) || !fs.statSync(personasDir).isDirectory()) return [];
  const specs: PersonaSpec[] = [];
  const files = fs
    .readdirSync(personasDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const id = file.slice(0, -3);
    if (!ID_PATTERN.test(id)) {
      // personas/ 下的说明文档等非人格 .md 不应中止整次构建：跳过并告警。
      findings.push(warningFinding('PERSONA_FILE_SKIPPED', `personas/${file} 的文件基名不是合法人格 id（[a-z0-9-]+），已跳过`, `personas/${file}`));
      continue;
    }
    const sourceFile = `personas/${file}`;
    const parsed = parseFrontmatter(fs.readFileSync(path.join(personasDir, file), 'utf8'));
    const declared = parsed.data['name'];
    const spec: PersonaSpec = { id, name: declared !== undefined && declared !== '' ? declared : id, sourceFile };
    const avatar = findAvatar(root, id);
    if (avatar !== undefined && payloadFiles.includes(avatar)) spec.avatarSource = avatar;
    const levels = projectLevels(rules.personas.levels, { id, skill: skillName }, id, payloadFiles, findings);
    if (levels !== undefined) spec.levels = levels;
    specs.push(spec);
  }
  return specs;
}

const AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];

function findAvatar(root: string, id: string): string | undefined {
  for (const extension of AVATAR_EXTENSIONS) {
    const relative = `personas/${id}.${extension}`;
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return relative;
  }
  return undefined;
}

function projectLevels(
  template: Record<string, string[]> | undefined,
  tokens: Record<string, string>,
  id: string,
  payloadFiles: readonly string[],
  findings: Finding[],
): Record<string, string[]> | undefined {
  if (template === undefined) return undefined;
  const levels: Record<string, string[]> = {};
  for (const [levelId, files] of Object.entries(template)) {
    const expanded = files.map((file) =>
      assertSafeRelativePath(expandTemplate(file, tokens, `personas.levels.${levelId}`), `personas.levels.${levelId}`),
    );
    const missing = expanded.filter((file) => !payloadFiles.includes(file));
    if (missing.length > 0) {
      findings.push(
        warningFinding('LEVEL_FILE_MISSING', `人格 ${id} 的档位 ${levelId} 引用了载荷外的文件，已跳过该档：${missing.join(', ')}`, 'personas.levels'),
      );
      continue;
    }
    levels[levelId] = expanded;
  }
  return Object.keys(levels).length > 0 ? levels : undefined;
}

function safeStat(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}
