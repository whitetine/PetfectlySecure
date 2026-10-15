// BizForm -> Vital CRM bridge  (階段 1：接收並記錄 Webhook，並測試 CRM 連線)
// 不需要安裝任何套件，Node 18 以上即可。
const http = require('http');

const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';   // 自訂一組長密碼，網址要帶 ?token=
const CRM_STORE = process.env.CRM_STORE || '';           // CRM 店點識別碼 (32 碼)
const CRM_API_KEY = process.env.CRM_API_KEY || '';       // CRM 管理 > 服務資訊 產生的 ApiKey

const recent = []; // 只放在記憶體，最近 20 筆；重啟就清空

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
};
const authed = (url) => WEBHOOK_TOKEN && url.searchParams.get('token') === WEBHOOK_TOKEN;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // 1) 健康檢查（Render 用）
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { ok: true });

  // 2) 測試 CRM ApiKey 是否可用：GET /check-crm?token=...
  if (req.method === 'GET' && url.pathname === '/check-crm') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    if (!CRM_STORE || !CRM_API_KEY) return send(res, 500, { error: 'CRM_STORE / CRM_API_KEY 未設定' });
    const r = await fetch(`https://crm-storeapi.vitalyun.com/${CRM_STORE}/api/apikey`, {
      headers: { Authorization: `ApiKey ${CRM_API_KEY}` },
    });
    return send(res, 200, { crmStatus: r.status, meaning: r.status === 200 ? 'ApiKey 合法' : 'ApiKey 不合法或店點識別碼錯誤' });
  }

  // 3) 接收 BizForm Webhook：POST /webhook/bizform?token=...
  if (req.method === 'POST' && url.pathname === '/webhook/bizform') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body; try { body = JSON.parse(raw); } catch { body = raw; }
    recent.unshift({ at: new Date().toISOString(), headers: req.headers, body });
    recent.length = Math.min(recent.length, 20);
    console.log('[webhook] received', new Date().toISOString(), 'bytes=', raw.length);
    // TODO(階段 2)：在這裡依內容 查/建客戶 → 建立消費
    return send(res, 200, { received: true });
  }

  // 4) 查看最近收到的內容：GET /debug/last?token=...（含個資，測試完請拿掉）
  if (req.method === 'GET' && url.pathname === '/debug/last') {
    if (!authed(url)) return send(res, 401, { error: 'bad token' });
    return send(res, 200, recent);
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log('listening on', PORT));
