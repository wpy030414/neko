/**
 * zip 读写：读取时逐条做路径穿越检查（协议 §12）并限制解压规模（防解压炸弹），写入时按目录树打包。
 * 规模上限在解压前依据中央目录声明的原始大小判定，超限条目直接跳过、不解压。
 */
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { AipError, errorFinding, warningFinding, type Finding } from './errors.js';
import { isSafeRelativePath } from './paths.js';
import { assertFile, walkFiles, writeFileAt } from './fsutil.js';

export interface ZipLimits {
  /** 中央目录条目数上限（含目录条目）。 */
  maxEntries: number;
  /** 单个条目解压后字节数上限。 */
  maxEntrySize: number;
  /** 全部条目解压后累计字节数上限。 */
  maxTotalSize: number;
  /** 单个条目最大压缩比（解压后 / 压缩后）。 */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntrySize: 128 * 1024 * 1024,
  maxTotalSize: 512 * 1024 * 1024,
  maxRatio: 1_000,
};

export interface ZipReadResult {
  files: Map<string, Uint8Array>;
  findings: Finding[];
}

function isJunkEntry(normalized: string): boolean {
  return (
    normalized === '.DS_Store' ||
    normalized.endsWith('/.DS_Store') ||
    normalized === '__MACOSX' ||
    normalized.startsWith('__MACOSX/')
  );
}

export function readZip(file: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipReadResult {
  assertFile(file, file);
  const raw = new Uint8Array(fs.readFileSync(file));
  const files = new Map<string, Uint8Array>();
  const findings: Finding[] = [];
  let entryCount = 0;
  let totalSize = 0;
  let entryLimitReported = false;
  let totalLimitReported = false;

  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(raw, {
      // filter 在解压前收到中央目录声明的尺寸；返回 false 的条目不会被解压。
      filter: (info) => {
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          if (!entryLimitReported) {
            entryLimitReported = true;
            findings.push(errorFinding('ZIP_TOO_MANY_ENTRIES', `zip 条目数超过上限 ${limits.maxEntries}，超出的条目已跳过`, file));
          }
          return false;
        }
        const normalized = info.name.replace(/\\/g, '/');
        if (normalized.endsWith('/')) return false; // 目录条目
        if (isJunkEntry(normalized)) {
          findings.push(warningFinding('ZIP_JUNK_IGNORED', `已忽略打包工具附加条目：${info.name}`, file));
          return false;
        }
        if (!isSafeRelativePath(normalized)) {
          findings.push(errorFinding('ZIP_ENTRY_UNSAFE', `zip 条目名不安全（绝对路径/含 ../控制字符/反斜杠）：${info.name}`, file));
          return false;
        }
        if (info.originalSize > limits.maxEntrySize) {
          findings.push(
            errorFinding('ZIP_ENTRY_TOO_LARGE', `zip 条目解压后大小 ${info.originalSize} 超过上限 ${limits.maxEntrySize}，已跳过：${info.name}`, file),
          );
          return false;
        }
        if (totalSize + info.originalSize > limits.maxTotalSize) {
          if (!totalLimitReported) {
            totalLimitReported = true;
            findings.push(
              errorFinding('ZIP_TOTAL_TOO_LARGE', `zip 解压累计大小超过上限 ${limits.maxTotalSize}，超出的条目已跳过：${info.name}`, file),
            );
          }
          return false;
        }
        const ratio = info.size > 0 ? info.originalSize / info.size : info.originalSize > 0 ? Number.POSITIVE_INFINITY : 1;
        if (ratio > limits.maxRatio) {
          findings.push(
            errorFinding('ZIP_RATIO_EXCEEDED', `zip 条目压缩比 ${Math.round(ratio)}:1 超过上限 ${limits.maxRatio}:1，已跳过：${info.name}`, file),
          );
          return false;
        }
        totalSize += info.originalSize;
        return true;
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AipError('ZIP_INVALID', `无法解包 zip（${reason}）`, file);
  }

  for (const [name, bytes] of Object.entries(extracted)) {
    files.set(name.replace(/\\/g, '/'), bytes);
  }
  return { files, findings };
}

export function extractZip(files: Map<string, Uint8Array>, destRoot: string): void {
  for (const [relative, bytes] of files) {
    writeFileAt(destRoot, relative, Buffer.from(bytes));
  }
}

export function writeZip(root: string, outFile: string): void {
  const record: Record<string, Uint8Array> = {};
  for (const relative of walkFiles(root, root)) {
    record[relative] = new Uint8Array(fs.readFileSync(path.join(root, relative)));
  }
  const bytes = zipSync(record, { level: 6 });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bytes);
}
