import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPackage, toSkill, validatePackage } from '../src/index.js';
import { makeSourceTree, tempDir, treeDigest, writeFileAt, writeRules } from './helpers.js';

describe('(e) 幂等：二次执行不产生冲突或重复', () => {
  it('二次 build 到同一输出目录成功且产物逐字节一致', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const out = path.join(root, 'pkg');

    const first = buildPackage({ dir: src, out, rulesFile, withAgents: true });
    const firstDigest = treeDigest(out);
    const second = buildPackage({ dir: src, out, rulesFile, withAgents: true });

    expect(second.skillName).toBe(first.skillName);
    expect(treeDigest(out)).toEqual(firstDigest);
    expect(validatePackage(out, { rulesFile }).ok).toBe(true);
  });

  it('二次 to-skill 到同一输出目录结果一致', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: src, out: pkg, rulesFile });

    const restored = path.join(root, 'restored');
    toSkill(pkg, restored, { rulesFile });
    const firstDigest = treeDigest(restored);
    toSkill(pkg, restored, { rulesFile });
    expect(treeDigest(restored)).toEqual(firstDigest);
  });

  it('输出目录存在但不是 AIP 包时拒绝覆盖', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const out = path.join(root, 'pkg');
    writeFileAt(out, 'important.txt', '用户数据，不得被删。\n');

    expect(() => buildPackage({ dir: src, out, rulesFile })).toThrow(/拒绝覆盖/);
    expect(fs.readFileSync(path.join(out, 'important.txt'), 'utf8')).toBe('用户数据，不得被删。\n');
  });

  it('源树中残留旧包产物（dist/）不影响二次构建', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const out = path.join(root, 'pkg');
    buildPackage({ dir: src, out, rulesFile });

    // 把上一次的产物目录塞回源树，模拟误操作
    writeFileAt(src, 'dist/neko/plugin.json', '{}\n');
    const again = buildPackage({ dir: src, out, rulesFile });
    expect(again.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(Object.keys(treeDigest(out)).some((relative) => relative.includes('dist/'))).toBe(false);
  });
});
