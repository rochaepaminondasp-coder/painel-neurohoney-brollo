// Coleta dados de Ratoeira (MCP), Taboola e MGID, gera _site/data.enc.json (criptografado).
// Uso: node scripts/fetch.mjs            (produção, lê secrets do ambiente)
//      node scripts/fetch.mjs --mock     (gera dados fictícios para testar o layout)
import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile, cp } from 'node:fs/promises';

const env = process.env;
const MOCK = process.argv.includes('--mock');
const TZ = 'America/Sao_Paulo';
const HISTORY_DAYS = Number(env.HISTORY_DAYS || 30);
const REFRESH_DAYS = Number(env.REFRESH_DAYS || 3); // últimos N dias sempre recalculados
const MGID_CURRENCY = (env.MGID_CURRENCY || 'USD').toUpperCase();
const PAGES_URL = env.PAGES_URL || 'https://rochaepaminondasp-coder.github.io/painel-neurohoney-brollo/';
const OUT = '_site';

const errors = [];
const logErr = (src, msg) => { errors.push({ src, msg: String(msg).slice(0, 300) }); console.log(`[erro] ${src}: ${String(msg).slice(0, 300)}`); };

// ---------- datas ----------
const fmtDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = fmtDate(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastDays = (n) => Array.from({ length: n }, (_, i) => addDays(today, -(n - 1 - i)));

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : (v != null && v !== '' && isFinite(+v) ? +v : 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(2000 * (i + 1)); }
  }
  throw last;
}

async function fetchT(url, opts = {}, ms = 120000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// ---------- cripto (AES-GCM + PBKDF2), mesmo formato que o index.html decifra ----------
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const ITER = 250000;
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
async function decrypt(env_, pass) {
  const key = await deriveKey(pass, unb64(env_.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env_.iv) }, key, unb64(env_.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------- Ratoeira (cliente MCP mínimo, Streamable HTTP) ----------
class Mcp {
  constructor(url) { this.url = url; this.sid = null; this.id = 0; }
  async rpc(method, params, isNotification = false) {
    const body = { jsonrpc: '2.0', method, params };
    if (!isNotification) body.id = ++this.id;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sid) headers['mcp-session-id'] = this.sid;
    const res = await fetchT(this.url, { method: 'POST', headers, body: JSON.stringify(body) }, 180000);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    if (isNotification) return null;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const text = await res.text();
    let msg;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) msg = m; } catch {}
      }
    } else msg = JSON.parse(text);
    if (!msg) throw new Error('MCP sem resposta');
    if (msg.error) throw new Error(`MCP erro: ${msg.error.message}`);
    return msg.result;
  }
  async init() {
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'painel-neurohoney', version: '1.0' } });
    await this.rpc('notifications/initialized', {}, true);
    const tools = await this.rpc('tools/list', {});
    this.tools = (tools.tools || []).map((t) => t.name);
  }
  toolName(base) { return this.tools.find((n) => n === base || n.endsWith(base)) || base; }
  async call(base, args) {
    const r = await this.rpc('tools/call', { name: this.toolName(base), arguments: args });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(text.slice(0, 200));
    return text;
  }
}

// As respostas podem vir truncadas (limite de 25k chars), então lemos campos por regex.
const pick = (text, key) => { const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?[0-9.eE+-]+)`)); return m ? +m[1] : 0; };

async function ratoeiraDay(mcp, date) {
  const args = { periodoAtual: { dataInicio: date, dataFim: date }, format: 'json' };
  if (env.RATOEIRA_PROJETO_ID) args.projeto = [Number(env.RATOEIRA_PROJETO_ID)];
  const t = await withRetry(() => mcp.call('get_financial_dashboard', args));
  return {
    revenue_usd: pick(t, 'vendas_total_valor_dolar'),
    revenue_brl: pick(t, 'vendas_total_valor_real'),
    gross_usd: pick(t, 'faturamento_bruto_valor_dolar'),
    sales: pick(t, 'vendas_total_quantidade'),
    sales_front: pick(t, 'vendas_sem_upsell_quantidade'),
    upsells: pick(t, 'vendas_upsell_quantidade'),
    upsell_usd: pick(t, 'vendas_upsell_total_valor_dolar'),
    refunds_usd: pick(t, 'reembolsos_total_valor_dolar'),
    refunds: pick(t, 'reembolsos_quantidade'),
    untracked: pick(t, 'vendas_nao_trackeadas_quantidade'),
    r_cost_brl: pick(t, 'custo_total_valor_real'),
    r_cost_usd: pick(t, 'custo_total_valor_dolar'),
  };
}

async function ratoeiraTaboolaDay(mcp, date) {
  const args = { level: 'account', startDate: date, endDate: date, format: 'json' };
  if (env.TABOOLA_ACCOUNT_ID) args.accountsIds = [env.TABOOLA_ACCOUNT_ID];
  const t = await withRetry(() => mcp.call('management_taboola_ads', args));
  return {
    tab_spend_brl: pick(t, 'custo_total_valor_real'),
    tab_spend_usd: pick(t, 'custo_total_valor_dolar'),
    tab_rev_usd: pick(t, 'vendas_total_valor_dolar'),
    tab_sales: pick(t, 'vendas_total_quantidade'),
    tab_clicks: pick(t, 'cliques_no_anuncio_quantidade'),
    tab_imps: pick(t, 'impressoes_quantidade'),
    tab_checkouts: pick(t, 'checkout_quantidade'),
    tab_pageviews: pick(t, 'page_view_quantidade'),
  };
}

// ---------- Taboola Backstage API ----------
let taboolaToken;
async function taboolaAuth() {
  const body = new URLSearchParams({ client_id: env.TABOOLA_CLIENT_ID, client_secret: env.TABOOLA_CLIENT_SECRET, grant_type: 'client_credentials' });
  const res = await fetchT('https://backstage.taboola.com/backstage/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`Taboola auth HTTP ${res.status}`);
  taboolaToken = (await res.json()).access_token;
}
let taboolaAccount = env.TABOOLA_ACCOUNT_ID;
async function taboolaResolveAccount() {
  try {
    const res = await fetchT('https://backstage.taboola.com/backstage/api/1.0/users/current/allowed-accounts', { headers: { Authorization: `Bearer ${taboolaToken}` } });
    if (!res.ok) { console.log(`[aviso] Taboola allowed-accounts HTTP ${res.status}`); return; }
    const list = (await res.json()).results || [];
    const want = String(env.TABOOLA_ACCOUNT_ID).trim().toLowerCase();
    const hit = list.find((a) => [a.account_id, a.id, a.name].map((v) => String(v ?? '').trim().toLowerCase()).includes(want));
    const advertisers = list.filter((a) => (a.partner_types || []).includes('ADVERTISER') || a.type === 'PARTNER');
    console.log(`Taboola: ${list.length} conta(s) acessível(is); secret corresponde a uma delas: ${hit ? 'sim' : 'não'}.`);
    if (hit) taboolaAccount = hit.account_id;
    else if (list.length === 1) taboolaAccount = list[0].account_id;
    else if (advertisers.length === 1) taboolaAccount = advertisers[0].account_id;
  } catch (e) { console.log('[aviso] Taboola allowed-accounts:', e.message); }
}
async function errBody(res) { try { return (await res.text()).replace(/\s+/g, ' ').slice(0, 160); } catch { return ''; } }
async function taboolaReport(dimension, start, end) {
  const url = `https://backstage.taboola.com/backstage/api/1.0/${encodeURIComponent(taboolaAccount)}/reports/campaign-summary/dimensions/${dimension}?start_date=${start}&end_date=${end}`;
  const res = await fetchT(url, { headers: { Authorization: `Bearer ${taboolaToken}` } });
  if (!res.ok) throw new Error(`Taboola ${dimension} HTTP ${res.status} ${await errBody(res)}`);
  return (await res.json()).results || [];
}
async function taboolaCampaigns(start, end) {
  const rows = await taboolaReport('campaign_breakdown', start, end);
  return rows.map((r) => ({
    id: String(r.campaign ?? ''), name: r.campaign_name || String(r.campaign),
    spend: num(r.spent), clicks: num(r.clicks), imps: num(r.impressions),
    conv: num(r.cpa_actions_num), currency: r.currency || 'BRL',
  })).filter((r) => r.spend > 0 || r.clicks > 0).sort((a, b) => b.spend - a.spend);
}

// ---------- MGID API ----------
const MGID_BASE = 'https://api.mgid.com/v1/goodhits';
let MGID_TOKEN = String(env.MGID_TOKEN || '').trim();
let MGID_CLIENT = String(env.MGID_CLIENT_ID || '').trim();
// Se houver e-mail e senha da MGID, gera um token novo a cada execução (o token da MGID expira).
async function mgidLogin() {
  if (!env.MGID_EMAIL || !env.MGID_PASSWORD) return;
  try {
    const res = await fetchT('https://api.mgid.com/v1/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ email: env.MGID_EMAIL.trim(), password: env.MGID_PASSWORD }) });
    const text = await res.text();
    if (!res.ok) { console.log(`[aviso] MGID login HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 120)}`); return; }
    const j = JSON.parse(text);
    if (j.token) { MGID_TOKEN = j.token; console.log('MGID login OK (token novo gerado)'); }
    const idAuth = String(j.idAuth ?? j.id_auth ?? j.clientId ?? '');
    if (idAuth) { console.log(`MGID_CLIENT_ID confere com a conta do login: ${idAuth === MGID_CLIENT ? 'sim' : 'não — usando o da conta'}`); MGID_CLIENT = idAuth; }
  } catch (e) { console.log('[aviso] MGID login:', e.message); }
}
const mgidModes = {
  query: (qs) => [{ token: MGID_TOKEN, ...qs }, { Accept: 'application/json' }],
  bearer: (qs) => [qs, { Accept: 'application/json', Authorization: `Bearer ${MGID_TOKEN}` }],
  plain: (qs) => [qs, { Accept: 'application/json', Authorization: MGID_TOKEN }],
};
let mgidMode = null, mgidDead = null;
async function mgidGet(path, params = {}) {
  if (mgidDead) throw new Error(mgidDead);
  const modes = mgidMode ? [mgidMode] : Object.keys(mgidModes);
  let res, text, tried = [];
  for (const m of modes) {
    const [qs, headers] = mgidModes[m](params);
    res = await fetchT(`${MGID_BASE}${path}?${new URLSearchParams(qs)}`, { headers });
    text = await res.text();
    tried.push(`${m}=${res.status}`);
    if (res.ok) { if (!mgidMode) { mgidMode = m; console.log(`MGID OK (autenticação: ${m})`); } break; }
  }
  if (!res.ok) {
    const msg = `MGID ${path.split('/').pop()} HTTP ${res.status} [${tried.join(' ')}] ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
    if (!mgidMode && res.status === 401) mgidDead = msg; // não insiste 30x com token inválido
    throw new Error(msg);
  }
  try { return JSON.parse(text); } catch { throw new Error('MGID resposta não-JSON'); }
}
// Descreve só a estrutura (chaves), nunca valores — logs do Actions são públicos.
const shape = (o, d = 0) => (o && typeof o === 'object' && d < 3 ? `{${Object.keys(o).slice(0, 6).map((k) => `${/^\d+$/.test(k) ? '<id>' : k}:${shape(o[k], d + 1)}`).join(',')}}` : typeof o);

// Percorre o JSON e devolve {campaignId: {spent, clicks, imps, conv}} somando folhas que tenham "spent".
function mgidCollect(obj) {
  const out = {};
  const walk = (o, cid) => {
    if (!o || typeof o !== 'object') return;
    const hasSpent = ['spent', 'spend', 'cost'].some((k) => k in o && typeof o[k] !== 'object');
    if (hasSpent) {
      const id = String(o.campaignId ?? o.id ?? cid ?? 'total');
      const r = (out[id] ||= { spent: 0, clicks: 0, imps: 0, conv: 0 });
      r.spent += num(o.spent ?? o.spend ?? o.cost);
      r.clicks += num(o.clicks);
      r.imps += num(o.imps ?? o.impressions ?? o.hits);
      r.conv += num(o.conversions ?? o.conversionsCount ?? o.buy ?? o.decision ?? 0);
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(v, /^\d+$/.test(k) ? k : cid);
  };
  walk(obj);
  return out;
}
async function mgidStats(start, end) {
  const j = await mgidGet(`/clients/${MGID_CLIENT}/campaigns-stat`, { dateInterval: 'interval', startDate: start, endDate: end });
  const c = mgidCollect(j);
  if (!Object.keys(c).length && !mgidStats.warned) { mgidStats.warned = true; console.log('[aviso] MGID estrutura sem "spent":', shape(j)); }
  return c;
}
let mgidNames = {};
async function mgidLoadNames() {
  try {
    const j = await mgidGet(`/clients/${MGID_CLIENT}/campaigns`, { limit: 700 });
    const walk = (o, cid) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.name === 'string' && (o.id || cid)) { mgidNames[String(o.id ?? cid)] = o.name; return; }
      for (const [k, v] of Object.entries(o)) walk(v, /^\d+$/.test(k) ? k : cid);
    };
    walk(j);
  } catch (e) { logErr('mgid-nomes', e.message); }
}
const sumMgid = (c) => Object.values(c).reduce((a, r) => ({ spent: a.spent + r.spent, clicks: a.clicks + r.clicks, imps: a.imps + r.imps, conv: a.conv + r.conv }), { spent: 0, clicks: 0, imps: 0, conv: 0 });

// ---------- dados anteriores (incremental) ----------
async function loadPrevious(pass) {
  try {
    const res = await fetchT(PAGES_URL + 'data.enc.json?t=' + Date.now(), {}, 30000);
    if (!res.ok) return null;
    return await decrypt(await res.json(), pass);
  } catch { return null; }
}

// ---------- mock ----------
function mockData() {
  const days = lastDays(HISTORY_DAYS).map((date, i) => {
    const fx = 5.45 + Math.sin(i / 5) * 0.08;
    const tab = 9000 + Math.random() * 4000, mg = 600 + Math.random() * 500;
    const tabRev = tab / fx * (1.2 + Math.random() * 0.5), mgRev = mg * (1.0 + Math.random() * 0.8);
    const rev = tabRev + mgRev;
    return { date, fx, revenue_usd: rev, revenue_brl: rev * fx, gross_usd: rev, sales: Math.round(rev / 55), sales_front: Math.round(rev / 80), upsells: Math.round(rev / 170), upsell_usd: rev * 0.45, refunds_usd: Math.random() * 60, refunds: Math.round(Math.random() * 2), untracked: Math.round(Math.random() * 3),
      tab_spend_brl: tab, tab_spend_usd: tab / fx, tab_rev_usd: tabRev, tab_sales: Math.round(tabRev / 55), tab_clicks: Math.round(tab * 4), tab_imps: Math.round(tab * 2000), tab_checkouts: Math.round(tab / 10), tab_pageviews: Math.round(tab * 7),
      mgid_spend: mg, mgid_clicks: Math.round(mg * 12), mgid_imps: Math.round(mg * 5000), mgid_conv: Math.round(mg / 40) };
  });
  const camp = (p, n) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), name: `${p} | Memory ${['LATAM', 'FR', 'MX', 'CO'][i % 4]} | v${i + 1}`, spend: 3000 / (i + 1), clicks: 12000 / (i + 1), imps: 5e6 / (i + 1), conv: Math.round(60 / (i + 1)) }));
  return { days, campaigns: { d7: { taboola: camp('TB', 8), mgid: camp('MG', 5) }, d1: { taboola: camp('TB', 5), mgid: camp('MG', 3) } } };
}

// ---------- principal ----------
async function main() {
  const pass = env.DASH_PASSWORD;
  if (!pass) { console.error('Falta o secret DASH_PASSWORD (senha do painel).'); process.exit(1); }

  let payload;
  if (MOCK) payload = mockData();
  else {
    const hasR = !!env.RATOEIRA_MCP_URL, hasT = !!(env.TABOOLA_CLIENT_ID && env.TABOOLA_CLIENT_SECRET && env.TABOOLA_ACCOUNT_ID), hasM = !!((env.MGID_CLIENT_ID && env.MGID_TOKEN) || (env.MGID_EMAIL && env.MGID_PASSWORD));
    const prev = await loadPrevious(pass);
    const prevByDate = Object.fromEntries((prev?.days || []).map((d) => [d.date, d]));
    const window = lastDays(HISTORY_DAYS);
    const refresh = new Set(window.slice(-REFRESH_DAYS));
    const need = (d, k) => refresh.has(d) || !prevByDate[d] || !prevByDate[d][k];
    const todo = window.filter((d) => need(d, 'ok_r') || need(d, 'ok_rt') || (hasM && need(d, 'ok_m')));
    console.log(`Histórico anterior: ${prev ? Object.keys(prevByDate).length + ' dias' : 'nenhum'}. Atualizando ${todo.length} dia(s).`);

    let mcp = null;
    if (hasR) { try { mcp = new Mcp(env.RATOEIRA_MCP_URL); await mcp.init(); console.log('Ratoeira OK, tools:', mcp.tools.length); } catch (e) { logErr('ratoeira', e.message); mcp = null; } }
    if (hasT) { try { await taboolaAuth(); console.log('Taboola OK'); await taboolaResolveAccount(); } catch (e) { logErr('taboola', e.message); } }
    if (hasM) { await mgidLogin(); await mgidLoadNames(); }

    // Taboola diário pela API direta (fallback de gasto se a Ratoeira falhar)
    let tabDaily = {};
    if (taboolaToken && todo.length) {
      try { for (const r of await taboolaReport('day', todo[0], todo[todo.length - 1])) tabDaily[String(r.date).slice(0, 10)] = r; }
      catch (e) { logErr('taboola-dia', e.message); }
    }

    const days = [];
    for (const date of window) {
      if (!todo.includes(date)) { days.push(prevByDate[date]); continue; }
      const old = prevByDate[date] || {};
      const d = { ...old, date };
      if (mcp && need(date, 'ok_r')) {
        try { Object.assign(d, await ratoeiraDay(mcp, date)); d.ok_r = true; } catch (e) { d.ok_r = false; logErr(`ratoeira ${date}`, e.message); }
      }
      if (mcp && need(date, 'ok_rt')) {
        try { Object.assign(d, await ratoeiraTaboolaDay(mcp, date)); d.ok_rt = true; } catch (e) { d.ok_rt = false; logErr(`ratoeira-taboola ${date}`, e.message); }
      }
      const td = tabDaily[date];
      if (td) {
        d.api_tab_spend = num(td.spent); d.api_tab_clicks = num(td.clicks); d.api_tab_imps = num(td.impressions); d.api_tab_conv = num(td.cpa_actions_num);
        if (!mcp || !d.tab_spend_brl) { d.tab_spend_brl = d.api_tab_spend; d.tab_clicks = d.api_tab_clicks; d.tab_imps = d.api_tab_imps; }
      }
      if (hasM && need(date, 'ok_m')) {
        try { const s = sumMgid(await withRetry(() => mgidStats(date, date))); d.mgid_spend = s.spent; d.mgid_clicks = s.clicks; d.mgid_imps = s.imps; d.mgid_conv = s.conv; d.ok_m = true; }
        catch (e) { d.ok_m = false; if (!mgidDead || !errors.some((x) => x.src.startsWith('mgid'))) logErr(`mgid ${date}`, e.message); }
      }
      // câmbio BRL por USD, derivado dos próprios números da Ratoeira
      d.fx = d.revenue_usd > 0 ? d.revenue_brl / d.revenue_usd : d.r_cost_usd > 0 ? d.r_cost_brl / d.r_cost_usd : d.tab_spend_usd > 0 ? d.tab_spend_brl / d.tab_spend_usd : old.fx || days.at(-1)?.fx || 5.5;
      d.partial = (hasR && !(d.ok_r && d.ok_rt)) || (hasM && !d.ok_m);
      days.push(d);
    }
    // preenche câmbio faltante
    for (const d of days) if (d && !d.fx) d.fx = days.find((x) => x?.fx)?.fx || 5.5;

    const campaigns = { d7: {}, d1: {} };
    const d7start = addDays(today, -6);
    if (taboolaToken) {
      try { campaigns.d7.taboola = await taboolaCampaigns(d7start, today); } catch (e) { logErr('taboola-campanhas', e.message); }
      try { campaigns.d1.taboola = await taboolaCampaigns(today, today); } catch (e) { logErr('taboola-campanhas-hoje', e.message); }
    }
    if (hasM) {
      const toRows = (c) => Object.entries(c).filter(([id]) => id !== 'total' || Object.keys(c).length === 1)
        .map(([id, r]) => ({ id, name: mgidNames[id] || `Campanha ${id}`, spend: r.spent, clicks: r.clicks, imps: r.imps, conv: r.conv }))
        .filter((r) => r.spend > 0 || r.clicks > 0).sort((a, b) => b.spend - a.spend);
      try { campaigns.d7.mgid = toRows(await mgidStats(d7start, today)); } catch (e) { logErr('mgid-campanhas', e.message); }
      try { campaigns.d1.mgid = toRows(await mgidStats(today, today)); } catch (e) { logErr('mgid-campanhas-hoje', e.message); }
    }
    payload = { days: days.filter(Boolean), campaigns };
  }

  payload.meta = { updated_at: new Date().toISOString(), today, tz: TZ, mgid_currency: MGID_CURRENCY, errors, mock: MOCK };
  await mkdir(OUT, { recursive: true });
  await cp('public', OUT, { recursive: true });
  await writeFile(`${OUT}/data.enc.json`, JSON.stringify(await encrypt(payload, pass)));
  console.log(`OK: ${payload.days.length} dias, ${errors.length} erro(s).`);
}

main().catch((e) => { console.error('Falha geral:', e.message); process.exit(1); });
