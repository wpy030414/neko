/**
 * 极简 YAML 前置元数据处理。
 *
 * 协议只用到「name / description」这类扁平标量（§5），因此这里只实现该子集：
 * - 识别文件开头的 --- ... --- 块；
 * - 解析 `key: value` 标量（支持单/双引号）；
 * - 忽略注释行与无法解析的行（嵌套结构不在协议范围内）。
 * 不支持块标量（| / >），遇到时该键会被忽略——这是有意为之的窄实现。
 */

export interface ParsedFrontmatter {
  data: Record<string, string>;
  body: string;
}

export function splitFrontmatter(text: string): { raw: string | null; body: string } {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (match === null) return { raw: null, body: source };
  return { raw: match[1] ?? '', body: source.slice(match[0].length) };
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const { raw, body } = splitFrontmatter(text);
  const data: Record<string, string> = {};
  if (raw !== null) {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (match === null) continue;
      const key = match[1];
      if (key === undefined) continue;
      data[key] = unquote((match[2] ?? '').trim());
    }
  }
  return { data, body };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** 生成前置元数据块，以 `---\n` 开头、`---\n` 结尾，正文紧随其后。 */
export function emitFrontmatter(data: Record<string, string>): string {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${emitScalar(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

const PLAIN_SCALAR = /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿 _.,()（）「」·!?！？、-]*$/;

function emitScalar(value: string): string {
  if (value !== '' && PLAIN_SCALAR.test(value) && !value.endsWith(' ')) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}
