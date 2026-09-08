/**
 * aip validate：协议 §10.1 验证门。
 * 覆盖：closed-schema、路径包含、id 命名、primary 存在、双形态一致性、往返字节一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AipError, errorFinding, hasErrors, type Finding } from './errors.js';
import { readTree, walkEmptyDirs } from './fsutil.js';
import { frontmatterBodyBytes, parseFrontmatter } from './frontmatter.js';
import {
  asFinding,
  isPlainObject,
  locateExtensionManifest,
  readJsonFile,
  validateExtensionManifestDoc,
  validatePluginJson,
  type ManifestPersona,
} from './manifest.js';
import { materializePackage, type Materialized } from './package.js';
import { ID_PATTERN, resolveInside } from './paths.js';
import { loadRules, type Rules } from './rules.js';
import { buildPackage } from './build.js';
import { readSourceSkill, restoredLevelPath, toSkill } from './toSkill.js';

export interface ValidateOptions {
  rulesFile?: string;
  rulesOverride?: Rules;
  /** 跳过往返门（仅供内部调用，避免递归）。 */
  skipRoundTrip?: boolean;
}

export interface ValidateResult {
  findings: Finding[];
  ok: boolean;
}

type CheckedPersona = ManifestPersona & { genericLayer?: boolean };

export function validatePackage(input: string, options: ValidateOptions = {}): ValidateResult {
  const findings: Finding[] = [];
  let materialized: Materialized | null = null;
  try {
    materialized = materializePackage(input, { strict: false });
    findings.push(...materialized.findings);
    validateRoot(materialized.root, findings, options);
  } catch (err) {
    findings.push(asFinding(err));
  } finally {
    materialized?.cleanup();
  }
  return { findings, ok: !hasErrors(findings) };
}

function validateRoot(root: string, findings: Finding[], options: ValidateOptions): void {
  // 门 1：plugin.json 存在且满足 Agent Plugins 1.0 closed-schema
  const pluginPath = path.join(root, 'plugin.json');
  let pluginDoc: unknown = null;
  if (!fs.existsSync(pluginPath)) {
    findings.push(errorFinding('PLUGIN_MISSING', '缺少 plugin.json（Agent Plugins 1.0 必选清单）', 'plugin.json'));
  } else {
    pluginDoc = readJsonFile(pluginPath, findings);
    if (pluginDoc !== null) findings.push(...validatePluginJson(pluginDoc, 'plugin.json'));
  }

  // 门 2：扩展清单结构与字段
  const location = locateExtensionManifest(root, pluginDoc);
  findings.push(...location.findings);
  let manifestDoc: unknown = null;
  let manifestPersonas: ManifestPersona[] = [];
  if (location.file !== null) {
    manifestDoc = readJsonFile(location.file, findings);
    if (manifestDoc !== null) {
      const result = validateExtensionManifestDoc(manifestDoc, root, location.file);
      findings.push(...result.findings);
      manifestPersonas = result.personas;
    }
  }

  // 门 3：source.skill 指向的技能目录存在
  const sourceSkill = readSourceSkill(manifestDoc);
  if (sourceSkill !== undefined) {
    try {
      const directory = resolveInside(root, `skills/${sourceSkill}`, 'source.skill');
      if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        findings.push(errorFinding('SKILL_DIR_MISSING', `source.skill 指向的技能目录不存在：skills/${sourceSkill}`, 'xrl.momoi/plugin.json'));
      }
    } catch (err) {
      findings.push(asFinding(err));
    }
  }

  // 门 3b：技能目录命名（Agent Skills 约定：[a-z0-9-]+）；skills/ 本身不得是符号链接
  let skillsDir: string | null = null;
  try {
    skillsDir = resolveInside(root, 'skills', 'skills');
  } catch (err) {
    findings.push(asFinding(err));
  }
  if (skillsDir !== null && fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!ID_PATTERN.test(entry.name)) {
        findings.push(errorFinding('ID_INVALID', `技能目录名必须匹配 [a-z0-9-]+：skills/${entry.name}`, `skills/${entry.name}`));
      }
    }
  }

  // 门 4：通用层发现与双形态一致性
  const generic = collectGenericLayer(root, findings);
  for (const persona of manifestPersonas) {
    const entry = generic.get(persona.id);
    if (entry === undefined) continue;
    let primaryBytes: Buffer;
    try {
      primaryBytes = fs.readFileSync(resolveInside(root, persona.primary, 'personas[].primary'));
    } catch {
      continue; // primary 缺失已由清单校验报告
    }
    if (!entry.bodyBytes.equals(primaryBytes)) {
      findings.push(errorFinding('DUAL_FORM_MISMATCH', `通用层 agents/${persona.id}.md 的正文与扩展清单 primary 不一致（协议 §6.3）`, `agents/${persona.id}.md`));
    }
  }

  const personas: CheckedPersona[] = [...manifestPersonas];
  if (personas.length === 0) {
    for (const entry of generic.values()) {
      personas.push({ id: entry.id, name: entry.name, primary: entry.file, genericLayer: true });
    }
  }

  if (location.file === null && generic.size === 0) {
    findings.push(errorFinding('NOT_AIP_PACKAGE', '既无扩展清单（xrl.momoi/plugin.json）也无通用层（agents/*.md），不是 AIP 包', root));
  }

  // 门 5：往返字节一致
  if (options.skipRoundTrip !== true) {
    findings.push(...roundTripFindings(root, personas, sourceSkill, options));
  }
}

interface GenericEntry {
  id: string;
  name: string;
  file: string;
  /** frontmatter 之后的正文原始字节（非 UTF-8 内容按字节比较，避免 U+FFFD 误判）。 */
  bodyBytes: Buffer;
}

function collectGenericLayer(root: string, findings: Finding[]): Map<string, GenericEntry> {
  const result = new Map<string, GenericEntry>();
  const agentsDir = path.join(root, 'agents');
  if (!fs.existsSync(agentsDir)) return result;
  if (fs.lstatSync(agentsDir).isSymbolicLink()) {
    findings.push(errorFinding('SYMLINK_UNSUPPORTED', '通用层目录不支持符号链接/重解析点：agents', 'agents'));
    return result;
  }
  if (!fs.statSync(agentsDir).isDirectory()) return result;
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      findings.push(errorFinding('SYMLINK_UNSUPPORTED', `通用层不支持符号链接：agents/${entry.name}`, `agents/${entry.name}`));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const id = entry.name.slice(0, -3);
    if (!ID_PATTERN.test(id)) {
      findings.push(errorFinding('ID_INVALID', `通用层文件名必须匹配 [a-z0-9-]+：${entry.name}`, `agents/${entry.name}`));
      continue;
    }
    const raw = fs.readFileSync(path.join(agentsDir, entry.name));
    const declared = parseFrontmatter(raw.toString('utf8')).data['name'];
    if (declared === undefined || declared.trim() === '') {
      findings.push(errorFinding('GENERIC_NAME_MISSING', '通用层文件缺少 frontmatter name（协议 §5）', `agents/${entry.name}`));
    }
    if (result.has(id)) {
      findings.push(errorFinding('ID_DUPLICATE', `通用层 id 重复：${id}`, `agents/${entry.name}`));
      continue;
    }
    result.set(id, { id, name: declared ?? '', file: `agents/${entry.name}`, bodyBytes: frontmatterBodyBytes(raw) });
  }
  return result;
}

/**
 * 往返门：包 → to-skill 还原 → build 重建 → 载荷/人格正文字节比对。
 * 重建使用「全收」载荷规则：源树黑名单只作用于 build 的源树→包方向，
 * 施加到还原树会把包内 docs/、tools/ 等合法条目误判为往返缺失。
 */
function roundTripFindings(
  root: string,
  personas: readonly CheckedPersona[],
  sourceSkill: string | undefined,
  options: ValidateOptions,
): Finding[] {
  const findings: Finding[] = [];
  let rules: Rules;
  try {
    rules = options.rulesOverride ?? loadRules(options.rulesFile).rules;
  } catch (err) {
    return [asFinding(err)];
  }
  const rebuildRules: Rules = {
    ...rules,
    skill: { ...rules.skill, payload: { include: ['*'], exclude: [] } },
    personas: { primary: rules.personas.primary, avatar: rules.personas.avatar },
  };

  // 纯扩展包可以声明空的 personas[]（协议 §6.1）：无可还原内容，往返门无判定对象，直接跳过。
  if (sourceSkill === undefined && personas.length === 0) return findings;

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-roundtrip-'));
  try {
    const restored = path.join(temp, 'src');
    const first = toSkill(root, restored, { rulesOverride: rules });
    findings.push(...first.findings.filter((finding) => finding.severity === 'error'));

    const rebuilt = path.join(temp, 'pkg');
    buildPackage({ dir: restored, out: rebuilt, rulesOverride: rebuildRules });

    if (sourceSkill !== undefined) {
      if (first.skillName !== sourceSkill) {
        findings.push(errorFinding('ROUNDTRIP_SKILL_NAME', `还原树的技能名 ${JSON.stringify(first.skillName)} 与 source.skill ${JSON.stringify(sourceSkill)} 不一致`, 'xrl.momoi/plugin.json'));
      }
      const originalDir = path.join(root, 'skills', sourceSkill);
      const producedDir = path.join(rebuilt, 'skills', first.skillName);
      if (!fs.existsSync(producedDir)) {
        findings.push(errorFinding('ROUNDTRIP_MISSING', `往返重建后缺少技能目录：skills/${first.skillName}`, `skills/${first.skillName}`));
        return findings;
      }
      const original = readTree(originalDir, originalDir);
      const produced = readTree(producedDir, producedDir);
      for (const [relative, bytes] of original) {
        const other = produced.get(relative);
        if (other === undefined) {
          findings.push(errorFinding('ROUNDTRIP_MISSING', `往返重建后缺少文件：${relative}`, `skills/${sourceSkill}/${relative}`));
        } else if (!other.equals(bytes)) {
          findings.push(errorFinding('ROUNDTRIP_MISMATCH', `往返重建后字节不一致：${relative}`, `skills/${sourceSkill}/${relative}`));
        }
      }
      for (const relative of produced.keys()) {
        if (!original.has(relative)) {
          findings.push(errorFinding('ROUNDTRIP_EXTRA', `往返重建后多出文件：${relative}`, `skills/${first.skillName}/${relative}`));
        }
      }
      // 空目录没有文件承载，必须单独比较，否则往返丢空目录不会被发现（协议 §8.3）。
      const originalDirs = new Set(walkEmptyDirs(originalDir, originalDir));
      const producedDirs = new Set(walkEmptyDirs(producedDir, producedDir));
      for (const relative of originalDirs) {
        if (!producedDirs.has(relative)) {
          findings.push(errorFinding('ROUNDTRIP_MISSING', `往返重建后缺少空目录：${relative}`, `skills/${sourceSkill}/${relative}`));
        }
      }
      for (const relative of producedDirs) {
        if (!originalDirs.has(relative)) {
          findings.push(errorFinding('ROUNDTRIP_EXTRA', `往返重建后多出空目录：${relative}`, `skills/${first.skillName}/${relative}`));
        }
      }
      return findings;
    }

    const rebuiltManifest = readJsonFile(path.join(rebuilt, rules.namespace, 'plugin.json'), []);
    const rebuiltPersonas =
      isPlainObject(rebuiltManifest) && Array.isArray(rebuiltManifest['personas']) ? rebuiltManifest['personas'] : [];
    const primaryPaths = new Set(personas.map((persona) => persona.primary));
    for (const persona of personas) {
      let originalBytes: Buffer;
      try {
        originalBytes = fs.readFileSync(resolveInside(root, persona.primary, 'personas[].primary'));
      } catch {
        continue; // primary 缺失已由清单校验报告
      }
      const match = rebuiltPersonas.find((item) => isPlainObject(item) && item['id'] === persona.id);
      if (!isPlainObject(match) || typeof match['primary'] !== 'string') {
        findings.push(errorFinding('ROUNDTRIP_MISSING', `往返重建后缺少人格：${persona.id}`, persona.primary));
        continue;
      }
      // to-skill 生成 personas/<id>.md 时补写显示名 frontmatter，正文按 frontmatter 之后的原始字节比对。
      const expectedBody = frontmatterBodyBytes(originalBytes);
      const rebuiltBytes = fs.readFileSync(resolveInside(rebuilt, match['primary'], 'personas[].primary'));
      const rebuiltBody = frontmatterBodyBytes(rebuiltBytes);
      if (!rebuiltBody.equals(expectedBody)) {
        findings.push(errorFinding('ROUNDTRIP_MISMATCH', `人格 ${persona.id} 往返后正文字节不一致`, persona.primary));
      }
      const expectedName = persona.name.replace(/\r?\n/g, ' ');
      if (expectedName !== '' && match['name'] !== expectedName) {
        findings.push(
          errorFinding(
            'ROUNDTRIP_MISMATCH',
            `人格 ${persona.id} 往返后显示名不一致：${JSON.stringify(expectedName)} → ${JSON.stringify(match['name'])}`,
            persona.primary,
          ),
        );
      }
      if (persona.levels === undefined) continue;
      for (const files of Object.values(persona.levels)) {
        for (const levelFile of files) {
          if (primaryPaths.has(levelFile)) continue; // 已由对应人格的 primary 覆盖
          let levelBytes: Buffer;
          try {
            levelBytes = fs.readFileSync(resolveInside(root, levelFile, 'personas[].levels'));
          } catch {
            continue; // 档位文件缺失已由清单校验报告
          }
          const rebuiltLevel = resolveInside(
            rebuilt,
            path.posix.join('skills', first.skillName, restoredLevelPath(levelFile)),
            'personas[].levels',
          );
          if (!fs.existsSync(rebuiltLevel) || !fs.statSync(rebuiltLevel).isFile()) {
            findings.push(errorFinding('ROUNDTRIP_MISSING', `往返重建后缺少档位文件：${levelFile}`, levelFile));
          } else if (!fs.readFileSync(rebuiltLevel).equals(levelBytes)) {
            findings.push(errorFinding('ROUNDTRIP_MISMATCH', `档位文件往返后字节不一致：${levelFile}`, levelFile));
          }
        }
      }
    }
    return findings;
  } catch (err) {
    findings.push(err instanceof AipError ? asFinding(err) : errorFinding('ROUNDTRIP_ERROR', err instanceof Error ? err.message : String(err)));
    return findings;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
