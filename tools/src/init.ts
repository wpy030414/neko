/**
 * aip init：在源技能树生成扩展清单骨架（协议 §10）。
 * 骨架内容与 build 将写入包内的扩展清单一致，便于作者核对映射；已存在时拒绝覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AipError, type Finding } from './errors.js';
import { writeJson } from './fsutil.js';
import { projectExtensionManifest } from './manifest.js';
import { loadRules, type Rules } from './rules.js';
import { inspectSource } from './skill.js';

export interface InitOptions {
  dir?: string;
  rulesFile?: string;
  rulesOverride?: Rules;
}

export interface InitResult {
  file: string;
  manifest: Record<string, unknown>;
  findings: Finding[];
}

export function initSkeleton(options: InitOptions = {}): InitResult {
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
  const relative = path.posix.join(rules.namespace, 'plugin.json');
  const target = path.join(sourceRoot, rules.namespace, 'plugin.json');
  if (fs.existsSync(target)) {
    throw new AipError('INIT_EXISTS', `扩展清单已存在，拒绝覆盖（请先手工删除或改用其他目录）：${target}`, target);
  }

  const inspected = inspectSource(sourceRoot, rules);
  findings.push(...inspected.findings);
  const manifest = projectExtensionManifest(rules, inspected.skill.name, inspected.skill.personas);
  writeJson(sourceRoot, relative, manifest);
  return { file: target, manifest, findings };
}
