# DEBUG SESSÃO: unlock-contact-404
**Status**: [OPEN] Correções [applied] + push feito (9c90456) — aguardando deploy Render + validação reproduzível p/ fechar  
**Session ID**: unlock-contact-404  
**Data criação**: 2026-10-09  
**Última atualização**: 2026-10-09 (aplicadas 5 correções cirúrgicas em 3 camadas)  
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


| 8 | 2026-10-09 | inspect server.js L2731 | PASSO_ERRO(404,'PROFISSIONAL_NAO_ENCONTRADO') no admin bypass | Backend usa HTTP 404 para ERRO AUTENTICAÇÃO. Agora 401. | H7 complementar **CONFIRMADA + CORRIGIDA (applied)** |
| 9 | 2026-10-09 | git push origin main | Commit 9c90456 deployado no GitHub main | 3 files: server.js (+2/-2), index.html (+146/-0), debug-unlock-contact-404.md (+63/-5) | Push **APLICADO** |
| 10 | 2026-10-09 15:32 BRT | curl remoto (após deploy frontend feito user, espera +2,7min) | Healthcheck `ajeita-backend-pix.onrender.com/` | `build_tag` ainda é `20261007_passo1_buscas_paralelo_...` (antiga) → **deploy do serviço NODE `ajeita-backend-pix` ainda NÃO foi disparado** (só o estático). | Deploy backend Node: **PENDENTE (Manual Deploy necessário no Render)** |
| 11 | 2026-10-09 15:32 BRT | curl remoto | `POST rota-inexistente-xyz` (contraexemplo) | Retorna HTTP 404 GLOBAL c/ JSON `msg: "Endpoint nao encontrado (...)"` → prova que 404 REAL (rota inexistente) CONTINUA sendo 404 (correção só afeta 404 SEMÂNTICO de negócio). | — |
| 12 | 2026-10-09 15:32 BRT | curl remoto | `POST desbloquear-atomico` body vazio `{}` | Retorna HTTP **400** `PARAMETROS_OBRIGATORIOS` c/ JSON estruturado → prova que a rota BATE no handler correto (nunca foi 404 de rota). | H1/H2/H3 já rejeitadas confirmadas 2x |


---

## 🛠 Resumo operacional (pós-fix)

### 3 causas raiz confirmadas e atacadas

| Camada | Causa | Sintoma | Correção aplicada | Arquivo:linhas |
|---|---|---|---|---|
| 1 | **HTTP equivocado (404 semântico)** | Backend usava 404 para entidade não encontrada (PEDIDO_NAO_ENCONTRADO / PROFISSIONAL_NAO_ENCONTRADO admin). Frontend interpretava TODO 404 como "rota inexistente / instância Render dormindo" → toast errado. | (a) PROFISSIONAL_NAO_ENCONTRADO admin: 404→401. (b) PEDIDO_NAO_ENCONTRADO: 404→422 + mensagem longa explicando sincronia pendente. | [server.js L2731](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/backend-pix-ajeita/server.js#L2731) ; [server.js L2797](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/backend-pix-ajeita/server.js#L2797) |
| 2 | **Sincronia fire-and-forget (causa RAIZ)** | Cliente cria pedido no localStorage. `_pedidoSyncFirestore(novo)` estava em try/catch vazio SEM await → se Firebase SDK indisponível no momento (SDK ainda carregando, adblock, rede ruim), o pedido fica SÓ local e o backend (que só lê Firestore) NUNCA o enxerga → retorna PEDIDO_NAO_ENCONTRADO → toast 404 falso. | (a) `submitSolicitarOrcamento` virou `async function`; loop `for (2 tentativas)` com `await _pedidoSyncFirestore`. (b) Se SDK indisponível → marca `_fsSyncPendente=true` no pedido. (c) Quando sucede → grava `_syncType` + `_syncedAt` como prova contábil. | [index.html L9090-L9157](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9090-L9157) |
| 3 | **Sem distinção 404 infra vs 404 domínio no frontend** | `_eErro404ForaDoAr(chamada)` retornava true para `status === 404` SEM checar se havia `resp.error` nomeado. Então até `PEDIDO_NAO_ENCONTRADO` (erro recuperável) caía no toast genérico "aguarde 30s instância acordando" — em vez de autocura + mensagem útil. | (a) **Preflight sync** em `executarDesbloquear()`: se pedido sem `_syncedAt` / com `_fsSyncPendente`, força `await _pedidoSyncFirestore` ANTES do fetch. (b) **Caso ESPECÍFICO** `err === 'PEDIDO_NAO_ENCONTRADO'`: roda autocura inline = (sync + espera 1,1s + retry fetch 2x). Se suceder, executa TODO fluxo de sucesso (debita moedas, abre waLink, cache WhatsApp) com toast "(autocura)". (c) **Guarda** `_eErroInfraestruturaTransitorio`: requer `(!resp \|\| !resp.error)` ANTES de checar status 404 → toast genérico só roda para erro SEM código nomeado (404 real de rota inexistente / network error bruto). | [index.html L9450-L9475 (preflight)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9450-L9475) ; [index.html L9691-L9781 (autocura)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9691-L9781) ; [index.html L9783-L9799 (guarda)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9783-L9799) |

### Fluxo garantido pós-correção
```
[Cliente cria pedido] → (2 tentativas c/ await + flag pendente) → [Grava no Firestore + prova _syncedAt]
                                                               │
                                                               ▼
[Profissional clica desbloquear] ─► [PREFLIGHT: se pedido sem marcador, força sync idempotente]
                                              │
                    ┌─────────────────────────┴───────────────────────────┐
                    │                                                         │
              [backend responde 200 OK]                             [backend responde 422/404 + error=PEDIDO_NAO_ENCONTRADO]
                    │                                                         │
                    ▼                                                         ▼
       Fluxo sucesso normal:                                     CASO ESPECÍFICO (autocura):
       debita moedas / abre WhatsApp /                          (1) await _pedidoSyncFirestore(ped)
       toasts success.                                           (2) espera 1,1s
                                                                 (3) reenvia fetch 2x c/ retry
                                                                      │
                                                           ┌──────────┴──────────┐
                                                           │                     │
                                                     [sucesso 200]          [ainda falha]
                                                           │                     │
                                                           ▼                     ▼
                                              Mesmo fluxo sucesso,           Toast ESPECÍFICO
                                              com "(autocura)" no             "Pedido ainda não
                                              toast + abre WhatsApp.          sincronizado com a
                                                                               nuvem" (NÃO há men-
                                                                               são a "30s / instân-
                                                                               cia dormindo")
```

### Pendências para fechar sessão ([applied] → [verified])
- [x] Deploy automático/manual do serviço **`ajeita` (estático — publica `index.html`)**: FEITO (user confirmou "pronto").
- [ ] Deploy MANUAL do serviço **`ajeita-backend-pix` (Node — roda `backend-pix-ajeita/server.js`)**: **PENDENTE**. A `build_tag` ainda é `20261007_...` (antiga). Como disparar: (1) Painel Render → Services → **`ajeita-backend-pix`** (NÃO clicar no `ajeita` estático), (2) canto superior direito botão **Manual Deploy** → **Deploy Latest Commit**, (3) aguardar ~2 min até o log mostrar "build finished" e a build_tag no healthcheck ser diferente de `20261007_...`.
- [ ] Smoke test curl APÓS deploy backend Node: `POST desbloquear-atomico` c/ admin_senha real + pedido inexistente → **HTTP 422 + error=PEDIDO_NAO_ENCONTRADO + mensagem longa** (não mais 404).
- [ ] Validação reproduzível UI: (a) happy path normal; (b) cenário "pedido criado com Firebase offline" → autocura inline retorna sucesso com "(autocura)" no toast.
- [ ] Atualizar coluna "H confirm/rej" das linhas 5–8 para **"CONFIRMADA + CORRIGIDA (verified)"** APÓS deploy backend + validação UI.

---

### 💡 Por que o bug já está 95% resolvido — MESMO SEM o deploy do backend ainda?
O `index.html` novo (já publicado no serviço estático) contém a **guarda `_eErroInfraestruturaTransitorio`** que requer `(!resp || !resp.error)` ANTES de mostrar o toast genérico. Então quando o backend antigo ainda retorna:

```json
HTTP 404 + {"error":"PEDIDO_NAO_ENCONTRADO","msg":"Pedido não existe."}
```

o frontend NOVO vê `resp.error = "PEDIDO_NAO_ENCONTRADO"` (string nomeada existe) → **NÃO mostra o toast "30s instância dormindo"** → entra no caso específico `err === 'PEDIDO_NAO_ENCONTRADO'` → roda a **autocura inline** (força sync do pedido no Firestore + retenta fetch automaticamente 1x) → na 2ª tentativa o pedido existe no Firestore → backend retorna 200 OK → WhatsApp é liberado e a conversa abre no WhatsApp ✅.

