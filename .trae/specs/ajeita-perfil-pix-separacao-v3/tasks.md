# Ajeita V3 — Perfil Profissional + Fluxo PIX Realista + Separação Visões (Implementation Plan)

## Task 1: Inicializar campos novos globals + Storage bootstrap (backward compat)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Adicionar 2 campos NOVOS no schema do objeto PROFISSIONAIS_MOCK (todos os 6 mocks): `bairrosAtendimento: []` (array com 1-2 bairros demo) e `taxaHora: 0/50/80` (valores demo). Adicionar também campo `sobre` como editável (já existe em mocks, só será editável no perfil).
  - Novas keys no objeto profissional persistentes: `email` (já adicionado no Google Login commit), `bairrosAtendimento: string[]`, `taxaHora: Number`. Garantir backward compat: se localStorage vier sem esses campos (usuários que já usaram app antes), carregar defaults `[]` e `0` no `carregarDadosStorageBootstrap`.
  - Novas keys no objeto `recargas` persistentes: `status: string ('pendente_processamento_pix' | 'aprovado')`, `gateway: string ('mercado_pago_simulado')`, `webhookTimestamp: number (Date.now())`. Default status 'aprovado' para recargas antigas.
  - Adicionar variáveis globais novas de runtime: `estadoPagamentoPix: 'qr'|'processando'|'aprovado'|'falhou' = 'qr'`, `_timeoutAutoWebhookPix = null` (handle do setTimeout 5s para poder limpar se usuário clica botão manual antes).
- **Acceptance Criteria Addressed**: AC-2 (campos novos salvos), AC-5 (estado pix processando), AC-6 (status recarga aprovado), NFR-3 (persistência)
- **Test Requirements**:
  - `rule` TR-1.1: Profissionais mock após atualização do index.html (antes localStorage ser limpo) carregam em carregarDadosStorageBootstrap e `profissionaisMock[0].bairrosAtendimento` é array, `taxaHora` é number, não quebra a página (nenhum erro TypeError console). Evidence: MCP Browser console messages `SyntaxError` count === 0; evaluate `typeof PROFISSIONAIS_MOCK[0].taxaHora === 'number' && Array.isArray(PROFISSIONAIS_MOCK[0].bairrosAtendimento)`.
  - `rule` TR-1.2: Carregar dados storage antigo (limpar apenas bairrosAtendimento do localStorage para simular usuários antigos) e `carregarDadosStorageBootstrap` retorna com profissionais já tendo fields novos default (bairrosAtendimento = [] || [bairro do profissional cadastrado] default; taxaHora = 0). Evidence: remove field via evaluate `JSON.parse(localStorage.ajeita_moeda_app_profissionais)[0].bairrosAtendimento = undefined`, roda `carregarDadosStorageBootstrap()`, verify `Array.isArray(profissionais[0].bairrosAtendimento) === true`.

---

## Task 2: Criar Nova View `view-profissional-perfil` (HTML + Form) + Nav Menu entry
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Adicionar section `<section id="view-profissional-perfil" class="view-section">` ANTES de view-admin-login (entre view-profissional-loja / view-meus-pedidos), com UI: (1) Header "Área do Prestador" badge, Título "👤 Meu Perfil" (h2), sub-título "Atualize seus dados públicos e gerencie sua conta". (2) Grid 1col md:3cols gap-6. COL 1-2 (md span-2): Card "Editar Perfil" (white rounded-3xl shadow) com 9 campos + botão salvar (ver AC). COL 3 (md span-1): 3 cards estatísticas (Saldo Moedas / Leads Comprados / Nota Média) com icone + valor + subtitulo (ver AC-4).
  - 9 campos form perfil (com labels, grid): (1) Nome Completo * input type=text id=perfilNome; (2) WhatsApp * id=perfilWhatsApp type=tel mascaraInputTel; (3) E-mail (opcional) id=perfilEmail type=text inputmode=email autocomplete=off autocorrect=off spellcheck=false (igual fix 73a46e0); (4) URL Foto Perfil id=perfilFotoUrl + preview IMG circular 128px id=perfilFotoPreview ao lado (oninput live update debounce 100ms); (5) Cidade * id=perfilCidade select mesmo valores view-home; (6) Bairros Atendimento (multiplos checkboxes em grid 2 cols): id container=perfilBairrosContainer — renderizados dinamicamente de array BAIRROS_POR_CIDADE global (criar nova constante); (7) Especialidades (8 categorias checkboxes iguais cadastro): id=perfilCategoriasContainer; (8) Taxa/Hora (R$) id=perfilTaxaHora type=text placeholder="R$ 50,00" (mascara moeda opcional ou só number); (9) Descrição Sobre Mim (textarea 4 linhas id=perfilSobre — campo `sobre` já existe no objeto profissional). 10) Botão "💾 Salvar Alterações" azul primário grande full width ou no final.
  - Criar função nova `abrirMeuPerfil()` = chama guard `if (!profissionalLogado) navigateTo('view-profissional-cadastro') + toast warning` SENÃO `navigateTo('view-profissional-perfil')` + chama `renderFormPerfilComDadosAtuais()`.
  - Criar função `renderFormPerfilComDadosAtuais()`: preenche todos 9 inputs com valores `profissionalLogado.*`, marca checkboxes correspondentes checked, atualiza img preview.
  - Criar função `salvarAlteracoesPerfil()` = validação campos obrigatórios, atualiza profissionalLogado + profissionais array, `salvarTodosGlobaisNoStorage()`, re-render `renderCatalogoProfissionais(); atualizarHeaderPorSessao(); toast success 'Perfil atualizado!'.`
  - Adicionar entrada no MENU DESKTOP e MENU MOBILE para "Meu Perfil" no grupo "profissionalLogado === true" (ver Task 5 separação visões).
- **Acceptance Criteria Addressed**: AC-1 (guarda view), AC-2 (form carrega + salva), AC-3 (preview foto live), AC-4 (estatísticas cards), FR-3.5
- **Test Requirements**:
  - `rule` TR-2.1: View existe no DOM (`document.getElementById('view-profissional-perfil') != null`) e inicialmente tem classe hidden (não active). Evidence: Browser MCP evaluate.
  - `rule` TR-2.2: Cria profissional fake e loga; chama `abrirMeuPerfil()`; após 400ms evaluate `document.getElementById('view-profissional-perfil').classList.contains('active') === true` + `document.getElementById('perfilNome').value.length > 3 && document.getElementById('perfilWhatsApp').value.length > 10`. Evidence: valores preenchidos != empty.
  - `rule` TR-2.3: Editar campo perfilNome para "TestePerfil 123" + taxaHora para 99 + marcar 2 checkboxes bairros + clicar salvar() → `profissionalLogado.nome === 'TestePerfil 123' && profissionalLogado.taxaHora === 99 && Array.isArray(profissionalLogado.bairrosAtendimento) && profissionalLogado.bairrosAtendimento.length === 2`. Evidence: evaluate objetos.
  - `rubric` TR-2.4: Qualidade visual/layout da view Meu Perfil. Dimension: Responsividade mobile/desktop + clareza campos. Scale 1-5. Anchors 1=campos sobrepostos;3=ok mas sem preview; 5=100% responsivo, cards estatísticos coloridos alinhados, foto preview lado campo, grupos campos com boa separação. Threshold >=4. Evidence: screenshot MCP take_screenshot view perfil.

---

## Task 3: Refatorar Modal Pix 4 Estados (QR / Processando / Aprovado / Falhou) + Função Webhook Simulada
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Expandir modal-pix HTML interno (atualmente só tem o estado QR Code fixo) com **3 containers NOVOS internos** DIVs separados (flex hidden default):
    - `#pixEstadoQr`: container ATUAL com QR Code + valor + chave copia cola + BOTÃO "📤 Já efetuei o pagamento (PIX)" (trocar texto do botão existente).
    - `#pixEstadoProcessando`: container NOVO: spinner fa-circle-notch fa-spin 5x esmeralda + título "Estamos verificando o pagamento junto ao nosso banco..." + infobox azul (icone info ⓘ) com texto do aviso de produção WEBHOOK + 2 botões: (1) outline cinza "← Voltar para QR Code" (troca estado qr, limpa auto-webhook timeout); (2) verde "🧪 Simular Webhook Aprovado (Demo)" chama simularAprovacaoWebhook().
    - `#pixEstadoAprovado`: container NOVO: icone fa-circle-check 5x verde esmeralda, título "Pagamento aprovado! 🎉", subtítulo, card resumo (qtd Moedas / Pacote / Valor Pago R$), botão "Ir para Mural / Pedidos" fecha modal.
    - `#pixEstadoFalhou` (placeholder opcional por enquanto vazio): só estrutura, UI mínima (icone xmark vermelho, Título pagamento recusado, botão tentar novamente).
  - Nova função `renderEstadoModalPix(estado)`: todos containers `#pixEstado*` recebem `hidden` e removido hidden apenas do escolhido. Limpa ou cria `_timeoutAutoWebhookPix` de acordo com estado.
  - Refatorar `abrirModalPix(pkg)`: sempre `estadoPagamentoPix = 'qr'` → `renderEstadoModalPix('qr')`; limpa timeout antigo.
  - Refatorar `confirmarPagamentoPix()` (que era antigo que credita imediatamente): AGORA NÃO CRÉDITA NADA. Apenas: (a) `estadoPagamentoPix='processando'`; (b) `renderEstadoModalPix('processando')`; (c) limpa timeout anterior; (d) seta `_timeoutAutoWebhookPix = setTimeout(simularAprovacaoWebhook, 5000)`; (e) toast info opcional "Aguardando confirmação do pagamento PIX...".
  - Nova função `simularAprovacaoWebhook()` = (1) guard estado = processando apenas; (2) limpa `clearTimeout(_timeoutAutoWebhookPix)` e reseta null; (3) executa lógica de crédito hoje em dia (atualizar saldo, push recargas com keys novas status='aprovado', webhookTimestamp, gateway='mercado_pago_simulado'); (4) `salvarTodosGlobaisNoStorage(); atualizarHeaderPorSessao(); renderLojaPacotes();` (5) `estadoPagamentoPix='aprovado'; renderEstadoModalPix('aprovado');` (6) toast verde 💸 (pacote.qtd moedas); (7) `setTimeout(()=>{ if (!modalPixAberto()) return; fecharModal('modal-pix'); }, 2500);`
  - Botão "Voltar QR Code" no processo = `estadoPagamentoPix='qr'; clearTimeout(_timeoutAutoWebhookPix); renderEstadoModalPix('qr');`
- **Acceptance Criteria Addressed**: AC-5 (não credita imediatamente), AC-6 (webhook auto 5s ou botão), AC-7 (aviso produção), NFR-1
- **Test Requirements**:
  - `rule` TR-3.1: ModalPix após abrir → pixEstadoQr not hidden, outros hidden. Evidence: evaluate classList.
  - `rule` TR-3.2: Clicar confirmarPagamentoPix (botão "Já efetuei") → pixEstadoProcessando not hidden + saldo NÃO MUDOU ainda + _timeoutAutoWebhookPix existe typeof number handle. Evidence: evaluate profissionalLogado.saldoMoedas unchanged + `typeof _timeoutAutoWebhookPix === 'number'`.
  - `rule` TR-3.3: Esperar 5500ms ou clicar botão webhook simulado → pixEstadoAprovado not hidden + saldo novo correto (saldoAnterior + qtd pacote) + recarga nova status 'aprovado' tem webhookTimestamp number +  `recargas[ultima].gateway === 'mercado_pago_simulado'`. Evidence: MCP wait_for(6s) then evaluate objetos.
  - `rule` TR-3.4: Aviso produção WEBHOOK texto contém palavra "WEBHOOK" (case insensitive) e palavra "INSTANTANEAMENTE". Evidence: evaluate innerText pixEstadoProcessando infoBox.

---

## Task 4: Criar Guard Cláusula em navigateTo() (views profissional protegidas)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2 (view-perfil criada)
- **Description**:
  - Editar função existente `navigateTo(viewId)` (verificar line-range da função hoje no index.html).
  - Adicionar NO TOPO da função (antes de show/hide views): `const VIEWS_PROFISSIONAL_PROTEGIDAS = ['view-profissional-perfil', 'view-profissional-loja', 'view-profissional-historico-leads', 'view-admin-dashboard'];` (view-admin-login é público, view-admin-dashboard protegido admin separado já tem guard)
  - Guard: `if (VIEWS_PROFISSIONAL_PROTEGIDAS.includes(viewId) && !profissionalLogado)` → toast warning "Cadastre-se ou faça login como profissional para acessar esta página." → `navigateTo('view-profissional-cadastro'); return;` (evita renderizar view protegida).
  - Manter guard admin login existente (se houver) para admin dashboard.
  - Criar função `abrirHistoricoLeadsProfissional()` (nova entrada menu profissional) = `if (!profissionalLogado) navigateTo('view-profissional-cadastro'); else { trocarTabMeusPedidos('profissional'); navigateTo('view-meus-pedidos'); }` (reuso view-meus-pedidos, sem duplicar DOM).
- **Acceptance Criteria Addressed**: AC-1, AC-9
- **Test Requirements**:
  - `rule` TR-4.1: Sem login profissional, rodar `navigateTo('view-profissional-perfil')` → view ativa volta para view-profissional-cadastro (classe active = true). Evidence: evaluate 2 active class.
  - `rule` TR-4.2: Mesmo teste para view-profissional-loja → volta cadastro.
  - `rule` TR-4.3: `abrirHistoricoLeadsProfissional()` ao rodar → trocarTabMeusPedidos chama btnProfissional activo + view-meus-pedidos fica active. Evaluate `_tabMeusPedidosAtual === 'profissional' && view-meus-pedidos classList active`.

---

## Task 5: Separação estrita Visões no Header (menu desktop e mobile) → atualizar atualizarHeaderPorSessao() + menu mobile HTML.
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 4
- **Description**:
  - Header Desktop (botões lado direito, já atualizado para Google Login):
    - Logica atual: quando profissionalLogado != null, mostra botões "Mural Pedidos Região", "Loja Moedas", "Saldo Moedas", "Sair Conta Profissional".
    - **ADICIONAR 2 novos botões desktop** APÓS "Loja Moedas / Antes Sair": (1) "👥 Histórico Leads" → onclick `abrirHistoricoLeadsProfissional()` (Task 4) (2) "👤 Meu Perfil" → onclick `abrirMeuPerfil()` (Task 2).
    - Desktop quando NÃO profissionalLogado (só cliente / anon Google): **REMOVER os botões acima que são profissional**; manter apenas botão Loja Moedas (Talvez seja opcional ocultar — de acordo com FR-3.2, ocultar completamente Loja Moedas do menu cliente / anon; só aparece quando profissional logado. O cliente compra nada, por que ver loja? **Ocultar total Loja quando não profissional**).
  - Menu Mobile (header hamburguer aberto, 2 grupos cliente vs profissional, já atualizado com Google Login mobile):
    - **Grupo Profissional (aparece SOMENTE se profissionalLogado true, senão remove container hidden completo)**: Ordem itens: (1) 📋 Mural de Pedidos (Sua Região), (2) 🪙 Minha Loja / Saldo Moedas, (3) 👥 Histórico Leads Desbloqueados (nova entrada!), (4) 👤 Meu Perfil (nova entrada!), (5) 🚪 Sair da Conta Profissional.
    - **Grupo Cliente (se profissionalLogado false)**: (1) 🏠 Início / Buscar Profissionais (Home Catálogo), (2) 📝 Pedir Serviço (abrir modal solicitar orçamento ou mural), (3) 📦 Meus Pedidos (view-meus-pedidos tab cliente default), (4) 🟢 Entrar com Google, (5) 🟦 Cadastrar como Profissional.
  - Função `atualizarHeaderPorSessao()` que hoje já tem blocos separados para profissionalLogado / cliente: adicionar 8 novos refs DOM (botãoPerfil, botãoHistórico etc) + classList add/remove hidden de acordo com estado logado.
  - Garantir que não quebre o Avatar Google Cliente (se clienteGoogleLogado existir && !profissionalLogado, mostra avatar, não mostra botões profissional).
- **Acceptance Criteria Addressed**: AC-8, FR-3.1, FR-3.2, FR-3.3
- **Test Requirements**:
  - `rule` TR-5.1: Estado cliente anon (sem profissional logado): (a) botão View Profissional no header mobile "Loja Moedas" não existe (hidden). (b) botão Mobile "Meu Perfil" não existe. (c) Container "grupo profissional" HTML todo hidden. Evidence: evaluate classList hidden 3 condições.
  - `rule` TR-5.2: Estado profissional logado: (a) Container "grupo profissional" 100% não hidden (visível). (b) Todos 6 itens ordem corretos presentes MENU MOBILE: Home, Mural Pedidos, Minhas Moedas, Histórico Leads, Meu Perfil, Sair Conta Profissional. Evidence: evaluate `Array.from(menuMobileProfissional.children).length >= 4` + textos dos filhos.
  - `rubric` TR-5.3: Clareza separação visões mobile/desktop (não polui com telas erradas). Scale 1-5: 1=mistura ambos; 3=desktop ok mas mobile errado; 5=100% sem sobreposição. Threshold >=4. Evidence: MCP screenshot header e 2 screenshots menu mobile aberto (1 cliente / 1 profissional).

---

## Task 6: Atualizar navigateTo e render na inicialização DOMContentLoaded + render helpers cards estatísticas perfil
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 2, Task 4
- **Description**:
  - DOMContentLoaded: adicionar `if (view-profissional-perfil foi chamada no hash #) navidateTo(...)` (opcional, hash routing não existe hoje então skip se não tiver).
  - Adicionar chamada para re-renderizar cards estatísticas perfil se abrir view perfil (em navigateTo hook: `if (viewId === 'view-profissional-perfil') atualizarCardsEstatisticasPerfil();`).
  - Função nova `atualizarCardsEstatisticasPerfil()`: preenche os 3 cards com saldo, leads count (filter desbloqueios by profissionalId), média estrelas.
- **Acceptance Criteria Addressed**: AC-4, AC-9
- **Test Requirements**:
  - `rule` TR-6.1: Abrir Meu Perfil profissional com saldo 10, 3 desbloqueios, media 4.5 → cards mostram 10, 3, 4.5. Evidence: evaluate innerText dos cards.

---

## Task 7: Smoke Testes Geral (AC-10 regressão zero)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: All tasks (1 to 6)
- **Description**:
  - Rodar 7 fluxos smoke teste via Browser MCP (Integrado):
    (1) Admin login admin10/bolo2024 → loga e dashboard.
    (2) Cadastro profissional manual "Teste Silva" WhatsApp (61)98888-8888 Cidade Samambaia → bonus 10 moedas.
    (3) Abrir mural pedidos → desbloquear pedido (custo 2 moedas). Saldo antes 10 depois 8. Máximo 4 por pedido.
    (4) Abrir perfil profissional do profissional "Teste Silva" e avaliar com 5 estrelas + comentário "Muito bom!" → média do profissional no card atualiza.
    (5) Login Google cliente: botão entrar Google abre toast azul Abrindo Google (mesmo fluxo hoje).
    (6) Chave Pix modal: texto beneficiário Wesley aparece, chave Pix telefone +55 61 99251-8130.
    (7) Storage carrega e salva boot sem erros Syntax.
- **Acceptance Criteria Addressed**: AC-10
- **Test Requirements**:
  - `rubric` TR-7.1: Regressão zero em todos 7 fluxos smoke teste. Scale 1-5. Threshold >=4 (6 de 7 passando). Evidence: logs de cada teste.
  - `rule` TR-7.2: Nenhum SyntaxError / TypeError fatal não capturado em console messages após cada fluxo (apenas warnings aceitáveis). Evidence: Browser MCP console messages `[error] SyntaxError` count === 0.

---

## Task 8: Commit + Push Deploy GitHub + Anotar changelog
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 7
- **Description**:
  - Git status, add index.html, commit message descritiva "feat(v3): Meu Perfil Profissional editavel, Pix processamento + Webhook simulado, separacao visoes cliente/profissional".
  - Git push origin main.
  - Confirmar deploy automático Render em andamento (URL ajeita-app.onrender.com).
- **Acceptance Criteria Addressed**: NFR delivery
- **Test Requirements**:
  - `rule` TR-8.1: Git log -1 oneline contem feat(v3) → true. Evidence: terminal git log.
