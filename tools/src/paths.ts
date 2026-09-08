/**
 * 路径与命名安全：协议 §12 要求包内所有引用都落在插件根内。
 * 本模块是唯一的判定入口，所有来自清单/zip 的路径都必须先经过这里。
 * 除词法判定外，逐段 lstat 拒绝符号链接/重解析点（Windows junction 亦按符号链接处理），
 * 否则路径包含只是字面约束，实际读写仍会越出插件根。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AipError } from './errors.js';

/** 人格 id / 技能名 / 档位文件基名统一约束（协议 §5、§6.2）。 */
export const ID_PATTERN = /^[a-z0-9-]+$/;

/** 控制字符（U+0000–U+001F 与 U+007F）。用构造函数书写，避免源码中出现裸控制字符。 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]');
const WINDOWS_DRIVE = /^[A-Za-z]:/;

export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function assertValidId(value: unknown, kind: string, where: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AipError('ID_INVALID', `${kind}必须匹配 [a-z0-9-]+，实际为 ${describeValue(value)}`, where);
  }
  return value;
}

/** 合法相对路径：非空、无控制字符、无反斜杠、非绝对路径、无 . 或 .. 段、无 Windows ADS 分隔符。 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (WINDOWS_DRIVE.test(value)) return false;
  let rest = value;
  while (rest.startsWith('./')) rest = rest.slice(2);
  if (rest.length === 0) return false;
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    // `name:stream` 在 Windows 上是 NTFS 备用数据流（ADS），会被静默写入宿主文件；包内路径一律拒绝。
    if (segment.includes(':')) return false;
  }
  return true;
}

export function assertSafeRelativePath(value: unknown, where: string): string {
  if (!isSafeRelativePath(value)) {
    throw new AipError(
      'PATH_INVALID',
      `必须是插件根内的相对路径（不得为绝对路径、含 ..、反斜杠或控制字符），实际为 ${describeValue(value)}`,
      where,
    );
  }
  return value;
}

/** 顶层条目名（payload.include / exclude 用），允许 "*" 通配。 */
export function assertTopLevelName(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..') {
    throw new AipError('RULE_ENTRY_INVALID', `顶层条目名非法：${describeValue(value)}`, where);
  }
  if (value === '*') return value;
  if (value.includes('/') || value.includes('\\') || value.includes(':') || CONTROL_CHARS.test(value)) {
    throw new AipError('RULE_ENTRY_INVALID', `顶层条目名不得包含分隔符、ADS 冒号或控制字符：${describeValue(value)}`, where);
  }
  return value;
}

/** 解析并断言结果仍在 root 内；越界一律抛 PATH_ESCAPE，路径前缀含链接一律抛 SYMLINK_UNSUPPORTED。 */
export function resolveInside(root: string, relative: string, where: string): string {
  assertSafeRelativePath(relative, where);
  const absolute = path.resolve(root, relative);
  const back = path.relative(root, absolute);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new AipError('PATH_ESCAPE', `路径解析后越出插件根：${relative}`, where);
  }
  assertNoSymlinkComponents(root, relative, where);
  return absolute;
}

/**
 * 逐段 lstat（含最后一段），拒绝符号链接/重解析点。
 * 不存在的部分直接放行：存在性由调用方按需判定。
 */
export function assertNoSymlinkComponents(root: string, relative: string, where: string): void {
  let current = path.resolve(root);
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new AipError(
        'SYMLINK_UNSUPPORTED',
        `路径前缀包含符号链接/重解析点，拒绝访问（协议 §12）：${relative}`,
        where,
      );
    }
  }
}

/** 把任意文本净化为合法 id（[a-z0-9-]+）；用于插件名等非受控来源。 */
export function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}
