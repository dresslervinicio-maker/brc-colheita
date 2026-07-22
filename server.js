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
if (!process.env.ERP_WEBHOOK_SECRET) {
  console.warn('\n⚠️  ATENÇÃO: ERP_WEBHOOK_SECRET não configurado. A rota /api/erp/webhook-nf vai recusar qualquer chamada até essa variável ser definida — configure-a quando for plugar o ERP de faturamento.\n');
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

// Autenticação separada da do painel (x-api-key): o ERP de faturamento chama essa rota
// de fora, então usa um segredo próprio (x-erp-secret), pra não misturar com a chave do app.
function checkErpWebhookAuth(req) {
  const secret = process.env.ERP_WEBHOOK_SECRET;
  if (!secret) return false; // sem segredo configurado, a rota fica sempre fechada
  const recebido = req.headers['x-erp-secret'];
  if (!recebido || recebido.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(secret));
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

// ---------- Análise de contrato via IA (texto extraído do PDF) ----------
async function handleAnalisarContrato(req, res) {
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

  const { prompt } = body;
  if (!prompt) {
    return send(res, 400, { error: 'prompt é obrigatório' });
  }
  // Contratos costumam ter bastante campo (partes, volumes, prazos, preços, cláusulas) —
  // damos uma margem generosa de resposta, mas com um teto de segurança.
  let maxTokens = parseInt(body.maxTokens, 10);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 2500;
  maxTokens = Math.min(maxTokens, 4096);

  const anthropicPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }],
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
//   push-subs:<usuarioId>  ->  { value: [ {endpoint, keys:{p256dh,auth}}, ... ] }
// usuarioId = o id da conta de login (admin, produtor ou motorista) — qualquer usuário pode ativar.
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
  const { usuarioId, subscription } = body;
  if (!usuarioId || !subscription || !subscription.endpoint) {
    return send(res, 400, { error: 'usuarioId e subscription são obrigatórios' });
  }
  const chave = 'push-subs:' + usuarioId;
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
  const { usuarioId, endpoint } = body;
  if (!usuarioId || !endpoint) {
    return send(res, 400, { error: 'usuarioId e endpoint são obrigatórios' });
  }
  const chave = 'push-subs:' + usuarioId;
  const atuais = (db[chave] && db[chave].value) || [];
  db[chave] = { value: atuais.filter((s) => s.endpoint !== endpoint), updatedAt: new Date().toISOString() };
  saveDB(db);
  return send(res, 200, { ok: true });
}

async function handlePushBroadcast(req, res) {
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
  const { title, message, url } = body;
  if (!title) {
    return send(res, 400, { error: 'title é obrigatório' });
  }
  // Avisa TODO MUNDO que tiver notificações ativas em algum aparelho — não mira num usuário
  // específico, porque quem gerencia a colheita nem sempre é o dono da carga.
  const payload = JSON.stringify({ title, body: message || '', url: url || '/' });
  const chavesPush = Object.keys(db).filter((k) => k.startsWith('push-subs:'));
  let enviados = 0;
  for (const chave of chavesPush) {
    const subs = (db[chave] && db[chave].value) || [];
    const restantes = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        enviados++;
        restantes.push(sub);
      } catch (err) {
        if (err.statusCode !== 404 && err.statusCode !== 410) restantes.push(sub);
      }
    }
    db[chave] = { value: restantes, updatedAt: new Date().toISOString() };
  }
  saveDB(db);
  return send(res, 200, { ok: true, enviados });
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
  const { usuarioId, title, message, url } = body;
  if (!usuarioId || !title) {
    return send(res, 400, { error: 'usuarioId e title são obrigatórios' });
  }
  const chave = 'push-subs:' + usuarioId;
  const subs = (db[chave] && db[chave].value) || [];
  if (!subs.length) {
    return send(res, 200, { ok: true, enviados: 0, aviso: 'este usuário ainda não ativou notificações em nenhum aparelho' });
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

// ---------- Integração com ERP de faturamento (webhook) ----------
// CONTRATO ESPERADO (documentar pro time do ERP quando a API deles estiver disponível):
//
//   POST /api/erp/webhook-nf
//   Header:  x-erp-secret: <ERP_WEBHOOK_SECRET>
//   Body (JSON):
//     {
//       "tipo": "armazem" | "nf",
//       "dados": [ { ...um objeto por romaneio/NF, chaves livres — o painel identifica
//                    o formato pelos nomes das colunas, igual já faz com a importação
//                    de planilha/PDF... } ]
//     }
//
//   "tipo":"armazem"  -> entrada no armazém próprio (sem comprador), campos esperados:
//       armazem, produtor, cultura, safra, motorista, placa, romaneio, data,
//       pesoBruto, tara, umidade, impureza, ardido, observacao
//   "tipo":"nf"       -> nota fiscal de venda/remessa emitida, campos esperados:
//       status, produtor, numero, valorTotal, dataEmissao, operacao, destinatario,
//       transportadora, placa, observacao
//
// O painel (index.html) busca essa fila periodicamente via GET /api/erp/fila
// (autenticado com a x-api-key normal do app) e importa cada item usando a MESMA
// lógica que já existe pra importação de planilha/PDF — não duplica regra nenhuma.
async function handleErpWebhookNF(req, res) {
  if (!checkErpWebhookAuth(req)) {
    return send(res, 401, { error: 'segredo do webhook inválido ou ausente (header x-erp-secret) — configure ERP_WEBHOOK_SECRET no servidor' });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, { error: 'corpo da requisição precisa ser JSON válido' });
  }
  const { tipo, dados } = body;
  if (!tipo || !Array.isArray(dados) || !dados.length) {
    return send(res, 400, { error: '"tipo" (armazem|nf) e "dados" (array não vazio) são obrigatórios' });
  }
  const chave = 'erp-webhook-fila';
  const fila = (db[chave] && db[chave].value) || [];
  fila.push({ tipo, dados, recebidoEm: new Date().toISOString() });
  db[chave] = { value: fila, updatedAt: new Date().toISOString() };
  saveDB(db);
  return send(res, 200, { ok: true, recebidos: dados.length, posicaoNaFila: fila.length });
}

async function handleErpFila(req, res) {
  if (!checkAuth(req)) {
    return send(res, 401, { error: 'chave de API inválida ou ausente (header x-api-key)' });
  }
  const chave = 'erp-webhook-fila';
  const fila = (db[chave] && db[chave].value) || [];
  // devolve e já limpa a fila (o painel processa tudo na hora) — evita reprocessar o mesmo lote depois
  db[chave] = { value: [], updatedAt: new Date().toISOString() };
  saveDB(db);
  return send(res, 200, { itens: fila });
}

// ---------- Push programado (resumo periódico de armazém/secador) ----------
// Roda no PRÓPRIO SERVIDOR (não depende do navegador de ninguém estar aberto) — lê os mesmos dados
// que o painel já grava em /api/storage (chaves "cadastros" e "estoque") e dispara via web-push
// direto daqui. A configuração de cada fazenda (ativo/período/destinatários) é feita no painel,
// dentro do card "Push programado" do Monitor de Capacidade Operacional — ela é salva normalmente
// via /api/storage/cadastros, então este verificador sempre lê a versão mais recente.
function calcSaldoFazendaKgServer(fazendaId, movimentosEstoque) {
  return movimentosEstoque
    .filter((m) => m.fazendaId === fazendaId)
    .reduce((acc, m) => acc + (m.tipo === 'saida' ? -Number(m.pesoKg || 0) : Number(m.pesoKg || 0)), 0);
}
// Mesmo modelo físico (balanço de massa) + calibração usado no painel — ver calcularCapacidadeEfetivaSecador
// no index.html. Mantido em espelho aqui porque o push programado roda direto no servidor, sem o navegador aberto.
function capacidadeEfetivaSecadorServer(capacidadeNominalTonHora, ueRefPct, usAlvoPct, uePct, fatorCalibracao) {
  const capNominal = Number(capacidadeNominalTonHora) || 0;
  const fator = Number(fatorCalibracao) || 1;
  if (!capNominal) return null;
  const ueRef = Number(ueRefPct) / 100, usRef = Number(usAlvoPct) / 100;
  const ueReal = Number(uePct) / 100, usAlvo = Number(usAlvoPct) / 100;
  if (!(ueRef > usRef) || !(ueReal > usAlvo)) return null;
  const fracaoNominal = 1 - (1 - ueRef) / (1 - usRef);
  const fracaoReal = 1 - (1 - ueReal) / (1 - usAlvo);
  if (fracaoReal <= 0) return null;
  return capNominal * (fracaoNominal / fracaoReal) * fator;
}
function comprometimentoSecadorServer(f, romaneiosArmazem, config) {
  const secadorTonHora = Number(f.secadorTonHora) || 0;
  if (!secadorTonHora) return null;
  if (f.secadorSuspenso) return { suspenso: true };
  const horas = Number(f.janelaRecebimentoHoras) || Number(config?.janelaRecebimentoHoras) || 24;
  const umidadeSegura = Number(config?.umidadeSeguraPct ?? 14);
  const limiteTs = Date.now() - horas * 3600 * 1000;
  const cargasSecador = romaneiosArmazem.filter((r) => {
    if (r.fazendaId !== f.id) return false;
    const ts = new Date(r.createdAt || r.dataEntrada).getTime();
    if (isNaN(ts) || ts < limiteTs) return false;
    const pesoBruto = Number(r.pesoBruto) || 0;
    if (!pesoBruto) return false;
    return (Number(r.umidade || 0) / pesoBruto * 100) > umidadeSegura;
  });
  const kgNoSecador = cargasSecador.reduce((s, r) => s + Number(r.pesoLiquido || 0), 0);
  const umidadeMediaSecador = cargasSecador.length
    ? cargasSecador.reduce((s, r) => s + (Number(r.umidade || 0) / Number(r.pesoBruto || 1) * 100), 0) / cargasSecador.length
    : null;
  let capTonHoraUsado = secadorTonHora;
  if (f.secadorUmidadeRefPct && umidadeMediaSecador !== null) {
    const efetiva = capacidadeEfetivaSecadorServer(secadorTonHora, f.secadorUmidadeRefPct, umidadeSegura, umidadeMediaSecador, f.secadorFatorCalibracao);
    if (efetiva !== null) capTonHoraUsado = efetiva;
  }
  const capacidadeSecadorKg = capTonHoraUsado * 1000 * horas;
  return {
    capacidadeSecadorKg, kgNoSecador, umidadeMediaSecador,
    pct: capacidadeSecadorKg > 0 ? (kgNoSecador / capacidadeSecadorKg * 100) : 0,
  };
}
async function verificarPushesProgramadosServidor() {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // sem chaves configuradas, não tem como enviar
    const cadastrosRaw = db['cadastros'] && db['cadastros'].value;
    const estoqueRaw = db['estoque'] && db['estoque'].value;
    if (!cadastrosRaw || !estoqueRaw) return;
    const cadastros = JSON.parse(cadastrosRaw);
    const estoque = JSON.parse(estoqueRaw);
    const fazendas = cadastros.fazendas || [];
    const config = cadastros.config || {};
    const movimentosEstoque = estoque.movimentosEstoque || [];
    const romaneiosArmazem = estoque.romaneiosArmazem || [];
    let mudou = false;

    for (const f of fazendas) {
      const cfg = f.pushProgramado;
      if (!cfg || !cfg.ativo || !(cfg.usuarioIds || []).length) continue;
      const periodoMs = (Number(cfg.periodoHoras) || 12) * 3600 * 1000;
      const ultimoEnvio = f.pushProgramadoUltimoEnvio ? new Date(f.pushProgramadoUltimoEnvio).getTime() : 0;
      if (Date.now() - ultimoEnvio < periodoMs) continue;

      const capacidadeKg = Number(f.armazemKg) || 0;
      const saldoKg = calcSaldoFazendaKgServer(f.id, movimentosEstoque);
      const disponivelKg = Math.max(0, capacidadeKg - saldoKg);
      const secador = comprometimentoSecadorServer(f, romaneiosArmazem, config);
      const title = `📋 Resumo periódico — ${f.nome}`;
      const message = `Armazenado: ${(saldoKg / 1000).toFixed(1)} t · Livre: ${(disponivelKg / 1000).toFixed(1)} t` +
        (secador?.suspenso ? ` · Secador: SUSPENSO` : secador ? ` · Secador: ${secador.pct.toFixed(0)}% comprometido · Umidade média: ${secador.umidadeMediaSecador !== null ? secador.umidadeMediaSecador.toFixed(1) + '%' : '—'}` : '');
      const payload = JSON.stringify({ title, body: message, url: '/' });

      for (const usuarioId of cfg.usuarioIds) {
        const chaveSub = 'push-subs:' + usuarioId;
        const subs = (db[chaveSub] && db[chaveSub].value) || [];
        const restantes = [];
        for (const sub of subs) {
          try { await webpush.sendNotification(sub, payload); restantes.push(sub); }
          catch (err) { if (err.statusCode !== 404 && err.statusCode !== 410) restantes.push(sub); }
        }
        db[chaveSub] = { value: restantes, updatedAt: new Date().toISOString() };
      }
      f.pushProgramadoUltimoEnvio = new Date().toISOString();
      mudou = true;
    }

    if (mudou) {
      cadastros.fazendas = fazendas;
      db['cadastros'] = { value: JSON.stringify(cadastros), updatedAt: new Date().toISOString() };
      saveDB(db);
    }
  } catch (e) { console.error('Falha ao verificar pushes programados:', e); }
}
setInterval(verificarPushesProgramadosServidor, 10 * 60 * 1000);
verificarPushesProgramadosServidor(); // já roda uma vez na subida do servidor, não só a cada 10 min

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

    if (req.method === 'POST' && url.pathname === '/api/analisar-contrato') {
      return handleAnalisarContrato(req, res);
    }

    // Rota de sincronização com Google Sheets — mesma lógica, checada antes do filtro de /api/storage.
    if (req.method === 'GET' && url.pathname === '/api/sheet-sync') {
      return handleSheetSync(req, res);
    }

    // Integração com o ERP de faturamento: o ERP empurra (webhook) e o painel busca (fila).
    if (req.method === 'POST' && url.pathname === '/api/erp/webhook-nf') {
      return handleErpWebhookNF(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/erp/fila') {
      return handleErpFila(req, res);
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
    if (req.method === 'POST' && url.pathname === '/api/push/broadcast') {
      return handlePushBroadcast(req, res);
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
  console.log(`   Rota de análise de contrato em: http://localhost:${PORT}/api/analisar-contrato`);
  console.log(`   Rota de sync com Google Sheets em: http://localhost:${PORT}/api/sheet-sync`);
  console.log(`   Rotas de integração ERP em: POST /api/erp/webhook-nf (o ERP chama) e GET /api/erp/fila (o painel busca)`);
  console.log(`   Push programado (resumo periódico de armazém/secador): verificação a cada 10 min, direto no servidor`);
  console.log(`   Rotas de push em: /api/push/vapid-public-key, /api/push/subscribe, /api/push/unsubscribe, /api/push/send, /api/push/broadcast`);
  console.log(`   Dados salvos em: ${DATA_FILE}\n`);
});
