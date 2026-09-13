# Plataforma Marido de Aluguel & Serviços Domésticos (Moedas/Leads) — Product Requirements Document

## Overview
- **Summary**: Aplicação web COMPLETA em ÚNICO arquivo `index.html` para marketplace de serviços domésticos ("Marido de Aluguel") com modelo de monetização via compra de leads (moedas) inspirado no GetNinjas, 100% client-side (HTML + Tailwind CSS via CDN + JavaScript ES6+ puro).
- **Purpose**: Conectar clientes buscando serviços domésticos (reparos elétricos, encanamento, pintura, diaristas, montagem de móveis etc.) com profissionais locais, cobrando do profissional moedas para desbloquear contatos de clientes interessados.
- **Target Users**:
  - **Cliente**: Pessoa física buscando orçamento/serviço em sua cidade/bairro. Posta pedido gratuito.
  - **Profissional**: Prestador de serviço (pedreiro, eletricista, diarista, marido de aluguel etc.) cadastrado, compra moedas para desbloquear leads de pedidos em sua região.
  - **Administrador da Plataforma**: Login admin10/bolo2024 com painel de configuração da economia, gestão de pedidos/profissionais e métricas financeiras.

## Goals
- G1: Catálogo transparente de profissionais por região com avaliações e galeria de trabalhos.
- G2: Economia funcional via "moedas": profissional compra pacotes (PIX simulado) e gasta para desbloquear contatos de leads (WhatsApp).
- G3: Privacidade do cliente: WhatsApp mascarado no mural (9****-****) até desbloqueio.
- G4: Limite máximo de 4 desbloqueios por pedido (garante exclusividade parcial e justiça).
- G5: Cadastro profissional com BÔNUS de 10 moedas (teste gratuito do modelo).
- G6: Painel administrativo full: ajustar preços moedas, ver todo histórico, métricas financeiras.
- G7: 100% responsivo (mobile-first) e navegação SPA sem recarregar página.
- G8: Persistência total em localStorage (profissionais, pedidos, saldos, desbloqueios, avaliações, recargas, config admin).

## Non-Goals
- NG1: Backend próprio, API, servidor web, banco de dados real fora do localStorage.
- NG2: Integração com pagamento real (Stripe, Mercado Pago, PIX real) — apenas simulação PIX.
- NG3: Autenticação via e-mail/senha real ou provedores OAuth (Firebase, Google, Facebook).
- NG4: Geolocalização real precisa (GPS). Apenas seletor de cidade/bairro manual + botão "Usar minha localização atual" que usa `navigator.geolocation` se disponível.
- NG5: Upload de imagem para Storage na nuvem (usa placeholder avatares via `ui-avatars.com` e fotos demo locais).
- NG6: Envio real de mensagens WhatsApp (apenas gera link `https://wa.me/` pré-preenchido, abre em nova aba).

## Background & Context
- Diretriz é entrega em ÚNICO arquivo `index.html` (evitar build tools, bundlers, múltiplos arquivos).
- Stack fornecida pelo usuário: Tailwind via CDN + JS nativo ES6+.
- Paleta profissional: tons de azul + amarelo/laranja.
- Persistência: localStorage (dados ficam apenas no navegador do usuário).
- Cidades/bairros baseados em DF/GO (Asa Sul, Samambaia, Taguatinga etc.) para mock realista.
- Modelo de negócio GetNinjas: leads custam moedas, profissional compra pacotes de moedas via PIX.

---

## Functional Requirements

### Módulo A — Cabeçalho / Header
- **FR-A1**: Logo com ícone de ferramentas (ex: `fa-tools`) + nome da plataforma (ex: "Ajeita").
- **FR-A2**: Menu navegação SPA: "Buscar Profissionais", "Mural de Pedidos", "Sou Profissional", "Meus Pedidos", "Área do Admin".
- **FR-A3**: Indicador de saldo de moedas do profissional LOGADO (ex: "🪙 10 Moedas") + botão "+ Recarregar Moedas" (abre loja). Se cliente/anon, oculta saldo.
- **FR-A4**: Botão CTA destacado "Cadastrar como Profissional" (leva para o cadastro em G).

### Módulo B — Hero Section com Geolocalização
- **FR-B1**: Título grande: "Encontre os melhores profissionais bem perto de você".
- **FR-B2**: Barra Pesquisa Avançada com: (1) Seletor Categoria, (2) Cidade, (3) Bairro/Região.
- **FR-B3**: Botão "Usar minha localização atual" (tenta `navigator.geolocation.getCurrentPosition()`; se sucesso, preenche cidade/bairro demo automático com mensagem de sucesso; se falhar, toast erro).

### Módulo C — Catálogo de Profissionais & Perfis
- **FR-C1**: Grid responsivo (mobile 1 col, tablet 2 col, desktop 3-4 col) com cards profissionais: foto avatar, nome, especialidades (badges), avaliação estrelada (1-5), cidade/bairro.
- **FR-C2**: Clique no card abre Modal de Perfil Detalhado.
- **FR-C3**: Modal perfil contém: (1) Foto grande + nome/cidade/bairro/categorias; (2) Média de avaliação com total de avaliações; (3) Galeria de fotos de trabalhos anteriores (4-6 miniaturas); (4) Lista depoimentos de clientes (com nota + comentário).

### Módulo D — Sistema de Compra de Leads / Moedas (GetNinjas Model)
- **FR-D1**: Tela/Modal "Solicitar Orçamento" (cliente): campos (i) Problema/Descrição, (ii) Data preferencial, (iii) Cidade, (iv) Bairro/Região, (v) WhatsApp. Salva no localStorage.
- **FR-D2**: WhatsApp do cliente = OCULTO no Mural público: formato "(61) 9****-****".
- **FR-D3**: Botão na lista de pedidos: "[Desbloquear Contato]".
- **FR-D4**: Mural de Pedidos filtrado por cidade/bairro do profissional logado (mostra apenas pedidos locais).
- **FR-D5**: Clique "Desbloquear Contato" (Custo: 2 Moedas):
  - Confirmação modal do custo.
  - Valida que profissional TEM >= 2 moedas. Se faltar, toast erro ("Saldo insuficiente! Compre mais moedas." + abre loja).
  - Valida que o pedido NÃO chegou a 4 desbloqueios ainda. Se chegou = MAX, toast "Este pedido já foi desbloqueado por 4 profissionais e está fechado.".
  - Se OK: desconta 2 moedas do saldo, grava histórico (ID pedido, profissional, data).
  - WhatsApp revela: "(61) 99999-9999".
  - Mostra botão "📱 Abrir conversa WhatsApp" → `https://wa.me/5561999999999?text=Olá%20%5BNome%20Profissional%5D%2C%20vi%20seu%20pedido%20de%20orçamento%20para%20...`.
- **FR-D6**: Persiste contador `qtdDesbloqueios` no pedido e máximo de 4. Após 4, muda status para "fechado" e desativa botão.

### Módulo E — Sistema Recarga de Moedas (PIX Simulado)
- **FR-E1**: Loja de Moedas com 3 pacotes:
  (1) Bronze: 10 Moedas | R$ 15,00
  (2) Prata:  25 Moedas | R$ 30,00
  (3) Ouro:   60 Moedas | R$ 60,00
- **FR-E2**: Clique em pacote → Tela PIX: (1) QR Code visual (quadrado colorido placeholder); (2) Chave "Copia e Cola PIX" (texto longo aleatório); (3) Valor do pacote.
- **FR-E3**: Botão simulação "✅ Confirmar Pagamento PIX":
  - Ao clicar, adiciona DINAMICAMENTE as moedas ao saldo do profissional logado.
  - Grava recarga no localStorage (pacote, valor pago, data, qtd moedas adicionadas).
  - Atualiza IMEDIATAMENTE o saldo no header (🪙 X Moedas) sem recarregar.
  - Toast sucesso + fecha modal.

### Módulo F — Sistema Avaliação Pós-Serviço
- **FR-F1**: Área "Meus Pedidos" (visão Cliente): lista seus pedidos criados + status (pendente/desbloqueado/finalizado).
- **FR-F2**: Cliente pode marcar serviço como "Finalizado".
- **FR-F3**: Após marcar finalizado, abre Modal Avaliação: (1) Nota 1-5 estrelas clicável; (2) Comentário texto livre.
- **FR-F4**: Salva avaliação e RECALCULA automaticamente média do profissional (média ponderada nova + contador total avaliações).
- **FR-F5**: Atualiza média no card do profissional e no modal de perfil imediatamente.

### Módulo G — Área do Profissional (Cadastro + Bônus 10 Moedas)
- **FR-G1**: Formulário de cadastro profissional: (1) Nome Completo, (2) WhatsApp, (3) Cidade, (4) Bairro/Região, (5) Categorias (multi-select), (6) Foto (URL placeholder ou ui-avatars por nome).
- **FR-G2**: Ao submeter cadastro com sucesso, profissional LOGA automaticamente (estado = profissional logado).
- **FR-G3**: BÔNUS de 10 Moedas creditadas AUTOMATICAMENTE no saldo + toast "🎉 Parabéns! Você ganhou 10 Moedas BÔNUS para testar os desbloqueios!" + atualiza header.
- **FR-G4**: Grava novo profissional no localStorage.

### Módulo H — Painel do Administrador (Restrito)
- **FR-H1**: Tela Login Admin → credenciais hardcoded: Login = `admin10` | Senha = `bolo2024`. Se erro, toast.
- **FR-H2**: Login ADMIN válido grava sessão no localStorage (tipo = admin logado).
- **FR-H3**: Dashboard Admin com 3 blocos:
  (1) **Configuração da Economia**: inputs editáveis para: (a) Custo moedas por desbloqueio (padrão 2); (b) Preço Pacote Bronze/Prata/Ouro (valores R$). Botão "Salvar Configurações" (grava no localStorage).
  (2) **Gestão de Pedidos & Profissionais**: (a) Tabela com todos pedidos (ID, cidade/bairro, descrição, qtd desbloqueios, status); (b) Tabela com todos profissionais cadastrados (nome, WhatsApp, cidade, saldo moedas, média de avaliação).
  (3) **Métricas Financeiras**: (a) Total de moedas VENDIDAS (soma todos pacotes comprados); (b) Total de recargas efetuadas (contagem); (c) Receita ESTIMADA da plataforma (soma R$ de todos pacotes comprados). Números atualizados em tempo real do localStorage.

### Módulo I — Requisitos Técnicos / Persistência / Mock Data
- **FR-I1**: Dados Iniciais (Mocks): (a) Array `profissionaisMock` com pelo menos 6 profissionais fictícios, com foto, nome, especialidades, cidade (DF), bairro, média de estrelas. (b) Array `pedidosMock` com PELO MENOS 4 pedidos de orçamento PENDENTES em bairros reais DF (Asa Sul, Samambaia, Taguatinga, Ceilândia) — cada um com WhatsApp mascarável.
- **FR-I2**: Toda persistência em `localStorage`: chaves para `profissionais`, `pedidos`, `profissionalLogado`, `adminLogado`, `historicoDesbloqueios`, `historicoRecargas`, `avaliacoes`, `configEconomia`.
- **FR-I3**: Função `salvarDados()` / `carregarDados()` ou equivalente, executada no boot para popular arrays globais do localStorage; se vazio, usa mocks iniciais.
- **FR-I4**: SPA pattern: função `navigateTo(viewId)` que oculta todas views e mostra só a selecionada (NÃO recarrega a página). Views mínimas: home, mural, profissional-cadastro, profissional-loja, meus-pedidos, admin-login, admin-dashboard.
- **FR-I5**: Navegação WhatsApp: `window.open('https://wa.me/55' + numero_limpo + '?text=' + encodeURIComponent(mensagem_pre_preenchida), '_blank')`.

---

## Non-Functional Requirements
- **NFR-1 (Responsividade Mobile-First)**: UI funciona e tem boa UX em larguras 320px (celular pequeno) até 1920px (desktop largo). Grid responsivo em catalogo.
- **NFR-2 (Performance)**: Tudo carrega via CDN em <5s em conexão 3G; JS nativo sem dependências pesadas.
- **NFR-3 (Acessibilidade / UX)**: Toasts de feedback para 100% das ações (sucesso, erro, info); botões com hover/active; modais com fundo escuro e animações suaves; contraste adequado.
- **NFR-4 (Manutenibilidade)**: Único arquivo `index.html`, mas com comentários organizando módulos.
- **NFR-5 (Segurança Client-Side)**: Nenhum dado sensível hardcoded exposto (exceto login admin, que é client-side e não há dados reais).
- **NFR-6 (Compatibilidade)**: Chrome, Edge, Safari, Firefox versões modernas (ES6+).

## Constraints
- **Technical**:
  - Código em **ÚNICO** arquivo `/Users/tiagosantos/Desktop/Ajeita/index.html`.
  - Tailwind CSS **via CDN** (apenas `<script src="cdn.tailwindcss.com">` ou `<link>` tradicional).
  - **NENHUMA** biblioteca JS externa além de Tailwind (incluir Font Awesome via CDN para ícones é permitido e recomendado).
  - JavaScript **ES6+ nativo** (arrow functions, const/let, template strings, async/await se necessário).
- **Business**:
  - Modelo moedas FIXO por padrão: 1 desbloqueio = 2 moedas, mas ADMIN pode mudar via dashboard.
  - Máximo de **4 desbloqueios por pedido** (fechado depois).
  - Pacotes de moedas padrão: 10 R$15, 25 R$30, 60 R$60. Admin pode mudar.
  - Cadastro profissional = Bônus 10 moedas.
- **Dependencies**: CDNs Tailwind (`cdn.tailwindcss.com`) + Font Awesome (`kit.fontawesome.com` ou CDN padrão).

## Assumptions
- AS-1: Não há concorrência/multi-usuário real (tudo localStorage, por isso admin ajusta config na própria máquina).
- AS-2: Recarga PIX é simulação (botão "Confirmar Pagamento PIX" credita instantaneamente).
- AS-3: Cidades e bairros demo = DF (Brasília) pois usuário citou Asa Sul, Samambaia, Taguatinga.
- AS-4: Números WhatsApp demo são fictícios (ex: 5561999990001 a 999990004).
- AS-5: Login admin simples (comparação hardcoded strings).

---

## Acceptance Criteria

### AC-1 (rule): Único arquivo entregue em `index.html` com Tailwind via CDN
- **Type**: `rule`
- **Given**: Projeto em `/Users/tiagosantos/Desktop/Ajeita/`
- **When**: Listamos arquivos e abrimos `index.html`
- **Then**: `index.html` existe e contém tags `<script src="...tailwindcss..." />` ou equivalente CDN, TODO HTML/CSS/JS em um arquivo.
- **Pass Condition**: LS mostra `index.html` e grep por `cdn.tailwindcss.com` retorna 1+ match.
- **Evidence**: Saída `ls -la` + `grep -c cdn.tailwindcss index.html >= 1`.

### AC-2 (rule): Header completo com saldo moedas, CTA cadastro, menu 5 itens
- **Type**: `rule`
- **Given**: Home page carregada, profissional DEMO logado com saldo 10.
- **When**: Inspecionar header
- **Then**: Logo existe, menu com 5 links (Buscar, Mural, Sou Profissional, Meus Pedidos, Admin) visível; texto "🪙 10 Moedas" + botão "+ Recarregar Moedas" + CTA "Cadastrar como Profissional" visíveis.
- **Pass Condition**: querySelector para cada elemento retorna truthy.
- **Evidence**: Screenshot do header + browser_evaluate validando 5 elementos.

### AC-3 (rule): Hero com GPS e pesquisa avançada
- **Type**: `rule`
- **Given**: Home view
- **When**: Clicar botão "Usar minha localização atual"
- **Then**: Aparece toast (ou sucesso com cidade/bairro preenchidos) OU toast erro se permissão negada (qualquer um dos dois = pass). Campos de categoria, cidade, bairro existem e são inputs/selects.
- **Pass Condition**: 3 campos + botão GPS existem e evento click dispara fluxo.
- **Evidence**: browser_evaluate `document.querySelectorAll('#hero select, #hero input, #hero button#gps')`.

### AC-4 (rule): Grid profissionais + modal perfil com galeria e depoimentos
- **Type**: `rule`
- **Given**: Home view carregada
- **When**: Contar cards profissionais no grid; clicar no primeiro card
- **Then**: Grid contém >=6 cards profissionais. Modal abre mostrando: nome, foto, média estrelas, >=4 miniaturas na galeria, >=2 depoimentos com texto.
- **Pass Condition**: `document.querySelectorAll('.profissional-card').length >= 6`; `modal.classList.contains('hidden') == false` após clique; `modal.querySelectorAll('.galeria-foto').length >=4`.
- **Evidence**: browser_evaluate counts.

### AC-5 (rule): Sistema desbloqueio moedas (2 moedas, max 4, WhatsApp revelado, wa.me link)
- **Type**: `rule`
- **Given**: Profissional logado com 10 moedas, pedido demo tem 0 desbloqueios.
- **When**: Clicar Desbloquear Contato → confirmar
- **Then**: (1) Saldo cai para 8 moedas; (2) WhatsApp deixa de ser "9****-****" e mostra número completo; (3) aparece botão Abrir WhatsApp com `href` contendo `wa.me/55`; (4) contador desbloqueios do pedido = 1. Repetir com 4 profissionais demo → no 5º desbloqueio, botão desativado e toast "pedido fechado com 4 desbloqueios".
- **Pass Condition**: Todas 4 subcondições true.
- **Evidence**: Sequência de browser_evaluate + saldo final.

### AC-6 (rule): Loja de moedas (3 pacotes) + PIX simulado + Confirma Pagamento credita saldo
- **Type**: `rule`
- **Given**: Profissional logado saldo = 0, modal loja aberto.
- **When**: Clicar Pacote Prata (25 Moedas R$30) → Tela PIX aparece com QR Code visual + Copia e Cola → clicar "Confirmar Pagamento PIX"
- **Then**: Saldo do profissional vira 25 (atualiza header instantaneamente). Grava na localStorage.recargas com pacote Prata/30/25.
- **Pass Condition**: saldo = 25; `localStorage.getItem('recargas')` contém registro.
- **Evidence**: browser_evaluate saldoObjeto + localStorage recargas length >= 1.

### AC-7 (rule): Avaliação 1-5 recalcula média profissional
- **Type**: `rule`
- **Given**: Profissional "Carlos" tem média 4.0 com 2 avaliações totais; cliente criou pedido e marcou serviço finalizado.
- **When**: Modal avaliação aberta, clicar estrela 5, escrever "Excelente trabalho!", submit.
- **Then**: Carlos nova média = (4+4+5)/3 = 4.33? (fórmula: (soma antiga * total antigo + nova nota) / (total antigo + 1)). Contador total avaliações = 3. Card e modal perfil refletem nova média (4.3 estrelas).
- **Pass Condition**: mediaAtualizada = (4*2 + 5)/3 = 4.33; total = 3.
- **Evidence**: Valor do objeto profissional.avaliacaoMedia e qtdAvaliacoes.

### AC-8 (rule): Cadastro profissional ganha BÔNUS 10 Moedas instantâneo
- **Type**: `rule`
- **Given**: Tela cadastro profissional, sem usuário logado.
- **When**: Preencher form (Nome=Teste Souza, WhatsApp=61988887777, Cidade=Brasília, Bairro=Asa Sul, Categorias=[Eletricista,Encanador]) + submit
- **Then**: (1) novo profissional em localStorage; (2) estado = profissional logado; (3) saldo inicial = 10 moedas (creditado!); (4) toast sucesso mensagem sobre BÔNUS; (5) header mostra "🪙 10 Moedas".
- **Pass Condition**: 4/5 subcondições verdadeiras + bonus creditado.
- **Evidence**: localStorage keys + saldo header.

### AC-9 (rule): Admin login admin10/bolo2024 + dashboard completo economia, pedidos, métricas
- **Type**: `rule`
- **Given**: Tela Admin Login
- **When**: Logar com admin10 / bolo2024
- **Then**: Dashboard abre com (1) Config Economia (inputs custo desbloqueio, 3 preços + salvar), (2) Tabela Pedidos (>=4 linhas) e Tabela Profissionais (>=6 linhas), (3) Métricas 3 cards (Total Moedas Vendidas, Total Recargas, Receita Estimada R$). Logout retorna tela login. Errar senha → toast "Credenciais inválidas".
- **Pass Condition**: Login correto mostra todos 3 sub-blocos dashboard. Erro bloqueia.
- **Evidence**: Screenshot dashboard + browser counts.

### AC-10 (rule): Persistência total localStorage e inicialização mocks
- **Type**: `rule`
- **Given**: Navegador limpo (localStorage vazio), abrir página primeira vez.
- **When**: Esperar carregar DOMContentLoaded
- **Then**: localStorage contém 8 chaves mínimas (profissionais, pedidos, profissionalLogado, adminLogado, desbloqueios, recargas, avaliacoes, configEconomia). `profissionais.length >=6`, `pedidos.length >=4`. Fechar e reabrir aba → dados mantêm.
- **Pass Condition**: `Object.keys(localStorage).filter(k => k.startsWith('ajeita_') || k in defaultKeys).length >= 8` e arrays >= minima.
- **Evidence**: browser_evaluate `JSON.stringify(Object.keys(localStorage))` + lengths.

### AC-11 (rule): SPA pattern — navegação sem recarregar (location.reload nunca em click)
- **Type**: `rule`
- **Given**: Qualquer tela
- **When**: Clicar em Buscar, Mural, Sou Profissional, Meus Pedidos, Admin
- **Then**: Muda conteúdo (views aparecem/desaparecem classes hidden). `window.location.href` permanece o mesmo, sem hash novo ou reload.
- **Pass Condition**: função navigateTo definida e 5 cliques não dão reload (monitorar).
- **Evidence**: browser `window.onbeforeunload` não dispara.

### AC-12 (rubric): Qualidade visual & responsividade
- **Type**: `rubric`
- **Dimension**: UI moderna, limpa, cores azul+amarelo/laranja, responsividade mobile desktop
- **Scale**: 1-5
- **Anchors**:
  - 1 = layout quebrado mobile, cores sem padrão, overflow-X, inputs ilegíveis
  - 3 = mobile OK (sem quebrar), desktop aceitável, mas animações pobres ou contraste ruim
  - 5 = pixel-perfect mobile 360px e desktop 1440px; paleta profissional; cards hover, sombras, transições smooth (0.3s); modais com backdrop blur ou overlay escuro; toasts elegantes; scroll suave
- **Pass Threshold**: >= 4
- **Evidence**: Screenshots full-page mobile e desktop (iPhone SE viewport e 1440px viewport) + inspeção visual.

### AC-13 (rubric): Cobertura & completude features pedidas pelo usuário
- **Type**: `rubric`
- **Dimension**: Quantas features obrigatórias (A..H + Técnicos 1..8) estão COMPLETAS e FUNCIONANDO
- **Scale**: 1-5
- **Anchors**:
  - 1 = <40% das features (faltando D E H)
  - 3 = 70% features (faltando galeria depoimentos ou avaliação ou dashboard admin)
  - 5 = 100% features (A..H + Técnicos) implementadas, não há item obrigatório faltando
- **Pass Threshold**: >= 4
- **Evidence**: Checklist mark (A..H = sim/não, Téc 1..8 sim/não).

---

## Open Questions
- [ ] Nome da Plataforma? Assumido "Ajeita" (mantendo o nome da pasta), mas usuário pode preferir outro.
- [ ] Manter integração Firestore (existe no index.html ANTIGO) ou manter 100% localStorage (como pedido nesta spec)? Assumido TUDO localStorage como pedido nesta spec (o usuário NÃO mencionou Firebase, explicitamente pediu `localStorage` em requisito técnico 2).
- [ ] Manter aviso de geolocalização customizado? Assumido: usa `navigator.geolocation` padrão, com toast sucesso/erro.
