# Painel NeuroHoney · Brollo

Painel de faturamento × gasto (Taboola + MGID), atualizado a cada 30 min pelo GitHub Actions e publicado no GitHub Pages:
https://rochaepaminondasp-coder.github.io/painel-neurohoney-brollo/

## Como funciona
- `scripts/fetch.mjs` coleta:
  - **Ratoeira Ads** (via MCP): faturamento, vendas, upsells, câmbio do dia e receita atribuída ao Taboola.
  - **Taboola Backstage API**: gasto diário (reserva) e tabela de campanhas.
  - **MGID API v2** (`/v2/ads/account/{clientId}/statistics/reports`): gasto, cliques e conversões por dia, campanha e país.
- Os dados ficam em `data.json`, publicado junto com a página (acesso por link, sem senha).
- A cada execução só os últimos 3 dias são recalculados; o histórico (30 dias) vem da publicação anterior.

## Secrets necessários
`RATOEIRA_MCP_URL`, `TABOOLA_CLIENT_ID`, `TABOOLA_CLIENT_SECRET`, `TABOOLA_ACCOUNT_ID`, `MGID_CLIENT_ID` (ID numérico mostrado no menu da conta da MGID) e `MGID_TOKEN` (token da API v2).

Opcionais (variáveis de ambiente no workflow): `DAILY_GOAL` (meta de lucro diário em R$, hoje 3000), `START_DATE` (início da operação, hoje 2026-11-06), `RATOEIRA_PROJETO_ID`, `MGID_CURRENCY` (padrão USD), `HISTORY_DAYS`, `REFRESH_DAYS`.

## Testar o layout localmente
```bash
node scripts/fetch.mjs --mock && npx serve _site
```

## Ao vivo (Cloudflare Worker, a cada 4 minutos)
O agendamento do GitHub Actions atrasa e pula execuções, então os números de **hoje** vêm de um worker na Cloudflare
(`worker/`), que roda a cada 4 minutos e guarda o resultado num KV. O painel lê `GET <worker>/live` a cada 4 minutos.

- Publicação: workflow `deploy-worker.yml` (roda quando `worker/` muda ou manualmente). Precisa dos secrets
  `CLOUDFLARE_API_TOKEN` (modelo "Edit Cloudflare Workers") e `CLOUDFLARE_ACCOUNT_ID`; reaproveita os demais secrets.
- O endereço do worker fica em `public/live.json` (gravado pelo próprio workflow).
- Opcional: `GH_DISPATCH_TOKEN` (token do GitHub com permissão "Actions: read and write" neste repositório) faz o worker
  disparar a atualização completa a cada 30 minutos.
