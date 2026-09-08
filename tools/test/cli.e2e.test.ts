import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeSourceTree, readJson, runCli, tempDir, treeDigest, writeRules } from './helpers.js';

describe('CLI 端到端（dist/cli.js）', () => {
  it('build → validate → to-skill 全链路退出码为 0', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg');
    const restored = path.join(root, 'restored');

    const built = runCli(['build', src, '--out', pkg, '--with-agents', '--rules', rulesFile]);
    expect(built.stderr).toBe('');
    expect(built.status).toBe(0);
    expect(built.stdout).toContain('OK build');

    const validated = runCli(['validate', pkg, '--rules', rulesFile]);
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain('OK validate');

    const restoredRun = runCli(['to-skill', pkg, '--out', restored, '--rules', rulesFile]);
    expect(restoredRun.status).toBe(0);
    expect(restoredRun.stdout).toContain('source.skill 还原');

    const payload = treeDigest(src);
    const expected: Record<string, string> = {};
    for (const [relative, hash] of Object.entries(payload)) {
      if (relative === 'SKILL.md' || relative.startsWith('personas/') || relative.startsWith('scripts/')) {
        expected[relative] = hash;
      }
    }
    expect(treeDigest(restored)).toEqual(expected);
  });

  it('校验失败时退出码为 1 并逐条打印', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src);
    const rulesFile = writeRules(path.join(root, 'rules.json'));
    const pkg = path.join(root, 'pkg');
    runCli(['build', src, '--out', pkg, '--rules', rulesFile]);

    const pluginPath = path.join(pkg, 'plugin.json');
    const plugin = readJson(pluginPath);
    plugin['unknownField'] = true;
    fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);

    const result = runCli(['validate', pkg, '--rules', rulesFile]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERROR [SCHEMA_PLUGIN]');
    expect(result.stderr).toContain('FAILED validate');
  });

  it('用法错误退出码为 2', () => {
    expect(runCli(['bogus']).status).toBe(2);
    expect(runCli(['build', '--nope']).status).toBe(2);
  });

  it('--help 与 --version 退出码为 0', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('aip init');
    const version = runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe('aip 0.2.0');
  });
});
