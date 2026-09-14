# Ajeita V3 — Perfil Profissional + Fluxo PIX Realista + Separação Visões (Product Requirements Document)

## Overview
- **Summary**: Atualização do aplicativo single-file `index.html` (Ajeita — Marido de Aluguel & Serviços Domésticos, SPA localStorage-only) com 3 grandes módulos: (1) Aba "Meu Perfil" completa e editável para profissional logado (form + estatísticas), (2) Fluxo PIX realista com ETAPA DE PROCESSAMENTO + SIMULAÇÃO DE WEBHOOK antes de creditar moedas (não mais liberação instantânea após clique), (3) Separação estrita de navegação/abas entre visão CLIENTE vs visão PROFISSIONAL logado (cada perfil vê apenas o que é seu).
- **Purpose**: Elevar a fidelidade do protótipo frontend para se comportar como um produto real (edição de perfil, fluxo financeiro com processamento assíncrono realista de pagamentos PIX, UX dedicada por papel do usuário sem poluição de telas).
- **Target Users**:
  - **Cliente (Anônimo ou Google Login)**: Pessoa que publica pedidos, visualiza catálogo, avalia serviços. NÃO vê telas internas de profissional.
  - **Profissional Logado**: Prestador cadastrado que compra leads (moedas). NÃO vê mais navegações de cliente que não dizem respeito ao seu trabalho diário; vê apenas: Mural de Pedidos da Sua Região, Loja/Saldo Moedas, Histórico de Leads Desbloqueados, e a nova aba Meu Perfil.

## Goals
- **G1** (Perfil Profissional): Profissional consegue editar 100% dos seus dados pessoais e do perfil público (nome, WhatsApp, foto URL, cidade, bairro, categorias, taxa hora) através de uma aba dedicada "Meu Perfil" com form e botão Salvar Alterações; dados atualizam imediatamente no catálogo público e no localStorage.
- **G2** (Resumo Estatístico Perfil): Perfil do profissional mostra, em tempo real, 3 cards: Saldo atual de moedas, Total de leads comprados (histórico desbloqueios do profissional), Nota média ponderada (estrelas) e qtd total avaliações.
- **G3** (Fluxo PIX Realista): Loja de moedas, ao clicar em pacote → QR Code / Copia e Cola aparecem. Ao clicar em "Já efetuei o pagamento (PIX)" NÃO credita moedas IMEDIATAMENTE; exibe tela de status "Verificando pagamento junto ao banco..." com spinner animado (UX processamento). Após simulação de ~5 segundos (ou botão admin de controle "Simular Aprovação Webhook"), um "webhook do gateway" (ex: Mercado Pago/Asaas) é "recebido" e só ENTÃO as moedas são creditadas + toast de sucesso.
- **G4** (Aviso Produção Webhook): Tela de processamento mostra parágrafo explicativo que em PRODUÇÃO REAL as moedas são liberadas AUTOMATICAMENTE via Webhook do banco/gateway, sem precisar de botão manual.
- **G5** (Separação Visões Cliente vs Profissional): Quando um PROFISSIONAL está logado, navegação e visibilidade mostram apenas as telas do seu papel (Mural de Pedidos Local, Loja/Saldo, Histórico de Leads Desbloqueados, Meu Perfil). Telas de "Catálogo" são acessíveis via nav se quiserem, mas o MENU/Header prioriza as rotas profissional. Quando CLIENTE (anon ou Google) está usando, vê apenas Catálogo + Pedido Serviço + Meus Pedidos, e NÃO vê Loja de Moedas, Histórico Leads Profissional, Meu Perfil Profissional.

## Non-Goals
- **NG1**: Backend real / servidor Webhook real (ex: Mercado Pago API real, autenticação de pagamento). O protótipo é SPA client-side, logo webhook é SIMULAÇÃO apenas.
- **NG2**: Upload de arquivos/imagens real (ex: servidor de arquivos S3/Firebase Storage). A foto continua sendo URL (campo texto input tipo text com URL de imagem, como ui-avatars ou Unsplash).
- **NG3**: Autenticação por token/sessão além do localStorage existente (usa mecanismo atual profissionalLogado/clienteGoogleLogado).
- **NG4**: GPS real ou integração com API endereço/CEP/Cidade (bairros/cidades continuam mock DF/GO).

## Background & Context
- **Base herdada V1 (commit 482034a)**: 13 ACs completos (Loja Moedas, PIX simulado instantâneo, Mural, Avaliações, Admin, Média Ponderada, Máximo 4 Desbloqueios por Pedido).
- **Base V2 Cliente (commit 93ede77)**: Cliente anônimo persistente local + filtro Meus Pedidos por navegador + nome real em avaliações.
- **PIX Fix (commit d363066)**: Chave Pix fixa telefone +55 61 99251-8130 beneficiário Wesley - Ajeita Serviços Domésticos.
- **Google Login (commit 7ca7d85 + 8f707ec + 73a46e0)**: OAuth 2.0 configurado Client ID 709414286122-tu642dhpa9dnp158keo816ln1a52npu6.apps.googleusercontent.com GSI popup + fallback redirect.
- **Arquitetura estrita**: Tudo em 1 único arquivo `index.html` (>2700 linhas, localStorage-only, sem build tools). Tailwind CDN + FontAwesome + Google GSI CDN.
- **Estrutura views atuais**: `view-home` (Catálogo), `view-mural-pedidos`, `view-profissional-cadastro`, `view-profissional-loja`, `view-meus-pedidos` (aba cliente/profissional via tabs internas), `view-admin-login`, `view-admin-dashboard`.
- **Estrutura objeto profissional (keys atuais)**: `{id, nome, whatsapp, cidade, bairro, categorias:[], foto, sobre, mediaAvaliacoes, qtdAvaliacoes, saldoMoedas, trabalhosAnteriores:[], depoimentos:[], googleId?, emailGoogle?, email?}`. NOVAS keys necessárias para Perfil V3: `bairrosAtendimento:[]`, `taxaHora:Number`.
- **Estrutura arrays globais relevantes**: `profissionais:[]`, `pedidos:[]`, `desbloqueios:[]`, `recargas:[]`, `avaliacoes:[]` (salvos em `ajeita_moeda_app_*`).

---

## Functional Requirements

### Módulo 1 — Aba "Meu Perfil" do Profissional (Form Edição + Estatísticas)
- **FR-1.1**: Nova view SPA dedicada `view-profissional-perfil` (section HTML com classe `view-section`, escondida por padrão, navegada via `navigateTo('view-profissional-perfil')`). A view é **acessível SOMENTE se profissionalLogado != null**; se não logado, `navigateTo('view-profissional-cadastro')` + toast amarelo "Cadastre-se ou faça login como profissional".
- **FR-1.2**: Aba tem 2 blocos visuais em grid 1col sm:2cols (mobile 1 coluna, tablet/desktop 2 colunas). BLOCO ESQUERDA (2/3 da largura ou stack cima): **Formulário Edição Perfil**. BLOCO DIREITA (1/3 da largura ou stack baixo): **Cards Estatísticas Perfil**.
- **FR-1.3**: Formulário "Editar Meu Perfil" mostra 8 campos preenchidos AUTOMATICAMENTE ao abrir a view (pega valores de profissionalLogado):
  1. Nome Completo * (obrigatório, type=text)
  2. WhatsApp / Telefone * (obrigatório, type=tel + mascaraInputTel existente)
  3. E-mail (opcional, type=text inputmode=email autocomplete=off autocorrect=off spellcheck=false — evita popup "entrar com email" do browser mobile; igual fix commit 73a46e0)
  4. URL Foto de Perfil (text input placeholder "https://ui-avatars.com/.../https://images.unsplash.com/...")
  5. Cidade Principal * (select dropdown CATEGORIAS_CIDADES existentes: Brasília DF, Taguatinga, Samambaia, Ceilândia)
  6. Bairros de Atendimento (**MÚLTIPLOS CHECKBOXES** dinâmicos de acordo com cidade escolhida ou array global de bairros — ex: Asa Sul, Asa Norte, Setor O, Samambaia Sul, QNN, Ceilândia Sul, etc.). Campo novo no objeto: `bairrosAtendimento: string[]`.
  7. Especialidades / Serviços Oferecidos (MÚLTIPLOS CHECKBOXES iguais ao do cadastro = CATEGORIAS_GLOBAIS 8 categorias padrão)
  8. Valor estimado Taxa/Hora (R$) — campo number ou text com máscara moeda real (R$). Campo novo objeto: `taxaHora: Number` (padrão 0 = não informado).
- **FR-1.4**: Preview da foto de perfil: acima/beside o campo URL foto, mostra `<img>` circular 100px/128px refletindo a URL digitada, com fallback `FOTO_UI_AVATAR(nome)` se URL for vazia ou inválida (onerror handler). Atualiza LIVE em tempo real enquanto usuário digita URL (evento oninput).
- **FR-1.5**: Botão "💾 Salvar Alterações" (fixo ou sticky inferior ou abaixo do form) que ao clicar:
  (a) Validação campos obrigatórios (nome >=3 chars, WhatsApp limpo >= 10 dígitos, cidade != "") → se falhar toast warning.
  (b) Cria novo objeto com os campos editados e atualiza `profissionalLogado` + também encontra profissional no array `profissionais` por `id` e ATUALIZA O OBJETO NO ARRAY (para refletir em renderCatalogoProfissionais e Perfil Público).
  (c) Persiste `salvarTodosGlobaisNoStorage();` (tudo salvo localStorage).
  (d) Re-renderiza `renderCatalogoProfissionais();` + `atualizarHeaderPorSessao();` + toast verde sucesso "Perfil atualizado! Seus dados no catálogo público já foram atualizados."
- **FR-1.6**: Estatísticas Perfil (3 cards coloridos separados, 100% calculado LIVE):
  - **CARD 1 - SALDO DE MOEDAS**: 🪙 + `profissionalLogado.saldoMoedas` com subtítulo "Saldo disponível para desbloquear leads". Cor primária azul.
  - **CARD 2 - LEADS COMPRADOS**: 👥 + `desbloqueios.filter(d => d.profissionalId === profissionalLogado.id).length` com subtítulo "Total de pedidos/leads desbloqueados até hoje". Cor verde.
  - **CARD 3 - NOTA MÉDIA AVALIAÇÕES**: ⭐ + `${profissionalLogado.mediaAvaliacoes || 0.0}/5.0` (estrelinhas HTML `htmlEstrelas(media)`) com subtítulo `${profissionalLogado.qtdAvaliacoes || 0} avaliações de clientes`. Cor amarela/lareira.

### Módulo 2 — Fluxo PIX Realista (Processamento Assíncrono + Webhook Simulado)
- **FR-2.1**: Modal PIX existente `modal-pix` atualmente tem 3 estados estáticos. Reforma para **4 estados DINÂMICOS**, com containers renderizados de acordo com uma variável `estadoPagamentoPix = 'qr' | 'processando' | 'aprovado' | 'falhou'` (string enum). O modal sempre renderiza APENAS o container de estado ativo, ocultando os demais.
- **FR-2.2**: Estado 1 (`'qr'` — QR Code e Copia e Cola): 100% igual UI existente, mas o botão azul principal muda o texto de "✅ Já paguei! Confirmar Pagamento PIX" para **"📤 Já efetuei o pagamento (PIX)"**. Ao clicar → NÃO CRÉDITA MOEDAS. NÃO FECHA MODAL. Ao invés disso → Muda estado para `'processando'`.
- **FR-2.3**: Estado 2 (`'processando'` — Verificando pagamento junto ao banco):
  - UI nova: Centralizado, ícone grande spinner `fa-circle-notch fa-spin 5x` cor esmeralda (verde).
  - Título bold "Estamos verificando o pagamento junto ao nosso banco..." com subtítulo "Aguardando confirmação PIX (geralmente 1-5 segundos em ambiente real)."
  - Parágrafo explicativo em box cinza/claro com borda esquerda azul (info box): ⚠️ **Aviso**: Em PRODUÇÃO REAL, a confirmação ocorre automaticamente através de um **WEBHOOK do gateway de pagamento (Mercado Pago / Asaas / Stripe)**. Assim que seu banco confirma a transferência PIX, o webhook é disparado e as moedas são creditadas INSTANTANEAMENTE sem precisar clicar em nada — este passo NÃO É MANUAL para o cliente real.
  - **Botão secundário esquerdo**: "Cancelar / Voltar para QR Code" → volta para estado 'qr'.
  - **Botão de Simulação Webhook (Admin)**: Botão verde claro/outline separado abaixo: **"🧪 Simular Webhook Aprovado (Demonstração)"**. Ao clicar, APENAS para demonstração, executa a função `simularAprovacaoWebhook()` = o equivalente a receber POST /webhook do gateway no backend.
  - **Auto-simulação após 5 segundos**: MESMO sem usuário clicar no botão Simular, após exatamente 5.0 segundos (setTimeout 5000ms) o sistema AUTOMATICAMENTE executa `simularAprovacaoWebhook()` sem clique — para UX fluida de demonstração.
- **FR-2.4**: Função nova `simularAprovacaoWebhook(pedidoRecargaId?)`:
  - Se estado != 'processando' → ignora.
  - Validação final (pacotePixAtual + profissionalLogado existem).
  - Crédita as moedas (lógica atualmente no setTimeout 900ms de confirmarPagamentoPix): soma pkg.qtd em profissionalLogado.saldoMoedas + atualiza profissionais[idxPro] + push novo recarga em recargas[] com status `aprovado` e `webhookTimestamp: Date.now()` + `gateway: 'mercado_pago_simulado'`.
  - `salvarTodosGlobaisNoStorage();` `atualizarHeaderPorSessao();` `renderLojaPacotes();`
  - Muda estado para `'aprovado'`.
  - Toast sucesso 💸 verde grande 6.5s "Pagamento PIX aprovado! {pkg.qtd} moedas creditadas! Saldo atual {saldo} moedas.".
  - Fecha modal automaticamente após 2.5s do sucesso (tempo de ver UI aprovado).
  - **Limpa o setTimeout 5000ms de auto-webhook se ele ainda estiver pendente** (para não disparar 2 vezes).
- **FR-2.5**: Estado 3 (`'aprovado'` — PIX aprovado com sucesso):
  - UI nova: Checkmark gigante verde `fa-circle-check` 5x esmeralda.
  - Título bold "Pagamento aprovado! 🎉"
  - Subtítulo: "Moedas adicionadas ao seu saldo" + mostra qtd moedas + preço pago (pacote) em card resumo.
  - Botão "Ir para Loja / Mural" (fecha modal, opcionalmente navega view-mural-pedidos).
- **FR-2.6**: Estado 4 (`'falhou'` — Opcional, fallback): Caso simulação seja de falha (por enquanto não implementada UI, apenas estrutura no switch).
- **FR-2.7**: Nova função renderizadora UI interna do modal `renderEstadoModalPix(estado)` que troca display:flex/none das divs. Deve ser chamada ao abrir modal (sempre reseta estado para 'qr'), ao clicar Já Efetuei Pagamento, ao clicar Simular Webhook, ao clicar Voltar QR Code.

### Módulo 3 — Separação Estrita de Visões (Cliente vs Profissional)
- **FR-3.1**: Navegação SPA e menus (mobile e desktop) atualizados. Quando `profissionalLogado != null` (profissional logado), **itens principais menu (header desktop + menu hambúrguer mobile)** SE TORNAM, NESTA ORDEM PRIORIDADE:
  1. 🏠 **Home / Catálogo** (view-home — sempre acessível, opcional)
  2. 📋 **Mural de Pedidos (Sua Região)** (view-mural-pedidos — a página MAIS importante pro profissional)
  3. 🪙 **Minhas Moedas / Loja** (view-profissional-loja)
  4. 👥 **Histórico de Leads (Desbloqueados)** — NOVA view separada: `view-profissional-historico-leads`. Atualmente o histórico de desbloqueios do profissional estava na tab profissional de Meus Pedidos — ele continua lá, mas AGORA também ganha entrada PRÓPRIA no menu do profissional (se quiser ir direto).
  5. 👤 **Meu Perfil** (nova view-profissional-perfil — MÓDULO 1)
  6. 🚪 **Sair da Conta Profissional**
- **FR-3.2**: Quando NÃO há profissional logado (apenas cliente anônimo / clienteGoogleLogado) → MENU NÃO MOSTRA Loja de Moedas, Histórico Leads Profissional, Meu Perfil Profissional. Mostra: (1) Buscar Profissionais (Home), (2) Mural (opcional pode ocultar cliente), (3) Cadastrar Profissional (CTA), (4) Meus Pedidos, (5) Entrar com Google.
- **FR-3.3**: `atualizarHeaderPorSessao()` (função já existe, ~1000 linhas) — atualizar a parte de montagem do menu mobile/desktop com a lógica de separação acima. A função já tem flag profissionalLogado ? ... então só adicionar/remover itens de acordo.
- **FR-3.4**: Nova view `view-profissional-historico-leads` (opcional pode ser apenas navegação que troca a tab de view-meus-pedidos para aba profissional automaticamente via `trocarTabMeusPedidos('profissional')` + `navigateTo('view-meus-pedidos')`). Evita duplicar HTML.
- **FR-3.5**: Botões/CTAs anti-fuga: Ao profissional clicar em "Solicitar Orçamento" (button card profissional que é do fluxo cliente) → toast informativo "Você está logado como profissional. Para solicitar serviços, saia da sua conta profissional." (não quebra nada, só lembra).

## Non-Functional Requirements
- **NFR-1**: NÃO quebrar funcionalidades V1-V2 existentes (login admin admin10/bolo2024, cadastro profissional, loja, pix, avaliação média ponderada, máximo 4 desbloqueios, login Google cliente e profissional, chave Pix telefone, cliente anônimo persistente local). Todas ACs V1 e V2 continuam 100% válidas.
- **NFR-2**: 100% responsivo (mobile-first). Aba Meu Perfil form 1 coluna mobile. Cards estatísticas 1 coluna mobile, sm:grid-3 desktop.
- **NFR-3**: Persistência completa em localStorage: (a) campos novos bairrosAtendimento[], taxaHora do objeto profissional; (b) estadoPagamentoPix é apenas runtime (não precisa persistir); (c) recargas agora tem novas keys status, webhookTimestamp, gateway.
- **NFR-4**: Performance (sem atrasos > 100ms em renders). Form perfil campos live update foto de URL com debounce 100ms (não re-render img a cada keystroke, mas a cada 100ms).
- **NFR-5**: UX feedback imediato em toda ação (toast info/erro/sucesso em Salvar Perfil, Saldo insuficiente, Processamento Pagamento).
- **NFR-6**: Separação estrita de views não pode ser burlada digitando navigateTo no console. Guardas simples em cada navigateTo profissional: `if (viewId in ['view-profissional-perfil','view-profissional-historico-leads','view-profissional-loja']) && !profissionalLogado` → volta para cadastro + toast (guard em navigateTo()).

## Constraints
- **Technical**: TUDO dentro do mesmo arquivo `index.html` (não criar arquivos .js/.css/.html separados). Persistência 100% localStorage. Sem build tools. Tudo rodando em HTTP server stdlib Python local (127.0.0.1:8000) e deploy em onrender.com (ambos funcionam com single file).
- **Business**: Credenciais Admin continuam `admin10 / bolo2024` (hardcoded submitAdminLogin). Chave Pix proprietário NÃO MUDAR: telefone +55 61 99251-8130 / Wesley - Ajeita Serviços Domésticos. Valores pacotes loja NÃO MUDAR (bronze 10 R$15, prata 25 R$30, ouro 60 R$60). GOOGLE_CLIENT_ID OAuth NÃO MUDAR (valor já configurado).
- **Dependencies**: Apenas Tailwind CDN, FontAwesome 6.5.1, Google Identity Services CDN (já carregados no HEAD). NÃO adicionar novas bibliotecas (ex: QRCode.js real — mantém o QR Code visual placeholder existente).

## Assumptions
- A-1: "Mural de Pedidos da Sua Região" (visão profissional) já tem filtro cidade/bairro por profissional logado (implementado V1 FR-D4). Não vamos alterar a lógica do filtro, só garantir entrada no menu.
- A-2: Histórico Leads Desbloqueados (profissional) já implementado em view-meus-pedidos tab profissional; para não duplicar DOM, a nova entrada de menu Histórico Leads no menu profissional vai apenas chamar `trocarTabMeusPedidos('profissional'); navigateTo('view-meus-pedidos');` — simula view própria sem duplicar código.
- A-3: Bairros atendimento múltiplos: usar array de bairros mock padrão de DF baseados nas cidades já existentes; mesmo se usuário escolher bairro diferente do cadastro original, permite selecionar múltiplos (ex: profissional de Samambaia pode querer atender Samambaia Sul + Ceilândia Sul).
- A-4: Simulação webhook não precisa de validação de transação/ID real, basta o setTimeout 5s ou clique no botão demo para creditar.

---

## Acceptance Criteria

### AC-1: Aba Meu Perfil visível apenas para profissional logado
- **Type**: `rule`
- **Given**: Usuário acessa o site sem login (cliente anônimo).
- **When**: Tenta navegar manualmente para view-profissional-perfil (ou clica em algum link que levaria lá).
- **Then**: É redirecionado para view-cadastro-profissional + toast warning "Cadastre-se ou faça login como profissional para acessar Meu Perfil."
- **Pass Condition**: NÃO consegue acessar perfil sem profissionalLogado, sempre redireciona + toast visível (verificar no browser evaluate view ativa + toast).
- **Evidence**: Browser MCP: (1) limpar storage, abrir página, executar `navigateTo('view-profissional-perfil');` → evaluate `document.getElementById('view-profissional-perfil').classList.contains('active')` = **false**; `document.getElementById('view-profissional-cadastro').classList.contains('active')` = **true**.

### AC-2: Form Meu Perfil carrega dados prévios + Salvar atualiza localStorage e catálogo
- **Type**: `rule`
- **Given**: Profissional cadastrado e logado (ex: Wagner mock cadastrado antes, ou criar um novo). Navegou até Meu Perfil.
- **When**: Edita Nome para "Wagner Nascimento Atualizado", WhatsApp para novo número "61999999999", URL Foto para `https://ui-avatars.com/api/?name=Wagner+Teste&background=random`, Cidade para "Ceilândia", Marca checkbox "Diarista" adicional em Especialidades, Marca 2 bairros atendimento (ex: "QNN", "QNP"), taxaHora "80". Clica em "Salvar Alterações".
- **Then**: (1) Toast verde sucesso aparece. (2) `profissionalLogado.nome` = novo nome. (3) `profissionais.find(p => p.id === profissionalLogado.id).nome` = novo nome (catálogo atualizado). (4) localStorage `ajeita_moeda_app_profissionais` contém o novo objeto com novas keys `bairrosAtendimento: ['QNN','QNP']` e `taxaHora: 80`. (5) Recarrega página com F5 e ao voltar em Meu Perfil → campos ainda estão com os valores novos (persistência).
- **Pass Condition**: Todos os 5 checks acima passam (nome atualizado global + array + storage, reload preserva).
- **Evidence**: Browser MCP evaluate 2 vezes (antes reload, depois reload): `profissionais.find(p=>p.whatsapp==='61999999999')` existe; `localStorage.getItem('ajeita_moeda_app_profissionais').indexOf('QNP') > -1`.

### AC-3: Preview foto URL atualiza LIVE no perfil
- **Type**: `rule`
- **Given**: Tela Meu Perfil aberta, campo "URL Foto Perfil" vazio, img preview default ui-avatars do nome do profissional.
- **When**: Usuário digita no input: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=500"
- **Then**: No evento oninput (debounce 100ms) → `<img id="perfilFotoPreview">` src muda para a nova URL digitada (não precisa terminar de digitar, atualiza em tempo real enquanto digita).
- **Pass Condition**: Evaluate após digitar via `dispatchEvent(new Event('input'))` no campo → `perfilFotoPreview.src.startsWith('https://images.unsplash.com/photo-1507003211169')` = **true**.
- **Evidence**: Browser MCP evaluate campo input + img src atualizada.

### AC-4: Cards estatísticas perfil (Saldo, Leads comprados, Nota média) atualizados corretamente
- **Type**: `rule`
- **Given**: Profissional com saldoMoedas=27, já desbloqueou 3 leads (array desbloqueios tem 3 entradas com seu profissionalId), mediaAvaliacoes = 4.6 e qtdAvaliacoes = 51.
- **When**: Abre view Meu Perfil.
- **Then**: Card Saldo mostra "27 Moedas". Card Leads Comprados mostra "3 Total". Card Nota Média mostra "⭐ 4.6 (51 avaliações)".
- **Pass Condition**: 3 valores correspondem exatamente aos dados objetos globais (não hardcoded).
- **Evidence**: Browser MCP evaluate textos dos cards.

### AC-5: Fluxo PIX NÃO credita moedas imediatamente (vai para Processando)
- **Type**: `rule`
- **Given**: Profissional logado saldo = 10 moedas. Abre Loja → clica Pacote Prata (25 R$30). Modal PIX QR Code / Copia e Cola aberto.
- **When**: Clica "📤 Já efetuei o pagamento (PIX)".
- **Then**: (1) Modal NÃO fecha. (2) Estado muda para `processando` (visível spinner `fa-circle-notch fa-spin` + título "Verificando pagamento junto ao banco..."). (3) **SALDO CONTINUA = 10 Moedas** (não mudou para 35!). (4) Nenhum novo objeto em `recargas[]` ainda.
- **Pass Condition**: Saldo não foi creditado, modal aberto, UI de processamento apareceu (spinner + títulos).
- **Evidence**: Browser evaluate `profissionalLogado.saldoMoedas` após clique (ainda 10); `document.getElementById('pixEstadoProcessando').classList.contains('hidden')` = false.

### AC-6: Webhook simulado credita moedas (auto 5s OU botão)
- **Type**: `rule`
- **Given**: Estado `processando` vigente, saldo=10, pacote=prata qtd=25.
- **When**: Passam 5 segundos (setTimeout auto), ou usuário clica em "🧪 Simular Webhook Aprovado (Demonstração)".
- **Then**: (1) Muda estado para 'aprovado' (checkmark verde aparece, título sucess0). (2) Saldo = 10 + 25 = 35. (3) Novo `recargas[]` push com status='aprovado' + webhookTimestamp (número) + gateway = 'mercado_pago_simulado'. (4) Header saldo atualizado. (5) Toast verde sucesso 💸 aparece. (6) Modal fecha automaticamente após +2.5s.
- **Pass Condition**: Todas 6 condições passam (saldo 35, recarga gravada, toast, UI aprovado visível + fecha após).
- **Evidence**: Browser MCP: wait 5.5s → evaluate `profissionalLogado.saldoMoedas === 35` && `recargas[recargas.length-1].gateway === 'mercado_pago_simulado'` → true.

### AC-7: Aviso de produção Webhook presente no processamento
- **Type**: `rule`
- **Given**: Modal Pix no estado 'processando'.
- **When**: Usuário lê a tela.
- **Then**: Existe um container informativo (box cinza/borda esquerda info azul) contendo as palavras chave "WEBHOOK" + "gateway de pagamento (Mercado Pago / Asaas / Stripe)" + "assim que seu banco confirma" + "moedas são creditadas INSTANTANEAMENTE sem precisar clicar em nada".
- **Pass Condition**: texto do container contém WEBHOOK (case insensitive) + "INSTANTANEAMENTE" ou equivalente.
- **Evidence**: Browser evaluate innerText da div info box.

### AC-8: Separação Visões Cliente vs Profissional (menu mobile e desktop)
- **Type**: `rubric`
- **Dimension**: Navegação/itens do menu por papel do usuário (não poluição de telas erradas).
- **Scale**: 1-5
- **Anchors**: 1 = nenhum item do menu muda (tanto cliente como profissional vê tudo igual, falha total); 3 = itens do desktop header corretos mas menu mobile errados / faltam 1 aba (ex: Histórico Leads não aparece menu profissional); 5 = **(alvo)** Desktop + Mobile 100% corretos: (a) Sem login profissional (cliente) → NÃO vê Loja Moedas / Histórico Leads / Meu Perfil Profissional. Apenas Catálogo, Mural (opcional), Meus Pedidos, Cadastrar CTA, Entrar Google. (b) Com login profissional → 6 itens aparecem na ordem do FR-3.1 (Home / Mural / Minhas Moedas / Histórico Leads / Meu Perfil / Sair Conta Profissional). Clicar em cada item navega para view correta.
- **Pass Threshold**: >= 4 (se só faltar um item small ok, se 2 itens faltando = falha)
- **Evidence**: Browser MCP 2 snaps (1 cliente anon, 1 profissional logado) + evaluate contagem botões no `header-menu-mobile` antes e depois do login.

### AC-9: View Meu Perfil + Nova View Histórico Leads guarda correta (navigateTo protegida)
- **Type**: `rule`
- **Given**: Não logado profissional (cliente anônimo).
- **When**: Executar console `navigateTo('view-profissional-perfil');` e depois `navigateTo('view-profissional-historico-leads');` (ou view-meus-pedidos com tentativa de acessar tab profissional via navigate fake).
- **Then**: Guard roda. view-profissional-perfil NÃO fica active, volta pro cadastro profissional, toast warning.
- **Pass Condition**: View ativa nunca é perfil profissional sem login.
- **Evidence**: Browser MCP evaluate após os 2 navigateTo.

### AC-10: Nenhum AC V1 V2 V Google Login quebrado (regressão zero)
- **Type**: `rubric`
- **Dimension**: Estabilidade/Regressão após implementação V3 (mudanças em navigateTo, modal pix, submit forms, header sessão).
- **Scale**: 1-5
- **Anchors**: 1 = pelo menos 2 fluxos V1 quebrados (ex: Login Admin não funciona, pix não gera QR, avaliação não recalcula média); 3 = 1 pequeno bug de regressão (conserta rápido); 5 = todos fluxos V1-V2 funcionando: (a) Login admin admin10/bolo2024 loga, (b) cadastrar profissional comum bonus 10, (c) desbloquear lead custo 2 moedas máximo 4 por pedido, (d) Avaliação 5 estrelas recalcula média no catalogo, (e) Login Google cliente avatar header aparece, (f) Chave Pix telefone 61992518130 aparece em Copia e Cola, (g) localStorage carrega/salva boot sem erros.
- **Pass Threshold**: >= 4
- **Evidence**: Smoke testes MCP nos 7 fluxos acima.

---

## Open Questions
- [ ] **OQ-1**: O campo "Sobre Mim / Descrição curta do profissional" (campo `sobre` que aparece no Perfil Público Modal) deve ser incluído no formulário Meu Perfil como textarea para editar? Recomendo fortemente **SIM** — o profissional vai querer alterar sua apresentação pública. Usuário confirmou em passagem anterior? (Se não tiver resposta, EU INCLUO por padrão no form, pois é bug UX se profissional não pode editar o "Sobre" que aparece no perfil público. Será item 9 no FR-1.3: **9. Descrição / Sobre (textarea 3 linhas)** — valor atualizado no campo `sobre` do objeto profissional, aparece perfil público modal). Isso não quebra nada, só adiciona.
- [ ] **OQ-2**: Botão "Cancelar Assinatura" / "Excluir Conta Profissional" deve ter no Meu Perfil? **Por enquanto NÃO implementar** (non-goal: usuário não pediu). Só se solicitar depois.
- [ ] **OQ-3**: A view Histórico Leads no menu do profissional deve ser um redirecionamento para `trocarTabMeusPedidos('profissional')` e abrir view-meus-pedidos (menos duplicidade) ou criar view nova separada 100%? **Eu prefiro a primeira opção (reuso existente com tab automática)** — menos DOM, mais rápido, não duplica lógica. Se preferir view separada explicitamente, me avise que crio container próprio com mesmo conteúdo.
