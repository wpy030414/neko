import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { initSkeleton, isSafeRelativePath, materializePackage, readZip, validatePackage, toSkill } from '../src/index.js';
import { existsAt, makeSourceTree, tempDir, writeFileAt, writeRules } from './helpers.js';

const PLUGIN_JSON = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'demo',
  version: '1.0.0',
  extensions: { 'xrl.momoi': { formatVersion: 1, manifest: './xrl.momoi/plugin.json' } },
};

function writePackage(root: string, manifest: unknown, files: Record<string, string | Buffer> = {}): string {
  const pkg = path.join(root, 'pkg');
  writeFileAt(pkg, 'plugin.json', `${JSON.stringify(PLUGIN_JSON, null, 2)}\n`);
  writeFileAt(pkg, 'xrl.momoi/plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileAt(pkg, 'skills/demo/SKILL.md', '---\nname: demo\n---\n\n正文。\n');
  for (const [relative, content] of Object.entries(files)) writeFileAt(pkg, relative, content);
  return pkg;
}

function baseManifest(persona: Record<string, unknown>): Record<string, unknown> {
  return {
    formatVersion: 1,
    namespace: 'xrl.momoi',
    source: { skill: 'demo' },
    personas: [{ id: 'alpha', name: '阿尔法', ...persona }],
  };
}

function errorCodes(pkg: string): string[] {
  return validatePackage(pkg, { skipRoundTrip: true })
    .findings.filter((finding) => finding.severity === 'error')
    .map((finding) => finding.code);
}

describe('安全：路径包含与命名（协议 §12）', () => {
  it.each([
    ['../evil.md'],
    ['/etc/passwd'],
    ['C:/Windows/system32/evil.md'],
    ['personas/../../evil.md'],
    ['personas\\..\\evil.md'],
    ['personas/\u0000evil.md'],
  ])('拒绝越界的 primary：%s', (primary) => {
    const root = tempDir();
    const pkg = writePackage(root, baseManifest({ primary }));
    expect(errorCodes(pkg)).toContain('PATH_INVALID');
    expect(validatePackage(pkg, { skipRoundTrip: true }).ok).toBe(false);
  });

  it.each([['../alpha'], ['Alpha'], ['a b'], ['a/b'], ['a\\b'], ['alpha\u0001']])(
    '拒绝非法 id：%s',
    (id) => {
      const root = tempDir();
      const pkg = writePackage(root, baseManifest({ id, primary: 'personas/alpha.md' }));
      expect(errorCodes(pkg)).toContain('ID_INVALID');
    },
  );

  it('拒绝越界的 source.skill', () => {
    const root = tempDir();
    const manifest = { ...baseManifest({ primary: 'personas/alpha.md' }), source: { skill: '../outside' } };
    const pkg = writePackage(root, manifest);
    expect(errorCodes(pkg)).toContain('ID_INVALID');
  });

  it('拒绝越界的 avatar 与 levels 路径', () => {
    const root = tempDir();
    const pkg = writePackage(
      root,
      baseManifest({
        primary: 'personas/alpha.md',
        avatar: '../../secret.png',
        levels: { default: ['personas/alpha.md'], bad: ['../escape.md'] },
      }),
      { 'personas/alpha.md': '正文\n' },
    );
    const codes = errorCodes(pkg);
    expect(codes).toContain('PATH_INVALID');
  });

  it('zip 内出现 ../ 条目时 validate 报错、to-skill 拒绝解包', () => {
    const root = tempDir();
    const zipFile = path.join(root, 'evil.zip');
    const bytes = zipSync({
      'plugin.json': new Uint8Array(Buffer.from(JSON.stringify(PLUGIN_JSON))),
      '../evil.txt': new Uint8Array([1, 2, 3]),
    });
    fs.writeFileSync(zipFile, bytes);

    const result = validatePackage(zipFile);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('ZIP_ENTRY_UNSAFE');
    expect(() => toSkill(zipFile, path.join(root, 'out'), {})).toThrow(/不安全/);
  });

  it('to-skill 拒绝含越界路径的包，且不产生任何输出', () => {
    const root = tempDir();
    const outside = path.join(root, 'outside');
    const pkg = writePackage(root, baseManifest({ primary: '../outside/evil.md' }));
    writeFileAt(root, 'outside/evil.md', '原始内容\n');
    const target = path.join(root, 'restored');
    expect(() => toSkill(pkg, target, {})).toThrow(/扩展清单存在错误/);
    expect(fs.readFileSync(path.join(outside, 'evil.md'), 'utf8')).toBe('原始内容\n');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('路径包含判定本身拒绝反斜杠与绝对路径', async () => {
    const { isSafeRelativePath: check } = await import('../src/index.js');
    for (const value of ['..', '../a', 'a/../b', '/abs', 'C:/x', 'a\\b', '', 'a/\u0000b', './']) {
      expect(check(value)).toBe(false);
    }
    for (const value of ['a', 'a/b', './a/b', 'a/b.md', 'a-b_c/d.png']) {
      expect(check(value)).toBe(true);
    }
  });

  it('拒绝 Windows ADS 名称（NTFS 备用数据流）：清单引用与 zip 条目都不例外', () => {
    for (const value of ['plugin.json:hidden', 'a/b:c', 'personas/alpha.md:stream']) {
      expect(isSafeRelativePath(value)).toBe(false);
    }

    const root = tempDir();
    const pkg = writePackage(root, baseManifest({ primary: 'skills/demo/personas/alpha.md:hidden' }));
    expect(errorCodes(pkg)).toContain('PATH_INVALID');

    const zipFile = path.join(root, 'ads.zip');
    fs.writeFileSync(zipFile, zipSync({ 'plugin.json:hidden': new Uint8Array([1, 2, 3]) }));
    const read = readZip(zipFile);
    expect(read.files.has('plugin.json:hidden')).toBe(false);
    expect(read.findings.map((finding) => finding.code)).toContain('ZIP_ENTRY_UNSAFE');
  });
});

describe('安全：解包失败回收临时目录', () => {
  it('提取失败时不泄漏临时目录（cleanup 回调尚未返回也必须回收）', () => {
    const root = tempDir();
    // 同一路径既是文件又是目录：writeFileAt 写 x 后，x/y 的 mkdir 必然失败。
    const zipFile = path.join(root, 'conflict.zip');
    fs.writeFileSync(
      zipFile,
      zipSync({ x: new Uint8Array(Buffer.from('file')), 'x/y': new Uint8Array(Buffer.from('nested')) }),
    );

    const fakeTmp = tempDir('aip-tmp-');
    const spy = vi.spyOn(os, 'tmpdir').mockReturnValue(fakeTmp);
    try {
      expect(() => materializePackage(zipFile, { strict: false })).toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(fakeTmp)).toEqual([]);
  });
});

/** 创建目录符号链接/重解析点（Windows 用 junction，无需管理员）；平台不支持时返回 false。 */
function makeDirLink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('安全：符号链接/重解析点包含（协议 §12）', () => {
  it('skills/<name> 是符号链接时 to-skill 拒绝还原，validate 报错', () => {
    const root = tempDir();
    const victim = path.join(root, 'victim');
    writeFileAt(root, 'victim/passwords.txt', 'VICTIM-PASSWORDS\n');
    const pkg = path.join(root, 'pkg');
    writeFileAt(pkg, 'plugin.json', `${JSON.stringify(PLUGIN_JSON, null, 2)}\n`);
    writeFileAt(
      pkg,
      'xrl.momoi/plugin.json',
      `${JSON.stringify({ formatVersion: 1, namespace: 'xrl.momoi', source: { skill: 'demo' }, personas: [] }, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(pkg, 'skills'), { recursive: true });
    if (!makeDirLink(victim, path.join(pkg, 'skills', 'demo'))) return; // 平台不支持符号链接

    const target = path.join(root, 'out');
    expect(() => toSkill(pkg, target, {})).toThrow(/符号链接/);
    expect(fs.existsSync(path.join(target, 'passwords.txt'))).toBe(false);

    const result = validatePackage(pkg, { skipRoundTrip: true });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('SYMLINK_UNSUPPORTED');
  });

  it('agents/ 是符号链接时通用层发现拒绝越界读取', () => {
    const root = tempDir();
    writeFileAt(root, 'victim/x.md', '---\nname: 越界\n---\n\n包外正文。\n');
    const pkg = path.join(root, 'pkg');
    writeFileAt(pkg, 'plugin.json', `${JSON.stringify(PLUGIN_JSON, null, 2)}\n`);
    writeFileAt(pkg, 'xrl.momoi/plugin.json', `${JSON.stringify({ formatVersion: 1, namespace: 'xrl.momoi', personas: [] }, null, 2)}\n`);
    if (!makeDirLink(path.join(root, 'victim'), path.join(pkg, 'agents'))) return;

    expect(() => toSkill(pkg, path.join(root, 'out'), {})).toThrow(/符号链接/);
    const result = validatePackage(pkg, { skipRoundTrip: true });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('SYMLINK_UNSUPPORTED');
  });

  it('init 拒绝通过符号链接/重解析点写入源树之外的扩展清单', () => {
    const root = tempDir();
    const src = path.join(root, 'src');
    makeSourceTree(src, { clutter: false });
    const outside = path.join(root, 'outside');
    writeFileAt(root, 'outside/keep.txt', 'keep\n');
    if (!makeDirLink(outside, path.join(src, 'xrl.momoi'))) return;
    const rulesFile = writeRules(path.join(root, 'rules.json'));

    expect(() => initSkeleton({ dir: src, rulesFile })).toThrow(/符号链接/);
    expect(fs.existsSync(path.join(outside, 'plugin.json'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});

/** 改写中央目录里某条目的「解压后大小」字段，用于伪造解压炸弹（不实际写入大文件）。 */
function patchZipUncompressedSize(bytes: Buffer, entryName: string, size: number): Buffer {
  const eocd = bytes.length - 22;
  let offset = bytes.readUInt32LE(eocd + 16);
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === entryName) {
      bytes.writeUInt32LE(size, offset + 24);
      return bytes;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip 中未找到条目：${entryName}`);
}

describe('安全：zip 解压规模上限（防解压炸弹）', () => {
  it('中央目录声明超大解压尺寸时跳过该条目，不解压也不分配大内存', () => {
    const root = tempDir();
    const zipFile = path.join(root, 'bomb.zip');
    const bytes = Buffer.from(
      zipSync({
        'plugin.json': new Uint8Array(Buffer.from(JSON.stringify(PLUGIN_JSON))),
        'bomb.bin': new Uint8Array(1024 * 1024),
      }),
    );
    patchZipUncompressedSize(bytes, 'bomb.bin', 2 * 1024 * 1024 * 1024);
    fs.writeFileSync(zipFile, bytes);

    const read = readZip(zipFile);
    expect(read.files.has('bomb.bin')).toBe(false);
    expect(read.files.has('plugin.json')).toBe(true);
    expect(read.findings.map((finding) => finding.code)).toContain('ZIP_ENTRY_TOO_LARGE');

    const result = validatePackage(zipFile, { skipRoundTrip: true });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('ZIP_ENTRY_TOO_LARGE');
    expect(() => toSkill(zipFile, path.join(root, 'out'), {})).toThrow(/不安全/);
  });

  it('可配置上限：单条目大小、压缩比与条目数各自可拦截', () => {
    const root = tempDir();
    const zipFile = path.join(root, 'small.zip');
    fs.writeFileSync(
      zipFile,
      zipSync({ 'a.txt': new Uint8Array(Buffer.from('a'.repeat(4096))), 'b.txt': new Uint8Array(Buffer.from('b')) }),
    );

    const tooLarge = readZip(zipFile, { maxEntries: 100, maxEntrySize: 16, maxTotalSize: 1024, maxRatio: 10_000 });
    expect(tooLarge.files.has('a.txt')).toBe(false);
    expect(tooLarge.findings.map((finding) => finding.code)).toContain('ZIP_ENTRY_TOO_LARGE');

    const tooCompressed = readZip(zipFile, { maxEntries: 100, maxEntrySize: 1024 * 1024, maxTotalSize: 1024 * 1024, maxRatio: 10 });
    expect(tooCompressed.findings.map((finding) => finding.code)).toContain('ZIP_RATIO_EXCEEDED');

    const tooMany = readZip(zipFile, { maxEntries: 1, maxEntrySize: 1024 * 1024, maxTotalSize: 1024 * 1024, maxRatio: 10_000 });
    expect(tooMany.findings.map((finding) => finding.code)).toContain('ZIP_TOO_MANY_ENTRIES');

    const totalTooLarge = readZip(zipFile, { maxEntries: 100, maxEntrySize: 1024 * 1024, maxTotalSize: 16, maxRatio: 10_000 });
    expect(totalTooLarge.files.has('a.txt')).toBe(false);
    expect(totalTooLarge.findings.map((finding) => finding.code)).toContain('ZIP_TOTAL_TOO_LARGE');
  });
});
