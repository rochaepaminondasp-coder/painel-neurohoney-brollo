// Coleta dados de Ratoeira (MCP), Taboola e MGID e gera _site/data.json.
// Uso: node scripts/fetch.mjs            (produção, lê secrets do ambiente)
//      node scripts/fetch.mjs --mock     (gera dados fictícios para testar o layout)
import { mkdir, writeFile, cp } from 'node:fs/promises';

const env = process.env;
const MOCK = process.argv.includes('--mock');
const TZ = 'America/Sao_Paulo';
const HISTORY_DAYS = Number(env.HISTORY_DAYS || 90);
const DEADLINE = Date.now() + Number(env.MAX_MINUTES || 40) * 60000; // para antes do timeout; o resto fica para a próxima execução
const REFRESH_DAYS = Number(env.REFRESH_DAYS || 3); // últimos N dias sempre recalculados
const MGID_CURRENCY = (env.MGID_CURRENCY || 'USD').toUpperCase();
const START_DATE = /^\d{4}-\d{2}-\d{2}$/.test(env.START_DATE || '') ? env.START_DATE : ''; // início da operação: nada antes disso entra no painel
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
    try { return await fn(); } catch (e) {
      last = e;
      const busy = /too many|429|tempo limite|timeout|abort/i.test(e.message);
      if (i < tries - 1) await sleep(busy ? [5000, 15000, 30000][i] || 30000 : 2000 * (i + 1));
    }
  }
  throw last;
}

async function fetchT(url, opts = {}, ms = 120000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// ---------- Ratoeira (cliente MCP mínimo, Streamable HTTP) ----------
class Mcp {
  constructor(url) { this.url = url; this.sid = null; this.id = 0; this.last = 0; }
  async rpc(method, params, isNotification = false) {
    const body = { jsonrpc: '2.0', method, params };
    if (!isNotification) body.id = ++this.id;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sid) headers['mcp-session-id'] = this.sid;
    const res = await fetchT(this.url, { method: 'POST', headers, body: JSON.stringify(body) }, 180000);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    if (isNotification) return null;
    if (!res.ok) throw new Error(res.status === 429 ? 'Too Many Requests' : `MCP HTTP ${res.status}`);
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
    const wait = this.last + 1500 - Date.now(); if (wait > 0) await sleep(wait); // espaça chamadas (limite de requisições)
    this.last = Date.now();
    const r = await this.rpc('tools/call', { name: this.toolName(base), arguments: args });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(text.slice(0, 200));
    return text;
  }
}

// As respostas podem vir truncadas (limite de 25k chars), então lemos campos por regex.
const pick = (text, key) => { const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?[0-9.eE+-]+)`)); return m ? +m[1] : 0; };

async function ratoeiraDay(mcp, date) {
  const args = { periodoAtual: { dataInicio: date, dataFim: date }, format: 'json', incluirGraficos: true };
  if (env.RATOEIRA_PROJETO_ID) args.projeto = [Number(env.RATOEIRA_PROJETO_ID)];
  const t = await withRetry(() => mcp.call('get_financial_dashboard', args), 4);
  // vendas por país: {"siglaPais":"MX", ... "quantidadeVenda":21, ... "totalVendaDolar":765 ...}
  const countries = {};
  for (const m of t.matchAll(/"siglaPais"\s*:\s*"([^"]*)"[^}]*?"quantidadeVenda"\s*:\s*([0-9.]+)[^}]*?"totalVendaDolar"\s*:\s*(-?[0-9.]+)/g)) {
    const cc = (m[1] || '??').toUpperCase(); const c = (countries[cc] ||= [0, 0]); c[0] += +m[2]; c[1] += +m[3];
  }
  // faturamento e investimento por hora (USD)
  const hours = [];
  for (const m of t.matchAll(/"hora"\s*:\s*"(\d+)"[^}]*?"faturamentoDolar"\s*:\s*(-?[0-9.]+)[^}]*?"investimentoDolar"\s*:\s*(-?[0-9.]+)/g)) hours[+m[1]] = [+m[2], +m[3]];
  return {
    countries, hours: hours.length ? Array.from({ length: 24 }, (_, i) => hours[i] || [0, 0]) : undefined,
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
  // usa o account_id resolvido pela API do Taboola (o secret pode estar em outro formato)
  if (taboolaAccount) args.accountsIds = [taboolaAccount];
  const t = await withRetry(() => mcp.call('management_taboola_ads', args), 4);
  if (!ratoeiraTaboolaDay.checked) {
    ratoeiraTaboolaDay.checked = true;
    const linked = t.includes(`"accountId": "${taboolaAccount}"`) || t.includes(`"accountId":"${taboolaAccount}"`);
    console.log(`Conta Taboola do secret vinculada na Ratoeira: ${linked ? 'sim' : 'não — gasto do Taboola virá da API do Taboola e a receita não será atribuída ao Taboola'}`);
  }
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

// initiate checkouts registrados pela Ratoeira (total e por rede: 4 = Taboola, 6 = MGID)
async function ratoeiraCheckouts(mcp, date) {
  const count = async (extra) => {
    const t = await withRetry(() => mcp.call('get_checkout_vendas_by_cliente', { data_inicio: date, data_fim: date, limit: 1, page: 1, format: 'json', timezone: TZ, ...extra }), 4);
    const all = [...t.matchAll(/"total"\s*:\s*(\d+)/g)];
    if (!all.length) { if (/nenhum|não foi|sem /i.test(t)) return 0; throw new Error('checkouts: resposta sem total — ' + t.replace(/\s+/g, ' ').slice(0, 120)); }
    return +all.at(-1)[1]; // o "total" da lista vem depois dos itens
  };
  const ic = await count({});
  const ic_tab = ic ? await count({ rede_ads_id: 4 }) : 0;
  const ic_mgid = ic ? await count({ rede_ads_id: 6 }) : 0;
  return { ic, ic_tab, ic_mgid };
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
let taboolaCurrency = null;
const r2 = (v) => Math.round(v * 100) / 100;
// campanhas por dia (uma chamada para o intervalo inteiro)
async function taboolaCampaignDays(start, end) {
  const out = {};
  for (const r of await taboolaReport('campaign_day_breakdown', start, end)) {
    const date = String(r.date).slice(0, 10);
    if (r.currency) taboolaCurrency = r.currency;
    if (!(num(r.spent) > 0 || num(r.clicks) > 0)) continue;
    (out[date] ||= []).push({ id: String(r.campaign ?? ''), name: r.campaign_name || String(r.campaign), spend: r2(num(r.spent)), clicks: num(r.clicks), imps: num(r.impressions), conv: num(r.cpa_actions_num), cval: r2(num(r.conversions_value)) });
  }
  return out;
}
// gasto por país de um dia: {CC: [gasto, cliques, impressões, conversões]}
async function taboolaCountryDay(date) {
  const out = {};
  for (const r of await taboolaReport('country_breakdown', date, date)) {
    if (!(num(r.spent) > 0 || num(r.clicks) > 0)) continue;
    const cc = String(r.country || r.country_code || '??').toUpperCase();
    out[cc] = [r2(num(r.spent)), num(r.clicks), num(r.impressions), num(r.cpa_actions_num)];
  }
  return out;
}

// ---------- MGID API v2 (https://api.mgid.com/v2/ads/docs) ----------
// Autenticação: "Authorization: Bearer <token>". Client ID = ID numérico mostrado no menu da conta no painel da MGID.
const MGID_TOKEN = String(env.MGID_TOKEN || '').trim();
const MGID_CLIENT = String(env.MGID_CLIENT_ID || '').trim();
let mgidOk = false, mgidDead = null, mgidCurrency = null;
const shape = (o, d = 0) => (o && typeof o === 'object' && d < 3 ? `{${Object.keys(o).slice(0, 6).map((k) => `${/^\d+$/.test(k) ? '<id>' : k}:${shape(o[k], d + 1)}`).join(',')}}` : typeof o);
// nome do país (em inglês) -> código ISO, caso a MGID devolva nomes
const countryCode = (() => {
  const map = {};
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) { const cc = String.fromCharCode(a, b); try { const n = dn.of(cc); if (n && n !== cc) map[n.toLowerCase()] = cc; } catch {} }
  } catch {}
  return (v) => { const s = String(v ?? '').trim(); if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase(); return map[s.toLowerCase()] || s || '??'; };
})();
const sp = (v) => (v && typeof v === 'object' ? (v.currency && (mgidCurrency ||= v.currency), num(v.amount)) : num(v));
async function mgidReport(dateFrom, dateTo, dimensions, metrics) {
  if (mgidDead) throw new Error(mgidDead);
  const rows = [], limit = 1000;
  for (let offset = 0; offset < 50000; offset += limit) {
    const qs = new URLSearchParams({ metrics: metrics.join(','), dimensions: dimensions.join(','), limit, offset,
      'filters[dateRange][dateFrom]': `${dateFrom}T00:00:00-03:00`, 'filters[dateRange][dateTo]': `${dateTo}T23:59:59-03:00` });
    const res = await fetchT(`https://api.mgid.com/v2/ads/account/${encodeURIComponent(MGID_CLIENT)}/statistics/reports?${qs}`, { headers: { Authorization: `Bearer ${MGID_TOKEN}`, Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.replace(/\s+/g, ' ').slice(0, 200);
      try { const e = JSON.parse(text).error; if (e) msg = `${e.code || ''} ${e.message || ''} ${e.details ? JSON.stringify(e.details) : ''}`.trim().slice(0, 240); } catch {}
      const m = `MGID relatório HTTP ${res.status}: ${msg}`;
      if (res.status === 401 || res.status === 403 || res.status === 404) mgidDead = m; // credencial/ID errado: não insiste
      throw new Error(m);
    }
    const j = JSON.parse(text);
    if (!mgidOk) { mgidOk = true; console.log('MGID OK (API v2)'); }
    const data = Array.isArray(j.data) ? j.data : [];
    if (!Array.isArray(j.data)) console.log('[aviso] MGID resposta sem "data":', shape(j));
    rows.push(...data);
    if (data.length < limit) break;
  }
  return rows;
}
// por dia: campanhas e totais
async function mgidCampaignDays(from, to) {
  const out = {};
  for (const r of await mgidReport(from, to, ['day', 'campaignId', 'campaignName'], ['spent', 'clicks', 'impressions', 'conversionsBuy', 'revenue'])) {
    const date = String(r.day || '').slice(0, 10); if (!date) continue;
    const row = { id: String(r.campaignId ?? ''), name: r.campaignName || `Campanha ${r.campaignId}`, spend: r2(sp(r.spent)), clicks: num(r.clicks), imps: num(r.impressions), conv: num(r.conversionsBuy), cval: r2(sp(r.revenue)) };
    if (row.spend > 0 || row.clicks > 0) (out[date] ||= []).push(row);
  }
  return out;
}
// por dia: gasto por país {CC: [gasto, cliques, impressões, conversões]}
async function mgidCountryDays(from, to) {
  const out = {};
  for (const r of await mgidReport(from, to, ['day', 'country'], ['spent', 'clicks', 'impressions', 'conversionsBuy'])) {
    const date = String(r.day || '').slice(0, 10); if (!date) continue;
    const s = r2(sp(r.spent)); if (!(s > 0 || num(r.clicks) > 0)) continue;
    const cc = countryCode(r.country), o = (out[date] ||= {}), c = (o[cc] ||= [0, 0, 0, 0]);
    c[0] = r2(c[0] + s); c[1] += num(r.clicks); c[2] += num(r.impressions); c[3] += num(r.conversionsBuy);
  }
  return out;
}

// ---------- dados anteriores (incremental) ----------
async function loadPrevious() {
  try {
    const res = await fetchT(PAGES_URL + 'data.json?t=' + Date.now(), {}, 30000);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ---------- mock ----------
function mockData() {
  const CC = { MX: 0.3, AR: 0.2, CL: 0.17, ES: 0.1, CO: 0.08, EC: 0.06, UY: 0.03, PE: 0.03, FR: 0.03 };
  const camps = Array.from({ length: 9 }, (_, i) => ({ id: String(4100 + i), name: `NH | Memory ${['MX', 'AR', 'CL', 'ES', 'CO', 'FR'][i % 6]} | v${i + 1}`, w: 1 / (i + 1.5) }));
  const mcamps = Array.from({ length: 5 }, (_, i) => ({ id: String(9100 + i), name: `MG | Memory ${['LATAM', 'FR', 'MX'][i % 3]} | v${i + 1}`, w: 1 / (i + 1.5) }));
  const wsum = camps.reduce((a, c) => a + c.w, 0), msum = mcamps.reduce((a, c) => a + c.w, 0);
  const days = lastDays(HISTORY_DAYS).map((date, i) => {
    const fx = 5.45 + Math.sin(i / 5) * 0.08;
    const tab = 9000 + Math.random() * 4000, mg = 600 + Math.random() * 500;
    const tabRev = tab / fx * (1.2 + Math.random() * 0.5), mgRev = mg * (1.0 + Math.random() * 0.8);
    const rev = tabRev + mgRev, sales = Math.round(rev / 55);
    const countries = Object.fromEntries(Object.entries(CC).map(([c, w]) => [c, [Math.round(sales * w), r2(rev * w * (0.8 + Math.random() * 0.4))]]));
    const tab_ctry = Object.fromEntries(Object.entries(CC).map(([c, w]) => [c, [r2(tab * w * (0.8 + Math.random() * 0.4)), Math.round(tab * 4 * w), Math.round(tab * 2000 * w), Math.round(20 * w)]]));
    const hours = Array.from({ length: 24 }, (_, h) => { const k = Math.max(0.1, Math.sin((h - 4) / 24 * Math.PI)); return [r2(rev / 14 * k * Math.random()), r2(tab / fx / 14 * k)]; });
    return { date, fx, revenue_usd: rev, revenue_brl: rev * fx, gross_usd: rev, sales, sales_front: Math.round(sales * 0.68), upsells: Math.round(sales * 0.32), upsell_usd: rev * 0.45, refunds_usd: Math.random() * 60, refunds: Math.round(Math.random() * 2), untracked: Math.round(Math.random() * 3),
      tab_spend_brl: tab, tab_spend_usd: tab / fx, tab_rev_usd: tabRev, tab_sales: Math.round(tabRev / 55), tab_clicks: Math.round(tab * 4), tab_imps: Math.round(tab * 2000), tab_checkouts: Math.round(tab / 10), tab_pageviews: Math.round(tab * 7),
      mgid_spend: mg, mgid_clicks: Math.round(mg * 12), mgid_imps: Math.round(mg * 5000), mgid_conv: Math.round(mg / 40),
      ic: Math.round(sales * 7.5), ic_tab: Math.round(tabRev / 55 * 7), ic_mgid: Math.round(sales * 7.5 - tabRev / 55 * 7), countries, tab_ctry, hours, mgid_ctry: Object.fromEntries(Object.entries(CC).map(([c, w]) => [c, [r2(mg * w), Math.round(mg * 12 * w), Math.round(mg * 5000 * w), Math.round(mg / 40 * w)]])),
      tab_camps: camps.map((c) => ({ id: c.id, name: c.name, spend: r2(tab * c.w / wsum), clicks: Math.round(tab * 4 * c.w / wsum), imps: Math.round(tab * 2000 * c.w / wsum), conv: Math.round(30 * c.w / wsum), cval: 0 })),
      mgid_camps: mcamps.map((c) => ({ id: c.id, name: c.name, spend: r2(mg * c.w / msum), clicks: Math.round(mg * 12 * c.w / msum), imps: Math.round(mg * 5000 * c.w / msum), conv: Math.round(mg / 40 * c.w / msum) })) };
  });
  return { days, tab_currency: 'BRL', mgid_currency: 'USD' };
}

// ---------- principal ----------
async function main() {

  let payload;
  if (MOCK) payload = mockData();
  else {
    const hasR = !!env.RATOEIRA_MCP_URL, hasT = !!(env.TABOOLA_CLIENT_ID && env.TABOOLA_CLIENT_SECRET && env.TABOOLA_ACCOUNT_ID), hasM = !!(env.MGID_CLIENT_ID && env.MGID_TOKEN);
    const prev = await loadPrevious();
    const prevByDate = Object.fromEntries((prev?.days || []).map((d) => [d.date, d]));
    const window = lastDays(HISTORY_DAYS).filter((d) => !START_DATE || d >= START_DATE);
    if (START_DATE) console.log(`Início da operação: ${START_DATE}`);
    const refresh = new Set(window.slice(-REFRESH_DAYS));
    const need = (d, k) => refresh.has(d) || !prevByDate[d] || !prevByDate[d][k];
    const KEYS = [hasR && 'ok_r2', hasR && 'ok_rt2', hasR && 'ok_ic', hasT && 'ok_tc', hasT && 'ok_tg', hasM && 'ok_m3'].filter(Boolean);
    const todo = window.filter((d) => KEYS.some((k) => need(d, k)));
    console.log(`Histórico anterior: ${prev ? Object.keys(prevByDate).length + ' dias' : 'nenhum'}. Atualizando ${todo.length} dia(s).`);

    let mcp = null;
    if (hasR) { try { mcp = new Mcp(env.RATOEIRA_MCP_URL); await mcp.init(); console.log('Ratoeira OK, tools:', mcp.tools.length); } catch (e) { logErr('ratoeira', e.message); mcp = null; } }
    if (hasT) { try { await taboolaAuth(); console.log('Taboola OK'); await taboolaResolveAccount(); } catch (e) { logErr('taboola', e.message); } }

    // Taboola: diário + campanhas por dia (uma chamada cada para o intervalo)
    let tabDaily = {}, tabCamps = null;
    const tcDays = todo.filter((d) => need(d, 'ok_tc'));
    if (taboolaToken && todo.length) {
      try { for (const r of await taboolaReport('day', todo[0], todo.at(-1))) tabDaily[String(r.date).slice(0, 10)] = r; }
      catch (e) { logErr('taboola-dia', e.message); }
    }
    if (taboolaToken && tcDays.length) {
      try { tabCamps = await taboolaCampaignDays(tcDays[0], tcDays.at(-1)); } catch (e) { logErr('taboola-campanhas', e.message); }
    }

    // MGID: duas chamadas para o intervalo inteiro (campanhas por dia e países por dia)
    let mgCamps = null, mgCtry = null;
    const mDays = todo.filter((d) => need(d, 'ok_m3'));
    if (hasM && mDays.length) {
      try { mgCamps = await mgidCampaignDays(mDays[0], mDays.at(-1)); } catch (e) { logErr('mgid', e.message); }
      if (mgCamps) { try { mgCtry = await mgidCountryDays(mDays[0], mDays.at(-1)); } catch (e) { logErr('mgid-paises', e.message); } }
    }

    const byDate = { ...prevByDate };
    let stopped = false, tgErr = 0, rErr = 0;
    // do mais recente para o mais antigo: os dias novos aparecem primeiro
    for (const date of todo.slice().reverse()) {
      if (Date.now() > DEADLINE) { if (!stopped) console.log('[aviso] tempo limite desta execução atingido; o restante continua na próxima.'); stopped = true; }
      const old = prevByDate[date] || {};
      const d = { ...old, date };
      if (!stopped && mcp && need(date, 'ok_r2')) {
        try { Object.assign(d, await ratoeiraDay(mcp, date)); d.ok_r2 = d.ok_r = true; } catch (e) { d.ok_r2 = false; if (rErr++ < 5) logErr(`ratoeira ${date}`, e.message); }
      }
      if (!stopped && mcp && need(date, 'ok_rt2')) {
        try { Object.assign(d, await ratoeiraTaboolaDay(mcp, date)); d.ok_rt = d.ok_rt2 = true; } catch (e) { d.ok_rt2 = false; if (rErr++ < 5) logErr(`ratoeira-taboola ${date}`, e.message); }
      }
      if (!stopped && mcp && need(date, 'ok_ic')) {
        try { Object.assign(d, await ratoeiraCheckouts(mcp, date)); d.ok_ic = true; } catch (e) { d.ok_ic = false; if (rErr++ < 5) logErr(`ratoeira-checkouts ${date}`, e.message); }
      }
      const td = tabDaily[date];
      if (td) {
        d.api_tab_spend = num(td.spent); d.api_tab_clicks = num(td.clicks); d.api_tab_imps = num(td.impressions); d.api_tab_conv = num(td.cpa_actions_num);
        // a API do Taboola é a fonte do gasto; a Ratoeira fica com a receita atribuída
        if (!d.ok_rt || d.api_tab_spend > 0 || !d.tab_spend_brl) { d.tab_spend_brl = d.api_tab_spend; d.tab_spend_usd = 0; d.tab_clicks = d.api_tab_clicks; d.tab_imps = d.api_tab_imps; }
      }
      if (tabCamps && need(date, 'ok_tc')) { d.tab_camps = tabCamps[date] || []; d.ok_tc = true; }
      if (!stopped && taboolaToken && need(date, 'ok_tg')) {
        try { d.tab_ctry = await taboolaCountryDay(date); d.ok_tg = true; } catch (e) { d.ok_tg = false; if (tgErr++ < 2) logErr(`taboola-paises ${date}`, e.message); }
      }
      if (mgCamps && need(date, 'ok_m3')) {
        const list = mgCamps[date] || [];
        d.mgid_camps = list; d.ok_m3 = true;
        d.mgid_spend = r2(list.reduce((a, c) => a + c.spend, 0)); d.mgid_clicks = list.reduce((a, c) => a + c.clicks, 0);
        d.mgid_imps = list.reduce((a, c) => a + c.imps, 0); d.mgid_conv = list.reduce((a, c) => a + c.conv, 0);
        if (mgCtry) d.mgid_ctry = mgCtry[date] || {};
      }
      // câmbio BRL por USD, derivado dos próprios números da Ratoeira
      d.fx = d.revenue_usd > 0 ? d.revenue_brl / d.revenue_usd : d.r_cost_usd > 0 ? d.r_cost_brl / d.r_cost_usd : d.tab_spend_usd > 0 ? d.tab_spend_brl / d.tab_spend_usd : old.fx || 0;
      d.partial = KEYS.some((k) => !d[k]);
      byDate[date] = d;
    }
    // mantém todo o histórico (aba "Tudo"), ordenado
    const days = Object.values(byDate).filter((d) => d?.date && (!START_DATE || d.date >= START_DATE)).sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < days.length; i++) if (!days[i].fx) days[i].fx = days[i - 1]?.fx || days.find((x) => x.fx)?.fx || 5.5;
    const pending = days.filter((d) => d.partial && window.includes(d.date)).length;
    if (pending) console.log(`Dias ainda incompletos: ${pending}`);
    payload = { days, tab_currency: taboolaCurrency || prev?.tab_currency || 'BRL', mgid_currency: mgidCurrency || prev?.mgid_currency || MGID_CURRENCY, sources: { ratoeira: !!mcp, taboola: !!taboolaToken, mgid: mgidOk } };
  }

  payload.meta = { updated_at: new Date().toISOString(), today, tz: TZ, mgid_currency: MGID_CURRENCY, errors, mock: MOCK, history_days: HISTORY_DAYS, start_date: START_DATE || null, daily_goal_brl: Number(env.DAILY_GOAL || 0) || null };
  await mkdir(OUT, { recursive: true });
  await cp('public', OUT, { recursive: true });
  await writeFile(`${OUT}/data.json`, JSON.stringify(payload));
  console.log(`OK: ${payload.days.length} dias, ${errors.length} erro(s).`);
}

main().catch((e) => { console.error('Falha geral:', e.message); process.exit(1); });
