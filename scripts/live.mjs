// Ciclo "ao vivo": roda no GitHub Actions por ~5h40, buscando os números de HOJE a cada 4 minutos
// (Ratoeira sem cache, Taboola e MGID) e gravando live.json no branch "live". O painel lê esse arquivo
// direto pela API do GitHub, sem esperar a publicação da página.
// A cada 30 minutos também dispara a atualização completa (atualizar.yml), porque o agendamento
// do GitHub atrasa muito. No fim, religa a si mesmo.
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const env = process.env;
const REPO = env.GITHUB_REPOSITORY || 'rochaepaminondasp-coder/painel-neurohoney-brollo';
const TOKEN = env.GITHUB_TOKEN;
const LOOP_MIN = Number(env.LOOP_MINUTES || 340);
const STEP = Number(env.STEP_MINUTES || 4) * 60000;
const FULL_EVERY = 30 * 60000;
const BRANCH = 'live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

// a coleta é a mesma do worker da Cloudflare (worker/index.js)
const tmp = join(env.RUNNER_TEMP || tmpdir(), 'live-worker.mjs');
await cp(new URL('../worker/index.js', import.meta.url), tmp);
const { collect } = await import(tmp);

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${opts.method || 'GET'} ${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

// grava live.json num commit sem histórico e move o branch para ele (o branch fica sempre com 1 commit)
async function publish(json) {
  const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ tree: [{ path: 'live.json', mode: '100644', type: 'blob', content: json }] }) });
  const commit = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message: 'ao vivo ' + new Date().toISOString(), tree: tree.sha, parents: [] }) });
  try { await gh(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) }); }
  catch (e) {
    if (!/HTTP 422|HTTP 404/.test(e.message)) throw e;
    await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }) });
  }
}

const dispatch = (workflow) => gh(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });

const start = Date.now();
let lastFull = Date.now(), n = 0;
console.log(`Ciclo ao vivo: a cada ${STEP / 60000} min por ${LOOP_MIN} min.`);
while (Date.now() - start < LOOP_MIN * 60000) {
  const t0 = Date.now();
  try {
    const data = await collect(env);
    await publish(JSON.stringify(data));
    n++;
    // logs do Actions são públicos: só contagens, nunca valores
    console.log(`[${stamp()}] ok · ${Object.keys(data.day || {}).length} campos · ${data.errors.length} aviso(s)${data.errors.length ? ': ' + data.errors.map((e) => e.split(':')[0]).join(', ') : ''}`);
  } catch (e) { console.log(`[${stamp()}] falhou: ${String(e.message || e).slice(0, 200)}`); }
  if (Date.now() - lastFull >= FULL_EVERY) {
    lastFull = Date.now();
    try { await dispatch('atualizar.yml'); console.log(`[${stamp()}] atualização completa disparada`); } catch (e) { console.log('não consegui disparar a atualização completa:', e.message); }
  }
  await sleep(Math.max(5000, STEP - (Date.now() - t0)));
}
console.log(`Fim do ciclo (${n} publicações). Religando…`);
try { await dispatch('ao-vivo.yml'); } catch (e) { console.log('não consegui religar:', e.message); }
