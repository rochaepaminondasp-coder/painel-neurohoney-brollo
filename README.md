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
