// Worker "ao vivo" do Painel NeuroHoney.
// A cada 4 minutos (Cron Trigger) busca os números de HOJE na Ratoeira, Taboola e MGID
// e guarda no KV. O painel lê GET /live a cada 4 minutos.
// Secrets (definidos pelo workflow deploy-worker.yml a partir dos secrets do GitHub):
//   RATOEIRA_MCP_URL, TABOOLA_CLIENT_ID, TABOOLA_CLIENT_SECRET, TABOOLA_ACCOUNT_ID, MGID_CLIENT_ID, MGID_TOKEN
// Opcional: GH_DISPATCH_TOKEN (token do GitHub com permissão de Actions) para disparar a
// atualização completa do painel a cada 30 min, já que o agendamento do GitHub atrasa.

const TZ = 'America/Sao_Paulo';
const KEY = 'today';
const STALE_MS = 6 * 60 * 1000;

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : v != null && v !== '' && isFinite(+v) ? +v : 0);
const r2 = (v) => Math.round(v * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todaySP = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET' } });
    if (url.pathname === '/live') {
      let data = await env.LIVE.get(KEY, 'json');
      const stale = !data || data.date !== todaySP() || Date.now() - Date.parse(data.updated_at) > STALE_MS;
      if (stale) {
        try { data = await collect(env); ctx.waitUntil(env.LIVE.put(KEY, JSON.stringify(data))); }
        catch (e) { if (!data) return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: CORS }); }
      }
      return new Response(JSON.stringify(data), { headers: CORS });
    }
    return new Response(JSON.stringify({ ok: true, endpoints: ['/live'] }), { headers: CORS });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const data = await collect(env);
      await env.LIVE.put(KEY, JSON.stringify(data));
      // dispara a atualização completa no GitHub a cada ~30 min (opcional)
      const min = new Date(event.scheduledTime).getUTCMinutes();
      if (env.GH_DISPATCH_TOKEN && min % 30 < 4) await dispatchGithub(env).catch(() => {});
    })());
  },
};

async function dispatchGithub(env) {
  await fetch('https://api.github.com/repos/rochaepaminondasp-coder/painel-neurohoney-brollo/actions/workflows/atualizar.yml/dispatches', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'painel-neurohoney-live' },
    body: JSON.stringify({ ref: 'main' }),
  });
}

// ---------- coleta ----------
async function collect(env) {
  const date = todaySP();
  const errors = [];
  const day = { date };
  const tab = env.TABOOLA_CLIENT_ID ? taboolaToday(env, date).catch((e) => { errors.push('taboola: ' + e.message); return null; }) : null;
  const mg = env.MGID_TOKEN ? mgidToday(env, date).catch((e) => { errors.push('mgid: ' + e.message); return null; }) : null;
  const t = await tab; // conta Taboola resolvida é usada na Ratoeira
  if (env.RATOEIRA_MCP_URL) {
    try { Object.assign(day, await ratoeiraToday(env, date, t?.account)); }
    catch (e) { errors.push('ratoeira: ' + e.message); }
  }
  if (t) Object.assign(day, t.day);
  const m = await mg;
  if (m) Object.assign(day, m);
  day.fx = day.revenue_usd > 0 ? day.revenue_brl / day.revenue_usd : day.r_cost_usd > 0 ? day.r_cost_brl / day.r_cost_usd : undefined;
  return { date, updated_at: new Date().toISOString(), day, errors };
}

// ---------- Ratoeira (MCP via Streamable HTTP) ----------
class Mcp {
  constructor(url) { this.url = url; this.sid = null; this.id = 0; }
  async rpc(method, params, notify = false) {
    const body = { jsonrpc: '2.0', method, params };
    if (!notify) body.id = ++this.id;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sid) headers['mcp-session-id'] = this.sid;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id'); if (sid) this.sid = sid;
    if (notify) return null;
    if (!res.ok) throw new Error(res.status === 429 ? 'Too Many Requests' : `MCP HTTP ${res.status}`);
    const text = await res.text();
    let msg;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const line of text.split('\n')) { if (!line.startsWith('data:')) continue; try { const m = JSON.parse(line.slice(5).trim()); if (m.id === body.id) msg = m; } catch {} }
    } else msg = JSON.parse(text);
    if (!msg) throw new Error('MCP sem resposta');
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  }
  async init() {
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'painel-neurohoney-live', version: '1.0' } });
    await this.rpc('notifications/initialized', {}, true);
    this.tools = ((await this.rpc('tools/list', {})).tools || []).map((t) => t.name);
  }
  async call(base, args) {
    const name = this.tools.find((n) => n === base || n.endsWith(base)) || base;
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await this.rpc('tools/call', { name, arguments: args });
        const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (r.isError) throw new Error(text.slice(0, 160));
        return text;
      } catch (e) { last = e; await sleep(1500 * (i + 1)); }
    }
    throw last;
  }
}
const pick = (t, k) => { const m = t.match(new RegExp(`"${k}"\\s*:\\s*(-?[0-9.eE+-]+)`)); return m ? +m[1] : 0; };

async function ratoeiraToday(env, date, taboolaAccount) {
  const mcp = new Mcp(env.RATOEIRA_MCP_URL);
  await mcp.init();
  const out = {};
  // financeiro do dia, sem cache, com vendas por país e por hora
  const t = await mcp.call('get_financial_dashboard', { periodoAtual: { dataInicio: date, dataFim: date }, format: 'json', incluirGraficos: true, usarCache: false });
  Object.assign(out, {
    revenue_usd: pick(t, 'vendas_total_valor_dolar'), revenue_brl: pick(t, 'vendas_total_valor_real'), gross_usd: pick(t, 'faturamento_bruto_valor_dolar'),
    sales: pick(t, 'vendas_total_quantidade'), sales_front: pick(t, 'vendas_sem_upsell_quantidade'), upsells: pick(t, 'vendas_upsell_quantidade'),
    upsell_usd: pick(t, 'vendas_upsell_total_valor_dolar'), refunds_usd: pick(t, 'reembolsos_total_valor_dolar'), refunds: pick(t, 'reembolsos_quantidade'),
    untracked: pick(t, 'vendas_nao_trackeadas_quantidade'), r_cost_brl: pick(t, 'custo_total_valor_real'), r_cost_usd: pick(t, 'custo_total_valor_dolar'),
  });
  const countries = {};
  for (const m of t.matchAll(/"siglaPais"\s*:\s*"([^"]*)"[^}]*?"quantidadeVenda"\s*:\s*([0-9.]+)[^}]*?"totalVendaDolar"\s*:\s*(-?[0-9.]+)/g)) {
    const c = (countries[(m[1] || '??').toUpperCase()] ||= [0, 0]); c[0] += +m[2]; c[1] += +m[3];
  }
  out.countries = countries;
  const hours = [];
  for (const m of t.matchAll(/"hora"\s*:\s*"(\d+)"[^}]*?"faturamentoDolar"\s*:\s*(-?[0-9.]+)[^}]*?"investimentoDolar"\s*:\s*(-?[0-9.]+)/g)) hours[+m[1]] = [+m[2], +m[3]];
  if (hours.length) out.hours = Array.from({ length: 24 }, (_, i) => hours[i] || [0, 0]);
  // receita atribuída ao Taboola
  try {
    const args = { level: 'account', startDate: date, endDate: date, format: 'json', usarCache: false };
    if (taboolaAccount) args.accountsIds = [taboolaAccount];
    const tt = await mcp.call('management_taboola_ads', args);
    Object.assign(out, { tab_rev_usd: pick(tt, 'vendas_total_valor_dolar'), tab_sales: pick(tt, 'vendas_total_quantidade'), tab_checkouts: pick(tt, 'checkout_quantidade') });
  } catch {}
  // initiate checkouts (total e por rede)
  try {
    const count = async (extra) => {
      const c = await mcp.call('get_checkout_vendas_by_cliente', { data_inicio: date, data_fim: date, limit: 1, page: 1, format: 'json', timezone: TZ, ...extra });
      const all = [...c.matchAll(/"total"\s*:\s*(\d+)/g)];
      return all.length ? +all.at(-1)[1] : 0;
    };
    out.ic = await count({});
    out.ic_tab = out.ic ? await count({ rede_ads_id: 4 }) : 0;
    out.ic_mgid = out.ic ? await count({ rede_ads_id: 6 }) : 0;
  } catch {}
  return out;
}

// ---------- Taboola ----------
async function taboolaToday(env, date) {
  const body = new URLSearchParams({ client_id: env.TABOOLA_CLIENT_ID, client_secret: env.TABOOLA_CLIENT_SECRET, grant_type: 'client_credentials' });
  const tr = await fetch('https://backstage.taboola.com/backstage/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!tr.ok) throw new Error(`auth HTTP ${tr.status}`);
  const token = (await tr.json()).access_token;
  const H = { Authorization: `Bearer ${token}` };
  let account = String(env.TABOOLA_ACCOUNT_ID || '').trim();
  try {
    const ar = await fetch('https://backstage.taboola.com/backstage/api/1.0/users/current/allowed-accounts', { headers: H });
    if (ar.ok) {
      const list = (await ar.json()).results || [];
      const hit = list.find((a) => [a.account_id, a.id, a.name].map((v) => String(v ?? '').trim().toLowerCase()).includes(account.toLowerCase()));
      if (hit) account = hit.account_id;
    }
  } catch {}
  const rr = await fetch(`https://backstage.taboola.com/backstage/api/1.0/${encodeURIComponent(account)}/reports/campaign-summary/dimensions/day?start_date=${date}&end_date=${date}`, { headers: H });
  if (!rr.ok) throw new Error(`relatório HTTP ${rr.status}`);
  const row = ((await rr.json()).results || [])[0] || {};
  return { account, day: { tab_spend_brl: r2(num(row.spent)), tab_spend_usd: 0, tab_clicks: num(row.clicks), tab_imps: num(row.impressions), api_tab_spend: r2(num(row.spent)) } };
}

// ---------- MGID (API v2) ----------
async function mgidToday(env, date) {
  const qs = new URLSearchParams({ metrics: 'spent,clicks,impressions,conversionsBuy', dimensions: 'day', limit: 10, offset: 0,
    'filters[dateRange][dateFrom]': `${date}T00:00:00-03:00`, 'filters[dateRange][dateTo]': `${date}T23:59:59-03:00` });
  const res = await fetch(`https://api.mgid.com/v2/ads/account/${encodeURIComponent(String(env.MGID_CLIENT_ID).trim())}/statistics/reports?${qs}`, { headers: { Authorization: `Bearer ${String(env.MGID_TOKEN).trim()}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()).data || [];
  const sp = (v) => (v && typeof v === 'object' ? num(v.amount) : num(v));
  const s = rows.reduce((a, r) => ({ spend: a.spend + sp(r.spent), clicks: a.clicks + num(r.clicks), imps: a.imps + num(r.impressions), conv: a.conv + num(r.conversionsBuy) }), { spend: 0, clicks: 0, imps: 0, conv: 0 });
  return { mgid_spend: r2(s.spend), mgid_clicks: s.clicks, mgid_imps: s.imps, mgid_conv: s.conv };
}
