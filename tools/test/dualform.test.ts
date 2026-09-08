import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPackage, validatePackage } from '../src/index.js';
import { makeSourceTree, tempDir, writeFileAt, writeRules } from './helpers.js';

function codes(pkg: string, rulesFile: string): string[] {
  return validatePackage(pkg, { rulesFile, skipRoundTrip: true }).findings.map((finding) => finding.code);
}

describe('(d) 双形态共存一致性（协议 §6.3）', () => {
  it('build --with-agents 产物双形态一致，validate 通过', () => {
    const root = tempDir();
    makeSourceTree(path.join(root, 'src'));
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: path.join(root, 'src'), out: pkg, rulesFile, withAgents: true });

    const result = validatePackage(pkg, { rulesFile });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('正文不一致时报 DUAL_FORM_MISMATCH 且校验失败', () => {
    const root = tempDir();
    makeSourceTree(path.join(root, 'src'));
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg');
    buildPackage({ dir: path.join(root, 'src'), out: pkg, rulesFile, withAgents: true });

    const agentPath = path.join(pkg, 'agents', 'alpha.md');
    fs.appendFileSync(agentPath, '\n被篡改的额外正文。\n');

    const result = validatePackage(pkg, { rulesFile, skipRoundTrip: true });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('DUAL_FORM_MISMATCH');
  });

  it('只有通用层的包合法（协议 §4：三种形态均合法）', () => {
    const root = tempDir();
    const pkg = path.join(root, 'pkg');
    writeFileAt(pkg, 'plugin.json', `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'demo',
      version: '1.0.0',
    }, null, 2)}\n`);
    writeFileAt(pkg, 'agents/alpha.md', '---\nname: 阿尔法\ndescription: 占位\n---\n\n阿尔法正文。\n');

    const result = validatePackage(pkg, { skipRoundTrip: true });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('通用层缺少 frontmatter name 时报错', () => {
    const root = tempDir();
    const pkg = path.join(root, 'pkg');
    writeFileAt(pkg, 'plugin.json', `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'demo',
    }, null, 2)}\n`);
    writeFileAt(pkg, 'agents/alpha.md', '没有前置元数据的正文。\n');
    expect(codes(pkg, '')).toContain('GENERIC_NAME_MISSING');
  });

  it('既无扩展清单也无通用层时不是 AIP 包', () => {
    const root = tempDir();
    const pkg = path.join(root, 'pkg');
    writeFileAt(pkg, 'plugin.json', `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'demo',
    }, null, 2)}\n`);
    expect(codes(pkg, '')).toContain('NOT_AIP_PACKAGE');
  });
});
