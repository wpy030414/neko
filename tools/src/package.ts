/**
 * 输入物化：目录直接使用；zip 解到临时目录并做条目安全过滤。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AipError, hasErrors, warningFinding, type Finding } from './errors.js';
import { extractZip, readZip, type ZipLimits } from './zip.js';

export interface Materialized {
  root: string;
  cleanup: () => void;
  findings: Finding[];
  fromZip: boolean;
}

export interface MaterializeOptions {
  /** true（默认）：遇到不安全 zip 条目直接拒绝；false：记录为错误并继续。 */
  strict?: boolean;
  /** zip 解压规模上限（防解压炸弹），默认 DEFAULT_ZIP_LIMITS。 */
  zipLimits?: ZipLimits;
}

export function materializePackage(input: string, options: MaterializeOptions = {}): Materialized {
  const absolute = path.resolve(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new AipError('INPUT_MISSING', `输入不存在：${absolute}`, absolute);
  }
  if (stat.isDirectory()) {
    return { root: absolute, cleanup: () => {}, findings: [], fromZip: false };
  }
  if (!stat.isFile()) {
    throw new AipError('INPUT_INVALID', `输入既不是目录也不是文件：${absolute}`, absolute);
  }

  const { files, dirs, findings } = readZip(absolute, options.zipLimits);
  if (hasErrors(findings) && options.strict !== false) {
    throw new AipError('ZIP_UNSAFE', 'zip 含不安全条目，拒绝解包（协议 §12）', absolute);
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-unzip-'));
  try {
    extractZip(files, tempRoot, dirs);
  } catch (err) {
    // 解包失败时 cleanup 回调尚未返回，必须在此回收临时目录，否则每次失败都泄漏一份解压产物。
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
  const root = resolveWrapper(tempRoot, findings);
  return {
    root,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    findings,
    fromZip: true,
  };
}

/** 打包工具可能多套一层同名目录：唯一顶层目录且其内有 plugin.json 时自动下钻。 */
function resolveWrapper(tempRoot: string, findings: Finding[]): string {
  if (fs.existsSync(path.join(tempRoot, 'plugin.json'))) return tempRoot;
  const directories = fs
    .readdirSync(tempRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  const only = directories[0];
  if (directories.length === 1 && only !== undefined) {
    const inner = path.join(tempRoot, only.name);
    if (fs.existsSync(path.join(inner, 'plugin.json'))) {
      findings.push(warningFinding('ZIP_WRAPPER_DIR', `zip 使用包装目录 ${only.name}/，已自动下钻`, tempRoot));
      return inner;
    }
  }
  return tempRoot;
}
