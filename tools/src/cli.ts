#!/usr/bin/env node
/**
 * aip —— Agents Import Protocol 转换器 CLI（协议 §10）。
 * 退出码：0 成功；1 校验失败或执行错误；2 用法错误。
 */
import process from 'node:process';
import { AipError, countBy, formatFinding, hasErrors, type Finding } from './errors.js';
import { buildPackage } from './build.js';
import { initSkeleton } from './init.js';
import { toSkill } from './toSkill.js';
import { validatePackage } from './validate.js';

const USAGE = `aip —— Agents Import Protocol 转换器（协议 v0.2）

用法：
  aip init [dir] [--rules <file>]                    在源技能树生成扩展清单骨架
  aip build [dir] [--out <dir|zip>] [--with-agents]  源技能树 → AIP 包
  aip to-skill [pkg] [--out <dir>]                   AIP 包 → 源技能树（协议 §8.2）
  aip validate [dir|zip] [--rules <file>]            校验包（协议 §10.1 验证门）

选项：
  --rules <file>   规则文件（默认使用内置 tools/rules/default.json）
  --out <path>     build 默认 ./dist/<插件名>；to-skill 默认 ./out/<技能名>
  --with-agents    build 时额外生成通用层 agents/*.md
  -h, --help       显示本帮助
  -V, --version    显示版本

退出码：0 成功；1 校验失败或执行错误；2 用法错误。`;

interface ParsedArgs {
  command: string;
  positionals: string[];
  rules?: string;
  out?: string;
  withAgents: boolean;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: '', positionals: [], withAgents: false, help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--version' || arg === '-V') {
      parsed.version = true;
    } else if (arg === '--with-agents') {
      parsed.withAgents = true;
    } else if (arg === '--rules' || arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`缺少 ${arg} 的值`);
      if (arg === '--rules') parsed.rules = value;
      else parsed.out = value;
      index += 1;
    } else if (arg.startsWith('--rules=')) {
      parsed.rules = arg.slice('--rules='.length);
    } else if (arg.startsWith('--out=')) {
      parsed.out = arg.slice('--out='.length);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`未知参数：${arg}`);
    } else if (parsed.command === '') {
      parsed.command = arg;
    } else {
      parsed.positionals.push(arg);
    }
  }
  return parsed;
}

function printFindings(findings: readonly Finding[]): void {
  for (const finding of findings) process.stderr.write(`${formatFinding(finding)}\n`);
}

function summarize(findings: readonly Finding[]): string {
  return `${countBy(findings, 'error')} 个错误，${countBy(findings, 'warning')} 个警告`;
}

function run(argv: readonly string[]): number {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed.version) {
    process.stdout.write('aip 0.2.0\n');
    return 0;
  }
  if (parsed.help || parsed.command === '' || parsed.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return parsed.command === '' && !parsed.help ? 2 : 0;
  }

  try {
    switch (parsed.command) {
      case 'init': {
        const result = initSkeleton({ dir: parsed.positionals[0], rulesFile: parsed.rules });
        printFindings(result.findings);
        if (hasErrors(result.findings)) {
          process.stderr.write(`FAILED init：${summarize(result.findings)}\n`);
          return 1;
        }
        process.stdout.write(`OK init: ${result.file}\n`);
        return 0;
      }
      case 'build': {
        const result = buildPackage({
          dir: parsed.positionals[0],
          out: parsed.out,
          rulesFile: parsed.rules,
          withAgents: parsed.withAgents,
        });
        printFindings(result.findings);
        if (hasErrors(result.findings)) {
          process.stderr.write(`FAILED build：${summarize(result.findings)}\n`);
          return 1;
        }
        process.stdout.write(`OK build: 技能 ${result.skillName}，${result.fileCount} 个文件 -> ${result.out}\n`);
        return 0;
      }
      case 'to-skill': {
        const result = toSkill(parsed.positionals[0] ?? '.', parsed.out, { rulesFile: parsed.rules });
        printFindings(result.findings);
        if (hasErrors(result.findings)) {
          process.stderr.write(`FAILED to-skill：${summarize(result.findings)}\n`);
          return 1;
        }
        process.stdout.write(`OK to-skill: ${result.generated ? '由清单生成' : 'source.skill 还原'} -> ${result.out}\n`);
        return 0;
      }
      case 'validate': {
        const result = validatePackage(parsed.positionals[0] ?? '.', { rulesFile: parsed.rules });
        printFindings(result.findings);
        if (!result.ok) {
          process.stderr.write(`FAILED validate：${summarize(result.findings)}\n`);
          return 1;
        }
        process.stdout.write(`OK validate: ${parsed.positionals[0] ?? '.'}（${summarize(result.findings)}）\n`);
        return 0;
      }
      default: {
        process.stderr.write(`ERROR 未知命令：${parsed.command}\n\n${USAGE}\n`);
        return 2;
      }
    }
  } catch (err) {
    if (err instanceof AipError) {
      process.stderr.write(`${formatFinding({ code: err.code, severity: 'error', message: err.message, ...(err.path === undefined ? {} : { path: err.path }) })}\n`);
    } else {
      process.stderr.write(`ERROR ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    }
    return 1;
  }
}

process.exitCode = run(process.argv.slice(2));
