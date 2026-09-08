/**
 * 文件系统工具：遍历、字节拷贝、原子替换输出目录。
 * 所有写入都先经过 resolveInside，保证不越出目标根。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AipError } from './errors.js';
import { resolveInside, toPosix } from './paths.js';
import { PLUGIN_SCHEMA_URL } from './rules.js';

export function assertDirectory(dir: string, where: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new AipError('DIR_MISSING', `目录不存在：${dir}`, where);
  }
  if (!stat.isDirectory()) throw new AipError('NOT_A_DIRECTORY', `不是目录：${dir}`, where);
}

export function assertFile(file: string, where: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new AipError('FILE_MISSING', `文件不存在：${file}`, where);
  }
  if (!stat.isFile()) throw new AipError('NOT_A_FILE', `不是普通文件：${file}`, where);
}

/** 递归收集普通文件（POSIX 相对路径，已排序）；根目录本身与内部条目遇到符号链接都直接拒绝。 */
export function walkFiles(root: string, where: string): string[] {
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new AipError('SYMLINK_UNSUPPORTED', `不支持符号链接/重解析点：${root}`, where);
  }
  const collected: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new AipError('SYMLINK_UNSUPPORTED', `不支持符号链接：${relative}`, where);
      }
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        collected.push(relative);
      }
    }
  };
  visit(root, '');
  return collected;
}

export function matchesPattern(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.startsWith('*') && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

export function readTree(root: string, where: string): Map<string, Buffer> {
  const tree = new Map<string, Buffer>();
  for (const relative of walkFiles(root, where)) {
    tree.set(relative, fs.readFileSync(resolveInside(root, relative, where)));
  }
  return tree;
}

/** 按给定相对路径列表把文件逐字节拷贝到 destRoot。 */
export function copyTreeFiles(root: string, files: readonly string[], destRoot: string): void {
  for (const relative of files) {
    const source = resolveInside(root, relative, root);
    const data = fs.readFileSync(source);
    writeFileAt(destRoot, relative, data);
    try {
      fs.chmodSync(resolveInside(destRoot, relative, destRoot), fs.statSync(source).mode & 0o777);
    } catch {
      // 平台不支持时忽略（Windows 上 mode 基本无意义）
    }
  }
}

export function writeFileAt(root: string, relative: string, data: Buffer | string): void {
  const target = resolveInside(root, relative, root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

export function writeJson(root: string, relative: string, value: unknown): void {
  writeFileAt(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 在 target 同级创建临时暂存目录，保证后续 rename 不跨卷。 */
export function createStagingSibling(target: string): string {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, `.aip-staging-${randomUUID().slice(0, 8)}-`));
}

/**
 * 用暂存目录原子替换输出目录。
 * 只有「已存在的、由本工具生成的包」才允许被覆盖（幂等 build），否则拒绝。
 */
export function replaceDir(target: string, staging: string): void {
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      throw new AipError('OUT_NOT_A_DIRECTORY', `输出路径已存在且不是目录：${target}`);
    }
    if (!looksLikePackage(target)) {
      throw new AipError(
        'OUT_NOT_AIP_PACKAGE',
        `输出目录已存在且不是本工具生成的 AIP 包，拒绝覆盖：${target}（请用 --out 指定其他位置）`,
      );
    }
    removeDir(target);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(staging, target);
}

function looksLikePackage(dir: string): boolean {
  const marker = path.join(dir, 'plugin.json');
  if (!fs.existsSync(marker)) return false;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(marker, 'utf8'));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { $schema?: unknown }).$schema === PLUGIN_SCHEMA_URL
    );
  } catch {
    return false;
  }
}

export function toRelativePosix(root: string, absolute: string): string {
  return toPosix(path.relative(root, absolute));
}
