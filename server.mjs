// orbiter ローカルサーバ
// - dist/ の静的配信(PCの空)
// - /launch : スマホ用の射出台(カーソルだけ。書いて閉じる)
// - /api/state : 状態ファイルの読み書き(アプリが正)
// - /api/launch(es) : 射出台からの粒のキュー(アプリが帰還時に取り込む)
//
// 使い方: npm run build && npm run serve
// スマホから http://<このPCのIP>:4870/launch

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PORT = 4870;
const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'orbiter-state.json');
const LAUNCH_FILE = path.join(DATA_DIR, 'launches.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const LAUNCH_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
<title>orbiter — 射出台</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { height:100%; }
body { background:#0b0e14; color:#d8dee9; font-family:"Hiragino Sans","Yu Gothic UI",sans-serif;
  display:flex; flex-direction:column; padding:24px 20px; }
#hint { color:#3a4152; font-size:11px; letter-spacing:1px; margin-bottom:16px; }
#pad { flex:1; width:100%; background:none; border:none; outline:none; resize:none;
  color:#d8dee9; font-size:17px; line-height:1.7; font-family:inherit; }
#pad::placeholder { color:#2a3040; }
#go { position:fixed; right:20px; bottom:24px; color:#6b7280; font-size:14px;
  letter-spacing:2px; padding:10px 18px; border:1px solid #2a3040; border-radius:4px;
  background:none; }
#go:active { color:#d8dee9; }
#flash { position:fixed; left:50%; bottom:80px; transform:translateX(-50%);
  color:#3a4152; font-size:12px; letter-spacing:1px; opacity:0; transition:opacity .3s; }
</style>
</head>
<body>
<div id="hint">射出台 — 書いて、打ち上げて、閉じる。粒は帰還後の空に積もる</div>
<textarea id="pad" placeholder="いま考えたこと" autofocus></textarea>
<button id="go">打ち上げ</button>
<div id="flash">打ち上げた</div>
<script>
const pad = document.getElementById('pad');
const go = document.getElementById('go');
const flash = document.getElementById('flash');
async function launch() {
  const text = pad.value.trim();
  if (!text) return;
  try {
    await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    pad.value = '';
    flash.style.opacity = '1';
    setTimeout(() => (flash.style.opacity = '0'), 900);
    pad.focus();
  } catch {
    flash.textContent = '届かなかった。もう一度';
    flash.style.opacity = '1';
    setTimeout(() => { flash.style.opacity = '0'; flash.textContent = '打ち上げた'; }, 1500);
  }
}
go.addEventListener('click', launch);
pad.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); launch(); }
});
</script>
</body>
</html>`;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function send(res, code, content, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  // ---- API ----
  if (url === '/api/state' && req.method === 'GET') {
    if (!fs.existsSync(STATE_FILE)) return send(res, 404, '{}');
    return send(res, 200, fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  if (url === '/api/state' && req.method === 'POST') {
    const data = await body(req);
    try {
      JSON.parse(data); // 壊れたJSONは書かない
      fs.writeFileSync(STATE_FILE, data);
      return send(res, 200, '{"ok":true}');
    } catch {
      return send(res, 400, '{"ok":false}');
    }
  }
  if (url === '/api/launches' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(readJson(LAUNCH_FILE, [])));
  }
  if (url === '/api/launch' && req.method === 'POST') {
    const data = await body(req);
    try {
      const { text } = JSON.parse(data);
      if (typeof text !== 'string' || !text.trim()) return send(res, 400, '{"ok":false}');
      const queue = readJson(LAUNCH_FILE, []);
      queue.push({ id: crypto.randomUUID(), text: text.trim(), createdAtWall: Date.now() });
      fs.writeFileSync(LAUNCH_FILE, JSON.stringify(queue, null, 2));
      return send(res, 200, '{"ok":true}');
    } catch {
      return send(res, 400, '{"ok":false}');
    }
  }
  if (url === '/api/launches/clear' && req.method === 'POST') {
    fs.writeFileSync(LAUNCH_FILE, '[]');
    return send(res, 200, '{"ok":true}');
  }

  // ---- 射出台 ----
  if (url === '/launch') {
    return send(res, 200, LAUNCH_HTML, 'text/html; charset=utf-8');
  }

  // ---- 静的配信(dist) ----
  let file = path.join(DIST, url === '/' ? 'index.html' : url);
  if (!file.startsWith(DIST)) return send(res, 403, 'forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    return send(res, 404, 'まず npm run build を実行してください', 'text/plain; charset=utf-8');
  }
  const ext = path.extname(file);
  send(res, 200, fs.readFileSync(file), MIME[ext] ?? 'application/octet-stream');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`orbiter server:`);
  console.log(`  PC:     http://localhost:${PORT}/`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  スマホ:  http://${net.address}:${PORT}/launch`);
      }
    }
  }
});
