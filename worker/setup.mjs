// Prepara a Cloudflare para o worker: cria (ou reaproveita) o KV e descobre o endereço workers.dev.
// Roda no GitHub Actions com CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID.
import { readFile, writeFile, appendFile } from 'node:fs/promises';

const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
const api = async (path, opts = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(j.errors || '').slice(0, 300)}`);
  return j.result;
};

const TITLE = 'painel-neurohoney-live';
const list = await api('/storage/kv/namespaces?per_page=100');
let ns = list.find((n) => n.title === TITLE);
if (!ns) { ns = await api('/storage/kv/namespaces', { method: 'POST', body: JSON.stringify({ title: TITLE }) }); console.log('KV criado'); }
else console.log('KV existente reaproveitado');

const toml = await readFile('worker/wrangler.toml', 'utf8');
await writeFile('worker/wrangler.toml', toml.replace(/id = "[^"]*"/, `id = "${ns.id}"`));

let url = '';
try {
  const sub = await api('/workers/subdomain');
  if (sub?.subdomain) url = `https://painel-neurohoney-live.${sub.subdomain}.workers.dev`;
} catch (e) { console.log('::warning::Não achei o subdomínio workers.dev da conta. Abra Workers & Pages no painel da Cloudflare uma vez para criá-lo.', e.message); }
console.log('Endereço do worker:', url || '(desconhecido)');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\n`);
