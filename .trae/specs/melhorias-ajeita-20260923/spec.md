# AjeitaAi — Especificação de Melhorias (2026-09-23)

*Idioma: Português (Brasil). Natural language matches usuário.*

## 1. Problema, Usuários, Objetivos

### Problema
O AjeitaAi apresenta hoje 7 frentes de lacuna:
1. **Validação de pagamento não 100% no backend**: o frontend possui "botão verificação" que confunde usuários; a confirmação real deve ser Mercado Pago → backend (webhook + CRON) *apenas*.
2. **Ausência de empresas patrocinadoras**: sem estrutura de patrocínio pago ativo, expiração e exibição pública.
3. **Bug de persistência de contas excluídas**: admin exclui → reload ou troca aba → dados retornam (causa-raiz: `carregarDadosStorageBootstrap` L1900-1903 index.html injeta `PROFISSIONAIS_MOCK[i]` em profissionais[i] quando `taxaHora` zero ou `bairrosAtendimento` pequeno, baseado na posição do array e ID mock — apaga profissional mock index 1, no reload o item é reconstruído).
4. **Sem notificações isoladas**: profissional não sabe quando chega pedido/orçamento novo (sem 🔔, sem contador, sem histórico).
5. **Sem anexar fotos no pedido**: cliente não consegue enviar imagens do serviço desejado.
6. **Categorias restritas**: só 8 profissões. Cliente de obra/pedreiro 2 etc precisa buscar manualmente.
7. **Sem botão admin limpar cache** + mensagens admin vazando para usuários finais.

### Usuários
- **Cliente**: cria pedido/orçamento, paga, recebe moedas de desconto, visualiza banners de patrocinadores, **não** recebe notificações administrativas, **não** visualiza botão "limpar cache".
- **Profissional**: atende pedidos/orçamentos, compra moedas, recebe 🔔 notificações de *seus* pedidos, vê fotos anexadas, tem login Google.
- **Patrocinador/Empresa**: cadastra dados + imagens empresa, paga plano, só aparece em lista pública após pagamento aprovado e dentro da vigência.
- **Administrador**: gerencia profissionais, patrocínios, limpa cache, vê logs admin apenas, aprovação manual excepcional.

### Objetivos
1. **Mercado Pago**: confirmação exclusivamente via (a) webhook oficial MP, (b) CRON backend 15s, (c) consulta backend direta — nunca via clique frontend/return URL/botão. Idempotência total. Separação tipo pagamento por `external_reference` prefixado.
2. **Patrocinadores**: coleção dedicada Firestore, pagamento MP via mesmo SDK, ativação automática após aprovado, expiração automática, lista pública com filtro de ativos, admin CRUD completo.
3. **Cache**: corrigir causa raiz do retorno de contas (remover merge PROFISSIONAIS_MOCK em carregarDadosStorageBootstrap por posição), adicionar botão admin limpar cache (apenas listagens, preserva sessão), notificações administrativas visíveis apenas na view admin.
4. **Notificações**: coleção `notificacoes` Firestore, sino 🔔 por profissional com contador não lidas, criação em tempo real via onSnapshot, isolamento estrito por usuário, marcar como lida, marcar todas lidas.
5. **Fotos**: cliente anexa até 3 fotos no pedido (galeria nativa, miniaturas, remover, valida tamanho/formato, comprime); profissional visualiza no detalhe pedido.
6. **Categorias**: expandir lista CATEGORIAS_GLOBAIS para 60+ em 5 grupos; 8 mais populares na home, resto visível em view "Ver todas categorias".

### Não-Objetivos (fora de escopo, explicitamente NÃO FAZER)
- NÃO criar segundo sistema de pagamento ou segunda conta Mercado Pago.
- NÃO criar segundo banco de dados (mantém Firestore + localStorage compartilhado com prefixo `ajeita_moeda_app_`).
- NÃO reescrever sistema de login (mantém Google Identity + login profissional cadastro manual).
- NÃO adicionar WebSocket/SSE (reutiliza Firebase onSnapshot como canal de realtime existente, já funcional).
- NÃO hospedar arquivos imagem em storage (mantém base64 inline em docs, compatível com a arquitetura existente de foto de perfil).
- NÃO remover botão de verificação pagamento (mas ele NUNCA mais aprova por clique em produção real; apenas reinicia listeners).

---

## 2. Requisitos Funcionais (RF) + Não-Funcionais (RNF)

### Mercado Pago e Pagamentos (§1-§6)

**RF-PAG-01 — Confirmação por backend apenas.**
- **Ação**: aprovação de pagamento / liberação de produto (moedas, patrocínio ativo) SÓ pode ocorrer no backend, depois de `GET /v1/payments/:id` no MP retornar `status === 'approved' | 'accredited'`.
- **Proibição explícita**: nenhum código JS client-side pode chamar função que seta `status: 'aprovado'` em banco ou localStorage; nenhum `setTimeout` libera moedas no frontend em produção; retorno do navegador `return_url` MP NÃO pode liberar nada (apenas exibe UI "Aguardando confirmação").

**RF-PAG-02 — Reuso do webhook existente.**
- O endpoint `POST /webhook-pix` (server.js L606) EXISTE. Reaproveita-lo.
- Melhorias obrigatórias:
  1. **Validar assinatura HMAC** antes de processar (função `_validarAssinaturaWebhookMp` existe; garantir que, se `MP_WEBHOOK_SECRET` env estiver vazio em produção real, loga WARNING de alto risco, NÃO aborta).
  2. **Idempotência**: antes de creditar moedas / ativar patrocinador, o handler `processarAprovacaoPix` verifica `doc.pix_transacoes.status === 'aprovado'` — se já aprovado, retorna sucesso imediato sem repetir operação.
  3. **Tipos external_reference**: switch por prefixo `external_reference` para rotear para o handler apropriado:
     - `RECARGA_PRO_<uid>_<ts>` → `_creditarMoedasProfissional` (existente)
     - `CLIENT_ORDER_<pedidoId>_<ts>` → (reservado para futuro, hoje só loga)
     - `SPONSOR_<sponsorId>_<plan>_<ts>` → `_ativarPatrocinadorPorPagamento` (novo)

**RF-PAG-03 — CRON backend 15s (existente L799).**
- Reaproveitar `setInterval` 15s já existente (não criar novo).
- Após o loop de `pix_transacoes`, executar em sequência 2 passos:
  1. Varredura `patrocinadores` collection: docs onde `status_pagamento !== 'approved' AND external_reference definido` → consultar MP; se aprovado, chamar `_ativarPatrocinadorPorPagamento` (idempotente).
  2. Varredura `patrocinadores` expiração: docs onde `status_patrocinador === 'ativo' AND data_termino < now` → marcar `status_patrocinador = 'expirado'`, `updated_at = now` (mantém histórico, não apaga).

**RF-PAG-04 — external_reference formatada e diferenciada.**
- NENHUM pagamento vai mais ter formato genérico `ajeita_moeda_<ts>_<uid>`.
- Novo formato padrão (todos os casos):
  - Recarga moedas profissional → `RECARGA_PRO_<uid>_<timestamp>`
  - Pagamento pedido cliente (reservado) → `CLIENT_ORDER_<pedidoId>_<timestamp>`
  - Plano patrocinador → `SPONSOR_<sponsorDocId>_<planoKey>_<timestamp>`

**RF-PAG-05 — Mínimo preço por pacote (existente project_memory, preservar).**
- Bronze ≥R$15, Prata ≥R$30, Ouro ≥R$60 validado no backend `POST /api/pix/criar-recarga-moedas`. Mantém. Patrocínio terá mínimo próprio no backend.

---

### Patrocinadores (§7-§13)

**RF-PAT-01 — Estrutura de dados `patrocinadores` (Firestore collection).**
Campos (todos os requeridos conforme user §7):
```typescript
{
  id: string,                         // docId firestore (SPONSOR_<uuid>)
  nome_empresa: string,
  categoria: string,
  descricao: string,
  logo: string | null,                // base64 dataURL
  cartao_visita: string | null,       // base64 dataURL (📇 Cartão visita)
  fotos: string[],                    // até 3 fotos extras, base64
  whatsapp: string,
  site: string,
  instagram: string,
  plano: 'bronze' | 'prata' | 'ouro' | 'personalizado',
  plano_dias: number,                 // dias de vigência a partir aprovação
  valor: number,
  status_pagamento: 'pending' | 'in_process' | 'approved' | 'rejected' | 'cancelled' | 'refunded',
  status_patrocinador: 'rascunho' | 'aguardando_pagamento' | 'ativo' | 'expirado' | 'inativo_admin' | 'rejeitado_pagto',
  data_inicio: Timestamp | null,
  data_termino: Timestamp | null,
  mp_payment_id: string | null,
  external_reference: string | null,
  patrocinador_uid_criador: string,   // id de quem criou (admin/patrocinador logado)
  aprovado_por_admin_manual?: boolean, // apenas true se ação administrativa manual (§13 regra)
  motivo_manual?: string,
  created_at: Timestamp,
  updated_at: Timestamp
}
```

**RF-PAT-02 — Rota backend criar pagamento patrocinador (mesmo MP SDK).**
- `POST /api/patrocinadores/criar-pagamento`:
  - Recebe: objeto parcial de patrocinador, uid criador, plano selecionado.
  - Valida: plano preço mínimo >= (ex: Bronze 30 dias R$50, Prata 60d R$120, Ouro 90d R$240, personalizado admin define).
  - Salva doc `patrocinadores/<id>` inicial `status_pagamento='pending'`, `status_patrocinador='aguardando_pagamento'`, grava `external_reference = SPONSOR_<id>_<plano>_<ts>`.
  - Cria pagamento MP usando o mesmo código (SDK v2 + fetch fallback nativo) de `/api/pix/criar-recarga-moedas` → reuso 100%.
  - Retorna QR code igual rota recarga (inclui fallback qrcodejs).

**RF-PAT-03 — Ativação automática pós pagamento.**
- Ao receber `approved` (via webhook OU cron 15s), handler `_ativarPatrocinadorPorPagamento(external_reference)`:
  1. Idempotência: se `status_patrocinador === 'ativo'` já, retorna.
  2. Seta `status_pagamento='approved'`, `status_patrocinador='ativo'`, `data_inicio = now`, `data_termino = now + plano_dias dias`, `mp_payment_id`, `updated_at`.
  3. NÃO ativa se `status_pagamento !== approved` (pending/in_process/rejected/cancelled/refunded → mantém `status_patrocinador` inativo).

**RF-PAT-04 — Não exibir antes do pagamento (§9).**
- `GET /api/patrocinadores/ativos` retorna apenas `status_patrocinador === 'ativo' AND data_inicio <= now <= data_termino`. Filtrar NO backend (não confiar em front).
- Frontend banner: chama a rota; fallback: onSnapshot `patrocinadores` onde `status_patrocinador === 'ativo'`.

**RF-PAT-05 — Expiração automática (§10).**
- Dentro do mesmo `setInterval` 15s existente, passo 2: varrer `patrocinadores` onde `status_patrocinador === 'ativo' AND data_termino < now` → marcar `status_patrocinador = 'expirado'`, `updated_at`.
- Não apaga doc (mantém histórico). UI banners some imediatamente pois query filtra.

**RF-PAT-06 — Área do patrocinador (§11).**
- Na página inicial, bottom nav (já tem 5 abas — transformar 5ª aba "Entrar/Perfil" em menu dropdown com 4ª aba nova?) → MELHOR: adicionar card "Quero patrocinar o AjeitaAi" na view-home (abaixo banners), e na view-login uma opção "Sou empresa/quero patrocinar".
- Formulário de cadastro patrocinador com:
  - Campos texto: nome_empresa, categoria, descricao, whatsapp, site, instagram.
  - Input arquivo para LOGO (📷 Adicionar imagem, type=file accept=image/* — abre galeria nativa).
  - Input arquivo para CARTÃO DE VISITA (📇 Cartão visita).
  - Input arquivo para até 3 FOTOS adicionais.
  - Validação: JPG/PNG/GIF/WebP, max 5MB cada.
  - Comprimir no front (canvas resize max 1080px, 0.8 JPEG quality) antes base64.

**RF-PAT-07 — Banners públicos (§12).**
- Acima do "Categorias rápidas" ou abaixo do hero, nova seção HTML:
  - Título: "🏷️ Empresas parceiras do AjeitaAi"
  - Componente: scroll horizontal (overflow-x-auto snap) cards banners autoplay a cada 6s (touch native + CSS animation; sem lib).
  - Cada card: imagem (logo ou cartão_visita), nome, categoria, descrição 1 linha, botão "👉 Conhecer empresa" (abre WhatsApp ou site ou Instagram; ordem whatsapp > site > instagram).
  - Fonte de dados: `onSnapshot mods.collection(FbDb, 'patrocinadores') + filter status_patrocinador==='ativo'` no front + server rota fallback.

**RF-PAT-08 — Painel admin patrocínios (§13).**
- No admin.html, adicionar 3ª tab `🤝 Patrocinadores` no mesmo header tabs de pedidos/profissionais.
- Tabela mostra: Nome empresa, categoria, plano, valor, status pagto, status patrocinador, data_inicio / termino, payment_id, MP external_reference.
- Ações por linha:
  - ✅ Ativar manualmente / 🚫 Desativar admin: seta `status_patrocinador='inativo_admin'`. ESTRITAMENTE proibido setar `status_pagamento='approved'` a menos que checkbox explícito "Eu autorizo manualmente esta aprovação de pagamento (ação administrativa)" esteja marcado + campo motivo; seta `aprovado_por_admin_manual=true` + `motivo_manual`.
  - ✏️ Editar dados (nome, categoria, whatsapp, etc — NÃO deleta pagamentos já aprovados).
  - 🗑️ Excluir: remove doc Firestore + confirmação dupla.
  - 💾 Export CSV opcional (se fácil, se não omitir).
- Isolamento: todo painel só existe em admin.html; nenhum botão visível em index.html p/ cliente/profissional.

---

### Cache e Botão Limpar (§14-§16)

**RF-CACHE-01 — Corrigir causa raiz contas reaparecem (§14).**
- Alterar função `carregarDadosStorageBootstrap` (index.html L1900-L1907): REMOVER o loop `profissionais.forEach((p, i) => { ... PROFISSIONAIS_MOCK[i] ... })` que sobrepõe dado mock storageado baseado no índice + ID mock igual. É a causa raiz do bug: se apagar item pro_mock_2 (index 1) e reload tiver array 4 elementos sem ele, `PROFISSIONAIS_MOCK[1]` (Rosângela) é injetada no `profissionais[1]` que não tem ela mais → voltou!
- Substituição: preservar mock inicial SÓ se storage estiver vazio. Se storage tem conteúdo, usar 100% storage (dado real pode ter taxaHora 0, é permitido; não forçar preenchimento default).

**RF-CACHE-02 — Botão admin 🧹 Limpar cache (§15).**
- Local: admin.html, canto superior direito (ao lado de sair), ícone `🧹` texto "Limpar cache".
- Ação ao clicar:
  ```javascript
  const CHAVES_LISTAGENS = ['profissionais','pedidos','desbloqueios','recargas','avaliacoes','meusPedidosClienteIds','clienteUltimosDados','fotoPerfilBase64Temp','_cadFotoBase64Temp'];
  CHAVES_LISTAGENS.forEach(k => try localStorage.removeItem(PREFIXO_STORAGE + k));
  try localStorage.removeItem('ajeita_ult_ext_ref_pix');
  ```
  - **MANTER intacto**: `profissionalLogado`, `adminLogado`, `configEconomia`, `clienteGoogleLogado` → sessão/login preserved.
  - Imediatamente após, chamar: re-carregar dados (carregarDadosStorageBootstrap) + forçar `fbSyncProfissionaisRealtime()` reconnect + `renderAdminDashboard()` + toast admin apenas `Cache atualizado com sucesso. Sessão mantida.`

**RF-CACHE-03 — Mensagens admin permanecem no admin apenas (§16).**
- Tipos `toast('info','Cache atualizado','Atualizei...')` só aparecem se `adminLogado === true` (na view admin).
- A função `toast` NÃO é global só admin; todo código de toast no admin.html apenas.
- No index.html: nunca exibir toasts com texto como "N contas atualizadas / sincronizado / manutenção" exceto se view atual é view-admin-* (views admin removidas, então por construção index.html não vai ter).

---

### Notificações do Profissional (§17-§21)

**RF-NOTIF-01 — Coleção `notificacoes` Firestore (nova).**
```typescript
{
  id: string,                         // docId (notif_<uuid>)
  tipo_usuario_alvo: 'profissional' | 'cliente' | 'admin', // §19 isolamento
  usuario_id_alvo: string,            // profissional.id, cliente.googleId, admin 'admin'
  tipo: 'novo_pedido' | 'novo_orcamento' | 'novo_cliente_interesse' | 'nova_mensagem' | 'resposta_cliente' | 'atualizacao_orcamento' | 'alteracao_pedido',
  titulo: string,
  mensagem: string,
  pedido_id: string | null,
  profissional_id: string | null,
  cliente_id: string | null,
  payload_json: {} | null,
  lida: boolean,
  created_at: Timestamp
}
```
- Regras Firestore (inserir no console ou manter via SDK filtro): allow read, create: if `(request.auth != null && request.auth.uid == resource.data.usuario_id_alvo) || true` (por enquanto coleção aberta como profissionais; o importante é frontend SEMPRE filtrar usuario_id_alvo == eu).

**RF-NOTIF-02 — Criar notificação ao criar pedido.**
- Ao criar pedido/orçamento (função `_criarPedidoFirestoreEmitirNotificacao`), após salvar pedido, criar doc `notificacoes/`:
  - `tipo_usuario_alvo = 'profissional'`
  - `usuario_id_alvo = pedido.profissional_id`
  - `tipo = 'novo_pedido'`
  - `titulo = '🔨 Novo pedido de serviço'`
  - `mensagem = 'Um cliente fez um novo pedido de serviço para você. Abra para ver os detalhes!'`
  - `pedido_id = pedido.id`
  - `lida = false`
- Fluxos reservados para §18 (novo_orcamento etc) — estrutura do doc já suporta todos; a chamada de criação adicionada apenas onde hoje existe ação correspondente.

**RF-NOTIF-03 — Sino 🔔 no header do profissional logado (§17-§18).**
- Local: view-profissional area e view-login-perfil do profissional logado.
- Componente: botão circular com `🔔` e `badge-vermelho` contador (número de notif.nao_lidas do usuário logado; se 0, sem badge).
- Ao clicar no sino:
  - Abre drawer/dropdown (modal simples ou absolute div) com lista últimas 20 notif.
  - Cada notificação: ícone por tipo, título, mensagem, data, clicável (abre detalhe pedido).
  - Ao abrir drawer: marca notif. aberta como lida (lida = true) — async `updateDoc` Firestore batch.
  - Botão rodapé drawer: `Marcar todas como lidas` — batch update.
  - Fechar drawer clicar fora.

**RF-NOTIF-04 — Isolamento estrito por usuário (§19).**
- Frontend, ao abrir onSnapshot de `notificacoes`:
  ```javascript
  const qAlvo = mods.query(
    mods.collection(FbDb, 'notificacoes'),
    mods.where('usuario_id_alvo', '==', usuarioLogadoCorrente.id),
    mods.where('tipo_usuario_alvo', '==', 'profissional'), // etc
    mods.orderBy('created_at', 'desc'),
    mods.limit(50)
  );
  ```
- Se falhar por índice composto faltante: filtrar no Node.js-style memória após pegar tudo (como project_memory recomenda para coleções pequenas <100).
- Admin e cliente NUNCA escutam notificações uns dos outros. Se não logado como profissional: sino não renderiza.

**RF-NOTIF-05 — Realtime via onSnapshot existente (§21).**
- Não criar SSE/WebSocket; reaproveita Firebase SDK 10 onSnapshot para `notificacoes`.
- Quando novo doc chegar: atualiza contador instantaneamente, exibe micro toast não intrusivo (1,5s, tipo "🔔 Nova notificação: <titulo>").

---

### Fotos em Pedidos (§22-§23)

**RF-FOTO-01 — Cliente anexa até 3 fotos (§22).**
- No formulário view-criar-pedido (onde hoje tem campos de endereço e descrição), adicionar campo:
  ```
  📸 Fotos do serviço
  Adicione até 3 fotos para explicar melhor o que você precisa.
  Botão 📷 Adicionar foto → <input type="file" accept="image/*" multiple id="pedidoFotosInput">
  ```
- Validações:
  - Máximo 3 arquivos; 4º é rejeitado c/ toast "Máximo 3 fotos. Remova uma antes."
  - Cada imagem: type `image/*`, tamanho ≤ 5MB, formato JPG/PNG/WebP/GIF aceito.
  - Antes armazenar: função utilitária `_comprimirImagem(file, maxW=1080, quality=0.78)` → Promise retorna base64 JPEG (canvas resize mantém aspect ratio).
- UI miniaturas: abaixo do input, mini quadrados 80x80 da foto + botão × remover individual.

**RF-FOTO-02 — Profissional visualiza fotos no pedido (§23).**
- Na view detalhe-pedido (view `view-pedido-detalhe`), se `(pedido.fotos || []).length > 0`, renderizar seção:
  `📸 Fotos enviadas pelo cliente`
- Galeria grid 3 colunas, clique abre modal fullscreen (swiper simples ou nativo imagem zoom).
- Validação de autorização: só renderiza galeria SE `profissionalLogado.id === pedido.profissional_id` OR `clienteGoogleLogado && pedido.cliente_id === clienteGoogleLogado.googleId` OR admin (no admin dashboard view detalhe).

---

### Categorias (§24)

**RF-CAT-01 — Expandir CATEGORIAS_GLOBAIS para 60+ em 5 grupos.**
- Array novo `CATEGORIAS_COMPLETA` organizado como:
  ```javascript
  CATEGORIAS_GRUPOS = [
    { nome: '🏗️ Construção e reforma', itens: ['Pedreiro','Servente','Mestre de obras','Azulejista','Gesseiro','Drywall','Pintor','Eletricista','Encanador','Bombeiro hidráulico','Telhadista','Calheiro','Impermeabilizador','Serralheiro','Soldador','Marceneiro','Carpinteiro','Vidraceiro','Marmorista','Instalador de portas e janelas','Instalador de ar-condicionado','Instalador de energia solar'] },
    { nome: '🏠 Casa e manutenção', itens: ['Montador de móveis','Técnico de eletrodomésticos','Técnico de máquina de lavar','Técnico de geladeira','Jardineiro','Paisagista','Dedetizador','Limpeza residencial','Diarista','Limpeza pós-obra','Limpeza de caixa-d\'água','Piscineiro','Chaveiro'] },
    { nome: '🚚 Fretes e mudanças', itens: ['Frete','Carreto','Transporte de móveis','Ajudante de mudança','Transporte de materiais'] },
    { nome: '🛠️ Aluguel e equipamentos', itens: ['Aluguel de ferramentas','Aluguel de andaimes','Aluguel de betoneira','Aluguel de escadas','Aluguel de máquinas','Aluguel de equipamentos para obra','Aluguel de caçamba','Retroescavadeira','Compactador de solo','Caminhão/Munck'] },
    { nome: '📐 Projetos', itens: ['Arquiteto','Engenheiro civil','Técnico em edificações','Projetista','Topógrafo','Designer de interiores','Orçamentista de obras'] }
  ];
  ```
- `CATEGORIAS_GLOBAIS` (home, 8 ícones) fica com os 8 mais populares para não poluir a home.
- `CATEGORIAS_ICONE`: adicionar ícone FA para cada uma (se faltar, `fa-check` default).

**RF-CAT-02 — Ver todas categorias (nova view).**
- No header home (categorias rápidas), adicionar botão direito: `Ver todas →`. Abre nova view `view-categorias-todas`.
- View renderiza 5 grupos accordion ou blocos separados, cada categoria = card clicável (filtra catálogo).
- Campo pesquisa topo (já existe no header; reutiliza). Se filtrar input texto → match por substring nome nas 60+.

---

### Não-Funcionais (RNF)

**RNF-01 — Nenhuma refatoração geral.** Alterações cirúrgicas: 5 arquivos existentes + 0 novos arquivos (exceto talvez nenhum; tudo em `index.html` front + `admin.html` + `server.js` backend + `package.json` (se precisar dependência, mas NÃO adicionar). NÃO adicionar dependências (reutiliza `mercadopago:2.2.0` + Firebase SDK 10 CDN).

**RNF-02 — Compatibilidade total deploy existente.** Mantém Render static + backend Node na porta `$PORT`. Novas collections Firestore são criadas automaticamente pelo SDK ao primeiro write (regra já usada em pix_transacoes).

**RNF-03 — Validação HMAC webhook obrigatória quando secret configurado.** Se `MP_WEBHOOK_SECRET` preenchido, rejeita chamadas inválidas antes de `fetch MP /v1/payments/:id`.

**RNF-04 — Logging estruturado.** Cada handler crítico (processarAprovacaoPix, ativar patrocinador, expiração) loga `[IDEMPOTENCIA] SKIP: ja aprovado external_ref=X` (evidenciar idempot).

**RNF-05 — Tamanho base64 imagens.** Comprimir antes: max 1080px lado maior, 0.78 JPEG quality. Não permitir imagens > 2.5MB pós-compressão final.

**RNF-06 — Nomes e marca mantém grafia AjeitaAi (i minúsculo).** Nenhum AjeitaAI maiúsculo.

---

## 3. Restrições, Dependências, Assunções

### Restrições
- NÃO adicionar pacotes NPM novos. Reutilizar Firebase SDK v10 e `mercadopago` 2.2.0.
- NÃO alterar prefixo storage `ajeita_moeda_app_` (identificador técnico lowercase).
- NÃO apagar collections existentes.
- NÃO remover integração chave Pix fallback manual (para emergências).
- NÃO quebrar login Google existente e credencial admin10/bolo2024.

### Dependências
- Mercado Pago Access Token + Webhook Secret preenchidos (Render ENV).
- Projeto Firestore `ajeita-app-c9fc2` com regras allow create/read/write/delete para coleções novas: `patrocinadores`, `notificacoes`, `pedidos` (ou permissões iguais às de `profissionais`).
- Regra allow `delete` Firestore `profissionais` já existe (já deleteDoc hoje).

### Assunções
- Assumido que coleções novas (patrocinadores, notificacoes) são criadas automaticamente (SDK).
- Assumido tamanho de pedido com 3 fotos comprimidas cabe no Firestore doc (~1MB) — caso não, a implementação deve reduzir qualidade automaticamente para 0.65 ou max 800px lado.
- Assumido view categorias todas pode ser criada no mesmo arquivo index.html com classe `view-categorias-todas` + função navigateTo (existente).

### Questões em Aberto (NÃO BLOQUEIAM IMPLEMENTAÇÃO — valores defaults adotados)
- Q01: Preço planos patrocinador. Adotar: Bronze R$50 / 30 dias, Prata R$120 / 60 dias, Ouro R$240 / 90 dias; admin pode criar personalizado.
- Q02: Onde colocar botão área patrocinador. Adotar: novo card na home abaixo hero + opção "Sou empresa/quero patrocinar" no menu login.
- Q03: Coleção `pedidos` hoje localStorage só; vamos persistir no Firestore também? Adotar: SIM, criar função `_salvarPedidoFirestore(pedido)` duplicar write localStorage + Firestore com listener onSnapshot para profissional ver pedidos novos em tempo real (complementar notificações).

---

## 4. Critérios de Aceitação (AC)

> Tipo: `rule` = condição binária objetiva; `rubric` = qualitativo com escala 0-2.

### AC-PAG (Pagamentos)
- **rule AC-PAG-001**: após Mercado Pago aprovar, se eu rodar grep `processarAprovacaoPix` server.js o código NÃO CONTÉM `next(null)` que credita sem checar `status === 'approved' | 'accredited'`.
- **rule AC-PAG-002**: external_reference format novo. grep external_ref format: `RECARGA_PRO_|CLIENT_ORDER_|SPONSOR_` aparecem no criar-pagamento.
- **rule AC-PAG-003**: idempotência. Se `pix_transacoes/X.status === 'aprovado'` antes, `processarAprovacaoPix(X)` retorna sem `docRef.set saldoMoedas += qtdMoedas` executar.
- **rule AC-PAG-004**: segurança webhook. `MERCADO_PAGO_WEBHOOK_SECRET` setado → `_validarAssinaturaWebhookMp` retorna falso → handler não faz fetch MP e não credita nada.
- **rubric AC-PAG-005 (0-2, threshold ≥1)**: clareza dos logs de aprovação automática por webhook vs cron.
- **rule AC-PAG-006**: botão frontend `confirmarPagamentoPix` modo `automatico_mp` NÃO executa nenhum `saldoMoedas +=` localmente; só inicia listeners.

### AC-PAT (Patrocinadores)
- **rule AC-PAT-001**: collection `patrocinadores` schema inclui todos os 21 campos de RF-PAT-01.
- **rule AC-PAT-002**: patrocinador com status_pagamento = pending / in_process / rejected → doc não aparece na lista retornada por `GET /api/patrocinadores/ativos`.
- **rule AC-PAT-003**: webhook MP aprova pagamento SPONSOR external_ref → doc status_patrocinador = ativo e data_termino calculado corretamente em dias.
- **rule AC-PAT-004**: expiração. Crio doc ativo com data_termino = ontem → após próxima rodada 15s cron → `status_patrocinador = 'expirado'`, NÃO apagado.
- **rule AC-PAT-005**: banners públicos só mostram ativos. Simulo sponsor ativo e sponsor expirado → só 1 aparece em HTML renderizado.
- **rule AC-PAT-006**: admin manual set aprovado pagamento → obrigatório campo `aprovado_por_admin_manual=true` e `motivo_manual` preenchido; NÃO deixa setar pagto aprovado sem.

### AC-CACHE
- **rule AC-CACHE-001**: código `carregarDadosStorageBootstrap` index.html NÃO CONTÉM mais forEach PROFISSIONAIS_MOCK[i].taxaHora/popula storageado.
- **rule AC-CACHE-002**: botão admin limpar cache. simulo clique: `localStorage.getItem('ajeita_moeda_app_profissionalLogado')` AINDA existe, mas `ajeita_moeda_app_profissionais` (listagem) some. Após a ação, admin continua logado (toast confirma).
- **rule AC-CACHE-003**: toast mensagem admin aparece só se adminLogado.

### AC-NOTIF
- **rule AC-NOTIF-001**: criador pedido cria doc notificacoes com `usuario_id_alvo = profissional_id`.
- **rule AC-NOTIF-002**: contador sino = número docs onde `lida=false AND usuario_id_alvo=eu`.
- **rule AC-NOTIF-003**: isolamento. Profissional A recebe notificação X. Profissional B onSnapshot NÃO contém X (filter).
- **rule AC-NOTIF-004**: clicar "Marcar todas como lidas" → batch update Firestore define lida=true em todas do usuário.

### AC-FOTO
- **rule AC-FOTO-001**: input pedido fotos. Adiciono 4 arquivos → 4º rejeitado toast correto.
- **rule AC-FOTO-002**: Removo 1 de 3 → contador baixa e permite adicionar nova.
- **rule AC-FOTO-003**: Envio. Acesso como profissional. Pedido detalhe renderiza `<img>` para cada foto enviada. Se outro profissional abre (id diferente), NÃO renderiza galeria.

### AC-CAT
- **rule AC-CAT-001**: `CATEGORIAS_GRUPOS` objeto novo index.html contém 5 grupos e 60+ itens total.
- **rule AC-CAT-002**: ver todas categorias view navegável (navigateTo) a partir de botão home categorias.
- **rule AC-CAT-003**: checkbox form profissional apresenta TODAS 60+ categorias (não só 8).
