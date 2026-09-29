#!/usr/bin/env node
/**
 * 「没后端也能用」这条路的端到端自检 —— 也就是**双击打开 index.html**、
 * 或者传到 GitHub Pages 之后的真实场景。
 *
 * 跑法（在 wang 目录下）：
 *   npm run check:local
 *
 * 会真的在无头 Chrome 里跑一次完整流程：选图 → 点按钮 → 等模型 → 出图 → 下载按钮，
 * 中间会从 CDN 取 transformers.js、从 Hugging Face 取 MODNet 模型（约 6.6MB，每次跑
 * 都会重新下，因为 playwright 每个 context 是独立的缓存）。整轮大约 10 秒。
 *
 * 场景：
 *   A. file:// 打开        —— 必须直接可用（不能出现"要先起后端"这种挡路的提示）
 *   B. http:// + 本地后端  —— 必须自动升级成 Replicate 那条路
 *
 * 和 check-removebg.js 的分工：那个测「后端那条路」，这个测「浏览器本地那条路」。
 * 截图存到 tools/screenshots/。
 */

import { chromium } from 'playwright-core';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'index.html');
const IMG = path.join(ROOT, 'avatar.jpg');
const OUT = path.join(__dirname, 'screenshots');

const PROBE_PORT = Number(process.env.TEST_PORT || 3200);
const FAKE_TOKEN = 'r8_fake_token_for_engine_probe_0000';

const problems = [];
const check = (label, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) problems.push(label + (extra ? ' — ' + extra : ''));
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });

/* ================= A. file://（双击打开）必须能直接用 ================= */
console.log('\n=== A. file://  双击打开 · 浏览器本地模型 ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('[file] pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('[file] console error: ' + m.text()); });

  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.getElementById('removebg').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(900);

  const eng = await page.evaluate(() => ({
    text: document.getElementById('engine').textContent,
    cls: document.getElementById('engine').className,
    dropShown: !document.getElementById('drop').hidden,
    runShown: !document.getElementById('run').hidden,
    oldCardGone: !document.getElementById('needServer'),
  }));
  check('上传区直接就在页面上', eng.dropShown);
  check('按钮没有被藏起来', eng.runShown);
  check('「要先起后端」那张卡已经移除', eng.oldCardGone);
  check('徽标说明走浏览器本地', /浏览器/.test(eng.text) && /local/.test(eng.cls), eng.text);

  await page.setInputFiles('#file', IMG);
  await page.waitForTimeout(400);
  check('选文件后按钮可点', !(await page.isDisabled('#run')));

  await page.click('#run');
  await page.waitForTimeout(1200);
  const during = await page.evaluate(() => ({
    text: document.getElementById('run').textContent,
    disabled: document.getElementById('run').disabled,
    msg: document.getElementById('msg').textContent,
    compareShown: !document.getElementById('compare').hidden,
  }));
  check('处理中按钮文字', during.text.indexOf('处理中') === 0, during.text);
  check('处理中按钮禁用', during.disabled);
  check('对比区已展开', during.compareShown);
  check('提示里说清了在准备模型', /模型/.test(during.msg), during.msg.slice(0, 44) + (during.msg.length > 44 ? '…' : ''));
  await page.screenshot({ path: path.join(OUT, 'local-2-processing.png') });

  console.log('    （等模型下载 + 推理…）');
  const t0 = Date.now();
  // 不要死等固定时长：首次要下 6.6MB，网速不同差别很大。轮询最终状态。
  await page.waitForFunction(() => {
    const img = document.getElementById('imgAfter');
    return img.naturalWidth > 0 || /处理失败/.test(document.getElementById('msg').textContent);
  }, null, { timeout: 300_000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const after = await page.evaluate(() => {
    const img = document.getElementById('imgAfter');
    const dl = document.getElementById('dl');
    return {
      shown: !img.hidden && img.naturalWidth > 0,
      size: img.naturalWidth + 'x' + img.naturalHeight,
      msg: document.getElementById('msg').textContent,
      msgCls: document.getElementById('msg').className,
      dlShown: dl.getAttribute('data-show') === '1',
      dlIsBlob: /^blob:/.test(dl.getAttribute('href') || ''),
      dlName: dl.getAttribute('download'),
      btnText: document.getElementById('run').textContent,
      btnDisabled: document.getElementById('run').disabled,
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  check('真的出图了', after.shown, after.size + '，用时 ' + secs + ' 秒');
  check('成功提示是绿色', /ok/.test(after.msgCls), after.msg);
  check('下载按钮出现', after.dlShown);
  check('下载链接是同源 blob（跨域 URL 的 download 属性是无效的）', after.dlIsBlob);
  check('下载文件名带 -no-bg', after.dlName === 'avatar-no-bg.png', after.dlName);
  check('按钮已复位', after.btnText === '去除背景' && !after.btnDisabled);
  check('没有横向溢出', !after.hScroll);

  await page.screenshot({ path: path.join(OUT, 'local-1-done.png') });
  await page.evaluate(() => document.getElementById('compare').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'local-3-result.png') });
  await ctx.close();
}

/* ============ B. http:// + 真后端在跑 → 必须自动切到 Replicate ============ */
console.log('\n=== B. http:// + 本地后端 · 应自动升级成 Replicate ===');
{
  // 假 token 起服务：验证「探测到后端就切引擎」，同时不真花一次模型调用
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PROBE_PORT), REPLICATE_API_TOKEN: FAKE_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PROBE_PORT}/api/health`)).ok;
    } catch { /* 还没起来 */ }
    if (!up) await new Promise(r => setTimeout(r, 250));
  }
  check('后端起来了', up, up ? '' : log.trim().slice(0, 120));

  if (up) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push('[http] pageerror: ' + e.message));
    await page.goto(`http://127.0.0.1:${PROBE_PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const eng = await page.evaluate(() => ({
      text: document.getElementById('engine').textContent,
      cls: document.getElementById('engine').className,
    }));
    check('徽标切成 Replicate', /Replicate/.test(eng.text) && /server/.test(eng.cls), eng.text);
    await ctx.close();
  }
  srv.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 600));
}

await browser.close();
console.log('\n截图已保存到 tools/screenshots/');
console.log(problems.length ? '\n发现问题:\n- ' + problems.join('\n- ') : '\n全部通过。');
process.exit(problems.length ? 1 : 0);
