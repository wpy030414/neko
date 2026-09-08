import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..');
export const CLI_PATH = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

export function tempDir(prefix = 'aip-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFileAt(root: string, relative: string, content: string | Buffer): void {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function readFileAt(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

export function existsAt(root: string, relative: string): boolean {
  return fs.existsSync(path.join(root, ...relative.split('/')));
}

export interface PersonaFixture {
  id: string;
  name?: string;
  avatar?: boolean;
}

export interface SourceTreeOptions {
  dirName?: string;
  skillName?: string;
  personas?: PersonaFixture[];
  /** 是否写入 docs/tools/.git/node_modules/dist/coverage/xrl.momoi/agents 等干扰项。 */
  clutter?: boolean;
}

export const DEFAULT_PERSONAS: PersonaFixture[] = [
  { id: 'alpha', name: '阿尔法' },
  { id: 'beta', name: '贝塔' },
];

export function makeSourceTree(root: string, options: SourceTreeOptions = {}): void {
  const skillName = options.skillName ?? 'demo';
  const personas = options.personas ?? DEFAULT_PERSONAS;
  writeFileAt(root, 'SKILL.md', `---\nname: ${skillName}\ndescription: 测试技能\n---\n\n## 概览\n\n占位正文。\n`);
  for (const persona of personas) {
    writeFileAt(root, `personas/${persona.id}.md`, `## ${persona.id}\n\n这是 ${persona.id} 的正文，含中文与 emoji 🐾。\n`);
    if (persona.avatar !== false) {
      writeFileAt(root, `personas/${persona.id}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, persona.id.length]));
    }
  }
  writeFileAt(root, 'personas/special.md', 'R-18 附加档位占位正文。\n');
  writeFileAt(root, 'scripts/tool.js', 'console.log("hi");\n');
  if (options.clutter !== false) {
    writeFileAt(root, 'docs/guide.md', '文档，不应入包。\n');
    writeFileAt(root, 'tools/build.js', '工具，不应入包。\n');
    writeFileAt(root, '.git/config', '[core]\n');
    writeFileAt(root, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    writeFileAt(root, 'dist/artifact.js', '构建产物，不应入包。\n');
    writeFileAt(root, 'coverage/lcov.info', 'TN:\n');
    writeFileAt(root, 'xrl.momoi/plugin.json', '{}\n');
    writeFileAt(root, 'agents/stale.md', '---\nname: 陈旧\n---\n旧通用层正文。\n');
    writeFileAt(root, 'notes.tsbuildinfo', '{}\n');
  }
}

export interface RulesFixtureOptions {
  entries?: { id: string; name: string; [key: string]: unknown }[];
  levels?: Record<string, string[]> | null;
  pluginName?: string;
  include?: string[];
  exclude?: string[];
  host?: string;
  extraTopLevel?: Record<string, unknown>;
}

export function writeRules(file: string, options: RulesFixtureOptions = {}): string {
  const rules: Record<string, unknown> = {
    formatVersion: 1,
    namespace: 'xrl.momoi',
    plugin: { name: options.pluginName ?? '{skill}', version: '1.0.0', description: '测试包 {skill}', license: 'Proprietary' },
    skill: {
      name: '{skill}',
      payload: {
        include: options.include ?? ['SKILL.md', 'personas', 'scripts'],
        exclude: options.exclude ?? ['docs', 'tools', '.git', 'node_modules', 'dist', 'coverage', 'xrl.momoi', 'agents', '*.tsbuildinfo'],
      },
    },
    personas: {
      primary: 'personas/{id}.md',
      avatar: 'personas/{id}.png',
      entries: options.entries ?? DEFAULT_PERSONAS.map((persona) => ({ id: persona.id, name: persona.name ?? persona.id })),
    },
    genericLayer: { description: '{name}' },
    toSkill: { skillName: '{pluginName}' },
  };
  if (options.levels !== null) {
    (rules['personas'] as Record<string, unknown>)['levels'] = options.levels ?? {
      default: ['personas/{id}.md'],
      r18: ['personas/{id}.md', 'personas/special.md'],
    };
  }
  if (options.host !== undefined) rules['host'] = options.host;
  Object.assign(rules, options.extraTopLevel ?? {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rules, null, 2)}\n`);
  return file;
}

/** 相对路径 → 内容 sha256，用于逐字节比较目录树。 */
export function treeDigest(root: string): Record<string, string> {
  const digest: Record<string, string> = {};
  const visit = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) digest[relative] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  };
  visit(root, '');
  return digest;
}

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: readonly string[], cwd?: string): CliResult {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(`未找到 ${CLI_PATH}，请先执行 npm run build（npm test 会自动构建）`);
  }
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: cwd ?? PACKAGE_ROOT, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}
