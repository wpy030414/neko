import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toSkill } from '../src/index.js';
import { tempDir, writeFileAt } from './helpers.js';

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

function writeGenericPackage(root: string, body: string | Buffer): string {
  const pkg = path.join(root, 'pkg');
  writeFileAt(pkg, 'plugin.json', `${JSON.stringify({ $schema: SCHEMA, name: 'demo' }, null, 2)}\n`);
  writeFileAt(pkg, 'agents/alpha.md', body);
  return pkg;
}

describe('to-skill：先校验后写盘与逐字节还原', () => {
  it('通用层缺少必填 frontmatter name 时拒绝还原，且不产生输出（协议 §5）', () => {
    const root = tempDir();
    const pkg = writeGenericPackage(root, '没有前置元数据的正文。\n');
    const target = path.join(root, 'out');
    expect(() => toSkill(pkg, target, {})).toThrow(/通用层/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('扩展清单声明存在但文件缺失：先校验后写盘，不产生任何输出（协议 §10.1）', () => {
    const root = tempDir();
    const pkg = path.join(root, 'pkg');
    writeFileAt(
      pkg,
      'plugin.json',
      `${JSON.stringify(
        { $schema: SCHEMA, name: 'demo', extensions: { 'xrl.momoi': { formatVersion: 1, manifest: './xrl.momoi/plugin.json' } } },
        null,
        2,
      )}\n`,
    );
    // 通用层可用，但声明的扩展清单缺失是致命错误，必须先于写盘终止。
    writeFileAt(pkg, 'agents/alpha.md', '---\nname: 阿尔法\n---\n正文。\n');
    const target = path.join(root, 'out');
    expect(() => toSkill(pkg, target, {})).toThrow(/声明的扩展清单不存在/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('纯通用层包：非 UTF-8 正文按字节还原，不替换为 U+FFFD', () => {
    const root = tempDir();
    const invalid = Buffer.from([0xff, 0xfe, 0x41, 0x0a]);
    const pkg = writeGenericPackage(root, Buffer.concat([Buffer.from('---\nname: 阿尔法\n---\n', 'utf8'), invalid]));
    const target = path.join(root, 'out');

    const result = toSkill(pkg, target, {});
    expect(result.generated).toBe(true);
    const restored = fs.readFileSync(path.join(target, 'personas', 'alpha.md'));
    expect(restored.subarray(restored.length - invalid.length)).toEqual(invalid);
    expect(restored.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it('扩展层人格：primary 为非 UTF-8 正文时同样按字节还原（协议 §8.2）', () => {
    const root = tempDir();
    const invalid = Buffer.from([0x80, 0x81, 0x0a]);
    const pkg = path.join(root, 'pkg');
    writeFileAt(
      pkg,
      'plugin.json',
      `${JSON.stringify({ $schema: SCHEMA, name: 'demo' }, null, 2)}\n`,
    );
    writeFileAt(
      pkg,
      'xrl.momoi/plugin.json',
      `${JSON.stringify(
        { formatVersion: 1, namespace: 'xrl.momoi', personas: [{ id: 'alpha', name: '阿尔法', primary: 'personas/alpha.md' }] },
        null,
        2,
      )}\n`,
    );
    writeFileAt(pkg, 'personas/alpha.md', Buffer.concat([Buffer.from('---\nname: 阿尔法\n---\n', 'utf8'), invalid]));

    const target = path.join(root, 'out');
    toSkill(pkg, target, {});
    const restored = fs.readFileSync(path.join(target, 'personas', 'alpha.md'));
    expect(restored.subarray(restored.length - invalid.length)).toEqual(invalid);
  });
});
