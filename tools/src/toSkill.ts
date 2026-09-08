/**
 * aip to-skill：AIP 包 → 源技能树（协议 §8.2）。
 * 有 source.skill：取 skills/<name>/ 子树逐字节写回；
 * 无 source.skill：按固定规则生成 SKILL.md 与 personas/<id>.md（补写显示名 frontmatter），
 * 并把 levels 引用的每个文件按 personas/<basename> 一并还原（协议 §7）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AipError, errorFinding, hasErrors, warningFinding, type Finding } from './errors.js';
import { assertDirectory, copyTreeFiles, walkFiles, writeFileAt } from './fsutil.js';
import { emitFrontmatter, parseFrontmatter, splitFrontmatter } from './frontmatter.js';
import { isPlainObject, locateExtensionManifest, readJsonFile, validateExtensionManifestDoc, type ManifestPersona } from './manifest.js';
import { materializePackage } from './package.js';
import { assertValidId, normalizeId, resolveInside } from './paths.js';
import { expandTemplate, loadRules, type Rules } from './rules.js';

export interface ToSkillOptions {
  rulesFile?: string;
  rulesOverride?: Rules;
}

export interface ToSkillResult {
  out: string;
  skillName: string;
  /** true = 由清单生成（无 source.skill）；false = 源技能子树还原。 */
  generated: boolean;
  findings: Finding[];
}

type ToSkillPersona = ManifestPersona & { genericLayer?: boolean };

export function toSkill(pkg: string, out: string | undefined, options: ToSkillOptions = {}): ToSkillResult {
  const findings: Finding[] = [];
  const materialized = materializePackage(pkg);
  findings.push(...materialized.findings);
  try {
    const root = materialized.root;
    const pluginPath = path.join(root, 'plugin.json');
    if (!fs.existsSync(pluginPath)) {
      throw new AipError('PLUGIN_MISSING', `包内缺少 plugin.json：${root}`, root);
    }
    const pluginDoc = readJsonFile(pluginPath, findings);
    if (hasErrors(findings)) throw new AipError('PLUGIN_INVALID', 'plugin.json 无法解析，无法还原', pluginPath);

    const location = locateExtensionManifest(root, pluginDoc);
    findings.push(...location.findings);
    let manifestDoc: unknown = null;
    let personas: ToSkillPersona[] = [];
    if (location.file !== null) {
      manifestDoc = readJsonFile(location.file, findings);
      if (manifestDoc !== null) {
        const validated = validateExtensionManifestDoc(manifestDoc, root, location.file);
        findings.push(...validated.findings);
        personas = validated.personas;
      }
      if (hasErrors(findings)) {
        throw new AipError('MANIFEST_INVALID', '扩展清单存在错误，拒绝还原（不产生任何输出）', location.file);
      }
    }

    const sourceSkill = readSourceSkill(manifestDoc);
    if (sourceSkill !== undefined) {
      const skillName = assertValidId(sourceSkill, 'source.skill', 'xrl.momoi/plugin.json');
      const skillRoot = resolveInside(root, `skills/${skillName}`, 'source.skill');
      assertDirectory(skillRoot, 'source.skill');
      const target = path.resolve(out ?? path.join(process.cwd(), 'out', skillName));
      copyTreeFiles(skillRoot, walkFiles(skillRoot, skillRoot), target);
      return { out: target, skillName, generated: false, findings };
    }

    if (personas.length === 0) personas = discoverGenericPersonas(root, findings);
    if (hasErrors(findings)) {
      throw new AipError('MANIFEST_INVALID', '通用层存在错误，拒绝还原（不产生任何输出）', root);
    }
    if (personas.length === 0) {
      throw new AipError('NO_PERSONAS', '包内既无 source.skill 也无可还原的人格定义（协议 §8.2）', root);
    }

    const rules = options.rulesOverride ?? loadRules(options.rulesFile).rules;
    const pluginName = isPlainObject(pluginDoc) && typeof pluginDoc['name'] === 'string' ? pluginDoc['name'] : 'aip-personas';
    const rawSkillName = expandTemplate(rules.toSkill?.skillName ?? '{pluginName}', { pluginName }, 'toSkill.skillName');
    const skillName = normalizeId(rawSkillName) || 'aip-personas';
    if (skillName !== rawSkillName) {
      findings.push(
        warningFinding(
          'SKILL_NAME_SANITIZED',
          `生成的技能名 ${JSON.stringify(rawSkillName)} 不是合法技能 id（[a-z0-9-]+），已净化为 ${JSON.stringify(skillName)}`,
          'toSkill.skillName',
        ),
      );
    }
    const target = path.resolve(out ?? path.join(process.cwd(), 'out', skillName));

    // 固定布局：personas/<id>.md 补写显示名 frontmatter；levels 引用的每个文件按 personas/<basename> 一并还原（协议 §7）。
    const planned = new Map<string, Buffer>();
    const plan = (relative: string, data: Buffer): void => {
      const existing = planned.get(relative);
      if (existing === undefined) {
        planned.set(relative, data);
        return;
      }
      if (!existing.equals(data)) {
        throw new AipError('RESTORE_CONFLICT', `还原布局冲突：${relative} 被多个不同内容引用，无法按固定布局还原`, relative);
      }
    };
    const primaryPaths = new Set(personas.map((persona) => persona.primary));
    for (const persona of personas) {
      const primaryBytes = fs.readFileSync(resolveInside(root, persona.primary, 'personas[].primary'));
      const body = splitFrontmatter(primaryBytes.toString('utf8')).body;
      plan(
        `personas/${persona.id}.md`,
        Buffer.concat([Buffer.from(emitFrontmatter({ name: persona.name }), 'utf8'), Buffer.from(body, 'utf8')]),
      );
      if (persona.avatar !== undefined) {
        const extension = path.posix.extname(persona.avatar).slice(1).toLowerCase() || 'png';
        plan(`personas/${persona.id}.${extension}`, fs.readFileSync(resolveInside(root, persona.avatar, 'personas[].avatar')));
      }
      if (persona.levels !== undefined) {
        for (const files of Object.values(persona.levels)) {
          for (const levelFile of files) {
            if (primaryPaths.has(levelFile)) continue; // 已由对应人格的 primary 生成
            plan(restoredLevelPath(levelFile), fs.readFileSync(resolveInside(root, levelFile, 'personas[].levels')));
          }
        }
      }
    }
    for (const [relative, data] of planned) writeFileAt(target, relative, data);

    const description = resolveDescription(rules, pluginDoc, pluginName, skillName);
    const table = personas.map((persona) => `| ${escapeCell(persona.name)} | ${persona.id} |`).join('\n');
    const body = `\n## 人格\n\n| 名称 | 档案文件 |\n| --- | --- |\n${table}\n\n各人格的正文文件位于 \`personas/\`，作为系统提示词原文使用。\n`;
    writeFileAt(target, 'SKILL.md', `${emitFrontmatter({ name: skillName, description })}${body}`);
    return { out: target, skillName, generated: true, findings };
  } finally {
    materialized.cleanup();
  }
}

export function readSourceSkill(manifestDoc: unknown): string | undefined {
  if (!isPlainObject(manifestDoc)) return undefined;
  const source = manifestDoc['source'];
  if (!isPlainObject(source)) return undefined;
  const skill = source['skill'];
  return typeof skill === 'string' ? skill : undefined;
}

/** 纯人格包还原时 levels 引用文件的固定布局：personas/<basename>（协议 §7 档位文件随包保留）。 */
export function restoredLevelPath(levelFile: string): string {
  return `personas/${path.posix.basename(levelFile)}`;
}

/** 通用层兜底：agents/*.md，id 取文件名，显示名取 frontmatter name。 */
export function discoverGenericPersonas(root: string, findings: Finding[]): ToSkillPersona[] {
  const agentsDir = path.join(root, 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  if (fs.lstatSync(agentsDir).isSymbolicLink()) {
    throw new AipError('SYMLINK_UNSUPPORTED', '通用层目录不支持符号链接/重解析点：agents', 'agents');
  }
  if (!fs.statSync(agentsDir).isDirectory()) return [];
  const personas: ToSkillPersona[] = [];
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      findings.push(errorFinding('SYMLINK_UNSUPPORTED', `通用层不支持符号链接：agents/${entry.name}`, `agents/${entry.name}`));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const id = entry.name.slice(0, -3);
    if (!/^[a-z0-9-]+$/.test(id)) {
      findings.push(errorFinding('ID_INVALID', `通用层文件名不是合法 id（[a-z0-9-]+）：${entry.name}`, `agents/${entry.name}`));
      continue;
    }
    const parsed = parseFrontmatter(fs.readFileSync(path.join(agentsDir, entry.name), 'utf8'));
    const declared = parsed.data['name'];
    const persona: ToSkillPersona = {
      id,
      name: declared !== undefined && declared.trim() !== '' ? declared : id,
      primary: `agents/${entry.name}`,
      genericLayer: true,
    };
    const avatar = findGenericAvatar(agentsDir, id);
    if (avatar !== undefined) persona.avatar = avatar;
    personas.push(persona);
  }
  return personas;
}

const AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];

function findGenericAvatar(agentsDir: string, id: string): string | undefined {
  for (const extension of AVATAR_EXTENSIONS) {
    const relative = `agents/${id}.${extension}`;
    const absolute = path.join(agentsDir, `${id}.${extension}`);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute); // lstat：符号链接不视为头像文件
    } catch {
      continue;
    }
    if (stat.isFile()) return relative;
  }
  return undefined;
}

function resolveDescription(rules: Rules, pluginDoc: unknown, pluginName: string, skillName: string): string {
  if (rules.toSkill?.description !== undefined) {
    return expandTemplate(rules.toSkill.description, { pluginName, skill: skillName }, 'toSkill.description');
  }
  if (isPlainObject(pluginDoc) && typeof pluginDoc['description'] === 'string' && pluginDoc['description'].trim() !== '') {
    return pluginDoc['description'];
  }
  return `由 AIP 包生成的人格技能（${pluginName}）。`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
