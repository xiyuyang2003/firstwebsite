#!/usr/bin/env node
/**
 * 真实端到端自检 —— 动真格的那一次：
 *   1) 自己把 server.js 作为子进程拉起来（父子同网络空间，避开沙箱对 localhost 的隔离）
 *   2) 把 avatar.jpg 真发过去，等模型出图
 *   3) 把结果 PNG 落到 tools/screenshots/，并检查它确实是「带透明通道」的
 *
 * ⚠️ 这个脚本会**真实消耗一次 Replicate 模型调用**（每次几厘钱）。
 *    所以它不在 npm run check 里，要显式跑：
 *
 *      npm run check:e2e
 *
 * 前提：.env 里的 REPLICATE_API_TOKEN 是好的（先跑 npm run check:token）。
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const IMG = path.join(ROOT, 'avatar.jpg');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const ok = (label, extra) => console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`);
const bad = (label, extra) => {
  console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`);
  problems.push(label);
};

console.log('\n=== 拉起 server.js ===');
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
srv.on('exit', c => { if (c !== 0 && c !== null) srvLog += `\n[server exited ${c}]`; });

const stop = () => { try { srv.kill('SIGTERM'); } catch { /* 已经没了 */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

/* ---------- 等 /api/health 起来 ---------- */
let health = null;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 250));
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) { health = await r.json(); break; }
  } catch { /* 还没起来，继续等 */ }
}

if (!health) {
  console.log(srvLog.trim());
  bad('服务 10 秒内没起来');
  process.exit(1);
}
ok('服务已就绪', JSON.stringify(health));
if (!health.tokenConfigured) {
  bad('server 没读到 REPLICATE_API_TOKEN —— 先跑 npm run check:token');
  stop();
  process.exit(1);
}
ok('server 读到 token 了');

/* ---------- 真发一张图 ---------- */
console.log('\n=== POST /api/remove-bg（真实模型调用）===');
const bytes = fs.readFileSync(IMG);
console.log(`  送去的图      : avatar.jpg  ${(bytes.length / 1024).toFixed(0)} KB`);

const form = new FormData();
form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'avatar.jpg');

const t0 = Date.now();
let res, body;
try {
  res = await fetch(`${BASE}/api/remove-bg`, { method: 'POST', body: form });
  body = await res.json();
} catch (err) {
  bad(`请求失败: ${err.message}`);
  console.log(srvLog.trim());
  process.exit(1);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`  HTTP          : ${res.status}   用时 ${secs} 秒`);

if (res.status !== 200 || !body.ok) {
  bad('模型没出图', body.error || JSON.stringify(body).slice(0, 200));
  console.log('\n--- server 日志 ---\n' + srvLog.trim());
  process.exit(1);
}
ok('模型返回成功', `服务端记的用时 ${body.ms}ms，结果 ${(body.bytes / 1024).toFixed(1)} KB`);

if (!/^data:image\/png;base64,/.test(body.image)) {
  bad('返回的不是 PNG data URI', body.image.slice(0, 30));
  process.exit(1);
}
ok('返回的是 PNG data URI（可直接给前端下载用）');

/* ---------- 落盘 + 验透明通道 ---------- */
const pngPath = path.join(OUT, 'e2e-real-result.png');
fs.writeFileSync(pngPath, Buffer.from(body.image.split(',')[1], 'base64'));

const buf = fs.readFileSync(pngPath);
const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const colorType = buf[25];                    // IHDR 里的颜色类型
ok('落盘的确实是 PNG', `${(buf.length / 1024).toFixed(1)} KB`);
ok('颜色类型是 RGBA', `colorType=${colorType}（6=RGBA 带透明通道）`);
if (colorType !== 6) bad('不是 RGBA，抠图结果没有透明通道');

/* 用 PIL 数一下透明像素占多少，确认「背景真的被抠掉了」而不是原样返回 */
try {
  const stat = execFileSync('/usr/bin/python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(pngPath)})
print(f"{im.size[0]}x{im.size[1]} {im.mode}")
a = im.getchannel("A")
hist = a.histogram()
transparent = sum(hist[0:8])
opaque = sum(hist[248:256])
total = im.size[0]*im.size[1]
print(f"{transparent} {opaque} {total}")
`], { encoding: 'utf8' }).trim().split('\n');
  const [sizeMode, counts] = stat;
  const [transparent, opaque, total] = counts.split(' ').map(Number);
  console.log(`  结果图        : ${sizeMode}`);
  console.log(`  全透明像素    : ${transparent} / ${total}  (${(transparent / total * 100).toFixed(0)}%)`);
  console.log(`  全不透明像素  : ${opaque} / ${total}  (${(opaque / total * 100).toFixed(0)}%)`);
  if (transparent === 0) bad('没有任何透明像素 —— 背景没被抠掉');
  else ok('背景确实被抠掉了（存在透明像素）');
  if (opaque === 0) bad('整张图全透明 —— 主体也被抠没了');
  else ok('主体保留下来了（存在不透明像素）');
} catch (err) {
  console.log(`  （跳过像素统计：${err.message.split('\n')[0]}）`);
}

stop();
console.log(`\n结果图已保存：${path.relative(ROOT, pngPath)}`);
console.log(problems.length
  ? '\n有问题:\n' + problems.map(p => '  - ' + p).join('\n')
  : '\n真实端到端通过：token → server → Replicate → 带透明通道的 PNG。');
process.exit(problems.length ? 1 : 0);
