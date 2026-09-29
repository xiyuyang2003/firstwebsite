#!/usr/bin/env node
/**
 * 页面自检脚本 —— 用无头 Chrome 真打开 index.html，检查：
 *   1) 有没有横向溢出、控制台报错、资源 404
 *   2) 头像是否真的加载成功（naturalWidth）
 *   3) 右上角天气接口是否真的请求成功（Open-Meteo 状态码 + 渲染出的文字）
 *   4) 每一屏的实际高度（桌面目标 ≈ 一屏一屏，手机允许滚动）
 *   5) file:// 下第三屏是不是「能用」的状态（上传区在、而不是一张说明卡）
 *   6) 从 1440 到 320 逐档宽度扫一遍，看有没有元素把内容横向裁掉
 * 顺便把桌面 / 手机的截图存到 tools/screenshots/。
 *
 * 注意：这个脚本用 file:// 打开页面，所以第三屏走的是**浏览器本地模型**那条路。
 *       真去抠一张图的端到端验证在 check-local.js（同一条路）和 check-removebg.js（后端那条路）。
 *
 * 跑法（在 wang 目录下）：
 *   npm install       # 只需第一次
 *   node tools/check.js
 *
 * 依赖 playwright-core（已在本项目 devDependencies 里）+ 本机装的 Google Chrome。
 */

import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, 'screenshots');

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'mobile', w: 390, h: 844 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const problems = [];
  const check = (label, cond, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
    if (!cond) problems.push(label + (extra ? ' — ' + extra : ''));
  };

  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();

    page.on('console', m => {
      if (m.type() === 'error') problems.push(`[${v.name}] console error: ${m.text()}`);
      if (m.type() === 'warning') problems.push(`[${v.name}] console warn: ${m.text()}`);
    });
    page.on('pageerror', e => problems.push(`[${v.name}] pageerror: ${e.message}`));
    page.on('requestfailed', r => problems.push(`[${v.name}] 请求失败: ${r.url()}`));

    let wxStatus = null;
    page.on('response', r => {
      if (r.url().includes('open-meteo')) wxStatus = r.status();
    });

    await page.goto(PAGE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000); // 等天气接口回来

    const s = await page.evaluate(() => {
      const wx = document.getElementById('wx');
      const avatar = document.querySelector('.avatar');
      return {
        horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        avatarLoaded: avatar.complete && avatar.naturalWidth > 0,
        avatarSize: avatar.naturalWidth + 'x' + avatar.naturalHeight,
        weather: {
          icon: document.getElementById('wxIco').textContent,
          temp: document.getElementById('wxTemp').textContent,
          city: document.getElementById('wxCity').textContent,
          meta: document.getElementById('wxMeta').textContent,
          tooltip: wx.title,
          stuckLoading: wx.classList.contains('loading'),
        },
        screenHeights: [...document.querySelectorAll('.screen')].map(el => Math.round(el.getBoundingClientRect().height)),
        viewportHeight: window.innerHeight,
        timelineItems: document.querySelectorAll('.item').length,
      };
    });

    console.log(`\n=== ${v.name}  ${v.w}x${v.h} ===`);
    console.log(`  横向溢出      : ${s.horizontalScroll ? '有 ✗' : '无 ✓'}`);
    console.log(`  头像          : ${s.avatarLoaded ? '已加载 ✓ ' + s.avatarSize : '没加载 ✗'}`);
    console.log(`  天气接口      : ${wxStatus ? 'HTTP ' + wxStatus : '没发出请求 ✗'}`);
    console.log(`  天气渲染      : ${s.weather.icon} ${s.weather.temp}°C  ${s.weather.city} ${s.weather.meta}`);
    console.log(`  天气悬停信息  : ${s.weather.tooltip || '(空)'}`);
    console.log(`  停留在加载态  : ${s.weather.stuckLoading ? '是 ✗' : '否 ✓'}`);
    console.log(`  各屏高度      : ${s.screenHeights.join(' / ')}  (视口 ${s.viewportHeight})`);
    console.log(`  时间线节点数  : ${s.timelineItems}`);

    if (s.horizontalScroll) problems.push(`[${v.name}] 有横向溢出`);
    if (!s.avatarLoaded) problems.push(`[${v.name}] 头像没加载出来`);
    if (wxStatus !== 200) problems.push(`[${v.name}] 天气接口状态异常: ${wxStatus}`);
    if (s.weather.stuckLoading) problems.push(`[${v.name}] 天气卡卡在 loading`);

    await page.screenshot({ path: path.join(OUT, `${v.name}-1-about.png`) });
    await page.evaluate(() => document.getElementById('records').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${v.name}-2-records.png`) });
    await page.evaluate(() => document.getElementById('removebg').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${v.name}-3-removebg.png`) });

    // 第三屏在 file:// 下也必须是**能用**的：上传区就在页面上，而不是换成一张
    // 「要先起后端」的说明卡。（没后端时自动走浏览器本地模型，见 check-local.js）
    const fb = await page.evaluate(() => {
      const vis = id => {
        const el = document.getElementById(id);
        return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
      };
      const eng = document.getElementById('engine');
      return {
        drop: vis('drop'),
        run: vis('run'),
        msg: vis('msg'),
        compare: vis('compare'),
        engineText: eng ? eng.textContent : '(没有 #engine 元素)',
        engineCls: eng ? eng.className : '',
        oldCardGone: !document.getElementById('needServer'),
      };
    });
    check('第三屏上传区可用（不再是"用不了"的说明卡）', fb.drop);
    check('按钮就在页面上', fb.run);
    check('提示文字也在', fb.msg);
    check('「要先起后端」那张卡已彻底移除', fb.oldCardGone);
    check('徽标说明走浏览器本地模型', /浏览器/.test(fb.engineText) && /local/.test(fb.engineCls), fb.engineText);
    check('对比区初始隐藏', !fb.compare);

    await ctx.close();
  }

  // ---- 窄屏横向裁切扫描 ----
  // 起因：命令行代码块原来用 <pre> + white-space:pre + overflow-x:auto，在 <=600px 时
  //       内容宽 519px、可视只有 290px，三分之一被滚出视野 —— macOS 不显示滚动条，
  //       看起来就像文字被硬裁掉了。
  // 判据：只查 overflow 不是 visible 的元素（那种才会真把内容藏起来）；
  //       scrollWidth > clientWidth 即内容溢出。
  //       注意 .avatar-ring 那种自转圆环 scrollWidth 会抖动，但它 overflow:visible，
  //       什么都不裁，所以要排除掉，否则会误报。
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    // 第三屏的对比区初始是 hidden，扫不到它的布局；这里强制展开，保证那一块也被量到
    await page.evaluate(() => {
      const c = document.getElementById('compare');
      if (c) { c.hidden = false; }
      const i = document.getElementById('imgAfter');
      if (i && !i.src) { i.src = document.querySelector('.drop-thumb').src || ''; }
    });

    console.log('\n=== 窄屏横向裁切扫描 ===');
    for (const w of [1440, 1024, 820, 768, 720, 668, 600, 520, 480, 430, 390, 375, 360, 320]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        const clipped = [];
        document.querySelectorAll('.screen *').forEach(el => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          if (cs.overflowX === 'visible') return;
          const d = el.scrollWidth - el.clientWidth;
          if (d > 1) clipped.push((el.className || el.tagName) + ' -> +' + d + 'px');
        });
        return {
          clipped,
          pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      check(
        `${String(w).padEnd(5)} 无内容被横向裁切`,
        !r.clipped.length && r.pageOver <= 0,
        r.clipped.length ? r.clipped.join(', ')
          : (r.pageOver > 0 ? '整页横向溢出 ' + r.pageOver + 'px' : '')
      );
    }
    await ctx.close();
  }

  await browser.close();
  console.log('\n截图已保存到 tools/screenshots/');
  console.log(problems.length ? '\n发现的问题:\n' + problems.join('\n') : '\n全部检查通过，没有问题。');
  process.exit(problems.length ? 1 : 0);
})();
