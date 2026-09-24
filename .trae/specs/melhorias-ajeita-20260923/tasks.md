# Tasks — Melhorias AjeitaAi (2026-09-23)

> Ordem de execução dependente. Prioridades: high primeiro; cada task tem Test Requirements (rule/rubric) antes da execução.
> Pasta spec: `/Users/tiagosantos/Desktop/Ajeita/.trae/specs/melhorias-ajeita-20260923/`.

## 🏗️ Task 1: Corrigir causa raiz cache e idempotência MP (base para tudo)

**Prioridade**: high
**Depende**: nenhuma
**Acertos Cobertos**: AC-CACHE-001, AC-CACHE-003, AC-PAG-003, AC-PAG-006
**Alterações**:
1. `index.html` — remover loop `carregarDadosStorageBootstrap` L1900-L1907 que injeta `PROFISSIONAIS_MOCK[i]` em storage por posição.
2. `server.js` — adicionar idempotência início `processarAprovacaoPix`: ler doc pix_transacoes → se já `status==='aprovado'` → console.log `[IDEMPOTENCIA] SKIP ja aprovado` → retornar true SEM creditar saldo Moedas, SEM inserir recarga duplicate.
3. `server.js` — external_ref FORMATADO no `POST /api/pix/criar-recarga-moedas`: `RECARGA_PRO_<uid>_<ts>` em vez de `ajeita_moeda_*` (garante compatibilidade; external_ref antigos nao processarão nada novo).
4. `server.js` — comentário em confirmarPagamentoPix frontend (já não aprova; só start listeners) + confirmar no modo automático que `_pixModoAtual === 'automatico_mp'` não executa `saldoMoedas +=` local.

### Test Requirements (TR) Task 1
- **rule TR1.01**: grep index.html após modificado `PROFISSIONAIS\[i\]\.taxaHora === 0` → 0 matches (loop merge removido).
- **rule TR1.02**: `processarAprovacaoPix` 1ª linha lê doc; se `transacao.status === 'aprovado'` retorna sem `saldoMoedas += qtdMoedas` executar (evidenciar por código).
- **rule TR1.03**: external_ref nova rota `/api/pix/criar-recarga-moedas` começa com `RECARGA_PRO_` (confirmar por código linha).
- **rule TR1.04**: função `confirmarPagamentoPix` index.html não tem linha `saldoMoedas` nem `avaliacoes.push` nem atribuição de status pagamento aprovado local.

---

## 🏗️ Task 2: Segurança e switch externa_ref webhook MP + CRON multipropósito

**Prioridade**: high
**Depende**: Task 1
**Acertos Cobertos**: AC-PAG-001, AC-PAG-002, AC-PAG-004, AC-PAG-005, RF-PAG-02
**Alterações** (todas `backend-pix-ajeita/server.js`):
1. Melhorar `_validarAssinaturaWebhookMp`: em MODO PRODUÇÃO REAL (APP_USR) se secret vazio → log `ALTO RISCO: MP_WEBHOOK_SECRET VAZIO EM PROD` console.error (mas não aborta).
2. Em `processarAprovacaoPix`, pegar external_ref e fazer switch prefix:
   - `if (startsWith('RECARGA_PRO_')) → _creditarMoedasProfissional(...)`
   - `if (startsWith('SPONSOR_')) → _ativarPatrocinadorPorPagamento(...)` (novo, stub inicial com console.log + DB write placeholder; função cheia na Task 3)
   - `default`: log warning tipo desconhecido, não quebra.
3. No `setInterval` 15s existente: adicionar 2 novos blocos APÓS loop pix_transacoes:
   a. Bloco patrocínios pendentes: `collection('patrocinadores').where().get()` (sem where proíbe índice; lista todos, filtra NODE memória: `status_pag != approved AND external_reference definido AND nao vazio`) → para cada chamar `_consultarPagamentoMpPorExternalRef()` e se aprovado → `_ativarPatrocinadorPorPagamento`.
   b. Bloco expiração: `collection('patrocinadores').get()` (coleção pequena), filtra `status_patrocinador==='ativo' AND data_termino < now` → update `status_patrocinador='expirado' + updated_at`. (não apaga).
4. GET `/api/patrocinadores/ativos`: novo endpoint; filtra backend ativos + datas vigentes; retorna array JSON.

### Test Requirements (TR) Task 2
- **rule TR2.01**: Código server.js contém `if (MODO_PRODUCAO_REAL && !MP_WEBHOOK_SECRET) console.error('ALTO RISCO...')`.
- **rule TR2.02**: `processarAprovacaoPix` tem 3 branches switch (RECARGA_PRO, SPONSOR, default warn).
- **rule TR2.03**: setInterval 15s contém 3 blocos sequenciais: pix_transacoes → patrocínios_pendentes → expiração.
- **rule TR2.04**: nova rota `/api/patrocinadores/ativos` existe; retorna somente `ativo + dentro_vigencia` (ver código filter).

---

## 🏗️ Task 3: Backend patrocinadores CRUD MP criar pagamento + ativar idempotente

**Prioridade**: high
**Depende**: Task 2
**Acertos Cobertos**: AC-PAT-001, AC-PAT-002, AC-PAT-003, AC-PAT-004, RF-PAG-04, RF-PAT-02, RF-PAT-03
**Alterações**:
1. `backend-pix-ajeita/server.js` — Criar `POST /api/patrocinadores/criar-pagamento`:
   - Recebe payload: `nome_empresa, categoria, descricao, whatsapp, site, instagram, logo (base64 null), cartao_visita, fotos[], plano, patrocinador_uid_criador`
   - Valida: plano bronze=30dias/R$50, prata=60dias/R$120, ouro=90dias/R$240 (mínimos). Se preço personalizado abaixo mínimo → erro.
   - Gera `sponsorDocId = SPONSOR_<Date.now()>_<random>`.
   - Salva doc Firestore `patrocinadores/<sponsorDocId>` campos RF-PAT-01.
   - External_reference = `SPONSOR_<sponsorDocId>_<planoKey>_<ts>` (RE-USAR criação pagamento MP mesma função de /api/pix/criar-recarga-moedas).
   - Retorna QR code (mesmo padrão recarga: qr_code_base64, copia_cola, external_reference, valor).
2. Função `_ativarPatrocinadorPorPagamento(external_reference)` (substituir stub Task 2):
   - parse external_ref extrair sponsorDocId.
   - load doc; idempot: se status_patrocinador já ativo retorna.
   - set campos `status_pagamento=approved, status_patrocinador=ativo, data_inicio=now, data_termino=now+plano_dias, mp_payment_id, updated_at`.
   - console.log sucesso.
3. Novas rotas admin (opcional): `GET /api/patrocinadores/todos` admin only (senha bolo2024 header), `PATCH /api/patrocinadores/:id` (editar), `DELETE /api/patrocinadores/:id`.

### Test Requirements (TR) Task 3
- **rule TR3.01**: `POST /api/patrocinadores/criar-pagamento` existe; valida mínimo preço bronze ≥50, prata ≥120, ouro ≥240.
- **rule TR3.02**: Doc Firestore `patrocinadores` após a primeira chamada tem 21 campos RF-PAT-01 (ver console schema).
- **rule TR3.03**: `_ativarPatrocinadorPorPagamento` idempotente: chamada dupla → primeira atualiza tudo, segunda retorna sem doc write.
- **rule TR3.04**: external_ref do pagamento patrocinador começa com `SPONSOR_<id>_<plano>_<ts>` (grep código).

---

## 🏗️ Task 4: Frontend index.html — Expandir categorias 60+ e view ver todas

**Prioridade**: medium
**Depende**: Task 1
**Acertos Cobertos**: AC-CAT-001, AC-CAT-002, AC-CAT-003
**Alterações**: index.html
1. Substituir `CATEGORIAS_GLOBAIS = ['Pedreiro', ...8]` por `CATEGORIAS_GRUPOS` objeto novo (grupos 5, ~60 categorias).
2. Manter `CATEGORIAS_GLOBAIS` (8 itens mais populares para home).
3. Expandir `CATEGORIAS_ICONE` para 60 categorias; default ícone `fa-check` se faltar.
4. Adicionar botão "Ver todas →" ao lado do título "Categorias rápidas" na home. Clique `navigateTo('view-categorias-todas')`.
5. Nova view HTML `<section class="hidden view ..." id="view-categorias-todas">` com header voltar + barra pesquisa + 5 grupos de cards categorias clicáveis.
6. Formulário cadastro de profissional (checklist categorias): antes só `CATEGORIAS_GLOBAIS` 8 → agora renderizar todos os 60+ de `CATEGORIAS_GRUPOS.flat`.

### Test Requirements (TR) Task 4
- **rule TR4.01**: `CATEGORIAS_GRUPOS` objeto 5 grupos (Construção, Casa, Fretes, Aluguel, Projetos) contendo 60+ itens total (contar por código).
- **rule TR4.02**: `view-categorias-todas` view existe (grep id="view-categorias-todas"). Botão home existe `Ver todas`.
- **rule TR4.03**: `renderChecklistCategoriasCadastro` (ou equivalente) renderiza 60+ checkboxes (contar).

---

## 🏗️ Task 5: Frontend index.html — Seção banners patrocinadores + área patrocinador cadastro + fotos empresa

**Prioridade**: high
**Depende**: Task 3 + Task 4
**Acertos Cobertos**: AC-PAT-005, RF-PAT-06, RF-PAT-07
**Alterações**: index.html
1. Nova seção abaixo hero "🏷️ Empresas parceiras do AjeitaAi" → carrossel horizontal snap scroll + CSS animation transform translate x automático a cada 6s (sem biblioteca). Dados: onSnapshot `patrocinadores` filter ativo + fallback rota `GET /api/patrocinadores/ativos`.
2. Card patrocinador: imagem logo/cartão, nome, categoria, descrição curta, botão "👉 Conhecer empresa" (abre link na ordem whatsapp > site > instagram).
3. Nova view `view-area-patrocinador`: formulário campos RF-PAT-06 (nome_empresa, categoria, desc, whatsapp, site, instagram) + 3 inputs arquivo (📷 LOGO, 📇 Cartão visita, 📷 Fotos x3) + comprimir imagem canvas (função util `_comprimirImagem` reutilizavel para fotos pedidos também) + botão "Concluir cadastro e gerar pagamento" → chama `POST /api/patrocinadores/criar-pagamento` → modal QR code (mesmo do recarga de moedas).
4. Adicionar na home (abaixo categorias) card CTA "💼 Quero patrocinar o AjeitaAi!" que abre view-area-patrocinador.

### Test Requirements (TR) Task 5
- **rule TR5.01**: view `view-area-patrocinador` existe; formulário tem campos + 2 inputs arquivo separados (logo, cartao_visita) + fotos múltiplas.
- **rule TR5.02**: função `_comprimirImagem(file)` existe (reutilizável Task 7), retorna Promise<string> base64.
- **rule TR5.03**: Banners públicos só renderizam `status_patrocinador==='ativo' AND hoje_interno<=fim` (código filter).
- **rubric TR5.04 (0-2, threshold ≥1)**: qualidade visual banners patrocinadores (carrossel, layout, responsivo mobile).

---

## 🏗️ Task 6: Admin.html — Tab Patrocinadores + Botão Limpar Cache Admin

**Prioridade**: high
**Depende**: Task 3, Task 1 (cache)
**Acertos Cobertos**: AC-PAT-006, AC-CACHE-002, RF-PAT-08, RF-CACHE-02, RF-CACHE-03
**Alterações**: admin.html
1. Adicionar 3ª tab no mesmo header tabs de pedidos/profissionais: `🤝 Patrocinadores` (toggle state `_tabAdminAtual`).
2. Tabela colunas: Nome empresa, categoria, plano, valor, status_pagamento (cor por status), status_patrocinador, data_inicio, data_termino, MP payment_id, external_reference, ações.
3. Ações linha: ✏️ Editar (modal com inputs), 🚫 Ativar/Desativar admin, ✅ Forçar Aprovar Pagamento (apenas com checkbox explícito "Eu autorizo manualmente esta aprovação de pagamento (ação administrativa)" + campo motivo → preenche `aprovado_por_admin_manual=true, motivo_manual, status_pagamento=approved, status_patrocinador=ativo, data_inicio, data_termino`), 🗑️ Excluir (confirmação dupla).
4. Cabeçalho superior direito, ao lado de sair, botão `🧹 Limpar cache` só em admin.html.
5. Ao clicar limpar cache: apagar listagens `profissionais, pedidos, desbloqueios, recargas, avaliacoes, meusPedidosClienteIds, clienteUltimosDados, ajeita_ult_ext_ref_pix`; MANTER: profissionalLogado, adminLogado, configEconomia, clienteGoogleLogado. Depois: `carregarDadosStorageBootstrap()`, `fbSyncProfissionaisRealtime()`, `renderAdminDashboard()`, toast "Cache atualizado com sucesso. Sessão mantida."
6. Logs admin: toast "3 contas foram atualizadas" etc sempre em admin.html apenas; se tentar exibir em index.html, aborta.

### Test Requirements (TR) Task 6
- **rule TR6.01**: tab 🤝 Patrocinadores existe no admin.html; header tabs 3 items (pedidos, profissionais, patrocinadores).
- **rule TR6.02**: botão manual aprovar pagamento DESABILITADO a menos que checkbox marcado + motivo preenchido.
- **rule TR6.03**: botão `🧹 Limpar cache` existe; após clique: localStorage `adminLogado` existe (logado), `profissionais` storage é vazio ou recarregado por onSnapshot (sessão intacta).
- **rule TR6.04**: storage antes e depois (confirmar): `ajeita_moeda_app_profissionalLogado` NÃO foi removido.

---

## 🏗️ Task 7: Pedidos com 3 fotos cliente, visualização profissional

**Prioridade**: high
**Depende**: Task 5 (função util comprimir pronta), Task 8 opcional antes
**Acertos Cobertos**: AC-FOTO-001, AC-FOTO-002, AC-FOTO-003
**Alterações**: index.html
1. Reutilizar `_comprimirImagem` Task 5.
2. Form pedido/orçamento (view-criar-pedido): adicionar seção "📸 Fotos do serviço" com input arquivo multiple `accept="image/*" id="pedidoFotosInput"` + texto "Adicione até 3 fotos...".
3. Estado temporário `_pedidoEmEdicao.fotos = []; const MAX_FOTOS_PEDIDO = 3;`.
4. Ao selecionar arquivos:
   - Se total > 3 → toast "Máximo 3 fotos. Remova uma antes." → ignorar novas.
   - Cada arquivo validar tipo `image/*` e ≤5MB.
   - Chamar `_comprimirImagem` por arquivo → push base64 em fotos[].
   - Renderizar miniaturas abaixo (grid 3 cols) + botão × individual remover foto específica do array.
5. Ao submit do pedido: salvar `pedido.fotos = fotos` (3). Persistir localStorage + (se Task 8 foi feita) Firestore.
6. Em view detalhe pedido (profissional/cliente/admin): se `(pedido.fotos||[]).length>0` renderizar seção "📸 Fotos enviadas pelo cliente" com galeria grid.
7. Isolamento: só renderiza galeria SE `profissionalLogado.id === pedido.profissional_id OR (clienteGoogleLogado && pedido.cliente_id === clienteGoogleLogado.googleId) OR admin` (no admin sempre sim).

### Test Requirements (TR) Task 7
- **rule TR7.01**: Adicionar 4 arquivos → toast bloqueia e array length fica ≤3.
- **rule TR7.02**: Remover 1 de 3 → contador volta para 2; pode adicionar nova.
- **rule TR7.03**: Cada imagem tem type image e ≤5MB validado (código).
- **rule TR7.04**: view detalhe renderiza galeria só para autorizados (condição código presente).

---

## 🏗️ Task 8: Pedidos persistir Firestore + Notificações coleção + Sino profissional

**Prioridade**: high
**Depende**: Task 7 (pedido já com fotos)
**Acertos Cobertos**: AC-NOTIF-001, AC-NOTIF-002, AC-NOTIF-003, AC-NOTIF-004
**Alterações**: index.html
1. Ao criar pedido: duplicar write (já salva localStorage + novo write Firestore `pedidos/<pedidoDocId>`). Mesma estratégia `local_<id>` prefixo que profissionais.
2. Nova coleção `notificacoes`:
   - Ao criar pedido: adicionar doc notificacoes conforme RF-NOTIF-01 (tipo 'novo_pedido').
3. No front, quando usuário logado é profissional: rodar 2 novos onSnapshot:
   - `notificacoes where usuario_id_alvo == profissionalLogado.id AND tipo_usuario_alvo == 'profissional'` orderBy created_at desc LIMIT 50. Atualiza array `notificacoesDoProfissional[]`. Atualiza contador `contadorNotificacoesNaoLidas = notificacoesDoProfissional.filter(n => !n.lida).length`.
   - (Opcional): `pedidos where profissional_id == eu` → atualizar lista meus pedidos.
4. Sino 🔔: componente no header do profissional logado (top direita). Badge vermelho contador N. Clique abre drawer com lista últimas 20. Ao abrir drawer: batch update marcar as abertas como lida=true. Rodapé "Marcar todas como lidas" (batch).
5. Isolamento: Se logado não for profissional (admin/cliente), sino NÃO RENDERIZA. Cliente não onSnapshot notificacoes. Admin só no painel.
6. Isolamento forte: onSnapshot SEMPRE usa where filter by usuario_id_alvo e tipo.

### Test Requirements (TR) Task 8
- **rule TR8.01**: submit pedido cria doc notificacoes com usuario_id_alvo = profissional_id do pedido.
- **rule TR8.02**: contador sino = filter !lida.length; ver update a cada snapshot add.
- **rule TR8.03**: marcar todas lidas executa batch write 1x por Firebase.
- **rule TR8.04**: dois profissionais AB: A recebe notif, B filter retorna vazio (isolamento por where).

---

## 🏗️ Task 9: Persistência pedidos collection + rodar teste final sintaxe tudo

**Prioridade**: medium
**Depende**: Tasks 1-8 finalizadas
**Alterações**:
1. `GetDiagnostics` em index.html e admin.html, server.js.
2. Commit push para origin/main (deploy automatico).
3. Sumário final evidências do relatório final conforme user §26 final points 1-9.

### Test Requirements (TR) Task 9
- **rule TR9.01**: GetDiagnostics index.html/admin.html = 0 erros.
- **rule TR9.02**: Node syntax server.js `node -c server.js` = 0.
- **rule TR9.03**: Git push successful.

---

## Matriz de Risco e Isolamento por Task

| Task | Arquivos escritos | Pode conflitar? | Mitigação |
|---|---|---|---|
| 1 | index.html storage bootstrap + server.js idempot e ext_ref | Não (server altera função, index altera 1 loop) | serial |
| 2 | server.js | Não | serial após 1 |
| 3 | server.js | Não | serial após 2 |
| 4 | index.html categorias | Não (add arrays e view nova) | serial após 1 |
| 5 | index.html patrocinadores frontend | Conflita 4 se edita mesmo regiao? | Serial após 4 |
| 6 | admin.html (arquivo separado!) | NENHUM (arquivo diferente) | RODAR EM PARALELO com 5 se quiser; delegar |
| 7 | index.html pedido fotos | Conflita 5 mesmo arquivo? | Serial após 5 |
| 8 | index.html notif/ped firestore + sino | Conflita 7 mesmo arquivo | Serial após 7 |
| 9 | todos | Não | Final |

**Nota sobre concorrência**: Tasks 4 e 6 podem rodar em paralelo (arquivos diferentes) para acelerar; todo resto serial para não editar mesmo arquivo simultaneamente.

---

## Regras de Não Regressão (NR) (todas as tasks)

> **NR-01**: NENHUM existing botão recarga moedas, login profissional, login cliente, lista profissionais pode ter comportamento quebrado. Se uma alteração impacta código preexistente, a task que altera tem que adicionar o caso em seu TR e verificar.
> **NR-02**: NENHUM existing botão "Voltar para QR code" ou "Forçar verificação" de pagamento é removido; só mudanças de texto "verificação automática".
> **NR-03**: Credenciais admin10/bolo2024 preserva.
> **NR-04**: PREFIXO_STORAGE `ajeita_moeda_app_` nunca muda.
> **NR-05**: project_memory "API Pix NÃO aceita currency_id" → sempre garantir que currency_id NÃO É enviado no bodyCreate MP (já está hoje, manter).
> **NR-06**: "qr_code_base64" sempre garantir prefixo data:image/png;base64, (já aplicado hoje, manter).
> **NR-07**: build Render erro 254 = `.npmrc package-lock=false` já existe? → não alterar.
