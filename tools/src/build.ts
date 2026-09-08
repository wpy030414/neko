/**
 * aip build：源技能树 → AIP 包（协议 §8.1）。
 * 载荷逐字节拷贝；清单由规则投影；--with-agents 额外生成通用层。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AipError, warningFinding, type Finding } from './errors.js';
import { copyTreeFiles, createStagingSibling, ensureDirs, removeDir, replaceDir, writeFileAt, writeJson } from './fsutil.js';
import { emitFrontmatter } from './frontmatter.js';
import { projectExtensionManifest, projectPluginJson, validatePluginJson } from './manifest.js';
import { toPosix } from './paths.js';
import { expandTemplate, loadRules, type Rules } from './rules.js';
import { inspectSource, type SourceSkill } from './skill.js';
import { writeZip } from './zip.js';

export interface BuildOptions {
  dir?: string;
  out?: string;
  rulesFile?: string;
  withAgents?: boolean;
  /** 直接注入规则（供内部往返校验使用，优先于 rulesFile）。 */
  rulesOverride?: Rules;
}

export interface BuildResult {
  out: string;
  skillName: string;
  findings: Finding[];
  plugin: Record<string, unknown>;
  manifest: Record<string, unknown>;
  fileCount: number;
}

export function buildPackage(options: BuildOptions = {}): BuildResult {
  const findings: Finding[] = [];
  let rules: Rules;
  if (options.rulesOverride !== undefined) {
    rules = options.rulesOverride;
  } else {
    const loaded = loadRules(options.rulesFile);
    rules = loaded.rules;
    findings.push(...loaded.findings);
  }

  const sourceRoot = path.resolve(options.dir ?? process.cwd());
  const inspected = inspectSource(sourceRoot, rules);
  findings.push(...inspected.findings);
  const skill = inspected.skill;
  const skillName = skill.name;
  const plugin = projectPluginJson(rules, { skill: skillName });
  const manifest = projectExtensionManifest(rules, skillName, skill.personas);

  const schemaFindings = validatePluginJson(plugin, 'plugin.json');
  if (schemaFindings.length > 0) {
    throw new AipError(
      'PLUGIN_PROJECTION_INVALID',
      `生成的 plugin.json 未通过 Agent Plugins closed-schema：${schemaFindings.map((finding) => finding.message).join('；')}（检查 rules.plugin 字段）`,
    );
  }

  const out = path.resolve(options.out ?? path.join(process.cwd(), 'dist', String(plugin['name'])));
  const payload = excludeOutputFromPayload(sourceRoot, out, skill.payloadFiles, skill.emptyDirs, findings);
  const staging = createStagingSibling(out);
  try {
    const skillStaging = path.join(staging, 'skills', skillName);
    copyTreeFiles(sourceRoot, payload.files, skillStaging);
    ensureDirs(skillStaging, payload.dirs);
    writeJson(staging, 'plugin.json', plugin);
    writeJson(staging, path.posix.join(rules.namespace, 'plugin.json'), manifest);
    let fileCount = payload.files.length + 2;
    if (options.withAgents === true) fileCount += writeAgentsLayer(staging, rules, skill);

    if (out.toLowerCase().endsWith('.zip')) {
      writeZip(staging, out);
      removeDir(staging);
    } else {
      replaceDir(out, staging);
    }
    return { out, skillName, findings, plugin, manifest, fileCount };
  } catch (err) {
    removeDir(staging);
    throw err;
  }
}

/**
 * 输出目录落在源树内时，把该目录从载荷中剔除：否则第二次 build 会把上一次产物打包进包内（幂等性破坏）。
 * 输出目录等于源树本身或源树被输出目录包含时，构建会删除源树，直接拒绝。
 */
function excludeOutputFromPayload(
  sourceRoot: string,
  out: string,
  payloadFiles: readonly string[],
  emptyDirs: readonly string[],
  findings: Finding[],
): { files: string[]; dirs: string[] } {
  const relative = path.relative(sourceRoot, out);
  if (relative === '') {
    throw new AipError('OUT_IS_SOURCE', `输出目录不能是源技能树本身：${out}`);
  }
  if (!isInside(sourceRoot, out)) {
    if (isInside(out, sourceRoot)) {
      throw new AipError('OUT_CONTAINS_SOURCE', `输出目录不能是源技能树的上级目录（构建会删除源树）：${out}`);
    }
    return { files: [...payloadFiles], dirs: [...emptyDirs] };
  }
  const relativePosix = toPosix(relative);
  const prefix = `${relativePosix}/`;
  findings.push(warningFinding('OUT_INSIDE_SOURCE', `输出目录位于源树内（${relativePosix}），已从载荷（含空目录）中排除以保证二次构建幂等`, out));
  // 同时排除输出目录自身与 zip 输出文件（--out 指向源树内的 .zip）。
  const keep = (entry: string): boolean => entry !== relativePosix && !entry.startsWith(prefix);
  return { files: payloadFiles.filter(keep), dirs: emptyDirs.filter(keep) };
}

/** child 是否严格位于 parent 之内（不含相等；`..foo` 这类名字不被误判为上级）。 */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 通用层 agents/<id>.md：frontmatter 提供显示名，正文 = primary 文件字节。 */
function writeAgentsLayer(staging: string, rules: Rules, skill: SourceSkill): number {
  let written = 0;
  for (const persona of skill.personas) {
    const primaryBytes = fs.readFileSync(path.join(skill.root, persona.sourceFile));
    const frontmatter: Record<string, string> = { name: persona.name };
    if (rules.genericLayer?.description !== undefined) {
      frontmatter['description'] = expandTemplate(
        rules.genericLayer.description,
        { id: persona.id, name: persona.name, skill: skill.name },
        'genericLayer.description',
      );
    }
    writeFileAt(
      staging,
      `agents/${persona.id}.md`,
      Buffer.concat([Buffer.from(emitFrontmatter(frontmatter), 'utf8'), primaryBytes]),
    );
    written += 1;
    if (persona.avatarSource !== undefined) {
      const extension = path.posix.extname(persona.avatarSource).slice(1).toLowerCase() || 'png';
      writeFileAt(staging, `agents/${persona.id}.${extension}`, fs.readFileSync(path.join(skill.root, persona.avatarSource)));
      written += 1;
    }
  }
  return written;
}
