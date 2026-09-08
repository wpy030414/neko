import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPackage, toSkill, validatePackage } from '../src/index.js';
import { collectStrings, makeSourceTree, readJson, tempDir, writeRules } from './helpers.js';

describe('(c) 模型字段：不生成、出现即忽略（协议 §2.4）', () => {
  it('build 生成的清单不含 model', () => {
    const root = tempDir();
    makeSourceTree(path.join(root, 'src'));
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const result = buildPackage({ dir: path.join(root, 'src'), out: path.join(root, 'pkg'), rulesFile });
    expect(collectStrings(result.plugin).join('|')).not.toContain('model');
    expect(collectStrings(result.manifest).join('|')).not.toContain('model');
  });

  it('包内 persona 出现 model 字段时：validate 通过并给出忽略警告', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { personas: [{ id: 'alpha', name: '阿尔法' }] });
    const rulesFile = writeRules(path.join(root, 'rules.json'), { entries: [{ id: 'alpha', name: '阿尔法' }] });
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: src, out: pkg, rulesFile });

    const manifestPath = path.join(pkg, 'xrl.momoi', 'plugin.json');
    const manifest = readJson(manifestPath);
    const personas = manifest['personas'] as Record<string, unknown>[];
    personas[0]!['model'] = 'gpt-x';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = validatePackage(pkg, { rulesFile });
    expect(result.ok).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain('MODEL_IGNORED');
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('含 model 的包还原后不把 model 带到输出', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { personas: [{ id: 'alpha', name: '阿尔法' }] });
    const rulesFile = writeRules(path.join(root, 'rules.json'), { entries: [{ id: 'alpha', name: '阿尔法' }] });
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: src, out: pkg, rulesFile });
    const manifestPath = path.join(pkg, 'xrl.momoi', 'plugin.json');
    const manifest = readJson(manifestPath);
    (manifest['personas'] as Record<string, unknown>[])[0]!['model'] = 'gpt-x';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const restored = path.join(root, 'restored');
    toSkill(pkg, restored, { rulesFile });
    expect(fs.readFileSync(path.join(restored, 'SKILL.md'), 'utf8')).not.toContain('model');
    expect(fs.readFileSync(path.join(restored, 'personas', 'alpha.md'), 'utf8')).not.toContain('model');
  });

  it('规则条目里的 model 只产生警告，不进入清单', () => {
    const root = tempDir();
    makeSourceTree(path.join(root, 'src'), { personas: [{ id: 'alpha', name: '阿尔法' }] });
    const rulesFile = writeRules(path.join(root, 'rules.json'), {
      entries: [{ id: 'alpha', name: '阿尔法', model: 'gpt-x' }],
    });
    const result = buildPackage({ dir: path.join(root, 'src'), out: path.join(root, 'pkg'), rulesFile });
    expect(result.findings.map((finding) => finding.code)).toContain('RULES_MODEL_IGNORED');
    expect(JSON.stringify(result.manifest)).not.toContain('gpt-x');
  });
});
