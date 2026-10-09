# DEBUG SESSÃO: unlock-contact-404
**Status**: [OPEN] Investigando  
**Session ID**: unlock-contact-404  
**Data criação**: 2026-10-09  
**Bug**: Ao clicar em "Sim, desbloquear contato", recebe HTTP 404 "Servidor temporariamente indisponível" e o contato NÃO é liberado. Reprodutível sempre.

---

## 🎯 Sintomas (observados pelo usuário)
- Ação: Clicar em SIM desbloquear contato
- Resultado esperado: Contato desbloqueado, WhatsApp visível para cliente
- Resultado atual: Toast "Servidor temporariamente indisponível (HTTP 404) / 30 segundos / feche e abra"
- Contato **nunca** é liberado, mesmo após esperar

---

## 🔬 HIPÓTESES FALSIFICÁVEIS (antes de tocar lógica)

| # | Hipótese | Como falsificar/confirmar | Ponto de instrumentação |
|---|---|---|---|
| H1 | **URL errada do backend**: `AJEITA_PIX_BACKEND_URL` aponta para rota inexistente (ex: sem `/api/`, barra final dupla, porta errada) | Logar URL final + método + status HTTP antes do fetch | Frontend: função que chama endpoint desbloquear |
| H2 | **Método HTTP errado (GET vs POST) ou body vazio**: endpoint espera POST com body JSON mas recebe GET/POST vazio → rota não matcha → 404 | Logar method, headers (content-type), body stringificado enviado | Frontend: fetch desbloquear; Backend: log de request recebido |
| H3 | **Rota backend não existe ou normalização incompleta**: apesar do hotfix 0438192, normalização ASCII/acentos está incompleta — ou rota só registrada em 1 path e a URL tem acentos/casing | Backend: log cada requisição recebida (method + originalUrl + parsed path + matched route) | Backend: middleware global + rota /desbloquear handler |
| H4 | **Instância Render dormindo (cold start) e retry falha**: primeiro request 502/404 por ~20s, retry triplo espera pouco ou é atropelado por timeout | Logar timestamps de cada tentativa + duração + status recebido | Frontend: wrapper retry do fetch |
| H5 | **Bearer token / auth admin ausente ou inválido**: endpoint de desbloqueio requer autenticação admin e retorna 404 disfarçado (mascara 401/403 como 404) | Logar presence/absence e prefixo do header Authorization enviado | Frontend: fetch desbloquear; Backend: middleware auth |
| H6 | **ID/parâmetros errados no body**: `pedidoId`, `profissionalId`, `sessao_token` undefined ou null → body malformado → backend valida e retorna 404 | Logar todo payload montado e todo response (status + text/json) | Frontend: função submit desbloquear |

---

## 📁 Pontos de inspeção de código (pré-instrumentação)
- Frontend: [index.html](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html) → função de submit "desbloquear" (enviar pedido / confirmar desbloqueio)
- Backend: `backend-pix-ajeita/` → rotas de `/desbloquear` ou `/api/desbloquear`
- Config: `window.AJEITA_PIX_BACKEND_URL` no index.html (linha ~11)

---

## 📝 Registro de evidências (preencher durante a investigação)

| # | Timestamp | Origem | Evento | Dados | H confirm/rej |
|---|---|---|---|---|---|
| 1 | 2026-10-09 | curl remoto | POST /api/profissional/pedido/desbloquear-atomico (ASCII) body={} | HTTP 400 PARAMETROS_OBRIGATORIOS (rota BATE) | H1 (URL errada) **REJEITADA** |
| 2 | 2026-10-09 | curl remoto | POST /api/profissional/pedido/desbloquear-atômico (literal UTF-8 ô) body={} | HTTP 400 PARAMETROS_OBRIGATORIOS (rota BATE) | H3 (rota não existe) **REJEITADA** |
| 3 | 2026-10-09 | curl remoto | POST /api/profissional/pedido/desbloquear-at%C3%B4mico (%C3%B4) body={} | HTTP 400 PARAMETROS_OBRIGATORIOS (rota BATE) | H3 **REJEITADA** |
| 4 | 2026-10-09 | curl remoto | POST /api/profissional/pedido/rota-inexistente-xyz body={} | HTTP 404 GLOBAL handler (endpoint realmente não existe) | — |
| 5 | 2026-10-09 | inspect server.js L2797 | PASSO_ERRO(404,'PEDIDO_NAO_ENCONTRADO') | Backend usa HTTP 404 para ERRO DE DOMÍNIO (pedido não no FS). Frontend interpreta 404 QUALQUER como "rota não encontrada / servidor dormindo" | H nova (H7: **404 semântico vs 404 real**) **CONFIRMADA** |
| 6 | 2026-10-09 | inspect index.html submitSolicitarOrçamento L9131 | `_pedidoSyncFirestore(novo)` é fire-and-forget `try/catch` vazio. Se Firebase SDK offline ou falha, pedido fica SÓ localStorage → ao desbloquear, backend não encontra → **404 PEDIDO_NAO_ENCONTRADO** → toast errado | H8 (falta sincronia pedido FS) **CONFIRMADA** (causa raiz) |
| 7 | 2026-10-09 | inspect index.html L9642-L9647 | `_eErro404ForaDoAr(chamada)` retorna true p/ status 404 QUALQUER. Checa só status num, não `resp.error` → mesmo erro de negócio (PEDIDO_NAO_ENCONTRADO) cai em "30 segundos enquanto a instância acorda" | H9 (frontend não distingue 404 semântico) **CONFIRMADA** |


---

## 🛠 Resumo operacional (pré-fix)
Ainda sem correções. Coletando evidências.
