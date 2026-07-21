/**
 * BRC - Backend de Storage (referência)
 * ----------------------------------------------------
 * Implementa a API que o painel HTML (BRC - Colheita e Comercialização) espera:
 *
 *   GET    /api/storage?prefix=xxx   -> { keys: [...] }
 *   GET    /api/storage/:key         -> { value }         (404 se não existir)
 *   PUT    /api/storage/:key         -> { value }          body: { value }
 *   DELETE /api/storage/:key         -> { deleted: true }  (404 se não existir)
 *
 *   POST   /api/ocr-romaneio         -> lê o romaneio por foto via IA (Anthropic)
 *
 * Autenticação: header  x-api-key: <API_KEY>
 *
 * Não usa NENHUMA dependência externa (só módulos nativos do Node.js).
 * Isso significa que basta ter o Node.js instalado e rodar:
 *
 *     node server.js
 *
 * Os dados são gravados no arquivo data.json, na mesma pasta deste servidor.
 * Configure a porta, a API_KEY e a ANTHROPIC_API_KEY por variável de ambiente.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
// ^ única dependência externa deste servidor — necessária porque enviar push de verdade
//   exige criptografar a mensagem (RFC 8291) e assinar um JWT (VAPID, RFC 8292). Dá pra fazer
//   isso só com o módulo nativo "crypto", mas é fácil errar um detalhe da criptografia e o push
//   simplesmente não chegar, sem erro nenhum. "web-push" é a biblioteca padrão da comunidade pra
//   isso, testada por milhões de sites — por isso abrimos uma exceção à regra de "zero dependências".
//   Antes de rodar: npm install web-push

// ---------- Configuração ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const DATA_FILE = path.join(__dirname, 'data.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('\n⚠️  ATENÇÃO: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY não configuradas. As notificações push não vão funcionar até você configurar essas variáveis de ambiente.\n');
} else {
  webpush.setVapidDetails('mailto:contato@brconsult.com.br', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

if (!API_KEY) {
  console.warn('\n⚠️  ATENÇÃO: nenhuma API_KEY definida. Configure a variável de ambiente API_KEY antes de usar em produção!\n');
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('\n⚠️  ATENÇÃO: nenhuma ANTHROPIC_API_KEY definida. A leitura de romaneio por foto (OCR) não vai funcionar até você configurar essa variável de ambiente.\n');
}
if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
  console.warn('\n⚠️  ATENÇÃO: sincronização com Google Sheets não configurada (faltam GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).\n');
}

// ---------- "Banco de dados" simples em arquivo JSON ----------
function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {}; // arquivo ainda não existe ou está vazio
  }
}

function saveDB(db) {
  // grava em arquivo temporário e renomeia, para evitar corromper o arquivo
  // se o processo for interrompido no meio da escrita
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

let db = loadDB();

// ---------- Utilidades HTTP ----------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) { // limite de 10MB por segurança
        reject(new Error('payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!API_KEY) return true; // se não configurou chave, libera (não recomendado em produção)
  const key = req.headers['x-api-key'];
  if (!key || key.length !== API_KEY.length) return false;
  // comparação em tempo constante, para evitar timing attacks
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(API_KEY));
}

// ---------- OCR de romaneio via IA (Anthropic) ----------
async function handleOcrRomaneio(req, res) {
  if (!checkAuth(req)) {
    return send(res, 401, { error: 'chave de API inválida ou ausente (header x-api-key)' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return send(res, 500, { error: 'ANTHROPIC_API_KEY não configurada no servidor' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: 'corpo da requisição precisa ser JSON válido' });
  }

  const { base64, mediaType, prompt } = body;
  if (!base64 || !prompt) {
    return send(res, 400, { error: 'base64 e prompt são obrigatórios' });
  }

  const anthropicPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(anthropicPayload),
    },
  };

  const anthropicReq = https.request(options, (anthropicRes) => {
    let responseData = '';
    anthropicRes.on('data', (chunk) => { responseData += chunk; });
    anthropicRes.on('end', () => {
      res.writeHead(anthropicRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(responseData);
    });
  });

  anthropicReq.on('error', (err) => {
    send(res, 502, { error: 'Falha ao consultar a IA', detail: err.message });
  });

  anthropicReq.write(anthropicPayload);
  anthropicReq.end();
}

// ---------- Sincronização com Google Sheets (conta de serviço) ----------
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedGoogleToken = null; // { access_token, expiresAt }

function getGoogleAccessToken() {
  return new Promise((resolve, reject) => {
    if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60000) {
      return resolve(cachedGoogleToken.access_token);
    }
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!email || !privateKey) return reject(new Error('credenciais do Google não configuradas no servidor'));

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };
    const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
    let signature;
    try {
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(unsigned);
      signer.end();
      signature = base64url(signer.sign(privateKey));
    } catch (e) {
      return reject(new Error('não foi possível assinar o JWT — confira se a GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY foi colada corretamente'));
    }
    const jwt = unsigned + '.' + signature;

    const bodyStr = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt;
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const tokenReq = https.request(options, (tokenRes) => {
      let data = '';
      tokenRes.on('data', (c) => { data += c; });
      tokenRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.access_token) return reject(new Error(parsed.error_description || parsed.error || 'falha ao autenticar no Google'));
          cachedGoogleToken = { access_token: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in || 3600) * 1000 };
          resolve(parsed.access_token);
        } catch (e) { reject(e); }
      });
    });
    tokenReq.on('error', reject);
    tokenReq.write(bodyStr);
    tokenReq.end();
  });
}

async function handleSheetSync(req, res) {
  if (!checkAuth(req)) {
    return send(res, 401, { error: 'chave de API inválida ou ausente (header x-api-key)' });
  }
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = process.env.GOOGLE_SHEET_RANGE || 'A1:Z10000';
  if (!sheetId) {
    return send(res, 500, { error: 'GOOGLE_SHEET_ID não configurado no servidor' });
  }
  try {
    const token = await getGoogleAccessToken();
    const sheetsPath = `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
    const googleRes = await new Promise((resolve, reject) => {
      const gReq = https.request({
        hostname: 'sheets.googleapis.com',
        path: sheetsPath,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, (gRes) => {
        let data = '';
        gRes.on('data', (c) => { data += c; });
        gRes.on('end', () => resolve({ status: gRes.statusCode, data }));
      });
      gReq.on('error', reject);
      gReq.end();
    });
    if (googleRes.status !== 200) {
      return send(res, 502, { error: 'Falha ao ler a planilha no Google', detail: googleRes.data });
    }
    const parsed = JSON.parse(googleRes.data);
    const values = parsed.values || [];
    if (!values.length) return send(res, 200, { headers: [], rows: [] });
    const headers = values[0];
    const rows = values.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : null; });
      return obj;
    });
    return send(res, 200, { headers, rows });
  } catch (err) {
    return send(res, 502, { error: 'Erro ao sincronizar com o Google Sheets', detail: err.message });
  }
}

// ---------- Push notifications (Web Push / VAPID) ----------
// Guardamos as inscrições dentro do próprio data.json, numa chave por produtor:
//   push-subs:<produtorId>  ->  { value: [ {endpoint, keys:{p256dh,auth}}, ... ] }
async function handlePushSubscribe(req, res) {
  if (!checkAuth(req)) {
    return send(res, 401, { error: 'chave de API inválida ou ausente (header x-api-key)' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: 'corpo da requisição precisa ser JSON válido' });
  }
  const { produtorId, subscription } = body;
  if (!produtorId || !subscription || !subscription.endpoint) {
    return send(res, 400, { error: 'produtorId e subscription são obrigatórios' });
  }
  const chave = 'push-subs:' + produtorId;
  const atuais = (db[chave] && db[chave].value) || [];
  const semDuplicata = atuais.filter((s) => s.endpoint !== subscription.endpoint);
  semDuplicata.push(subscription);
  db[chave] = { value: semDuplicata, updatedAt: new Date().toISOString() };
  saveDB(db);
  return send(res, 200, { ok: true, total: semDuplicata.length });
}

async function handlePushUnsubscribe(req, res) {
  if (!checkAuth(req)) {
    return send(res, 401, { error: 'chave de API inválida ou ausente (header x-api-key)' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: 'corpo da requisição precisa ser JSON válido' });
  }
  const { produtorId, endpoint } = body;
  if (!produtorId || !endpoint) {
    return send(res, 400, { error: 'produtorId e endpoint são obrigatórios' });
  }
  const chave = 'push-subs:' + produtorId;
  const atuais = (db[chave] && db[chave].value) || [];
  db[chave] = { value: atuais.filter((s) => s.endpoint !== endpoint), updatedAt: new Date().toISOString() };
  saveDB(db);
  return send(res, 200, { ok: true });
}

async function handlePushSend(req, res) {
  if (!checkAuth(req)) {
    return send(res, 401, { error: 'chave de API inválida ou ausente (header x-api-key)' });
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return send(res, 500, { error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY não configuradas no servidor' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: 'corpo da requisição precisa ser JSON válido' });
  }
  const { produtorId, title, message, url } = body;
  if (!produtorId || !title) {
    return send(res, 400, { error: 'produtorId e title são obrigatórios' });
  }
  const chave = 'push-subs:' + produtorId;
  const subs = (db[chave] && db[chave].value) || [];
  if (!subs.length) {
    return send(res, 200, { ok: true, enviados: 0, aviso: 'este produtor ainda não ativou notificações em nenhum aparelho' });
  }
  const payload = JSON.stringify({ title, body: message || '', url: url || '/' });
  const restantes = [];
  let enviados = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      enviados++;
      restantes.push(sub);
    } catch (err) {
      // 404/410 = inscrição expirada/revogada pelo navegador — descartamos, o resto mantemos
      if (err.statusCode !== 404 && err.statusCode !== 410) restantes.push(sub);
    }
  }
  db[chave] = { value: restantes, updatedAt: new Date().toISOString() };
  saveDB(db);
  return send(res, 200, { ok: true, enviados });
}

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Pre-flight CORS
    if (req.method === 'OPTIONS') {
      return send(res, 204, {});
    }

    // Rota de OCR (leitura de romaneio por foto) — checada ANTES do filtro de /api/storage,
    // senão ela nunca seria alcançada.
    if (req.method === 'POST' && url.pathname === '/api/ocr-romaneio') {
      return handleOcrRomaneio(req, res);
    }

    // Rota de sincronização com Google Sheets — mesma lógica, checada antes do filtro de /api/storage.
    if (req.method === 'GET' && url.pathname === '/api/sheet-sync') {
      return handleSheetSync(req, res);
    }

    // Rotas de notificação push
    if (req.method === 'GET' && url.pathname === '/api/push/vapid-public-key') {
      return send(res, 200, { publicKey: VAPID_PUBLIC_KEY });
    }
    if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
      return handlePushSubscribe(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
      return handlePushUnsubscribe(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/push/send') {
      return handlePushSend(req, res);
    }

    // Só atende as demais rotas dentro de /api/storage
    if (!url.pathname.startsWith('/api/storage')) {
      return send(res, 404, { error: 'rota não encontrada' });
    }

    if (!checkAuth(req)) {
      return send(res, 401, { error: 'chave de API inválida ou ausente (header x-api-key)' });
    }

    const rest = url.pathname.replace(/^\/api\/storage\/?/, ''); // parte depois de /api/storage/
    const key = rest ? decodeURIComponent(rest) : null;

    // GET /api/storage?prefix=xxx  -> listar chaves
    if (req.method === 'GET' && !key) {
      const prefix = url.searchParams.get('prefix') || '';
      const keys = Object.keys(db).filter((k) => k.startsWith(prefix));
      return send(res, 200, { keys });
    }

    // GET /api/storage/:key -> ler valor
    if (req.method === 'GET' && key) {
      if (!(key in db)) return send(res, 404, { error: 'não encontrado' });
      return send(res, 200, { value: db[key].value });
    }

    // PUT /api/storage/:key -> gravar valor
    if (req.method === 'PUT' && key) {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return send(res, 400, { error: 'corpo da requisição precisa ser JSON válido' });
      }
      db[key] = { value: parsed.value, updatedAt: new Date().toISOString() };
      saveDB(db);
      return send(res, 200, { value: db[key].value });
    }

    // DELETE /api/storage/:key -> apagar valor
    if (req.method === 'DELETE' && key) {
      if (!(key in db)) return send(res, 404, { error: 'não encontrado' });
      delete db[key];
      saveDB(db);
      return send(res, 200, { deleted: true });
    }

    return send(res, 405, { error: 'método não suportado' });
  } catch (err) {
    console.error('Erro inesperado:', err);
    return send(res, 500, { error: 'erro interno no servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`\n✅ Servidor BRC rodando em http://localhost:${PORT}`);
  console.log(`   Rotas disponíveis em: http://localhost:${PORT}/api/storage`);
  console.log(`   Rota de OCR em: http://localhost:${PORT}/api/ocr-romaneio`);
  console.log(`   Rota de sync com Google Sheets em: http://localhost:${PORT}/api/sheet-sync`);
  console.log(`   Rotas de push em: /api/push/vapid-public-key, /api/push/subscribe, /api/push/unsubscribe, /api/push/send`);
  console.log(`   Dados salvos em: ${DATA_FILE}\n`);
});
