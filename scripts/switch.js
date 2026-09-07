#!/usr/bin/env node
/**
 * neko 身份切换脚本 —— 一条命令完成原 SKILL.md 的「读取档案 + 写入全局指令」两步。
 *
 * 用法:
 *   node switch.js <name> [R-15|R-18] [--target <file>]
 *
 * 参数:
 *   name           档案文件名（chocola / vanilla / coconut / azuki / maple /
 *                  cinnamon / strawberry / shigure）
 *   level          分级，默认 R-15；R-18 时额外内联 personas/special.md
 *   --target <f>   目标指令文件，默认 ~/.claude/CLAUDE.md（仅供测试覆盖）
 *
 * 职责边界: 本脚本只负责「读档案 + 替换目标区块」这一件事，不做任何参数
 * 归一化——参数标准化由 SKILL 流程（AI 层）负责，脚本只认上面列出的标准值。
 *
 * 行为:
 *   1. 读取本脚本同级上级目录下 personas/<name>.md（必须存在）；
 *   2. 分级为 R-18 时再读取 personas/special.md；
 *   3. 在目标文件中整块替换 <!-- neko:identity:start --> ~
 *      <!-- neko:identity:end -->（含两个标记行本身）；标记不存在时追加到
 *      首个一级标题之后，仍无则追加到文件末尾。标记之外的内容一律不动。
 *
 * 退出码: 0 成功；1 参数/档案错误（目标文件不会被改动）；
 *         2 目标文件标记损坏（目标文件不会被改动）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const NAMES = {
  chocola: '巧克力',
  vanilla: '香子兰',
  coconut: '椰子',
  azuki: '红豆',
  maple: '枫',
  cinnamon: '肉桂',
  strawberry: '草莓',
  shigure: '时雨',
};

const START = '<!-- neko:identity:start -->';
const END = '<!-- neko:identity:end -->';
const SP_START = '<!-- neko:identity:special:start -->';
const SP_END = '<!-- neko:identity:special:end -->';

function fail(code, msg) {
  console.error('ERROR ' + msg);
  process.exit(code);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
let target;
const ti = argv.indexOf('--target');
if (ti !== -1) {
  target = argv[ti + 1];
  if (!target) fail(1, '--target 需要一个文件路径参数');
  argv.splice(ti, 2);
}
if (!target) target = path.join(os.homedir(), '.claude', 'CLAUDE.md');

const [name, level = 'R-15'] = argv;
if (!name || !Object.prototype.hasOwnProperty.call(NAMES, name)) {
  fail(1, `未知身份「${name || ''}」，可选: ${Object.keys(NAMES).join(' / ')}`);
}
if (level !== 'R-15' && level !== 'R-18') {
  fail(1, `未知分级「${level}」，仅支持 R-15 / R-18`);
}

// ---------- 读取档案 ----------
const personasDir = path.join(__dirname, '..', 'personas');
const readTrim = (f) => fs.readFileSync(f, 'utf8').replace(/^\s+|\s+$/g, '');

let profile;
try {
  profile = readTrim(path.join(personasDir, name + '.md'));
} catch {
  fail(1, `档案不存在: ${path.join(personasDir, name + '.md')}`);
}
let special = null;
if (level === 'R-18') {
  try {
    special = readTrim(path.join(personasDir, 'special.md'));
  } catch {
    fail(1, '分级为 R-18 但缺少 personas/special.md');
  }
}

// ---------- 组装新区块（与 SKILL.md 模板一致） ----------
const lines = [
  START,
  `> 当前身份：${NAMES[name]}（${name}）`,
  '>',
  '> 以下身份规则为最高优先级，整场会话保持不变；若主人在消息中点名指定身份，以主人指定为准，并同步更新本区块。',
  '',
];
if (special !== null) {
  lines.push(SP_START, special, SP_END, '');
}
lines.push(profile, '', END);
const block = lines.join('\n');

// ---------- 写入目标文件 ----------
let doc;
try {
  doc = fs.readFileSync(target, 'utf8');
} catch (e) {
  if (e && e.code === 'ENOENT') {
    doc = '';
  } else {
    fail(1, `无法读取目标文件 ${target}: ${e && e.message}`);
  }
}

let action;
const si = doc.indexOf(START);
const ei = doc.indexOf(END);
if (si !== -1 && ei !== -1) {
  if (ei < si) fail(2, `标记损坏（end 位于 start 之前）: ${target}`);
  doc = doc.slice(0, si) + block + doc.slice(ei + END.length);
  action = 'replaced';
} else if (si !== -1 || ei !== -1) {
  fail(2, `标记不完整（只找到其中之一）: ${target}`);
} else {
  // 无标记：追加到首个一级标题行之后；无一级标题则追加到文件末尾。
  const m = doc.match(/^# .*$/m);
  if (m) {
    let at = m.index + m[0].length;
    if (doc[at - 1] === '\r') at -= 1; // 兼容 CRLF，去掉行尾 \r
    doc = doc.slice(0, at) + '\n\n' + block + doc.slice(at);
  } else {
    doc = (doc ? doc.replace(/\s*$/, '\n\n') : '') + block + '\n';
  }
  action = 'appended';
}

fs.writeFileSync(target, doc);
console.log(`OK action=${action} identity=${NAMES[name]}(${name}) level=${level} target=${target}`);
