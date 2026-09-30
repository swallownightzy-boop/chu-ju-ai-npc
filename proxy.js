/**
 * 《出局》本地代理 —— 静态服务 + DeepSeek 转发
 *
 * 启动：
 *   node --env-file=.env proxy.js
 *   或者双击 start.cmd
 *
 * 为什么要这个文件：
 *   1. API Key 不能放在前端 HTML 里（任何人打开源码就能看到）
 *   2. 浏览器直连 api.deepseek.com 会遇到 CORS
 *   同源服务一次解决两个问题 —— 页面从 http://localhost:8787/ 加载，
 *   /api/chat 是同源的，浏览器不会拦。
 *
 * 零 npm 依赖，只用 Node 内置模块。
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const UPSTREAM_HOST = 'api.deepseek.com';
const UPSTREAM_PATH = '/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 256 * 1024;

// 这些文件只在服务端用，不下发给浏览器
const SERVER_ONLY = new Set(['proxy.js', 'test.js', 'start.cmd', 'package.json', 'package-lock.json']);

// 只服务这些扩展名，其余一律 404
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

// ============================================================
//  工具
// ============================================================

function sendJSON(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  }, extraHeaders || {}));
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

// ============================================================
//  /api/chat —— 转发到 DeepSeek
// ============================================================

function handleChat(req, res) {
  if (!API_KEY) {
    sendJSON(res, 500, {
      error: { message: 'DEEPSEEK_API_KEY 未设置。请编辑 .env 文件填入你的 key，然后重启服务。' }
    });
    return;
  }

  let size = 0;
  const chunks = [];

  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      sendJSON(res, 413, { error: { message: '请求体过大' } });
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('end', () => {
    if (res.writableEnded) return;

    const payload = Buffer.concat(chunks);
    if (payload.length === 0) {
      sendJSON(res, 400, { error: { message: '空请求体' } });
      return;
    }

    const upstream = https.request({
      hostname: UPSTREAM_HOST,
      path: UPSTREAM_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        // 只有这里出现 key，日志绝不打印它
        'Authorization': 'Bearer ' + API_KEY
      }
    }, (up) => {
      // 原样透传状态码和 body —— 前端的 !response.ok 分支才能继续生效
      res.writeHead(up.statusCode, {
        'Content-Type': up.headers['content-type'] || 'application/json; charset=utf-8'
      });
      up.pipe(res);
    });

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('UPSTREAM_TIMEOUT'));
    });

    upstream.on('error', (err) => {
      if (res.writableEnded) return;
      const msg = err.message === 'UPSTREAM_TIMEOUT'
        ? '上游超时（' + (UPSTREAM_TIMEOUT_MS / 1000) + ' 秒），请重试'
        : '无法连接 DeepSeek：' + err.message;
      console.warn('[proxy] 上游错误:', err.message);
      sendJSON(res, 504, { error: { message: msg } });
    });

    upstream.end(payload);
  });

  req.on('error', () => { /* 客户端断开，忽略 */ });
}

// ============================================================
//  静态文件
// ============================================================

function handleStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    sendText(res, 400, '400 Bad Request');
    return;
  }

  const rel = decoded === '/' ? '/index.html' : decoded;
  const full = path.normalize(path.join(ROOT, rel));

  // 目录穿越防护
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    sendText(res, 403, '403 Forbidden');
    return;
  }

  // 点文件防护 —— 否则 GET /.env 就能把 key 读走，整个代理方案就白做了
  const base = path.basename(full);
  if (base.startsWith('.')) {
    sendText(res, 403, '403 Forbidden');
    return;
  }

  // 服务端文件不下发：它们不含密钥，但浏览器不需要，没有理由暴露
  if (SERVER_ONLY.has(base)) {
    sendText(res, 403, '403 Forbidden');
    return;
  }

  const ext = path.extname(full).toLowerCase();
  if (!MIME[ext]) {
    sendText(res, 404, '404 Not Found');
    return;
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      sendText(res, 404, '404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

// ============================================================
//  服务器
// ============================================================

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  // CORS —— 给 file:// 直接打开页面留一条后路
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      sendJSON(res, 405, { error: { message: '只支持 POST' } });
      return;
    }
    handleChat(req, res);
    return;
  }

  if (pathname === '/health') {
    sendJSON(res, 200, { ok: true, hasKey: Boolean(API_KEY) });
    return;
  }

  handleStatic(req, res, pathname);
});

server.requestTimeout = 60000;
server.headersTimeout = 65000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用。`);
    console.error(`   换个端口：  set PORT=8788 && node --env-file=.env proxy.js\n`);
  } else {
    console.error('\n❌ 服务启动失败:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n  《出局》本地服务已启动');
  console.log('  ─────────────────────────────────');
  console.log(`  打开：  http://localhost:${PORT}/`);
  console.log(`  密钥：  ${API_KEY ? '已加载 ✓' : '未设置 ✗ （对话会失败，静态可正常浏览）'}`);
  if (!API_KEY) {
    console.log('\n  设置方法：把 .env.example 复制成 .env，填入 DEEPSEEK_API_KEY=sk-xxx');
  }
  console.log('\n  按 Ctrl+C 停止\n');
});
