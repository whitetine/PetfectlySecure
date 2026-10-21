// assistant.js — 老闆的 AI 助手（自由問答）
// 老闆問的不是「篩選顧客／發券／核銷／新增商品」時，交給這裡用 Ollama 回答。
// 回答依據 guide.md（店家系統使用說明，可以直接改這個檔案，不用動程式）。
// 原則：不把任何顧客資料送給 LLM；只回答操作問題與一般經營問題。
const fs = require('fs');
const path = require('path');

const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');   // 例如 https://xxxx.ngrok-free.dev
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const SHOP_NAME = process.env.SHOP_NAME || '寵此安心';
const MEMORY_TTL = 15 * 60 * 1000;   // 記住最近 15 分鐘的對話，讓老闆可以追問
const MEMORY_TURNS = 6;              // 最多記 6 則（3 問 3 答）
const MAX_QUESTION = 500;

let guide = '';
try { guide = fs.readFileSync(path.join(__dirname, 'guide.md'), 'utf8'); }
catch { console.warn('[assistant] 找不到 guide.md，AI 只能用一般知識回答'); }

const FALLBACK = [
  '🤖 AI 助手暫時連不上（店裡跑 AI 的電腦可能沒開，或 ngrok 沒啟動）。',
  '',
  '你還是可以直接輸入這些指令：',
  '• 新增商品',
  '• 找出半年沒來的狗狗（篩選顧客、發優惠券）',
  '• 核銷 PS-XXXXX',
].join('\n');

const memory = new Map();   // userId -> { at, turns: [{role, content}] }
function history(userId) {
  const m = memory.get(userId);
  if (!m || Date.now() - m.at > MEMORY_TTL) { memory.delete(userId); return []; }
  return m.turns;
}
function remember(userId, q, a) {
  const turns = [...history(userId), { role: 'user', content: q }, { role: 'assistant', content: a }].slice(-MEMORY_TURNS);
  memory.set(userId, { at: Date.now(), turns });
  if (memory.size > 200) for (const [k, v] of memory) if (Date.now() - v.at > MEMORY_TTL) memory.delete(k);
}

function systemPrompt(context) {
  return [
    `你是「${SHOP_NAME}」寵物美容店老闆的 LINE 助手，用繁體中文回答。`,
    '你的工作：',
    '1. 回答老闆關於這套 LINE 系統怎麼操作的問題，依據下面的【使用說明】。',
    '2. 也可以回答一般的經營、行銷、文案、寵物美容相關問題。',
    '',
    '規則：',
    '- 回答要短，適合在手機 LINE 上看：最多 250 字，可以用「1. 2. 3.」或「•」條列，不要用 Markdown 的 # 或 ** 符號。',
    '- 說明書沒寫的系統功能，不要自己編造；直接說目前系統沒有這個功能，或請老闆聯絡負責設定系統的人。',
    '- 老闆想做某件事時，告訴他要輸入哪一句指令（用「」框起來），不要假裝你已經幫他做了。',
    '- 你看不到任何顧客資料、訂單或營收。被問到具體數字時，說明要用哪個指令查詢。',
    '- 老闆帳號不能使用預約、價目表、查詢紀錄、取消預約、意見回饋這些顧客功能，不要教老闆用這些。',
    '- 綁定碼由系統自動處理，老闆直接把綁定碼傳到 LINE 就會完成綁定，不需要再到管理頁輸入。',
    '- 不要提到你是哪個 AI 模型，也不要輸出思考過程。',
    context ? `\n老闆目前正在操作：${context}。如果他的問題跟這個步驟有關，回答完再提醒他接下來要做什麼。` : '',
    '',
    '【使用說明】',
    guide || '（目前沒有使用說明）',
  ].join('\n');
}

const clean = (s) => String(s || '')
  .replace(/<think>[\s\S]*?<\/think>/g, '')
  .replace(/^#+\s*/gm, '')
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .trim();

// 回傳要給老闆看的文字（永遠不丟錯，失敗時回傳 FALLBACK）
async function ask({ userId, question, context }) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (!q) return '請問想問什麼呢？';
  if (!OLLAMA_URL) return FALLBACK;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'system', content: systemPrompt(context) }, ...history(userId), { role: 'user', content: q }],
        stream: false,
        think: false,                                    // qwen3 等模型：不要輸出思考過程（舊版 Ollama 會忽略這個參數）
        options: { temperature: 0.3, num_predict: 600 },
      }),
      signal: AbortSignal.timeout(80000),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const j = await r.json();
    const answer = clean(j?.message?.content ?? j?.choices?.[0]?.message?.content);
    if (!answer) throw new Error('Ollama 沒有回答內容');
    if (userId) remember(userId, q, answer);
    return answer;
  } catch (e) {
    console.warn('[assistant] 呼叫 AI 失敗', e.message);
    return FALLBACK;
  }
}

// =====================================================================
// 意圖判斷：由 LLM 決定老闆這句話要走哪個流程（取代 iota 的「包含某些字」規則）
// 用 Ollama structured outputs 限定只能回清單裡的意圖，模型無法亂編。
// =====================================================================
const INTENTS = {
  add_product: '老闆要「開始」新增／上架一個商品（不是在問怎麼做）',
  find_customers: '篩選、找出、列出某一群顧客，或要發優惠券給某些顧客',
  redeem_coupon: '要核銷或查詢某一張優惠券，句子裡通常有優惠碼',
  customer_only: '想使用顧客的功能：預約、看價目表、查預約紀錄、取消預約、意見回饋（老闆帳號不能用這些）',
  help: '問這套 LINE 系統怎麼操作、某個步驟什麼意思、為什麼出錯',
  chat: '其他問題：經營、行銷、文案、寵物美容知識、閒聊',
};
const ROUTE_EXAMPLES = [
  ['新增商品', 'add_product'], ['我要上架一款新的洗毛精', 'add_product'], ['加入商品', 'add_product'],
  ['怎麼新增商品圖片', 'help'], ['商品照片要怎麼傳', 'help'], ['新增商品的格式是什麼', 'help'],
  ['找出半年沒來的狗狗', 'find_customers'], ['消費最高的前10位', 'find_customers'], ['發優惠券給很久沒來的客人', 'find_customers'], ['請告訴我消費金額最高的顧客', 'find_customers'],
  ['核銷 PS-AB3KQXY', 'redeem_coupon'], ['這張券還能用嗎 PS-K7Q2M9X', 'redeem_coupon'],
  ['優惠券要怎麼核銷', 'help'], ['為什麼照片無法儲存', 'help'], ['綁定碼在哪裡', 'help'],
  ['我要預約', 'customer_only'], ['幫我約下週六洗澡', 'customer_only'], ['價目表', 'customer_only'],
  ['查詢紀錄', 'customer_only'], ['取消預約', 'customer_only'], ['意見回饋', 'customer_only'],
  ['顧客要怎麼預約', 'help'], ['剪毛的價格要去哪裡改', 'help'],
  ['幫我想一句中秋節的優惠文案', 'chat'], ['夏天狗狗多久洗一次澡比較好', 'chat'], ['上個月營收多少', 'chat'],
];
const COUPON_CODE_RE = /\bPS\s*[-－]?\s*[A-Z0-9]{4,12}\b/i;

// Ollama 連不上時的備案：用簡單規則判斷，至少讓主要功能能用
function fallbackRoute(t) {
  const asking = /[?？]|怎麼|怎樣|什麼|甚麼|如何|為什麼|為何|哪裡|請問|教我/.test(t);
  if (COUPON_CODE_RE.test(t) && !/怎麼|如何|為什麼|為何/.test(t)) return 'redeem_coupon';
  if (asking) return 'help';
  if (/新增商品|加入商品|上架/.test(t)) return 'add_product';
  if (/預約|價目|價格表|查詢紀錄|消費紀錄|意見回饋/.test(t)) return 'customer_only';
  if (/顧客|客人|名單|優惠券|沒來|消費/.test(t)) return 'find_customers';
  return 'chat';
}

const CUSTOMER_ONLY_MSG = '這是顧客使用的功能（預約、價目表、查詢紀錄、取消預約、意見回饋），老闆帳號不能使用喔。\n\n要測試顧客的流程，請用另一個沒有綁定老闆的 LINE 帳號。';
const withTag = (r) => ({ ...r, tag: `#${r.intent}#`, ...(r.intent === 'customer_only' ? { message: CUSTOMER_ONLY_MSG } : {}) });

async function route(args) { return withTag(await routeRaw(args)); }
async function routeRaw({ text }) {
  const t = String(text || '').normalize('NFKC').trim().slice(0, MAX_QUESTION);
  if (!t) return { intent: 'chat', via: 'rule' };
  // 有優惠碼、又不是在發問 → 一定是核銷，不用問 LLM（省時間）
  if (COUPON_CODE_RE.test(t) && !/怎麼|如何|為什麼|為何/.test(t)) return { intent: 'redeem_coupon', via: 'rule' };
  if (!OLLAMA_URL) return { intent: fallbackRoute(t), via: 'fallback' };
  const system = [
    `你是「${SHOP_NAME}」寵物美容店 LINE 系統的分流員。老闆傳來一句話，你要判斷他想做哪一件事。`,
    '只能從下面的意圖選一個：',
    ...Object.entries(INTENTS).map(([k, v]) => `- ${k}：${v}`),
    '',
    '判斷重點：',
    '- 「怎麼、如何、什麼意思、為什麼、在哪裡」這類在問做法或原因的句子，一律是 help，就算句子裡有「新增商品」「預約」「核銷」這些字也一樣。',
    '- 只有老闆真的要「現在開始做」某件事時，才選那件事的意圖。',
    '',
    '範例：',
    ...ROUTE_EXAMPLES.map(([q, a]) => `老闆：${q} → ${a}`),
  ].join('\n');
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: t }],
        format: { type: 'object', properties: { intent: { type: 'string', enum: Object.keys(INTENTS) } }, required: ['intent'] },
        stream: false, think: false,
        options: { temperature: 0, num_predict: 60 },
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const j = await r.json();
    const raw = clean(j?.message?.content);
    const intent = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))?.intent;
    if (!INTENTS[intent]) throw new Error('意圖不在清單裡：' + raw.slice(0, 80));
    return { intent, via: 'llm' };
  } catch (e) {
    console.warn('[assistant] 意圖判斷失敗，改用規則', e.message);
    return { intent: fallbackRoute(t), via: 'fallback' };
  }
}

console.log('[assistant] AI 助手：', OLLAMA_URL ? `${OLLAMA_MODEL} @ ${OLLAMA_URL}` : '未設定 OLLAMA_URL（只會回覆指令清單）', '｜使用說明：', guide ? `${guide.length} 字` : '沒有');
module.exports = { ask, route };
