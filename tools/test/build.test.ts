import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPackage, projectExtensionManifest, toSkill, validatePluginJson } from '../src/index.js';
import {
  PACKAGE_ROOT,
  collectStrings,
  existsAt,
  makeSourceTree,
  readFileAt,
  readJson,
  tempDir,
  treeDigest,
  writeFileAt,
  writeRules,
} from './helpers.js';

const EXPECTED_PAYLOAD = [
  'SKILL.md',
  'personas/alpha.md',
  'personas/alpha.png',
  'personas/beta.md',
  'personas/beta.png',
  'personas/special.md',
  'scripts/tool.js',
].sort();

describe('build：源技能树 → AIP 包', () => {
  it('载荷只含 SKILL.md + personas/ + scripts/，排除干扰项', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    const out = path.join(root, 'pkg');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));

    const result = buildPackage({ dir: src, out, rulesFile });
    expect(result.skillName).toBe('demo');

    const files = treeDigest(out);
    const payload = Object.keys(files)
      .filter((relative) => relative.startsWith('skills/demo/'))
      .map((relative) => relative.slice('skills/demo/'.length))
      .sort();
    expect(payload).toEqual(EXPECTED_PAYLOAD);
    for (const excluded of ['docs/', 'tools/', '.git/', 'node_modules/', 'dist/', 'coverage/', 'xrl.momoi/plugin.json', 'agents/']) {
      expect(Object.keys(files).some((relative) => relative.startsWith(excluded) && relative !== 'xrl.momoi/plugin.json')).toBe(false);
    }
    expect(Object.keys(files)).toContain('plugin.json');
    expect(Object.keys(files)).toContain('xrl.momoi/plugin.json');
  });

  it('plugin.json 满足 Agent Plugins 1.0 closed-schema 且声明扩展', () => {
    const root = tempDir();
    makeSourceTree(path.join(root, 'src'));
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const result = buildPackage({ dir: path.join(root, 'src'), out: path.join(root, 'pkg'), rulesFile });

    expect(validatePluginJson(result.plugin, 'plugin.json')).toEqual([]);
    expect(result.plugin['$schema']).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(result.plugin['name']).toBe('demo');
    expect(result.plugin['extensions']).toEqual({
      'xrl.momoi': { formatVersion: 1, manifest: './xrl.momoi/plugin.json' },
    });
    const onDisk = readJson(path.join(root, 'pkg', 'plugin.json'));
    expect(onDisk).toEqual(result.plugin);
  });

  it('扩展清单按 §6 投影：primary/avatar/levels/source.skill，且不含 model', () => {
    const root = tempDir();
    makeSourceTree(path.join(root, 'src'));
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    buildPackage({ dir: path.join(root, 'src'), out: path.join(root, 'pkg'), rulesFile });
    const manifest = readJson(path.join(root, 'pkg', 'xrl.momoi', 'plugin.json'));

    expect(manifest['formatVersion']).toBe(1);
    expect(manifest['namespace']).toBe('xrl.momoi');
    expect(manifest['source']).toEqual({ skill: 'demo' });
    const personas = manifest['personas'] as Record<string, unknown>[];
    expect(personas.map((persona) => persona['id'])).toEqual(['alpha', 'beta']);
    expect(personas[0]).toEqual({
      id: 'alpha',
      name: '阿尔法',
      primary: 'skills/demo/personas/alpha.md',
      sourceFile: 'personas/alpha.md',
      avatar: 'skills/demo/personas/alpha.png',
      levels: {
        default: ['skills/demo/personas/alpha.md'],
        r18: ['skills/demo/personas/alpha.md', 'skills/demo/personas/special.md'],
      },
    });
    expect(personas[1]?.['avatar']).toBe('skills/demo/personas/beta.png');
    expect(JSON.stringify(manifest)).not.toContain('"model"');
  });

  it('缺失的头像不写 avatar 字段，缺失的档位文件只跳过该档', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { personas: [{ id: 'alpha', name: '阿尔法', avatar: false }] });
    const rulesFile = writeRules(path.join(root, 'rules.json'), {
      entries: [{ id: 'alpha', name: '阿尔法' }],
      levels: { default: ['personas/{id}.md'], r18: ['personas/{id}.md', 'personas/missing.md'] },
    });
    const result = buildPackage({ dir: src, out: path.join(root, 'pkg'), rulesFile });
    const personas = result.manifest['personas'] as Record<string, unknown>[];
    expect(personas[0]?.['avatar']).toBeUndefined();
    expect(personas[0]?.['levels']).toEqual({ default: ['skills/demo/personas/alpha.md'] });
    expect(result.findings.map((finding) => finding.code)).toContain('LEVEL_FILE_MISSING');
  });

  it('--with-agents 生成通用层：frontmatter 提供显示名，正文与 primary 逐字节一致', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const out = path.join(root, 'pkg');
    buildPackage({ dir: src, out, rulesFile, withAgents: true });

    const agentFile = readFileAt(out, 'agents/alpha.md');
    const primary = fs.readFileSync(path.join(out, 'skills', 'demo', 'personas', 'alpha.md'), 'utf8');
    expect(agentFile).toContain('name: 阿尔法');
    expect(agentFile.endsWith(primary)).toBe(true);
    expect(existsAt(out, 'agents/alpha.png')).toBe(true);
    expect(existsAt(out, 'agents/special.md')).toBe(false);
  });

  it('--out 指向 .zip 时打包为 zip，且可被 validate 读取', async () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const out = path.join(root, 'pkg.zip');
    const result = buildPackage({ dir: src, out, rulesFile });
    expect(fs.existsSync(out)).toBe(true);
    expect(result.out.endsWith('.zip')).toBe(true);

    const { validatePackage } = await import('../src/index.js');
    const validated = validatePackage(out, { rulesFile });
    expect(validated.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('投影函数不产生 model 字段（规则里出现也被忽略）', () => {
    const root = tempDir();
    makeSourceTree(path.join(root, 'src'));
    const rulesFile = writeRules(path.join(root, 'rules.json'), {
      entries: [{ id: 'alpha', name: '阿尔法', model: 'x-model' }],
    });
    const result = buildPackage({ dir: path.join(root, 'src'), out: path.join(root, 'pkg'), rulesFile });
    expect(result.findings.map((finding) => finding.code)).toContain('RULES_MODEL_IGNORED');
    expect(collectStrings(result.plugin).concat(collectStrings(result.manifest)).join('|')).not.toContain('model');
  });

  it('未进入载荷的源树顶层条目给出 PAYLOAD_ENTRY_DROPPED 告警（不静默丢弃）', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { clutter: false });
    writeFileAt(src, 'references/notes.md', '技能参考资料。\n');
    const rulesFile = writeRules(path.join(root, 'rules.json')); // 白名单不含 references

    const result = buildPackage({ dir: src, out: path.join(root, 'pkg'), rulesFile });
    const dropped = result.findings.filter((finding) => finding.code === 'PAYLOAD_ENTRY_DROPPED');
    expect(dropped.map((finding) => finding.message).join('\n')).toContain('references');
  });

  it('默认规则 include 为 ["*"]：references/ 等技能资源随包保留且可还原（§8.1.1、§8.3）', () => {
    const defaults = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'rules', 'default.json'), 'utf8')) as {
      skill: { payload: { include: string[] } };
    };
    expect(defaults.skill.payload.include).toEqual(['*']);

    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { clutter: false });
    writeFileAt(src, 'references/notes.md', '技能参考资料。\n');
    const rulesFile = writeRules(path.join(root, 'rules.json'), { include: ['*'] });
    const out = path.join(root, 'pkg');
    buildPackage({ dir: src, out, rulesFile });
    expect(existsAt(out, 'skills/demo/references/notes.md')).toBe(true);

    const restored = path.join(root, 'restored');
    toSkill(out, restored, { rulesFile });
    expect(readFileAt(restored, 'references/notes.md')).toBe('技能参考资料。\n');
  });

  it('projectExtensionManifest 只做描述：不内联正文', () => {
    const manifest = projectExtensionManifest(
      {
        formatVersion: 1,
        namespace: 'xrl.momoi',
        plugin: { name: 'x' },
        skill: { name: '{skill}', payload: { include: [], exclude: [] } },
        personas: { primary: 'personas/{id}.md', avatar: 'personas/{id}.png' },
      },
      'demo',
      [{ id: 'alpha', name: '阿尔法', sourceFile: 'personas/alpha.md' }],
    );
    expect(JSON.stringify(manifest)).not.toContain('正文');
  });
});
