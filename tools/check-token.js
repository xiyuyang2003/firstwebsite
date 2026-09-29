#!/usr/bin/env node
/**
 * Token 自检 —— 不启动服务、不消耗额度，只回答一个问题：
 *   「.env 里这串 REPLICATE_API_TOKEN 到底能不能过认证？」
 *
 * 跑法（在 wang 目录下）：
 *   npm run check:token
 *
 * 会顺便把常见的复制粘贴毛病指出来：多带了空格、少了字符、前后有换行、
 * 还是压根没配置。认证通过时打印账号名。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let failed = false;
const ok = (label, extra) => console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`);
const bad = (label, extra) => {
  console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`);
  failed = true;
};

/* ---------- 1. .env 在不在、读得到吗 ---------- */
const envPath = path.join(ROOT, '.env');
console.log(`\n=== 读 ${path.relative(ROOT, envPath) || '.env'} ===`);
if (!fs.existsSync(envPath)) {
  console.log('  ✗ 这个文件不存在');
  console.log('    先复制模板：cp .env.example .env，然后把 token 填进去');
  process.exit(1);
}
ok('.env 存在');

const parsed = dotenv.parse(fs.readFileSync(envPath));
const raw = parsed.REPLICATE_API_TOKEN || '';

/* ---------- 2. 值本身长什么样（不打印全文） ---------- */
const masked = raw.length > 12 ? raw.slice(0, 10) + '…' + raw.slice(-4) : '(太短，不显示)';
console.log('\n=== token 本身 ===');
console.log(`  值            : ${masked}`);
console.log(`  长度          : ${raw.length}`);

if (!raw) {
  bad('没有读到 REPLICATE_API_TOKEN');
  process.exit(1);
}
if (raw.includes('在这里粘贴')) {
  bad('还是模板里的占位符，没换成真 token');
  process.exit(1);
}
ok('读到了一个非空的值');

if (/\s/.test(raw)) {
  bad('值里含空白字符（空格 / 换行 / Tab）—— 大概率是复制时带进来的', JSON.stringify(raw.replace(/[^\s]/g, '.')));
} else {
  ok('值里没有空白字符');
}
if (!raw.startsWith('r8_')) {
  bad('不是以 r8_ 开头 —— Replicate 的 token 都以 r8_ 开头');
} else {
  ok('以 r8_ 开头');
}

const token = raw.replace(/\s+/g, '');

/* ---------- 3. 真发一次认证请求 ---------- */
console.log('\n=== 向 Replicate 验证（GET /v1/account）===');
let res, body;
try {
  res = await fetch('https://api.replicate.com/v1/account', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  body = await res.json().catch(() => ({}));
} catch (err) {
  console.log(`  ✗ 请求没发出去：${err.message}`);
  console.log('    网络问题（本机代理 / 断网），不是 token 的问题，稍后再试一次。');
  process.exit(1);
}

console.log(`  HTTP ${res.status}`);

if (res.status === 200) {
  ok('认证通过');
  const who = [body.username, body.name].filter(Boolean).join(' / ');
  console.log(`  账号          : ${who || '(接口没返回用户名)'}`);
  console.log(`  类型          : ${body.type || '—'}`);
  console.log('\n可以了，接下来：npm start，然后打开 http://localhost:3000\n');
  process.exit(0);
}

/* ---------- 4. 没通过，按状态码给结论 ---------- */
if (res.status === 401) {
  bad('认证失败，Replicate 认为这串 token 无效', body.detail ? '— ' + body.detail : '');
  if (/\s/.test(raw)) {
    console.log('    值里有空白字符，去掉后仍失败的话，说明是 token 本身的问题。');
  }
  if (token.length !== 40) {
    console.log(`    你这串去掉空白后有 ${token.length} 个字符，正常是 40 个。`);
    console.log('    少了 / 多了字符 → 很可能是复制时被截断了。');
  } else {
    console.log('    长度看着正常（40），但仍然被拒 → 可能已经在 Replicate 后台被删掉或轮换过了。');
  }
  console.log('    重新复制一整串：https://replicate.com/account/api-tokens');
} else if (res.status === 403) {
  bad('token 有效但没权限访问这个接口', body.detail || '');
} else {
  bad(`收到了意外的状态码 ${res.status}`, JSON.stringify(body).slice(0, 200));
}

console.log('');
process.exit(failed ? 1 : 0);
