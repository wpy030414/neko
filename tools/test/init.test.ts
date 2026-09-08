import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPackage, initSkeleton } from '../src/index.js';
import { makeSourceTree, readJson, tempDir, writeRules } from './helpers.js';

describe('init：在源技能树生成扩展清单骨架', () => {
  it('骨架与 build 写入包内的扩展清单一致', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { clutter: false });
    const rulesFile = writeRules(path.join(root, 'rules.json'));

    const result = initSkeleton({ dir: src, rulesFile });
    expect(result.file).toBe(path.join(src, 'xrl.momoi', 'plugin.json'));
    const skeleton = readJson(result.file);

    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: src, out: pkg, rulesFile });
    expect(skeleton).toEqual(readJson(path.join(pkg, 'xrl.momoi', 'plugin.json')));
  });

  it('已存在时拒绝覆盖', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { clutter: false });
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    initSkeleton({ dir: src, rulesFile });
    const before = fs.readFileSync(path.join(src, 'xrl.momoi', 'plugin.json'), 'utf8');
    expect(() => initSkeleton({ dir: src, rulesFile })).toThrow(/拒绝覆盖/);
    expect(fs.readFileSync(path.join(src, 'xrl.momoi', 'plugin.json'), 'utf8')).toBe(before);
  });

  it('源树中已存在扩展清单目录时同样拒绝', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    expect(() => initSkeleton({ dir: src, rulesFile })).toThrow(/拒绝覆盖/);
  });

  it('源树缺少 SKILL.md 时报错', () => {
    const root = tempDir();
    expect(() => initSkeleton({ dir: root })).toThrow(/SKILL.md/);
  });
});
