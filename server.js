/**
 * 个人主页的后端 —— 只干一件事：
 * 把浏览器上传的图片送去 Replicate 的 lucataco/remove-bg 去背景，再把结果发回浏览器。
 *
 * 启动：
 *   node server.js          （或 npm start）
 *   然后浏览器打开 http://localhost:3000
 *
 * 需要环境变量 REPLICATE_API_TOKEN，
 * 放在同目录的 .env 里（参考 .env.example），不要硬编码、不要提交到 git。
 */

import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import Replicate from 'replicate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 按文件位置找 .env，而不是按 cwd —— 这样从任何目录启动都能读到
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

// ------------------------------------------------------------------ 配置
const PORT = process.env.PORT || 3000;
// 默认只监听本机；要部署到云主机时设 HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';

// 去背景用的模型。
//
// ⚠️ 这里的版本 hash 不是「为了锁版本」，是**不写就跑不通**。踩坑记录（2026-09-29 实测）：
//
//   SDK 1.4.0 在 lib/predictions.js 里分两条路走：
//     写成 'owner/name:version' → POST /v1/predictions                body {version, input}  ✅ 能跑
//     只写 'owner/name'         → POST /v1/models/{o}/{n}/predictions                        ❌ 稳定 404
//
//   404 的正文是 {"detail":"The requested resource could not be found."}，
//   而同一路径的 GET 是 200、模型也有 latest_version —— 别被误导成「模型被作者停用了」，
//   换上别的模型（851-labs、birefnet…）照样 404，因为问题在端点不在模型。
//   想换模型：去 replicate.com 模型页拿到 hash，照样拼成 owner/name:hash 写在这里。
const MODEL = 'lucataco/remove-bg:95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1';

// 这个模型的入参只有 image 一个字段，别多传，多传会 422。
// 换模型时入参字段名可能不同 —— 改完请跑 npm run check:e2e 真验一次。

const MAX_MB = 10;              // 单张图上限
const TIMEOUT_MS = 120_000;     // 等模型出图的最长时间
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

const HAS_TOKEN = Boolean(process.env.REPLICATE_API_TOKEN);
if (!HAS_TOKEN) {
  console.warn('\n⚠️  没有读到 REPLICATE_API_TOKEN，去背景功能会不可用。');
  console.warn('   1) 复制一份 .env.example 为 .env');
  console.warn('   2) 把 token 填进去（https://replicate.com/account/api-tokens）');
  console.warn('   3) 重新启动 node server.js\n');
}

// useFileOutput:false —— 让 run() 直接返回图片的 URL 字符串，
// 而不是 ReadableStream 对象，服务端处理起来简单些。
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
  useFileOutput: false,
});

// ------------------------------------------------------------------ 重试
// 余额低于 $5 的账号，创建 prediction 会被限速到「每分钟 6 次、并发 1」——
// 也就是连点两下就可能吃一个 429。Replicate 会在错误里给 retry_after，
// 这里照着它自动等一下再试，别把限速当成真错误甩给用户。
const MAX_RETRY = 3;

async function runWithRetry(input) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await replicate.run(MODEL, { input });
    } catch (err) {
      const msg = err?.message || String(err);
      const throttled = /429|throttl|rate limit/i.test(msg);
      if (!throttled || attempt > MAX_RETRY) throw err;

      const m = msg.match(/"retry_after":\s*(\d+)/);
      const waitSec = m ? Number(m[1]) + 1 : 6;   // 拿不到就按 6 秒兜底
      console.log(`… 被限速（第 ${attempt} 次），${waitSec}s 后重试`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }
}

// ------------------------------------------------------------------ 服务
const app = express();

// 静态文件：只显式放行这两个。
// 不用 express.static(__dirname)，否则 .env / server.js / node_modules 都会被下载走。
const SEND = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/avatar.jpg': 'avatar.jpg',
};
for (const [route, file] of Object.entries(SEND)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, file)));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`只支持 PNG / JPG / WebP，收到的是 ${file.mimetype}`));
  },
});

// 前端用它判断后端是否可用 / token 有没有配好
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tokenConfigured: HAS_TOKEN, model: MODEL });
});

app.post('/api/remove-bg', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    // --- 上传这一层的问题
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `图片太大了，请控制在 ${MAX_MB}MB 以内`
        : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: '没有收到图片文件' });
    }
    if (!HAS_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: '服务端没有配置 REPLICATE_API_TOKEN，请先按 .env.example 建好 .env 再重启服务',
      });
    }

    const started = Date.now();
    try {
      // 直接把 Buffer 交给 SDK：它会自动上传到 Replicate 并换成 URL，
      // 不用我们手动转 base64。run() 默认 wait 模式是 block，会一直等到出图。
      const output = await runWithRetry({ image: req.file.buffer });

      // 这个模型输出单张图；写成数组也兼容一下
      const item = Array.isArray(output) ? output[0] : output;
      if (!item) throw new Error('模型没有返回图片');

      // 万一以后 useFileOutput 被改回 true，这里也兜住
      const url = typeof item === 'string' ? item
        : typeof item.url === 'function' ? item.url().toString()
        : String(item);

      // 服务端把结果下载回来转成 data URI 交给前端：
      // 这样「下载 PNG」是同源的，download 属性才会生效（跨域 URL 点下载会直接跳转）。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      let buf;
      try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) throw new Error(`下载结果失败（HTTP ${r.status}）`);
        buf = Buffer.from(await r.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }

      const ms = Date.now() - started;
      console.log(`✓ 去背景成功 ${req.file.size}B -> ${buf.length}B，用时 ${(ms / 1000).toFixed(1)}s`);

      res.json({
        ok: true,
        image: `data:image/png;base64,${buf.toString('base64')}`,
        bytes: buf.length,
        ms,
      });
    } catch (e) {
      const msg = explain(e);
      console.error('✗ 去背景失败:', e?.message || e);
      res.status(500).json({ ok: false, error: msg });
    }
  });
});

// 前端单页，其它路径都当成 404（避免 Express 默认 HTML 报错页混进来）
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: '没有这个接口' });
  res.status(404).send('404 —— 这里只有 / 和 /avatar.jpg');
});

/** 把常见错误翻译成人能看懂的一句话 */
function explain(err) {
  const msg = err?.message || String(err);
  if (/must provide an auth token|401|unauthoriz/i.test(msg)) {
    return 'Replicate 认证失败：检查 .env 里的 REPLICATE_API_TOKEN 是否正确、有没有多余空格';
  }
  if (/402|payment required|insufficient|billing/i.test(msg)) {
    return 'Replicate 账户额度不足，请到 replicate.com/account/billing 看一下';
  }
  if (/429|too many requests|rate limit/i.test(msg)) {
    return '请求太频繁了，Replicate 对低余额账号是每分钟 6 次、同时只能跑 1 个，等十几秒再试';
  }
  // 创建 prediction 返回 404 —— 见上面 MODEL 那段注释：多半是模型没带版本 hash。
  // 匹配得具体一点，别把「下载结果失败（HTTP 404）」也当成模型问题。
  if (/requested resource could not be found|\/predictions failed with status 404/i.test(msg)) {
    return '模型调用失败（404）：检查 server.js 里的 MODEL 是否写成了 owner/name:版本hash 的完整形式';
  }
  if (/NSFW|sensitive/i.test(msg)) {
    return '这张图被模型判定为不适合处理';
  }
  if (err?.name === 'AbortError') {
    return '等模型出图超时了，稍后重试或换张小一点的图';
  }
  return msg;
}

app.listen(PORT, HOST, () => {
  console.log(`\n个人主页已启动:  http://localhost:${PORT}`);
  console.log(`去背景模型:      ${MODEL}   (token ${HAS_TOKEN ? '已配置 ✓' : '未配置 ✗'})`);
  if (HOST === '127.0.0.1') console.log('只监听本机。要让局域网/云主机访问，设 HOST=0.0.0.0');
  console.log('');
});
