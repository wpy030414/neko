import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPackage, toSkill, validatePackage } from '../src/index.js';
import { REPO_ROOT, makeSourceTree, tempDir, treeDigest, writeRules } from './helpers.js';

/** 源树中应当进入载荷的相对路径。 */
function payloadDigest(root: string): Record<string, string> {
  const digest = treeDigest(root);
  const payload: Record<string, string> = {};
  for (const [relative, hash] of Object.entries(digest)) {
    if (relative === 'SKILL.md' || relative.startsWith('personas/') || relative.startsWith('scripts/')) {
      payload[relative] = hash;
    }
  }
  return payload;
}

describe('往返：build → to-skill', () => {
  it('(a) 合成源树往返后与源树载荷逐字节一致', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: src, out: pkg, rulesFile, withAgents: true });

    const restored = path.join(root, 'restored');
    const result = toSkill(pkg, restored, { rulesFile });
    expect(result.generated).toBe(false);
    expect(result.skillName).toBe('demo');
    expect(treeDigest(restored)).toEqual(payloadDigest(src));
  });

  it('(a) 真实 neko 源树往返后与源树载荷逐字节一致', () => {
    const root = tempDir();
    const pkg = path.join(root, 'pkg');
    const built = buildPackage({ dir: REPO_ROOT, out: pkg });
    expect(built.skillName).toBe('neko');

    const restored = path.join(root, 'restored');
    toSkill(pkg, restored, {});

    const source = payloadDigest(REPO_ROOT);
    expect(Object.keys(source)).toContain('SKILL.md');
    expect(Object.keys(source)).toContain('personas/special.md');
    expect(treeDigest(restored)).toEqual(source);
  });

  it('zip 形态同样可还原且字节一致', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg.zip');
    buildPackage({ dir: src, out: pkg, rulesFile });

    const restored = path.join(root, 'restored');
    const result = toSkill(pkg, restored, { rulesFile });
    expect(result.generated).toBe(false);
    expect(treeDigest(restored)).toEqual(payloadDigest(src));
  });

  it('纯人格包（无 source.skill）：to-skill 生成源树（含显示名与档位文件），再次 build 得到等价包', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { personas: [{ id: 'alpha', name: '阿尔法' }] });
    const rulesFile = writeRules(path.join(root, 'rules.json'), {
      entries: [{ id: 'alpha', name: '阿尔法' }],
    });
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: src, out: pkg, rulesFile });

    // 去掉 source.skill，模拟纯人格包
    const manifestPath = path.join(pkg, 'xrl.momoi', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest['source'];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const restored = path.join(root, 'restored');
    const result = toSkill(pkg, restored, { rulesFile });
    expect(result.generated).toBe(true);
    // §8.2 生成规则固定：personas/<id>.md = 显示名 frontmatter + primary 正文
    const restoredPrimary = fs.readFileSync(path.join(restored, 'personas', 'alpha.md'), 'utf8');
    expect(restoredPrimary).toContain('name: 阿尔法');
    expect(restoredPrimary.endsWith(fs.readFileSync(path.join(src, 'personas', 'alpha.md'), 'utf8'))).toBe(true);
    // §7 档位文件本身仍随包保留：levels 引用的 special.md 一并还原
    expect(fs.readFileSync(path.join(restored, 'personas', 'special.md'))).toEqual(
      fs.readFileSync(path.join(src, 'personas', 'special.md')),
    );
    expect(fs.readFileSync(path.join(restored, 'SKILL.md'), 'utf8')).toContain('name: demo');

    const rebuilt = path.join(root, 'rebuilt');
    buildPackage({ dir: restored, out: rebuilt, rulesFile });
    const rebuiltManifest = JSON.parse(fs.readFileSync(path.join(rebuilt, 'xrl.momoi', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    const rebuiltPersonas = rebuiltManifest['personas'] as Record<string, unknown>[];
    expect(rebuiltPersonas[0]?.['name']).toBe('阿尔法');
    expect(rebuiltPersonas[0]?.['levels']).toEqual({
      default: ['skills/demo/personas/alpha.md'],
      r18: ['skills/demo/personas/alpha.md', 'skills/demo/personas/special.md'],
    });
    expect(fs.readFileSync(path.join(rebuilt, 'skills', 'demo', 'personas', 'alpha.md'), 'utf8').endsWith(
      fs.readFileSync(path.join(src, 'personas', 'alpha.md'), 'utf8'),
    )).toBe(true);

    // 往返门对显示名与 levels 文件字节同样可判定
    expect(validatePackage(pkg, { rulesFile }).ok).toBe(true);
  });

  it('validate 的往返门对往返无损的包通过', () => {
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
