# Painel NeuroHoney · Brollo

Painel de faturamento × gasto (Taboola + MGID), atualizado a cada 30 min pelo GitHub Actions e publicado no GitHub Pages:
https://rochaepaminondasp-coder.github.io/painel-neurohoney-brollo/

## Como funciona
- `scripts/fetch.mjs` coleta:
  - **Ratoeira Ads** (via MCP): faturamento, vendas, upsells, câmbio do dia e receita atribuída ao Taboola.
  - **Taboola Backstage API**: gasto diário (reserva) e tabela de campanhas.
  - **MGID API**: gasto, cliques e campanhas.
- Os dados são **criptografados** (AES-GCM, senha `DASH_PASSWORD`) antes de publicar — o repositório é público, então nada sai em texto aberto. O `index.html` decifra no navegador.
- A cada execução só os últimos 3 dias são recalculados; o histórico (30 dias) vem da publicação anterior.

## Secrets necessários
`DASH_PASSWORD`, `RATOEIRA_MCP_URL`, `TABOOLA_CLIENT_ID`, `TABOOLA_CLIENT_SECRET`, `TABOOLA_ACCOUNT_ID`, `MGID_CLIENT_ID`, `MGID_TOKEN`.

Opcionais (variáveis de ambiente no workflow): `RATOEIRA_PROJETO_ID`, `MGID_CURRENCY` (padrão USD), `HISTORY_DAYS`, `REFRESH_DAYS`.

## Testar o layout localmente
```bash
DASH_PASSWORD=teste node scripts/fetch.mjs --mock && npx serve _site
```
