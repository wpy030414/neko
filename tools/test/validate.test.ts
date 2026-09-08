import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPackage, toSkill, validatePackage } from '../src/index.js';
import { REPO_ROOT, makeSourceTree, tempDir, writeFileAt, writeRules } from './helpers.js';

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

function pluginDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: SCHEMA, name: 'demo', ...overrides };
}

function writePackage(
  root: string,
  plugin: Record<string, unknown>,
  manifest: Record<string, unknown> | null,
  files: Record<string, string | Buffer> = {},
): string {
  const pkg = path.join(root, 'pkg');
  writeFileAt(pkg, 'plugin.json', `${JSON.stringify(plugin, null, 2)}\n`);
  if (manifest !== null) writeFileAt(pkg, 'xrl.momoi/plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relative, content] of Object.entries(files)) writeFileAt(pkg, relative, content);
  return pkg;
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    namespace: 'xrl.momoi',
    source: { skill: 'demo' },
    personas: [
      { id: 'alpha', name: '阿尔法', primary: 'skills/demo/personas/alpha.md', sourceFile: 'personas/alpha.md' },
    ],
    ...overrides,
  };
}

const BASE_FILES = {
  'skills/demo/SKILL.md': '---\nname: demo\n---\n\n正文。\n',
  'skills/demo/personas/alpha.md': '阿尔法正文。\n',
};

function check(pkg: string, skipRoundTrip = true): { codes: string[]; ok: boolean } {
  const result = validatePackage(pkg, { skipRoundTrip });
  return { codes: result.findings.map((finding) => finding.code), ok: result.ok };
}

describe('validate：协议 §10.1 验证门', () => {
  it('合法包全部通过', () => {
    const root = tempDir();
    const pkg = writePackage(root, pluginDoc(), baseManifest(), BASE_FILES);
    const result = validatePackage(pkg, { skipRoundTrip: true });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['未知顶层字段', pluginDoc({ extra: true }), 'SCHEMA_PLUGIN'],
    ['name 缺失', pluginDoc({ name: undefined }), 'SCHEMA_PLUGIN'],
    ['name 含大写', pluginDoc({ name: 'Demo' }), 'SCHEMA_PLUGIN'],
    ['$schema 不匹配', pluginDoc({ $schema: 'https://example.com/other.json' }), 'SCHEMA_PLUGIN'],
  ])('closed-schema 拒绝：%s', (_label, plugin, code) => {
    const root = tempDir();
    const pkg = writePackage(root, plugin, baseManifest(), BASE_FILES);
    expect(check(pkg).codes).toContain(code);
  });

  it('formatVersion 非 1 时拒绝整包', () => {
    const root = tempDir();
    const pkg = writePackage(root, pluginDoc(), baseManifest({ formatVersion: 2 }), BASE_FILES);
    expect(check(pkg).codes).toContain('FORMAT_VERSION_UNSUPPORTED');
  });

  it('namespace 不符时拒绝', () => {
    const root = tempDir();
    const pkg = writePackage(root, pluginDoc(), baseManifest({ namespace: 'other.ns' }), BASE_FILES);
    expect(check(pkg).codes).toContain('NAMESPACE_INVALID');
  });

  it('primary 文件缺失时报错', () => {
    const root = tempDir();
    const pkg = writePackage(root, pluginDoc(), baseManifest(), {
      'skills/demo/SKILL.md': '---\nname: demo\n---\n\n正文。\n',
    });
    expect(check(pkg).codes).toContain('FILE_MISSING');
  });

  it('source.skill 目录缺失时报错', () => {
    const root = tempDir();
    const pkg = writePackage(root, pluginDoc(), baseManifest(), BASE_FILES);
    fs.rmSync(path.join(pkg, 'skills'), { recursive: true, force: true });
    expect(check(pkg).codes).toContain('SKILL_DIR_MISSING');
  });

  it('技能目录名不合法时报错', () => {
    const root = tempDir();
    const pkg = writePackage(root, pluginDoc(), null, {
      'skills/Bad_Name/SKILL.md': '---\nname: bad\n---\n\n正文。\n',
    });
    expect(check(pkg).codes).toContain('ID_INVALID');
  });

  it('id 重复时报错', () => {
    const root = tempDir();
    const manifest = baseManifest({
      personas: [
        { id: 'alpha', name: '阿尔法', primary: 'skills/demo/personas/alpha.md' },
        { id: 'alpha', name: '阿尔法副本', primary: 'skills/demo/personas/alpha.md' },
      ],
    });
    const pkg = writePackage(root, pluginDoc(), manifest, BASE_FILES);
    expect(check(pkg).codes).toContain('ID_DUPLICATE');
  });

  it('primary 不是任何档位的首个文件时报错（协议 §7）', () => {
    const root = tempDir();
    const manifest = baseManifest({
      personas: [
        {
          id: 'alpha',
          name: '阿尔法',
          primary: 'skills/demo/personas/alpha.md',
          levels: { extended: ['skills/demo/personas/other.md', 'skills/demo/personas/alpha.md'] },
        },
      ],
    });
    const pkg = writePackage(root, pluginDoc(), manifest, {
      ...BASE_FILES,
      'skills/demo/personas/other.md': '其他正文。\n',
    });
    expect(check(pkg).codes).toContain('LEVELS_PRIMARY_MISMATCH');
  });

  it('往返门不把源树黑名单施加到还原树：载荷内含 docs/、dist/ 等条目仍判为无损', () => {
    const root = tempDir();
    const pkg = writePackage(root, pluginDoc(), baseManifest(), {
      ...BASE_FILES,
      'skills/demo/docs/guide.md': '技能自带文档。\n',
      'skills/demo/tools/helper.js': '技能自带工具。\n',
      'skills/demo/dist/artifact.js': '构建产物混入载荷。\n',
      'skills/demo/cache.tsbuildinfo': '{}\n',
    });
    const result = validatePackage(pkg);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('纯人格包：插件名含点号时往返门不再误判，技能名确定性净化', () => {
    const root = tempDir();
    const pkg = writePackage(
      root,
      pluginDoc({ name: 'demo.personas' }),
      {
        formatVersion: 1,
        namespace: 'xrl.momoi',
        personas: [{ id: 'alpha', name: '阿尔法', primary: 'personas/alpha.md' }],
      },
      { 'personas/alpha.md': '正文\n' },
    );
    const result = validatePackage(pkg);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);

    const restored = path.join(root, 'restored');
    const restoredResult = toSkill(pkg, restored, {});
    expect(restoredResult.skillName).toBe('demo-personas');
    expect(fs.readFileSync(path.join(restored, 'personas', 'alpha.md'), 'utf8')).toBe('---\nname: 阿尔法\n---\n正文\n');
  });

  it('扩展清单两种形式不一致时报 EXTENSION_AMBIGUOUS', () => {
    const root = tempDir();
    const pkg = writePackage(
      root,
      pluginDoc({ extensions: { 'xrl.momoi': { formatVersion: 1, manifest: './xrl.momoi/other.json' } } }),
      baseManifest(),
      BASE_FILES,
    );
    writeFileAt(pkg, 'xrl.momoi/other.json', `${JSON.stringify(baseManifest({ host: 'x' }), null, 2)}\n`);
    expect(check(pkg).codes).toContain('EXTENSION_AMBIGUOUS');
  });

  it('声明的扩展清单不存在时报 MANIFEST_MISSING', () => {
    const root = tempDir();
    const pkg = writePackage(
      root,
      pluginDoc({ extensions: { 'xrl.momoi': { formatVersion: 1, manifest: './xrl.momoi/missing.json' } } }),
      null,
      BASE_FILES,
    );
    expect(check(pkg).codes).toContain('MANIFEST_MISSING');
  });

  it('真实 neko 源树构建出的包通过完整验证（含往返门）', () => {
    const root = tempDir();
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: REPO_ROOT, out: pkg, withAgents: true });
    const result = validatePackage(pkg);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('合成源树构建的包通过完整验证（含往返门）', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: src, out: pkg, rulesFile, withAgents: true });
    const result = validatePackage(pkg, { rulesFile });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
