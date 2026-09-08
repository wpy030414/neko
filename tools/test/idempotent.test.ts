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

  it('--out 位于源树内且 include 为 "*"：二次 build 不把产物打包进包内（幂等）', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { clutter: false });
    const rulesFile = writeRules(path.join(root, 'rules.json'), { include: ['*'] });
    const out = path.join(src, 'pkg');

    const first = buildPackage({ dir: src, out, rulesFile });
    expect(first.findings.map((finding) => finding.code)).toContain('OUT_INSIDE_SOURCE');
    const firstDigest = treeDigest(out);

    const second = buildPackage({ dir: src, out, rulesFile });
    expect(second.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const secondDigest = treeDigest(out);
    expect(secondDigest).toEqual(firstDigest);
    expect(Object.keys(secondDigest).some((relative) => relative.startsWith('skills/demo/pkg/'))).toBe(false);

    // --out 指向源树内的 .zip 时同样排除，二次打包逐字节一致
    const zipOut = path.join(src, 'pkg.zip');
    buildPackage({ dir: src, out: zipOut, rulesFile });
    const firstZip = fs.readFileSync(zipOut);
    buildPackage({ dir: src, out: zipOut, rulesFile });
    expect(fs.readFileSync(zipOut)).toEqual(firstZip);
  });

  it('输出目录等于源树或包含源树时拒绝构建（防止删源树）', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { clutter: false });
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    expect(() => buildPackage({ dir: src, out: src, rulesFile })).toThrow(/输出目录不能是源技能树本身/);
    expect(() => buildPackage({ dir: src, out: root, rulesFile })).toThrow(/上级目录/);
    expect(fs.existsSync(path.join(src, 'SKILL.md'))).toBe(true);
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
