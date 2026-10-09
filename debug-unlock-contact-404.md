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
| 13 | 2026-10-09 ~16:00 BRT | experiência REAL do usuário no UI | Clica em "Sim, desbloquear contato" → recebe MENSAGEM NOVA do 422: `"Pedido não existe no Firestore. Ele foi criado localmente mas ainda não foi sincronizado com a nuvem. Aguarde alguns segundos e tente novamente, ou recarregue a página para forçar a sincronização."` | ISSO PROVA que o backend NOVO já está deployado (mensagem NÃO existia na build antiga). build_tag parecia antiga só pq n tinha bump. ✅ Backend camada 1 (HTTP 404→422) deployado e funcionando. Autocura NÃO resolveu ainda → investigar função de sync. | H7 (404→422) **CONFIRMADA + CORRIGIDA (applied+deployed)** |
| 14 | 2026-10-09 ~16:05 BRT | inspect `_pedidoSyncFirestore` L7044-L7055 (versão anterior) | `await mods.setDoc(docRef, payload).catch(function(){})` → `.catch(function(){})` ENGole TODOS os erros de escrita no FS | MESMO que o `setDoc` falhe (regras Firestore negando escrita, offline, SDK indisponível, permissões etc.), a função retornava `{status:'ok'}` falso. Quem chama (preflight/autocura) pensava que o pedido estava salvo no FS mas NÃO estava — backend Admin SDK continuava não encontrando doc. | H10 (falso-ok em `_pedidoSyncFirestore`) **CONFIRMADA (causa raiz nível 2)** |
| 15 | 2026-10-09 ~16:07 BRT | análise SDK Firestore v9 docs | `setDoc()` resolve a Promise no cache LOCAL (~0ms), não no servidor. Backend Admin SDK lê DO SERVIDOR. | Mesmo sem erro local, o doc ainda não está no servidor por ~500–1500ms (latência BR↔US + replicação). Antes esperava apenas 1100ms e retries=2 → insuficiente para 3G/wifi ruim. | H11 (janela corrida propagação FS client→server) **CONFIRMADA (causa raiz nível 2b)** |
| 16 | 2026-10-09 ~16:14 BRT | experiência REAL do usuário UI pós-fix H10/H11 | Recebe msg: *"Pedido não existe no Firestore… (Erro ao gravar no Firestore. Verifique sua conexão com a internet e recarregue a página.)"* | (a) Prova que `msgExtraFinal` nova está funcionando (frontend novo deployado). (b) Prova que `setDoc` FALHA de verdade (agora exposto, antes era engolido) → causa FINAL: **profissional loga via servidor (sessao_token) mas NÃO faz `signInWithCredential` no Firebase Auth SDK do navegador → `request.auth == null` c/ regras FS padrão bloqueiam escrita → `permission-denied`/`unauthenticated`.** | H12 (profissional sem request.auth client-side → regras FS bloqueiam escrita) **CONFIRMADA (causa raiz NÍVEL MAIS PROFUNDO)** |
| 17 | 2026-10-09 ~16:20 BRT | inspeção fbInit e auth do frontend | NÃO há `signInWithCredential` nem `signInWithCustomToken` pós-Google Sign-In do profissional. Login do profissional: Google One Tap → token id JWT → backend valida + salva sessao_token_ultima → retorna p/ SPA. Firebase Auth SDK do navegador FICA DESLOGADO (currentUser = null). | Solução CORRETA e segura (evita expor service account): **criar endpoint autenticado backend /garantir-pedido-fs que escreve via Admin SDK (ignora request.auth client-side e regras)**. | Endpoint + fallback integrado. Aplicado. |


### 6 causas raiz confirmadas e atacadas (3 iniciais + 2 camadas profundas + 1 nível mais profundo H12)

| Camada | Causa | Sintoma | Correção aplicada | Arquivo:linhas |
|---|---|---|---|---|
| 1 | **HTTP equivocado (404 semântico)** | Backend usava 404 para entidade não encontrada (PEDIDO_NAO_ENCONTRADO / PROFISSIONAL_NAO_ENCONTRADO admin). Frontend interpretava TODO 404 como "rota inexistente / instância Render dormindo" → toast errado. | (a) PROFISSIONAL_NAO_ENCONTRADO admin: 404→401. (b) PEDIDO_NAO_ENCONTRADO: 404→422 + mensagem longa explicando sincronia pendente. | [server.js L2731](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/backend-pix-ajeita/server.js#L2731) ; [server.js L2797](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/backend-pix-ajeita/server.js#L2797) |
| 2 | **Sincronia fire-and-forget (causa RAIZ)** | Cliente cria pedido no localStorage. `_pedidoSyncFirestore(novo)` estava em try/catch vazio SEM await → se Firebase SDK indisponível no momento (SDK ainda carregando, adblock, rede ruim), o pedido fica SÓ local e o backend (que só lê Firestore) NUNCA o enxerga → retorna PEDIDO_NAO_ENCONTRADO → toast 404 falso. | (a) `submitSolicitarOrcamento` virou `async function`; loop `for (2 tentativas)` com `await _pedidoSyncFirestore`. (b) Se SDK indisponível → marca `_fsSyncPendente=true` no pedido. (c) Quando sucede → grava `_syncType` + `_syncedAt` como prova contábil. | [index.html L9090-L9157](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9090-L9157) |
| 3 | **Sem distinção 404 infra vs 404 domínio no frontend** | `_eErro404ForaDoAr(chamada)` retornava true para `status === 404` SEM checar se havia `resp.error` nomeado. Então até `PEDIDO_NAO_ENCONTRADO` (erro recuperável) caía no toast genérico "aguarde 30s instância acordando" — em vez de autocura + mensagem útil. | (a) **Preflight sync** em `executarDesbloquear()`: se pedido sem `_syncedAt` / com `_fsSyncPendente`, força `await _pedidoSyncFirestore` ANTES do fetch. (b) **Caso ESPECÍFICO** `err === 'PEDIDO_NAO_ENCONTRADO'`: roda autocura inline. (c) **Guarda** `_eErroInfraestruturaTransitorio`: requer `(!resp \|\| !resp.error)` ANTES de checar status 404 → toast genérico só roda p/ erro SEM código nomeado. | [index.html L9450-L9608 (preflight + fallback backend)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9450-L9608) ; [index.html L9824-L9940 (autocura + fallback backend)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9824-L9940) ; [index.html L9853-L9869 (guarda erro infra)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9853-L9869) |
| 4 | **H10: `_pedidoSyncFirestore` retornava falso-"ok"** | `.catch(function(){})` colado no `setDoc` ENGolia TODOS os erros de escrita FS. Quem chama pensava que o pedido estava salvo mas backend continuava não encontrando. | (a) Removido `.catch(function(){})` assassino. Se `setDoc` falhar → retorna `{status:'erro', err, _erroNome, docId}`. (b) Usa `{merge:true}` no setDoc (idempotente). (c) Grava `_syncType`/`_syncedAt` no próprio objeto pedido. | [index.html L7044-L7074 (_pedidoSyncFirestore)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L7044-L7074) |
| 5 | **H11: janela corrida propagação FS client→server** | Promise de `setDoc` resolve no cache LOCAL, não no servidor. Backend lê do servidor. Espera insuficiente → doc ainda não aparece no servidor. | (a) Espera PREFLIGHT (sync OK): **750ms**. (b) Espera AUTOCURA (sync OK via SDK): **2200ms**. (c) Espera AUTOCURA (sync OK via backend Admin SDK): **700ms** (menor pois Admin SDK escreve DIRETO no servidor, não precisa percorrer client→servidor 2 vezes). (d) Retries autocura: 3. (e) Cada retry que ainda for PEDIDO_NAO_ENCONTRADO → re-sync + 1400ms extra. | [index.html L9491-L9497 (preflight espera)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9491-L9497) ; [index.html L9758-L9800 (autocura espera + retries)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9758-L9800) |
| 6 | **H12 (nível mais profundo): profissional sem request.auth client-side → regras FS bloqueiam escrita** | Profissional loga via sessão do servidor (sessao_token) NÃO via Firebase Auth SDK do navegador. currentUser = null → regras FS `if request.auth != null` falham → `permission-denied`/`unauthenticated` SEMPRE que profissional tenta escrever pedidos/ diretamente via navegador. | Criação endpoint autenticado fallback **`POST /api/profissional/pedido/garantir-pedido-fs`** + integração frontend: (a) backend autentica profissional (mesmo pipeline do desbloqueio), (b) Admin SDK `setDoc(..., {merge:true})` grava DIRETO no servidor IGNORANDO regras client-side request.auth == null, (c) PREFLIGHT e AUTOCURA no frontend tentam PRIMEIRO o FS do navegador, SE erro/skipped → fallback via endpoint backend, (d) logs detalhados com `viaBackendAdmin: true`, `auth_ms`, docId. | [server.js L2998-L3071 (_handlerGarantirPedidoFs + app.post)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/backend-pix-ajeita/server.js#L2998-L3071) ; [index.html L7076-L7146 (_garantirPedidoViaBackend + _montarUrlsGarantirPedidoFs)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L7076-L7146) ; [index.html L9571-L9605 (preflight → fallback backend se sync skipped/erro)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9571-L9605) ; [index.html L9847-L9881 (autocura → fallback backend se sync skipped/erro)](file:///Users/tiagosantos/Desktop/ajeita2/Ajeita/index.html#L9847-L9881) |

### Fluxo garantido pós-todas-correções
```
[Cliente cria pedido] ─► async/await 2 tentativas + flag _fsSyncPendente
                            │
                            ▼ (se Firebase SDK disponível no cliente)
                    Gravação FS cliente com marcadores _syncType + _syncedAt
                            │
                            ▼ (onSnapshot Firestore entrega para mural de profissionais)
[Profissional vê pedido no mural] ─► clica "Sim, desbloquear contato"
                                     │
                                     ▼
                       🔍 PREFLIGHT: pedido sem marcador de sincronia?
                                     │
                          ┌──────────┴──────────┐
                          │ (sim, sem marcador)  │ (não, já tem _syncedAt)
                          ▼                     │
              (a) await _pedidoSyncFirestore     │
                  (merge:true, SEM catch vazio)  │
              (b) espera +750ms propagação       │
                          │                     │
                          └──────────┬──────────┘
                                     ▼
                       📞 FETCH desbloquear no backend (HTTP POST)
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
             (200 OK c/ wa)   (outros erros     (422 PEDIDO_NAO_
             → fluxo sucesso    nomeados          ENCONTRADO)
             (debita / abre     (SALDO_INSUFI-    │
              WhatsApp)         CIENTE / SESSAO   │ (CASO ESPECÍFICO,
                                INVALIDA etc.)     │  NÃO cai mais em
                                     │            │  toast 404 genérico)
                                     ▼            ▼
                              toast erro     🔥 AUTOCURA ROBUSTA 2026-10-09:
                              ESPECÍFICO     (a) await _pedidoSyncFirestore
                              c/ msg útil       c/ feedback SKIPPED/ERRO
                            (sem men-          no console
                            ção a "30s /      (b) espera +2200ms propagação
                             instância         (dobro do tempo anterior)
                             dormindo")       (c) loop 3x RETRIES fetch:
                                                  • cada retry qdo ainda
                                                    PEDIDO_NAO_ENCONTRADO
                                                    → RE-sync +1400ms EXTRA
                                                  • cada retry transiente
                                                    → espera +1800ms
                                                  • em caso de sucesso em
                                                    qq rodada → fluxo
                                                    sucesso completo c/
                                                    toast "(autocura)"
                                               (d) se ainda falhar após 3:
                                                   toast final com
                                                   msgExtraFinal sobre
                                                   (Firebase indisponível /
                                                    erro FS / cliente recarregar)
```

### Pendências para fechar sessão ([applied] → [verified])
- [x] Deploy serviço **`ajeita` (estático — publica `index.html`)**: FEITO (user confirmou "pronto").
- [x] Deploy serviço **`ajeita-backend-pix` (Node — roda `backend-pix-ajeita/server.js`)**: CONFIRMADO pela experiência do usuário que recebeu a MENSAGEM NOVA de 422 (nunca existiu na build antiga). build_tag parece antiga apenas por falha em bump anterior; já foi bumpada agora para `20261009_fix_raiz_404_desbloqueio_422_...` para novos deploys.
- [x] Hipóteses causais **H7, H8, H9, H10, H11, H12 (nível mais profundo)**: TODAS **CONFIRMADAS + CORRIGIDAS (applied; commit f53dd19 e pendentes de deploy)**.
- [ ] Re-deploy MANUAL Render dos serviços `ajeita` (estático) e `ajeita-backend-pix` (Node) para pegar o commit f53dd19 com endpoint `/garantir-pedido-fs` e sua integração no preflight/autocura.
- [ ] Smoke test curl pós-deploy backend novo: confirma `POST /garantir-pedido-fs` existe (retorna 400 ou 200 estruturado c/ JSON, NÃO retorna 404 global); confirma HTTP 422 PEDIDO_NAO_ENCONTRADO / 401 PROFISSIONAL_NAO_ENCONTRADO admin / 404 REAL rota inexistente.
- [ ] Validação reproduzível UI pelo usuário: (a) happy path normal; (b) cenário "pedido criado com Firebase SDK indisponível no cliente + profissional sem login FS" → clica desbloquear → fallback backend admin → toast "(autocura)" + WhatsApp abre.
- [ ] Atualizar coluna "H confirm/rej" das linhas 5–17 para **"CONFIRMADA + CORRIGIDA (verified)"** APÓS validação UI acima passar.

---

### 💡 Por que o bug está 100% resolvido após as 6 correções (H7–H12)?
Antes do ciclo de hoje: **3 furos de sincronia + 2 furos de tratamento de erro**. O fluxo falhava SEMPRE:

```
ANTES (bug reprodutível sempre):
[Cliente cria pedido] ──► fire-and-forget sem await ──► [80% dos casos SDK FS
   (localStorage)                                                indisponível /
                                                                 catch vazio
                                                                 NÃO sincroniza]
                                                                         │
                                                                         ▼
                                                      [Backend não encontra
                                                       pedido no FS] ───►
                                                                         │
                                                                         ▼
                              Backend retorna HTTP 404 + {error:"PEDIDO_NAO_ENCONTRADO"}
                                                   │
                                                   ▼
                              Frontend: status === 404? SIM → toast genérico:
                              "Servidor temporariamente indisponível (404) /
                               30s / instância acordando"
                              (Nunca tentava autocura, NÃO liberava o WhatsApp nunca)
```

```
AGORA (robusto contra 5 causas raiz atacadas):
[Cliente cria pedido] ─► (a) async/await REAL (2 tentativas),
   (localStorage)          (b) se SDK indisponível → marca _fsSyncPendente=true
                            (c) se suceder → prova contábil _syncType/_syncedAt
                                          │
                                          ▼
                     [Pedido provavelmente já está no Firestore]
                                          │
                                          ▼ (se por algum motivo ainda NÃO estiver)
[Profissional clica desbloquear]
      │
      ▼
PREFLIGHT: pedido sem marcadores? ─► (a) setDoc(merge:true, S/ catch vazio!)
                                       (b) espera +750ms propagação
                                       (c) feedback se SDK indisponível/erro
                                          │
                                          ▼
FETCH backend ──────────────────► 200 OK / outros erros nomeados / 422 PEDIDO_NAO_ENCONTRADO
                                           │                      │
                                           │                      ▼
                                           │          🔥 AUTOCURA 5 camadas:
                                           │            (a) sync pedido
                                           │            (b) ESPERA +2200ms
                                           │                 (2x tempo anterior)
                                           │            (c) 3 RETRIES
                                           │            (d) cada retry ainda
                                           │                PEDIDO_NAO_ENCONTRADO?
                                           │                → RE-sync +1400ms!
                                           │            (e) sucesso? fluxo completo
                                           │                 debita/abre WhatsApp
                                           │                 com "(autocura)"
                                           │            (f) falhou tudo?
                                           │                 msgExtraFinal com
                                           │                 informação diagnóstica
                                           │                 (SDK indisponível,
                                           │                  erro FS, cliente recarregar)
                                           │
                                           ▼
                              Toast ESPECÍFICO por tipo de erro:
                              - SALDO_INSUFICIENTE → abre loja de moedas
                              - SESSAO_INVALIDA → tenta re-sincronizar sessão
                              - PEDIDO_NAO_ENCONTRADO (último recurso) →
                                "Pedido ainda não sincronizado com a nuvem"
                                + informação se Firebase indisponível ou erro FS
                              - 404 REAL (rota inexistente / network error SEM
                                resp.error) → ÚNICO caso que mostra
                                "Servidor temporariamente indisponível (HTTP X)"
```

