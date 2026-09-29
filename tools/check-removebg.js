#!/usr/bin/env node
/**
 * 第三屏「一键去除图片背景」的交互自检 —— 走后端那条路（Replicate）。
 *
 * 跑法（在 wang 目录下）：
 *   node tools/check-removebg.js
 *
 * 后端不用自己起：脚本自己拉一个 server.js 跑完关掉，而且在独立端口 3100 上、
 * **固定用一个假 token** —— 这样：
 *   · 不会复用你可能已经开着的真服务，不会意外烧掉一次真实的模型调用
 *   · 结果确定（必然是认证失败），断言不会时灵时不灵
 * 想验真实出图效果请跑 npm run check:e2e（那个才是真花钱的）。
 *
 * 想验「双击打开 / 纯静态托管」那条浏览器本地模型的路，跑 npm run check:local。
 *
 * 分两种场景：
 *   A. 真打后端（假 token）—— 验证「处理中…」状态、以及失败时的提示
 *   B. mock 成功响应     —— 验证结果图、棋盘格、下载按钮的渲染
 *
 * 截图存到 tools/screenshots/。
 */

import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const TEST_PORT = Number(process.env.TEST_PORT || 3100);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${TEST_PORT}`;
const TEST_IMG = path.join(ROOT, 'avatar.jpg');
const FAKE_TOKEN = 'r8_fake_token_for_local_test_0000';

/**
 * 自己拉一个后端来用，跑完关掉。
 * 独立端口 + 假 token，避免命中你可能开着的真服务（那会真花一次模型调用）。
 * 必须同进程树里起：沙箱里不同进程的 localhost 是隔离的，外部 curl 连不上。
 */
async function ensureServer() {
  const alive = async () => {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };

  const existing = await alive();
  if (existing) {
    // 只在端口被占时才会走到这里；提醒一下正在用的是谁的 token
    console.log(`（${BASE} 上已经有服务了，先关掉它再跑，否则可能会用真的 token 花钱）`);
    throw new Error(`端口 ${TEST_PORT} 被占用，请先停掉那个服务，或用 TEST_PORT=xxxx node tools/check-removebg.js 换一个端口`);
  }

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(TEST_PORT), REPLICATE_API_TOKEN: FAKE_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    const h = await alive();
    if (h) {
      console.log(`（已自动拉起 server.js，端口 ${TEST_PORT}，用假 token）`);
      return { health: h, stop: () => { try { srv.kill('SIGTERM'); } catch { /* 已经没了 */ } } };
    }
  }
  throw new Error('服务起不来：\n' + log.trim());
}

// 造一张带透明背景的假结果图（圆形抠图），让棋盘格能看出来
function makeMockResult() {
  const png = path.join(OUT, '_mock-result.png');
  const script = `
from PIL import Image, ImageDraw
im = Image.open(${JSON.stringify(TEST_IMG)}).convert('RGBA')
s = 480
mask = Image.new('L', (s, s), 0)
ImageDraw.Draw(mask).ellipse((30, 30, s - 30, s - 30), fill=255)
out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
out.paste(im.resize((s, s)), (0, 0), mask)
out.save(${JSON.stringify(png)})
`;
  execFileSync('/usr/bin/python3', ['-c', script]);
  const b64 = fs.readFileSync(png).toString('base64');
  fs.unlinkSync(png);
  return 'data:image/png;base64,' + b64;
}

const problems = [];
const check = (label, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) problems.push(label + (extra ? ' — ' + extra : ''));
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  let server;
  try {
    server = await ensureServer();
  } catch (e) {
    console.log('\n' + e.message);
    process.exit(1);
  }
  console.log(`后端状态: ${JSON.stringify(server.health)}`);
  const stopServer = server.stop;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const mockPng = makeMockResult();

  /* ---------------- A. 真打后端 ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));

    // 给接口加 1.2 秒延迟，才有稳定的窗口观察「处理中…」这个中间态
    // （不加延迟的话真服务可能几十毫秒就返回了，抓不到）
    await page.route('**/api/remove-bg', async route => {
      await new Promise(r => setTimeout(r, 1200));
      await route.continue();
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.getElementById('removebg').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(600);

    console.log('\n[A] 真打后端 —— 初始状态');
    check('检测到后端后徽标写着 Replicate', /Replicate/.test(await page.textContent('#engine')),
      await page.textContent('#engine'));
    check('按钮初始是禁用的', await page.isDisabled('#run'));
    check('对比区初始隐藏', await page.isHidden('#compare'));
    check('结果图初始隐藏', await page.isHidden('#imgAfter'));
    check('缩略图初始隐藏', await page.isHidden('#dropThumb'));
    check('「换一张」初始隐藏', await page.isHidden('#dropClear'));

    console.log('[A] 选中文件后');
    await page.setInputFiles('#file', TEST_IMG);
    await page.waitForTimeout(500);
    check('出现缩略图', await page.isVisible('#dropThumb'));
    check('按钮变为可用', !(await page.isDisabled('#run')));
    check('上传区收起空闲提示', await page.isHidden('#dropIdle'));
    check('出现「换一张」', await page.isVisible('#dropClear'));

    console.log('[A] 点「去除背景」');
    await page.click('#run');            // 必须 await，否则下面读到的还是点击前的状态
    await page.waitForTimeout(400);      // 落在上面那 1.2s 的延迟窗口里
    const during = await page.evaluate(() => ({
      text: document.getElementById('run').textContent,
      disabled: document.getElementById('run').disabled,
      busy: document.getElementById('run').classList.contains('busy'),
      msg: document.getElementById('msg').textContent,
      compareShown: !document.getElementById('compare').hidden,
      phText: document.getElementById('afterPh').textContent,
    }));
    check('处理中按钮文字', during.text.indexOf('处理中') === 0, during.text);
    check('处理中按钮禁用', during.disabled);
    check('处理中有 busy 类', during.busy);
    check('对比区已展开', during.compareShown);
    check('结果位显示处理中占位', during.phText.indexOf('模型处理中') === 0, during.phText);
    check('提示文字有进度说明', during.msg.indexOf('等待模型处理') >= 0, during.msg.slice(0, 24) + '…');
    await page.screenshot({ path: path.join(OUT, 'removebg-2-processing.png') });

    // 等后端回来。**不要死等固定时长**：真模型跑一次要好几秒，加上前面那 1.2s 的
    // 路由延迟，固定 4 秒就会误报「按钮没复位」。改成轮询按钮文字。
    const t0 = Date.now();
    await page.waitForFunction(
      () => document.getElementById('run').textContent === '去除背景',
      null,
      { timeout: 90_000 }
    );
    console.log(`    （等后端返回：${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);

    const after = await page.evaluate(() => ({
      text: document.getElementById('run').textContent,
      disabled: document.getElementById('run').disabled,
      msg: document.getElementById('msg').textContent,
      msgClass: document.getElementById('msg').className,
      dlShown: document.getElementById('dl').getAttribute('data-show') === '1',
      compareShown: !document.getElementById('compare').hidden,
    }));
    check('按钮恢复成「去除背景」', after.text === '去除背景', after.text);
    check('按钮恢复可用', !after.disabled);
    check('对比区是展开的（没有缩回去）', after.compareShown);

    // A 场景用的是脚本自己起的**假 token**，所以这里必然是认证失败 ——
    // 断言可以直接写死，不会出现"这次成功下次失败"的抖动。
    // 真实出图效果交给 npm run check:e2e（那个才真花一次模型调用）。
    check('失败时有红色提示', /err/.test(after.msgClass), after.msg);
    check('失败时不显示下载按钮', !after.dlShown);
    check('失败时结果图没显示', await page.isHidden('#imgAfter'));
    check('失败原因指向 token 配置', /认证失败/.test(after.msg));
    await page.screenshot({ path: path.join(OUT, 'removebg-3-error.png') });

    await ctx.close();
  }

  /* ---------------- B. mock 成功 ---------------- */
  for (const v of [{ name: 'desktop', w: 1440, h: 900 }, { name: 'mobile', w: 390, h: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));

    await page.route('**/api/remove-bg', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, image: mockPng, bytes: 12345, ms: 1234 }),
      })
    );

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.getElementById('removebg').scrollIntoView({ block: 'start' }));
    await page.setInputFiles('#file', TEST_IMG);
    await page.waitForTimeout(300);
    await page.click('#run');
    await page.waitForTimeout(1200);

    console.log(`\n[B:${v.name}] mock 成功`);
    const s = await page.evaluate(() => {
      const after = document.getElementById('imgAfter');
      const dl = document.getElementById('dl');
      return {
        afterVisible: !after.hidden && after.naturalWidth > 0,
        afterSrc: after.src.slice(0, 22),
        phHidden: document.getElementById('afterPh').hidden,
        dlShown: dl.getAttribute('data-show') === '1',
        dlHref: dl.getAttribute('href') ? dl.getAttribute('href').slice(0, 22) : null,
        dlName: dl.getAttribute('download'),
        msg: document.getElementById('msg').textContent,
        msgClass: document.getElementById('msg').className,
        btnText: document.getElementById('run').textContent,
        hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        screenH: Math.round(document.getElementById('removebg').getBoundingClientRect().height),
      };
    });
    check('结果图渲染出来了', s.afterVisible, s.afterSrc + '…');
    check('占位文字已隐藏', s.phHidden);
    check('下载按钮出现', s.dlShown);
    check('下载链接是 data URI', (s.dlHref || '').indexOf('data:image/png') === 0);
    check('下载文件名带 -no-bg', /-no-bg\.png$/.test(s.dlName || ''), s.dlName);
    check('成功提示是绿色', s.msgClass.indexOf('ok') >= 0, s.msg);
    check('按钮已复位', s.btnText === '去除背景');
    check('没有横向溢出', !s.hScroll);
    console.log(`    第三屏高度 ${s.screenH}（视口 ${v.h}）`);

    await page.screenshot({ path: path.join(OUT, `removebg-1-${v.name}-done.png`) });
    await ctx.close();
  }

  await browser.close();
  stopServer();
  console.log('\n' + (problems.length ? '发现问题:\n- ' + problems.join('\n- ') : '全部通过。'));
  process.exit(problems.length ? 1 : 0);
})();
