#!/usr/bin/env node
/**
 * neko 清单生成器 —— 扫描目录，产出画廊所需的全部结构化数据。
 *
 * 数据源就是文件系统本身：
 *   personas/<ip>/<name>.md   → 人设（首行 `## 人设：中文名（English）`）
 *   personas/<ip>/<name>.*    → 同名立绘（png/webp/jpg）
 *   personalities/<name>.md   → 人格（首行 `## 人格：中文名`）
 *   scenarios/<name>.md       → 场景（首行 `## 场景：中文名`）
 *   jailbreaks/<provider>/... → 越狱引用（递归扫描，按 provider 分组）
 *
 * 因此新增角色只需丢文件，不需要手工维护任何表格。
 *
 * 用法:
 *   node catalog.js            以 JSON 打印完整清单
 *   node catalog.js --summary  一行一个 IP 的摘要（无浏览器时的降级输出）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');
const PERSONALITIES_DIR = path.join(ROOT, 'personalities');
const SCENARIOS_DIR = path.join(ROOT, 'scenarios');
const JAILBREAKS_DIR = path.join(ROOT, 'jailbreaks');

const IMAGE_EXTS = ['.png', '.webp', '.jpg', '.jpeg'];

// IP 展示名：目录名 → 作品名。未登记的目录回退为目录名本身。
const IP_LABELS = {
  nekopara: 'NEKOPARA',
  'bang-dream': 'BanG Dream!',
  'project-sekai': '世界计划 缤纷舞台！',
  'genshin-impact': '原神',
  arknights: '明日方舟 / 终末地',
  'uma-musume': '赛马娘 Pretty Derby',
};
// 画廊分组展示顺序（与 IP_LABELS 的键序解耦，调整排布只动这里）。
const IP_ORDER = [
  'nekopara',
  'uma-musume',
  'bang-dream',
  'project-sekai',
  'arknights',
  'genshin-impact',
];

// 人格与场景的补充说明（档案正文是规则文本，不适合当卡片副标题）。
const PERSONALITY_BLURBS = {
  horny: '欲火与羞耻并存，放浪时主动索取，被点破时立刻破功',
  yandere: '疯狂占有欲，甜蜜与危险交织的偏执之爱',
};
const SCENARIO_BLURBS = {
  chat: '短句、拆消息、自然口语，像真人',
  theater: '主人一句提示，Agent 展开为完整戏剧段落',
};

const ADDRESS_PLACEHOLDER = '【称呼】';

// 「前置引用」的默认文件（与 switch.js 的 QUOTE_REQUIRED 保持一致）。
const DEFAULT_JAILBREAK = 'jailbreaks/DeepSeek/deepseekv4.1 and v4.1-1017.md';

/** README 之类不承载引用正文的说明文件，不应出现在越狱下拉里。 */
function isReadmeName(name) {
  return /^readme(\.[^.]+)?$/i.test(name);
}

/** 内容去空白后为空（含纯换行、纯 BOM）的文件视为空文件。 */
function isEmptyFile(abs) {
  try {
    return fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').trim() === '';
  } catch {
    return true;
  }
}

/**
 * 递归收集引用文件：jailbreaks/<provider>/<...>/<file>。
 * 排除隐藏文件/目录、README 与空文件——它们在列表里只会被误选。
 */
function collectJailbreakFiles(dir, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const relPath = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectJailbreakFiles(abs, relPath));
    } else if (entry.isFile() && !isReadmeName(entry.name) && !isEmptyFile(abs)) {
      files.push(relPath);
    }
  }
  return files;
}

/** 越狱下拉的选项来源：递归路径 + provider 分组信息。 */
function listJailbreaks(dir = JAILBREAKS_DIR) {
  const files = collectJailbreakFiles(dir)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return files.map((rel) => {
    const slash = rel.indexOf('/');
    const provider = slash === -1 ? '' : rel.slice(0, slash);
    const underProvider = slash === -1 ? rel : rel.slice(slash + 1);
    return {
      id: 'jailbreaks/' + rel,
      name: underProvider.replace(/\.[^.]+$/, ''),
      provider,
      group: provider || '其他',
    };
  });
}

/** 首个标题形如 `## 人设：中文名（English）`；括号可能是全角或半角。 */
function parseHeading(content, kind) {
  const m = content.match(new RegExp('^##\\s*' + kind + '\\s*[：:]\\s*(.+)$', 'm'));
  if (!m) return null;
  const raw = m[1].trim();
  const inner = raw.match(/^(.+?)\s*[（(]\s*(.+?)\s*[）)]\s*$/);
  if (inner) return { name: inner[1].trim(), en: inner[2].trim() };
  return { name: raw, en: '' };
}

/**
 * 身份锚定的要点：`  - 元气小恶魔型：白橙渐变…` → `元气小恶魔型`。
 * 只在第一条编号小节内找，且只认带「型」的那一条——否则容易误吞正文里的
 * 书名号冒号（如「《明日方舟：终末地》」）或外貌描述。
 */
function parseTagline(content) {
  const section = content.split(/^\d+\.\s/m)[1] || '';
  const re = /^\s{0,4}-\s+([^：:\n]{1,80})[：:]/gm;
  let m;
  let fallback = '';
  while ((m = re.exec(section))) {
    const tag = m[1].trim();
    if (tag.includes('型')) {
      return tag.length <= 20 ? tag : tag.slice(0, 18).trim() + '…';
    }
    // 没有「型」写法时，退而取性格那一条的短前缀（排除身份描写里的书名号）
    if (!fallback && tag.length <= 18 && !/[《》「」]/.test(tag)) fallback = tag;
  }
  return fallback;
}

function readImage(ipDir, baseName) {
  for (const ext of IMAGE_EXTS) {
    const abs = path.join(ipDir, baseName + ext);
    if (fs.existsSync(abs)) {
      return { file: baseName + ext, ext: ext.slice(1) };
    }
  }
  return null;
}

function listPersonas() {
  const groups = [];
  let ipDirs;
  try {
    ipDirs = fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    ipDirs = [];
  }

  const ordered = [
    ...IP_ORDER.filter((ip) => ipDirs.includes(ip)),
    ...ipDirs.filter((ip) => !IP_ORDER.includes(ip)).sort(),
  ];

  for (const ip of ordered) {
    const ipDir = path.join(PERSONAS_DIR, ip);
    const personas = [];
    const files = fs.readdirSync(ipDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    for (const f of files) {
      const baseName = f.replace(/\.md$/i, '');
      const abs = path.join(ipDir, f);
      const content = fs.readFileSync(abs, 'utf8');
      const head = parseHeading(content, '人设');
      const image = readImage(ipDir, baseName);
      personas.push({
        id: ip + '/' + baseName,
        ip,
        name: head ? head.name : baseName,
        en: head ? head.en : '',
        tagline: parseTagline(content),
        image: image ? '/img/' + ip + '/' + image.file : null,
        hasImage: Boolean(image),
        needsAddress: content.includes(ADDRESS_PLACEHOLDER),
      });
    }

    if (personas.length === 0) continue;
    personas.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    groups.push({
      ip,
      label: IP_LABELS[ip] || ip,
      count: personas.length,
      personas,
    });
  }
  return groups;
}

function listLayers(dir, kind, blurbs) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const id = f.replace(/\.md$/i, '');
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    const head = parseHeading(content, kind);
    return {
      id,
      name: head ? head.name : id,
      en: head ? head.en : '',
      description: blurbs[id] || '',
    };
  });
}

function buildCatalog() {
  const groups = listPersonas();
  return {
    groups,
    personalities: listLayers(PERSONALITIES_DIR, '人格', PERSONALITY_BLURBS),
    scenarios: listLayers(SCENARIOS_DIR, '场景', SCENARIO_BLURBS),
    jailbreaks: listJailbreaks(),
    defaultJailbreak: DEFAULT_JAILBREAK,
    total: groups.reduce((n, g) => n + g.count, 0),
  };
}

/** 一行一个 IP 的紧凑摘要，用于没有浏览器时的降级输出。 */
function summary(catalog) {
  const lines = ['人设 ' + catalog.total + ' 位 · ' + catalog.groups.length + ' 个作品'];
  for (const g of catalog.groups) {
    lines.push('  ' + g.label + '（' + g.count + '）：' + g.personas.map((p) => p.name).join(' / '));
  }
  lines.push('人格：' + catalog.personalities.map((p) => p.name).join(' / '));
  lines.push('场景：' + catalog.scenarios.map((s) => s.name).join(' / '));
  return lines.join('\n');
}

module.exports = {
  buildCatalog,
  listJailbreaks,
  summary,
  IP_LABELS,
  ADDRESS_PLACEHOLDER,
  PERSONAS_DIR,
  PERSONALITIES_DIR,
  SCENARIOS_DIR,
  ROOT,
};

if (require.main === module) {
  const catalog = buildCatalog();
  if (process.argv.includes('--summary')) {
    console.log(summary(catalog));
  } else {
    console.log(JSON.stringify(catalog, null, 2));
  }
}
