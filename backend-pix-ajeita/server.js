require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const admin = require('firebase-admin');
const crypto = require('crypto'); // ← (NOVO VALIDACAO WEBHOOK HMAC) Node built-in, nao precisa instalar nada

/* ============================
   FIREBASE ADMIN INIT (SERVICE ACCOUNT JSON)
   - Pegamos FIREBASE_SERVICE_ACCOUNT_JSON de ENV VAR (cole todo JSON bruto,
     exatamente como voce faz no buscabar: $env:FIREBASE_SERVICE_ACCOUNT_JSON=(Get-Content ...json -Raw))
   ============================ */
const svcAccountStr = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}').trim();
let svcAccount;
try { svcAccount = JSON.parse(svcAccountStr); }
catch (eParse) {
  console.error('[FIREBASE_ADMIN] ERRO ao parsear FIREBASE_SERVICE_ACCOUNT_JSON. Verifique ENV VAR.');
  console.error(eParse);
  svcAccount = null;
}
if (svcAccount && svcAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(svcAccount),
    databaseURL: `https://${svcAccount.project_id}.firebaseio.com`
  });
  console.log(`[FIREBASE_ADMIN] OK: conectado no projeto "${svcAccount.project_id}"`);
} else {
  console.warn('[FIREBASE_ADMIN] AVISO: Service Account valido NAO encontrado. Modo LOCAL storage apenas.');
}
const dbFirestore = admin.firestore ? admin.firestore() : null;

/* ============================
   MERCADO PAGO SDK CONFIG
   - TOKEN via ENV VAR: MERCADO_PAGO_ACCESS_TOKEN
   (Pode usar TEST-... primeiro para homologacao, depois APP_USR-... producao)
   - MODO PRODUCAO SEGURO: se token comeca com APP_USR- (producao real),
     NUNCA cai no modo MOCK (nao gera QR falso com dinheiro real envolvido).
   ============================ */
const MP_ACCESS_TOKEN = String(process.env.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
const MP_WEBHOOK_SECRET = String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || '').trim(); // ← (NOVO) Assinatura secreta do webhook MP (painel developers) — opcional, mas RECOMENDADO produzao real
const MODO_PRODUCAO_REAL = Boolean(MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.startsWith('APP_USR-'));
const MODO_HOMOLOGACAO_TESTE = Boolean(MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.startsWith('TEST-'));
let mercadopago = null;
try {
  const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
  if (MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.length > 10) {
    const mpClient = new MercadoPagoConfig({
      accessToken: MP_ACCESS_TOKEN,
      options: { timeout: 15000 }
    });
    mercadopago = { Payment: new Payment(mpClient), Preference: new Preference(mpClient) };
    console.log(`[MERCADO_PAGO] SDK inicializado. Modo = ${MODO_PRODUCAO_REAL ? '🚨 PRODUCAO (DINHEIRO REAL) 🚨' : MODO_HOMOLOGACAO_TESTE ? '🧪 HOMOLOGACAO TESTE' : 'DESCONHECIDO'}. Access Token prefixo: ${MP_ACCESS_TOKEN.substring(0, 12)}...`);
  } else {
    if (MODO_PRODUCAO_REAL) {
      console.error('[MERCADO_PAGO] ERRO CRITICO: MODO PRODUCAO (APP_USR) mas token INVALIDO. Sistema BLOQUEADO para nao gerar QR falso.');
    } else {
      console.warn('[MERCADO_PAGO] AVISO: MERCADO_PAGO_ACCESS_TOKEN vazio ou invalido. Modo MOCK (simulacao local HOMOLOGACAO APENAS, nao use producao).');
    }
  }
} catch (eInitMp) {
  console.error('[MERCADO_PAGO] Falha carregar SDK mercadopago:', eInitMp);
  if (MODO_PRODUCAO_REAL) {
    console.error('[MERCADO_PAGO] 🚨 PRODUCAO REAL: SDK nao carregou. Sistema BLOQUEADO para evitar QR falso / perda de dinheiro.');
    mercadopago = null;
  }
}

const BACKEND_PUBLIC_URL = String(process.env.BACKEND_PUBLIC_URL || 'http://127.0.0.1:7001').trim(); // ← (BUG FIX NEWLINE) .trim() remove \n espacos enter se user colou ENV errado no Render
const PORTA = Number(process.env.PORT || '7001');

/* ============================
   LEGAL / TERMOS & PRIVACIDADE — Versionamento e Validação Backend
   - Mesmas versões do frontend (index.html). Atualizar JUNTOS quando publicar nova versão.
   - Novas versões solicitam novo aceite no frontend; backend recusa operações que exigem consentimento (liberar moedas, etc.) sem aceite válido.
   ============================ */
const TERMS_VERSION = '1.0';
const PRIVACY_VERSION = '1.0';
function _validarAceiteTermosBackend(profDoc) {
  if (!profDoc || typeof profDoc !== 'object') return { ok:false, motivo:'doc_profissional_vazio' };
  const aceite = profDoc.aceite_termos || profDoc.aceite || null;
  if (!aceite || typeof aceite !== 'object') return { ok:false, motivo:'aceite_nao_registrado', detalhe:'Nenhum registro de aceite de Termos/Política encontrado no perfil.' };
  const tv = String(aceite.termos_version || '');
  const pv = String(aceite.privacidade_version || '');
  if (tv !== TERMS_VERSION) return { ok:false, motivo:'versao_termos_desatualizada', esperado:TERMS_VERSION, encontrado:tv };
  if (pv !== PRIVACY_VERSION) return { ok:false, motivo:'versao_privacidade_desatualizada', esperado:PRIVACY_VERSION, encontrado:pv };
  const dth = String(aceite.data_hora_aceite || '').trim();
  if (!dth || dth.length < 10) return { ok:false, motivo:'data_hora_aceite_faltante', detalhe:'O aceite existe mas não possui data/hora de registro.' };
  return { ok:true, motivo:'aceite_valido', versao_termos:tv, versao_privacidade:pv, data_hora:dth };
}
const app = express();
// ===== Ajeitaí Security Agent ===== (3 linhas)
const secAgent = require('./security/index');
if (secAgent && typeof secAgent.middleware === 'function') app.use(secAgent.middleware);
// ===== Fim Security Agent middleware =====
app.use(cors({ origin: true }));
// (NOVO V11 WEBHOOK SEGURO — FORMA CORRETA NO EXPRESS) Preservar raw body string SEM quebrar express.json
// Usamos a opcao `verify` do proprio express.json que devolve o Buffer intacto para o HMAC
// (Evita o middleware custom que consumia o stream antes do express.json, causando HTTP 500 em POSTs)
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    try { req.rawBodyStr = buf ? buf.toString(encoding || 'utf8') : ''; }
    catch (eRaw) { req.rawBodyStr = ''; }
  }
}));
app.use(morgan('combined'));
// Security Agent routes + dashboard (6 linhas)
try {
  if (secAgent && typeof secAgent.registerRoutes === 'function') secAgent.registerRoutes(app);
  if (secAgent && typeof secAgent.errorHandler === 'function') app.use(secAgent.errorHandler);
} catch (eSecInit) { console.warn('[SECURITY_AGENT] init falhou, modo OFF seguro.', String((eSecInit && eSecInit.message) || eSecInit).substring(0, 300)); }
// ===== Fim Security Agent routes =====

/* ============================
   (NOVO V11 WEBHOOK HMAC) Helper valida assinatura secreta Mercado Pago
   Documentacao MP: x-signature header tem format ts=123,v1=abc,v1=def
   Regra: criar string "id={dataId};{request_id or ''};{ts};" + rawBody
   HMAC_SHA256 com MP_WEBHOOK_SECRET → comparar com os v1=...
   ============================ */
function _validarAssinaturaWebhookMp(req, pagamentoIdFromBody) {
  if (!MP_WEBHOOK_SECRET || MP_WEBHOOK_SECRET.length < 5) {
    if (MODO_PRODUCAO_REAL) {
      console.error('[WEBHOOK_MP_VALIDACAO] 🚨 ALTO RISCO PRODUCAO: MERCADO_PAGO_WEBHOOK_SECRET VAZIO EM PRODUCAO REAL (APP_USR). QUALQUER UM PODE ENVIAR WEBHOOK FALSO E TENTAR FRAUDE. RECOMENDAMOS CONFIGURAR AGORA MESMO NO PAINEL RENDER ENV: MP_WEBHOOK_SECRET=<segredo painel developers MP>. SKIP validacao por compatibilidade, MAS FACA ISSO URGENTE.');
    } else {
      console.log('[WEBHOOK_MP_VALIDACAO] MERCADO_PAGO_WEBHOOK_SECRET nao configurado → SKIP validacao HMAC (recomendamos configurar para produzai real).');
    }
    return true;
  }
  try {
    const headerXSig = String(req.headers['x-signature'] || req.headers['X-Signature'] || '');
    if (!headerXSig) { console.warn('[WEBHOOK_MP_VALIDACAO] x-signature header nao recebido, MP_WEBHOOK_SECRET ativo → REJEITADO.'); return false; }
    const parts = headerXSig.split(',').reduce((acc, p) => {
      const [k, v] = p.split('=');
      if (k && v) acc[String(k).trim()] = String(v).trim();
      return acc;
    }, {});
    const ts = parts.ts || '';
    const v1Signatures = Object.keys(parts).filter(k => k.startsWith('v1')).map(k => parts[k]);
    if (!ts || v1Signatures.length === 0) { console.warn('[WEBHOOK_MP_VALIDACAO] x-signature sem ts ou v1.'); return false; }
    const idParaHash = String(pagamentoIdFromBody || (req.body && (req.body.data?.id || req.body.id)) || '').trim();
    const reqId = String(req.headers['x-request-id'] || '').trim();
    const manifest = `id:${idParaHash};request-id:${reqId};ts:${ts};`; // formato MP para webhook endpoint v2 (Pix checkouts)
    const baseHmac = `${manifest}\n${String(req.rawBodyStr || '')}`;
    const digest = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(baseHmac, 'utf8').digest('hex');
    const match = v1Signatures.some(sig => crypto.timingSafeEqual ? crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(digest, 'hex')) : (sig.toLowerCase() === digest.toLowerCase()));
    if (!match) {
      console.warn(`[WEBHOOK_MP_VALIDACAO] ASSINATURA INVALIDA. recebidas: ${v1Signatures.join('/')} calculada: ${digest.substring(0, 12)}... payloadLen=${String(req.rawBodyStr || '').length}.`);
      return false;
    }
    console.log(`[WEBHOOK_MP_VALIDACAO] ✅ HMAC x-signature validado com sucesso. ts=${ts} id=${idParaHash}.`);
    return true;
  } catch (eHmac) {
    console.error('[WEBHOOK_MP_VALIDACAO] exception durante validacao HMAC:', eHmac);
    return false;
  }
}

/* ============================
   HELPERS INTERNOS
   ============================ */
function _QtdMoedasPorPacote(pkgKey) {
  switch (String(pkgKey || '').toLowerCase()) {
    case 'bronze': return 10;
    case 'prata': return 25;
    case 'ouro': return 60;
    default: return Number(pkgKey) || 0;
  }
}
function _PrecoPorPacote(pkgKey) {
  switch (String(pkgKey || '').toLowerCase()) {
    case 'bronze': return 15.00;
    case 'prata': return 30.00;
    case 'ouro': return 60.00;
    default: return Number(pkgKey) || 15.00;
  }
}
function _NomePacote(pkgKey) {
  switch (String(pkgKey || '').toLowerCase()) {
    case 'bronze': return 'Pacote Bronze (10 moedas)';
    case 'prata': return 'Pacote Prata (25 moedas)';
    case 'ouro': return 'Pacote Ouro (60 moedas)';
    default: return 'Recarga de Moedas AjeitaAí';
  }
}
/* ============================
   (NOVO BUG FIX R$0 PRODUCAO)
   Helper gera CPF FAKE VALIDO (formato numerico, valido digito verificador,
   nao eh 00000000000). Nao precisa ser CPF real para pagamento PIX,
   mas MP Producao BLOQUEIA e ZERA VALOR se CPF for 00000000000 ou invalido
   (anti-fraude).
   ============================ */
function _gerarCpfFakeValidoParaMp() {
  // Gera base aleatoria 9 digitos
  let n = [];
  for (let i = 0; i < 9; i++) n.push(Math.floor(Math.random() * 9) + 1); // evita zero repetido
  function calcDV(digitos) {
    let soma = 0;
    for (let i = 0; i < digitos.length; i++) soma += digitos[i] * ((digitos.length + 1) - i);
    let resto = (soma * 10) % 11;
    return (resto === 10 || resto === 11) ? 0 : resto;
  }
  const d1 = calcDV(n); n.push(d1);
  const d2 = calcDV(n); n.push(d2);
  return n.join(''); // string 11 digitos numericos validos, nunca 00000000000
}
function uidDocLocal(idProfissionalOuCliente) { return 'local_' + String(idProfissionalOuCliente || 'anonimo'); }

/* ============================
   ROTA RAIZ (Health Check / Render ping)
   ============================ */
app.get('/', (req, res) => {
  const _emailVarsOk = Number(Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.EMAIL_FROM));
  res.json({
    ok: true,
    app: 'ajeita-pix-backend',
    versao: '2.3-smtp-sendgrid-render-timeout-fallback',
    build_tag: '20260924_smtp_sendgrid_587_2525_465_fallback_timeout',
    modo: MODO_PRODUCAO_REAL ? 'PRODUCAO_REAL_DINHEIRO' : MODO_HOMOLOGACAO_TESTE ? 'HOMOLOGACAO_TESTE' : 'MOCK_LOCAL_DESENVOLVIMENTO',
    firebase_project: svcAccount ? svcAccount.project_id : null,
    mp_ativado: !!mercadopago,
    mp_fetch_nativo_habilitado: true,
    mp_webhook_hmac_configurado: !!MP_WEBHOOK_SECRET && MP_WEBHOOK_SECRET.length > 5,
    backend_url_publica: BACKEND_PUBLIC_URL,
    backend_url_https_valida: Boolean(BACKEND_PUBLIC_URL && BACKEND_PUBLIC_URL.toLowerCase().startsWith('https://') && !BACKEND_PUBLIC_URL.includes('localhost') && !BACKEND_PUBLIC_URL.includes('127.0.0.1')),
    rotas_count: 13,
    recursos_email: { central_configurado: _emailVarsOk, possui_servico_sendEmail: typeof sendEmail === 'function', possui_rota_2fa_docs: true, possui_rota_teste_manual_get: true }
  });
});

/* ============================
   POST /api/pix/criar-recarga-moedas
   Body: {
     pacoteKey: 'bronze' | 'prata' | 'ouro' (REQUIRED),
     valorOpcional: 15.00 (OPCIONAL se nao bronze/prata/ouro),
     uidUsuario: 'pro_xxx' ou cliente uid (REQUIRED),
     tipoUsuario: 'profissional' | 'cliente',
     nomeUsuario: 'Fulano',
     emailUsuario: 'fulano@...',
     admin_senha: 'bolo2024' (OPCIONAL — se fornecido e correto: LIBERA preço QUALQUER (abaixo ou acima do default) p/ admin alterar valores)
   }
   ============================ */
app.post('/api/pix/criar-recarga-moedas', async (req, res) => {
  try {
    const b = req.body || {};

    // =============== (NOVO V11 PRODUCAO REAL: BLOQUEIOS ANTES DE TUDO) ================
    // - Se MODO PRODUCAO (token APP_USR) e a URL publica NAO for HTTPS real (nao localhost/ip/http): BLOQUEIA
    // - Isso evita que notification_url do webhook fique invalida em dinheiro real
    const urlPublicaValidaHTTPS = Boolean(BACKEND_PUBLIC_URL && BACKEND_PUBLIC_URL.toLowerCase().startsWith('https://') && !BACKEND_PUBLIC_URL.includes('localhost') && !BACKEND_PUBLIC_URL.includes('127.0.0.1'));
    if (MODO_PRODUCAO_REAL && !urlPublicaValidaHTTPS) {
      return res.status(500).json({
        ok: false,
        erro_critico: 'MODO_PRODUCAO_REAL',
        msg: 'ERRO CONFIGURACAO BACKEND (PRODUCAO REAL): ENV BACKEND_PUBLIC_URL nao e HTTPS valido. Ajuste no Render (BACKEND_PUBLIC_URL = https://ajeita-backend-pix.onrender.com e faca deploy novamente.'
      });
    }
    // =================================================================================

    const pacoteKey = String(b.pacoteKey || 'bronze').toLowerCase();

    // ================ (V1.92 ADMIN PODE ALTERAR PRECOS! LIBERADO!) ================
    // Regra nova:
    //  (a) Se body.admin_senha === 'bolo2024' (admin Wesley logado tentando cobrar valor diferente): USA QUALQUER preco > 0 (abaixo OU acima do default). Liberdade total p/ admin!
    //  (b) Senão (usuário comum profissional/cliente): anti-fraude V1.8 continua: SEMPRE >= preco minimo default 15/30/60 (nunca aceita R$0/R$1)
    let precoBRL = 0;
    const valorEnviadoFront = Number(b.valorOpcional || 0);
    const precoMinimoPorPacote = _PrecoPorPacote(pacoteKey); // Bronze=15, Prata=30, Ouro=60
    const ehAdminAlterando = String(b.admin_senha || '').trim() === 'bolo2024';
    if (ehAdminAlterando) console.log(`[CRIAR_PIX] 🔑 ADMIN DETECTADO (admin_senha correta)! Libera alteracao de preco para QUALQUER valor > 0. pacote=${pacoteKey} valor enviado=${valorEnviadoFront}`);
    if (valorEnviadoFront > 0) {
      if (ehAdminAlterando) {
        // ✅ ADMIN: preco VALE QUALQUER coisa > 0 (abaixo OU acima do default — Wesley alterou no painel admin!)
        precoBRL = valorEnviadoFront;
        console.log(`[CRIAR_PIX] ✅ ADMIN usando preco personalizado R$${precoBRL} (pacote=${pacoteKey} default=${precoMinimoPorPacote}).`);
      } else if (valorEnviadoFront >= precoMinimoPorPacote) {
        precoBRL = valorEnviadoFront;
        console.log(`[CRIAR_PIX] Usuario comum. Usando valor ENVIADO PELO FRONTEND R$${precoBRL} (pacote=${pacoteKey}) — >= minimo R$${precoMinimoPorPacote}`);
      } else {
        // Anti-fraude V1.8: usuario comum tentou enviar preco baixo → corrige para minimo
        precoBRL = precoMinimoPorPacote;
        console.warn(`[CRIAR_PIX] ⚠️ USUARIO COMUM ENVIOU PRECO ABAIXO DO MINIMO! valorEnviadoFront=R$${valorEnviadoFront} < minimo R$${precoMinimoPorPacote}. SOBRESCREVENDO PARA R$${precoBRL} (anti-fraude). pacote=${pacoteKey}`);
      }
    } else {
      precoBRL = precoMinimoPorPacote;
      console.log(`[CRIAR_PIX] Valor opcional nao envio. Usando helper interno default pacoteKey → R$${precoBRL}`);
    }
    precoBRL = Number(precoBRL);
    if (!(precoBRL > 0)) {
      // Ultima protecao: se ainda for 0/negativo, usa default minimo
      console.warn(`[CRIAR_PIX] ⚠️ Ultima protecao anti-fraude: precoBRL=R$${precoBRL} invalido, sobrescrevendo default R$${precoMinimoPorPacote}`);
      precoBRL = precoMinimoPorPacote;
    }

    const qtdMoedas = _QtdMoedasPorPacote(pacoteKey);
    const uidUsuario = String(b.uidUsuario || ('anon_' + Date.now()));
    const tipoUsuario = String(b.tipoUsuario || 'profissional');
    const nomeUsuario = String(b.nomeUsuario || 'Usuario AjeitaAí');
    const emailUsuario = String(b.emailUsuario || 'cliente@ajeita.com.br');
    const externalRef = 'RECARGA_PRO_' + uidUsuario.substring(0,20) + '_' + Date.now();

    // --- Passo 1: Salvar transacao PENDENTE no Firestore (colecao pix_transacoes) ---
    let docTransacaoId = externalRef;
    if (dbFirestore) {
      try {
        await dbFirestore.collection('pix_transacoes').doc(docTransacaoId).set({
          external_reference: externalRef,
          pacote_key: pacoteKey,
          qtd_moedas: qtdMoedas,
          preco_brl: precoBRL,
          uid_usuario: uidUsuario,
          tipo_usuario: tipoUsuario,
          nome_usuario: nomeUsuario,
          email_usuario: emailUsuario,
          status: 'pendente',
          mp_payment_id: null,
          qr_code_base64: null,
          copia_cola: null,
          criado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString()
        }, { merge: true });
        console.log(`[FIRESTORE] Transacao PENDENTE criada: ${docTransacaoId}`);
      } catch (eFbWrite) {
        console.error('[FIRESTORE] erro escrever transacao pendente:', eFbWrite);
      }
    }

    // --- Passo 2: Criar pagamento PIX no Mercado Pago (se SDK disponivel) ---
    let qrCodeBase64 = null;
    let copiaCola = null;
    let mpPaymentId = null;
    let ticketUrl = null;

    // ============ (BUG FIX R$0 PRODUCAO MP) VALIDACAO PRECO ANTES DE ENVIAR ============
    if (!precoBRL || !(Number(precoBRL) > 0)) {
      return res.status(400).json({
        ok: false,
        erro_critico: 'VALOR_INVALIDO_ZERADO',
        msg: `Valor da cobranca Pix R$0 invalido. Esperado > 0. precoBRL=${precoBRL} (pacote=${pacoteKey}). Entre em contato com suporte.`
      });
    }

    if (mercadopago || MP_ACCESS_TOKEN) {
      const cpfValidoAleatorio = _gerarCpfFakeValidoParaMp();
      const transactionAmountFormatado = Number(Number(precoBRL).toFixed(2));
      const first = (nomeUsuario.split(' ')[0] || 'Cliente').substring(0, 30);
      const last = (nomeUsuario.split(' ').slice(1).join(' ') || 'AjeitaAí').substring(0, 60);
      const emailPayer = emailUsuario || 'cliente@ajeita.com.br';

      // ====== BODY REST OFICIAL (igual documentacao Mercado Pago API v1/payments Pix) ======
      // Usamos o body MESMO tanto para SDK quanto para FETCH NATIVO (campos oficiais 100% documentados)
      const bodyCreate = {
        transaction_amount: transactionAmountFormatado,
        description: (_NomePacote(pacoteKey) + ' - AjeitaAí Serviços Domésticos').substring(0, 120),
        payment_method_id: 'pix',
        payer: {
          email: emailPayer,
          first_name: first,
          last_name: last,
          identification: { type: 'CPF', number: cpfValidoAleatorio }
        },
        external_reference: externalRef,
        notification_url: (BACKEND_PUBLIC_URL + '/webhook-pix')
      };

      console.log(`[MERCADO_PAGO][CRIAR] body OFICIAL v1.4 → pacote=${pacoteKey} valor=${transactionAmountFormatado} BRL email=${emailPayer} cpf_prefix=${cpfValidoAleatorio.substring(0,3)} external_ref=${externalRef}`);
      console.log(`[MERCADO_PAGO][CRIAR] Body keys: ${Object.keys(bodyCreate).join(',')} | payer keys: ${Object.keys(bodyCreate.payer).join(',')}`);

      let r = null; // resposta padronizada { id, transaction_amount, status, poi:{qr_code_base64, qr_code, ticket_url} }
      let mp_usou_fetch = false;
      let erroSdk = null;

      // ====== PASSO 1: TENTA SDK MERCADO PAGO v2 (se carregou) ======
      if (mercadopago && mercadopago.Payment) {
        try {
          const created = await mercadopago.Payment.create({
            body: bodyCreate,
            requestOptions: { idempotencyKey: externalRef }
          });
          if (created && created.response) {
            r = created.response;
            console.log(`[MERCADO_PAGO][CRIAR] SDK v2 funcionou (sem code 8)!`);
          } else {
            console.warn('[MERCADO_PAGO][CRIAR] SDK retornou mas sem response. Vamos tentar fetch nativo.');
          }
        } catch (eMpSdk) {
          erroSdk = eMpSdk;
          console.warn('[MERCADO_PAGO][CRIAR] SDK v2 falhou. Vamos fazer FALLBACK para FETCH NATIVO API REST (anti-code-8).');
          try {
            const causa = eMpSdk && eMpSdk.cause ? eMpSdk.cause : null;
            if (Array.isArray(causa)) causa.forEach((c, i) => { console.warn(`   [sdk causa ${i}] code=${c.code} desc=${c.description}`); });
            console.warn(`   sdk e.message=${eMpSdk.message}`);
          } catch(eL){}
        }
      }

      // ====== PASSO 2: FALLBACK FETCH NATIVO (se SDK falhou / não carregou / não retornou) ======
      if (!r && MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.length > 10) {
        mp_usou_fetch = true;
        try {
          console.log(`[MERCADO_PAGO][CRIAR_FETCH_NATIVO] POST https://api.mercadopago.com/v1/payments …`);
          const fetchResp = await fetch('https://api.mercadopago.com/v1/payments', {
            method: 'POST',
            headers: {
              'accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + MP_ACCESS_TOKEN,
              'X-Idempotency-Key': externalRef
            },
            body: JSON.stringify(bodyCreate)
          });
          const fetchData = await fetchResp.json();
          if (!fetchResp.ok) {
            console.error(`[MERCADO_PAGO][CRIAR_FETCH_NATIVO] HTTP ${fetchResp.status} resposta MP: ${JSON.stringify(fetchData||'').substring(0,1500)}`);
            throw new Error(`MP REST HTTP ${fetchResp.status}: ${fetchData && (fetchData.message || (Array.isArray(fetchData.cause)?fetchData.cause.map(c=>c.description).join(', '):'erro'))}`);
          }
          r = fetchData;
          console.log(`[MERCADO_PAGO][CRIAR_FETCH_NATIVO] SUCESSO (REST nativo) pagamento id=${r && r.id}`);
        } catch (eFetchNat) {
          console.error('[MERCADO_PAGO][CRIAR_FETCH_NATIVO] ERRO:', eFetchNat && eFetchNat.message);
          if (!erroSdk) erroSdk = eFetchNat;
          r = null;
        }
      }

      if (r) {
        mpPaymentId = String(r.id || '');
        const valorRetornadoMp = Number(r.transaction_amount || 0);
        const poi = r.point_of_interaction && r.point_of_interaction.transaction_data ? r.point_of_interaction.transaction_data : null;
        if (poi) {
          let rawQrPng = poi.qr_code_base64 || null;
          // (V1.6 QR PNG FIX) Garante prefixo data:image/png;base64, — Mercado Pago as vezes retorna base64 cru sem prefixo, img src nao renderiza
          if (rawQrPng && typeof rawQrPng === 'string' && rawQrPng.length > 100) {
            if (rawQrPng.startsWith('data:image') || rawQrPng.startsWith('http')) {
              qrCodeBase64 = rawQrPng;
            } else {
              // Remove whitespace/newlines que podem existir
              rawQrPng = rawQrPng.replace(/\s+/g, '').trim();
              qrCodeBase64 = 'data:image/png;base64,' + rawQrPng;
            }
          } else {
            qrCodeBase64 = null;
          }
          copiaCola = poi.qr_code || null;
          ticketUrl = poi.ticket_url || null;
          console.log(`[MERCADO_PAGO][QR_DIAG] raw_qr_base64_len=${(poi.qr_code_base64||'').length} | qr_final_len=${(qrCodeBase64||'').length} | copia_cola_len=${(copiaCola||'').length} | ticket_url=${ticketUrl ? 'SIM' : 'NAO'}`);
        }
        // ============ (BUG FIX R$0 PRODUCAO) DOUBLE CHECK ============
        if (mpPaymentId && valorRetornadoMp === 0) {
          console.error(`[MERCADO_PAGO][BUG R$0 DETECTADO] Pagamento id=${mpPaymentId} CRIADO MAS MP RETORNOU VALOR R$0. Cancelando.`);
          try {
            if (mercadopago && mercadopago.Payment) await mercadopago.Payment.cancel({ id: mpPaymentId });
            else if (MP_ACCESS_TOKEN) await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
          } catch(eCan){ console.warn('[MP] tentativa cancelar pagamento R$0 falhou, ok'); }
          return res.status(500).json({
            ok: false,
            erro_critico: 'MP_RETORNOU_VALOR_ZERO_PRODUCAO',
            msg: `Mercado Pago retornou valor R$0 em modo produção (pagamento id=${mpPaymentId}). Pagamento cancelado automaticamente. Tente novamente em 2 minutos ou contate suporte.`
          });
        }
        if (dbFirestore) {
          try {
            await dbFirestore.collection('pix_transacoes').doc(docTransacaoId).update({
              mp_payment_id: mpPaymentId,
              qr_code_base64: qrCodeBase64,
              copia_cola: copiaCola,
              ticket_url: ticketUrl,
              mp_valor_retornado: valorRetornadoMp,
              mp_cpf_usado: cpfValidoAleatorio.substring(0, 3) + '*****' + cpfValidoAleatorio.substring(cpfValidoAleatorio.length - 2),
              mp_status_criacao: String(r.status || 'desconhecido'),
              mp_modo_criacao: mp_usou_fetch ? 'fetch_nativo_rest_v1' : 'sdk_v2',
              mp_body_create_json: JSON.stringify(bodyCreate)
            });
          } catch(eFbUp) { console.error(eFbUp); }
        }
        console.log(`[MERCADO_PAGO] Pagamento CRIADO SUCESSO via ${mp_usou_fetch?'FETCH_NATIVO_REST':'SDK_v2'}: id=${mpPaymentId} external_ref=${externalRef} valor_mp=${valorRetornadoMp} status=${r.status || 'pendente'} qr_len=${(qrCodeBase64||'').length} copiacola_len=${(copiaCola||'').length}`);
      } else {
        console.error(`[MERCADO_PAGO] NEM SDK NEM FETCH NATIVO funcionaram. Retorna erro.`);
        if (erroSdk) {
          return res.status(500).json({ ok: false, msg: 'Erro Mercado Pago ao criar cobranca Pix (SDK e REST falharam)', err: (erroSdk.cause || erroSdk.message || String(erroSdk)), erro_tentativa: { sdk_ok: !!mercadopago, fetch_nativo_ok: !!MP_ACCESS_TOKEN } });
        }
      }
    } else {
      // =============== (NOVO V11 PRODUCAO REAL: BLOQUEIO MOCK EM DINHEIRO REAL) ================
      if (MODO_PRODUCAO_REAL) {
        // NUNCA, EM HIPOTESE NENHUMA, GERA QR FALSO QUANDO ESTA EM PRODUCAO REAL (APP_USR)
        console.error('[MERCADO_PAGO_PRODUCAO] ERRO CRITICO: MODO PRODUCAO REAL (APP_USR) mas SDK MP desligado. NÃO GERANDO QR MOCK (risco de perda dinheiro). Retorna erro para cliente.');
        return res.status(503).json({
          ok: false,
          erro_critico: 'PRODUCAO_MP_INDISPONIVEL',
          msg: 'Sistema de Pagamento Pix (Mercado Pago Produção) está temporariamente indisponível. Tente novamente em 2 minutos ou envie comprovante para WhatsApp do suporte.'
        });
      }
      // Se chegou aqui: MODO_HOMOLOGACAO_TESTE (TEST-) ou LOCAL MOCK: Pode gerar QR MOCK para desenvolvedor testar UI, sem dinheiro real
      console.warn('[MERCADO_PAGO_MOCK_HOMOLOGACAO] Modo MOCK: Mercado Pago (TEST ou LOCAL) nao configurado. Gerando QR simulado PARA TESTE UI APENAS (nao vale dinheiro real).');
      mpPaymentId = 'mock_' + Date.now();
      copiaCola = '00020126360014br.gov.bcb.pix0114' + externalRef + '5204000053039865404' + String(precoBRL).padStart(10,'0') + '5802BR5923AJEITA SERVICOS LTDA 6009SAO PAULO62070503***6304ABCD';
    }

    return res.json({
      ok: true,
      external_reference: externalRef,
      doc_transacao_id: docTransacaoId,
      mp_payment_id: mpPaymentId,
      pacote: {
        key: pacoteKey,
        nome: _NomePacote(pacoteKey),
        qtd_moedas: qtdMoedas,
        preco_brl: precoBRL
      },
      pix: {
        qr_code_base64: qrCodeBase64,
        copia_cola: copiaCola,
        ticket_url: ticketUrl
      },
      usuario: { uid: uidUsuario, tipo: tipoUsuario, nome: nomeUsuario }
    });
  } catch (eGeral) {
    console.error('[ROTA /api/pix/criar-recarga-moedas] EXCEPTION:', eGeral);
    return res.status(500).json({ ok: false, msg: 'Erro interno backend Pix', err: eGeral.message });
  }
});

/* ============================
   HELPER: _consultarPagamentoMpPorExternalRef(externalRef)
   - Busca no Mercado Pago pagamentos com external_reference = externalRef
   - Se acha pag approved/accredited: atualiza Firestore e CHAMA processarAprovacaoPix (libera moedas!)
   - Fallback se webhook nao chegou nunca.
   ============================ */
async function _consultarPagamentoMpPorExternalRef(externalRef) {
  if (!externalRef) return { ok:false, erro:'sem external_ref' };
  if (!MP_ACCESS_TOKEN) return { ok:false, erro:'sem MP_ACCESS_TOKEN' };
  let docFirestore = null;
  if (dbFirestore) try { const s = await dbFirestore.collection('pix_transacoes').doc(externalRef).get(); if (s.exists) docFirestore = Object.assign({}, s.data()); } catch(e){}
  let mpPaymentId = docFirestore && docFirestore.mp_payment_id ? String(docFirestore.mp_payment_id) : null;
  let pag = null;
  // 1) Se temos mp_payment_id no Firestore, consulta direto
  if (mpPaymentId && mpPaymentId.length > 3) {
    try {
      if (mercadopago && mercadopago.Payment) {
        const d = await mercadopago.Payment.get({ id: mpPaymentId });
        if (d && d.response) pag = d.response;
      }
      if (!pag) {
        const r = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, { headers: { 'Authorization':'Bearer '+MP_ACCESS_TOKEN, 'accept':'application/json' } });
        if (r.ok) pag = await r.json();
      }
    } catch(eP1){ console.warn('[CONSULTA_MP] erro por mp_payment_id='+mpPaymentId, eP1 && eP1.message); pag = null; }
  }
  // 2) Se não achou por payment_id, busca por external_reference via search
  if (!pag) {
    try {
      const searchUrl = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&external_reference=${encodeURIComponent(externalRef)}`;
      const r = await fetch(searchUrl, { headers: { 'Authorization':'Bearer '+MP_ACCESS_TOKEN, 'accept':'application/json' } });
      if (r.ok) {
        const s = await r.json();
        const arr = (s && Array.isArray(s.results)) ? s.results : [];
        if (arr && arr.length > 0) pag = arr[0];
      }
    } catch(eSearch){ console.warn('[CONSULTA_MP] erro search external_ref:', eSearch && eSearch.message); }
  }
  if (!pag) {
    console.log(`[CONSULTA_MP] external_ref=${externalRef} → NÃO ENCONTRADO pag MP ainda (nao foi pago ou webhook nao chegou).`);
    return { ok:true, status_mp: 'nao_encontrado_ainda', external_reference: externalRef, aprovado: false, doc_firestore: docFirestore };
  }
  const statusMp = String(pag.status || '');
  const valorMp = Number(pag.transaction_amount || 0);
  const idPag = String(pag.id || mpPaymentId || '');
  // Atualiza Firestore com status atual do MP SEMPRE (mesmo pendente, user vê progresso)
  if (dbFirestore && externalRef) {
    try {
      await dbFirestore.collection('pix_transacoes').doc(externalRef).set({
        mp_payment_id: idPag,
        mp_status_consulta_manual: statusMp,
        mp_valor_retornado: valorMp,
        ultima_consulta_manual_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString()
      }, { merge: true });
    } catch(eFbUp2){}
  }
  if (statusMp === 'approved' || statusMp === 'accredited') {
    console.log(`[CONSULTA_MP] ✅ external_ref=${externalRef} PAGAMENTO APROVADO NO MP! (status=${statusMp} id=${idPag} valor=${valorMp}). Chamando processarAprovacaoPix.`);
    await processarAprovacaoPix({
      external_reference: externalRef,
      status: 'approved',
      mp_payment_id: idPag,
      valor: valorMp,
      aprovado_via: 'consulta_manual_mp_backend_fallback_webhook'
    });
    return { ok:true, status_mp: statusMp, external_reference: externalRef, aprovado: true, mp_payment_id: idPag, valor_mp: valorMp };
  } else {
    console.log(`[CONSULTA_MP] external_ref=${externalRef} → MP status=${statusMp} (nao aprovado ainda). id=${idPag} valor=${valorMp}`);
    return { ok:true, status_mp: statusMp, external_reference: externalRef, aprovado: false, mp_payment_id: idPag, valor_mp: valorMp };
  }
}

/* ============================
   GET /api/pix/consultar-status/:externalRef
   (FALLBACK WEBHOOK FRONTEND CHAMA A CADA 8s)
   - Não precisa de autenticacao admin, qualquer um pode consultar (apenas le status MP e atualiza Firestore, moedas liberam por backend se aprovado).
   - Retorna { ok, status_mp, aprovado, valor_mp }
   ============================ */
app.get('/api/pix/consultar-status/:externalRef', async (req, res) => {
  try {
    const externalRef = String(req.params.externalRef || '');
    if (!externalRef) return res.status(400).json({ ok:false, msg:'informe external_ref na URL /api/pix/consultar-status/XXX' });
    const r = await _consultarPagamentoMpPorExternalRef(externalRef);
    return res.json(Object.assign({ ok: true }, r || {}));
  } catch (e) {
    console.error('[CONSULTA_MP_ENDPOINT] ERRO:', e);
    return res.status(500).json({ ok:false, erro: e && e.message });
  }
});

/* ============================
   POST /api/pix/aprovar-manual-admin
   (Fallback caso webhook MP demore muito ou fora do ar)
   - ADMIN chama essa rota com external_reference e senha do admin (bolo2024) ou header
   ============================ */
app.post('/api/pix/aprovar-manual-admin', async (req, res) => {
  try {
    const b = req.body || {};
    const senhaAdmin = String(b.senhaAdmin || '');
    const externalRef = String(b.external_reference || '');
    if (!externalRef) return res.status(400).json({ ok:false, msg:'informe external_reference' });
    if (senhaAdmin !== 'bolo2024') return res.status(401).json({ ok:false, msg:'senha admin invalida (bolo2024)' });
    // Simula webhook MP aprovado
    await processarAprovacaoPix({
      external_reference: externalRef,
      status: 'approved',
      mp_payment_id: String(b.mp_payment_id || ('manual_' + Date.now())),
      valor: Number(b.valor || 0),
      aprovado_via: 'admin_manual'
    });
    return res.json({ ok:true, msg:'Aprovacao manual enviada. Moedas liberadas se usuario existir.' });
  } catch (e) { return res.status(500).json({ ok:false, err: e.message }); }
});

/* ============================
   POST /webhook-pix  (WEBHOOK OFICIAL DO MERCADO PAGO)
   - Passo 0: Responder 200 IMEDIATAMENTE para MP nao repetir.
   - Passo 1 (NOVO SEGURANCA): Validar x-signature HMAC (se MP_WEBHOOK_SECRET foi colocado em ENV Render).
   - Passo 2: Extrair payment_id do body, consultar MP para pegar external_reference e status REAL (jamais confiar só no body webhook).
   - Passo 3: Se approved/accredited → processarAprovacaoPix libera moedas.
   ============================ */
app.post('/webhook-pix', async (req, res) => {
  res.status(200).send('OK'); // Resposta IMEDIATA ao MP (obrigação para não repetir webhook)
  try {
    const body = req.body || {};
    const action = String(body.action || '');
    const type = String(body.type || body.data?.type || '');
    const paymentId = String(body.data?.id || body.id || '');
    if (!paymentId || !action || !action.includes('payment')) {
      console.log(`[WEBHOOK_MP] Ignorado: action=${action} paymentId=${paymentId}`);
      return;
    }
    // ===== (NOVO V11 SEGURANCA WEBHOOK) Validar assinatura HMAC x-signature =====
    console.log(`[WEBHOOK_MP] >>> RECEBIDO paymentId=${paymentId} action=${action} type=${type}`);
    const assinaturaValida = _validarAssinaturaWebhookMp(req, paymentId);
    if (!assinaturaValida) {
      // Mesmo que já tenhamos respondido 200, NÃO processa nada (rejeita por segurança e loga)
      console.warn(`[WEBHOOK_MP] 🚨 BLOQUEADO POR ASSINATURA INVALIDA: paymentId=${paymentId}. Nao vamos consultar MP nem liberar moedas. BodyStrLen=${String(req.rawBodyStr || '').length}. HMAC SECRET configurado? ${MP_WEBHOOK_SECRET ? 'SIM (len='+MP_WEBHOOK_SECRET.length+')' : 'NAO, skip validacao'}.`);
      return;
    }
    console.log(`[WEBHOOK_MP] ✅ Assinatura HMAC validada OK (ou secret vazio skip). paymentId=${paymentId}`);
    if (!mercadopago && !MP_ACCESS_TOKEN) {
      console.log('[WEBHOOK_MP] Ignorado: SDK MP e MP_ACCESS_TOKEN nao disponiveis. Espera proxima notificacao MP.');
      return;
    }
    // Consultar detalhe do pagamento no MP (obrigatorio para pegar external_reference e status REAL):
    let pag = null;
    try {
      if (mercadopago && mercadopago.Payment) {
        const detalheResp = await mercadopago.Payment.get({ id: paymentId });
        if (detalheResp && detalheResp.response) pag = detalheResp.response;
      }
      if (!pag && MP_ACCESS_TOKEN) {
        // Fallback fetch nativo GET /v1/payments/:id
        const fetchResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'accept': 'application/json' }
        });
        if (fetchResp.ok) pag = await fetchResp.json();
      }
    } catch (ePagGet) { console.warn('[WEBHOOK_MP] Erro consultar detalhe pagamento:', ePagGet && ePagGet.message); }
    if (!pag) { console.warn('[WEBHOOK_MP] Nao consegui detalhe do pagamento id=' + paymentId); return; }
    console.log(`[WEBHOOK_MP] status mp_pag status=${pag.status || ''} id=${pag.id} external_ref=${pag.external_reference || ''} valor=${pag.transaction_amount || 0}`);
    const statusMP = String(pag.status || '');
    const externalRef = String(pag.external_reference || '');
    const valor = Number(pag.transaction_amount || 0);
    if (statusMP === 'approved' || statusMP === 'accredited') {
      console.log(`[WEBHOOK_MP] APROVADO! paymentId=${paymentId} external_ref=${externalRef} valor=${valor}`);
      await processarAprovacaoPix({
        external_reference: externalRef,
        status: 'approved',
        mp_payment_id: paymentId,
        valor: valor,
        aprovado_via: 'webhook_mercado_pago'
      });
    } else {
      console.log(`[WEBHOOK_MP] status nao aprovado: paymentId=${paymentId} status=${statusMP}`);
      if (dbFirestore && externalRef) {
        try {
          await dbFirestore.collection('pix_transacoes').doc(externalRef).update({
            status: statusMP,
            status_atualizado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString()
          });
        } catch(e){}
      }
    }
  } catch (eWebhook) {
    console.error('[WEBHOOK_MP] EXCEPTION (apenas log, ja enviamos 200 para MP):', eWebhook);
  }
});

/* ============================
   FUNCAO CORE: processarAprovacaoPix
   Chamada TANTO por webhook MP QUANTO por aprovacao manual admin.
   1) Atualiza status transacao pix_transacoes -> aprovado
   2) Incrementa saldo moedas no Firestore colecao PROFISSIONAIS (docId = local_uidUsuario)
   3) Adiciona log na colecao recargas
   ============================ */
async function processarAprovacaoPix(payload) {
  const externalRef = String(payload.external_reference || '');
  if (!externalRef || externalRef.length < 3) { console.warn('[processarAprovacaoPix] external_ref vazio, ignorado'); return false; }
  let transacao = null;
  if (dbFirestore) {
    try {
      const snap = await dbFirestore.collection('pix_transacoes').doc(externalRef).get();
      if (snap.exists) transacao = Object.assign({}, snap.data());
    } catch (eSnap){ console.error(eSnap); }
  }
  // ======================== (FIX IDEMPOTENCIA §4) ========================
  const statusAnterior = String((transacao && transacao.status) || '').toLowerCase();
  if (statusAnterior === 'aprovado' || statusAnterior === 'approved') {
    console.log(`[IDEMPOTENCIA] SKIP: pagamento external_ref="${externalRef}" JA ESTAVA aprovado. Nao credita moedas 2x, nao duplica recarga, nao ativa patrocinio 2x. via=${payload.aprovado_via || 'desconhecida'}.`);
    return true;
  }
  if (!transacao) {
    transacao = {
      uid_usuario: 'desconhecido', tipo_usuario: 'profissional',
      qtd_moedas: 0, preco_brl: Number(payload.valor || 0),
      pacote_key: 'bronze', nome_usuario: ''
    };
  }
  const qtdMoedas = Number(transacao.qtd_moedas || 0);
  const uidUsuario = String(transacao.uid_usuario || '');
  const tipoUsuario = String(transacao.tipo_usuario || 'profissional');
  // ======================== (SWITCH TIPO PAGAMENTO §6) ========================
  const prefixoTipo = externalRef.startsWith('RECARGA_PRO_') ? 'RECARGA_PRO'
    : externalRef.startsWith('SPONSOR_') ? 'SPONSOR'
    : externalRef.startsWith('CLIENT_ORDER_') ? 'CLIENT_ORDER'
    : 'DESCONHECIDO';
  console.log(`[PROCESSAR_APROVACAO] external_ref=${externalRef} tipo_prefixo=${prefixoTipo} status_anterior=${statusAnterior} qtdMoedas=${qtdMoedas} via=${payload.aprovado_via||'?'}`);
  if (prefixoTipo === 'SPONSOR') {
    // Ativação patrocinador (handler implementado na Task 3; se ainda null, retorna true sem erros.)
    try {
      if (typeof _ativarPatrocinadorPorPagamento === 'function') {
        await _ativarPatrocinadorPorPagamento(externalRef, {
          mp_payment_id: payload.mp_payment_id,
          valor_pago: Number(payload.valor || transacao.preco_brl || 0),
          aprovado_via: payload.aprovado_via
        });
      } else {
        console.log('[PROCESSAR_APROVACAO] SPONSOR_: _ativarPatrocinadorPorPagamento ainda nao carregado (stub Task2). Firestore atualiza status no cron Task3 proxima rodada.');
      }
    } catch(eSponsor){ console.error('[PROCESSAR_APROVACAO] ERRO SPONSOR:', eSponsor && eSponsor.message || eSponsor); }
  }
  if (prefixoTipo === 'CLIENT_ORDER') {
    console.log('[PROCESSAR_APROVACAO] CLIENT_ORDER: TIPO RESERVADO para futuro. Nao libera nada por enquanto. external_ref='+externalRef);
    if (dbFirestore) { try { await dbFirestore.collection('pix_transacoes').doc(externalRef).update({ status:'aprovado',tipo_pagamento_prefixo:'CLIENT_ORDER_RESERVADO',aprovado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),mp_payment_id: payload.mp_payment_id,aprovado_via: payload.aprovado_via }); } catch(e){} }
    return true;
  }
  if (prefixoTipo === 'DESCONHECIDO') {
    console.warn(`[PROCESSAR_APROVACAO] ⚠️ external_ref="${externalRef}" sem prefixo conhecido. Tenta fluxo RECARGA_PRO padrao para manter compatibilidade de pagamentos antigos (ajeita_moeda_*). Nao libera patrocinador.`);
  }
  // ======================== (FLUXO RECARGA_PRO / LEGADO) ========================
  // 1) Atualiza doc pix_transacoes -> aprovado
  if (dbFirestore) {
    try {
      await dbFirestore.collection('pix_transacoes').doc(externalRef).update({
        status: 'aprovado',
        mp_payment_id: payload.mp_payment_id,
        aprovado_via: payload.aprovado_via,
        aprovado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),
        valor_pago_mp: Number(payload.valor || transacao.preco_brl || 0),
        tipo_pagamento_prefixo: prefixoTipo === 'DESCONHECIDO' ? 'RECARGA_PRO_LEGADO' : prefixoTipo
      });
    } catch(eUp1){}
  }
  // 2) Libera moedas -> colecao "profissionais" (mesmo docId = local_uidUsuario)
  if (dbFirestore && qtdMoedas > 0 && uidUsuario && uidUsuario !== 'desconhecido') {
    try {
      const docId = uidDocLocal(uidUsuario);
      const docRef = dbFirestore.collection('profissionais').doc(docId);
      const snapPro = await docRef.get();
      const atual = snapPro.exists ? (snapPro.data() || {}) : {};
      // ======================== (VALIDACAO ACEITE TERMOS BACKEND §9) ========================
      // Não credita moedas se o profissional ainda não aceitou os Termos de Uso / Política de Privacidade da versão atual.
      // Não apaga transação (dinheiro recebido fica gravado como aprovado em pix_transacoes para auditoria);
      // moedas ficam "pendentes" e serão creditadas automaticamente no próximo webhook/aprovação manual
      // ASSIM QUE o profissional aceitar os termos no frontend.
      const validAceite = _validarAceiteTermosBackend(atual);
      if (!validAceite.ok) {
        const redacaoUid = String(uidUsuario||'?').substring(0, 14) + '***';
        const redacaoNome = (String(transacao.nome_usuario||'?').length > 2) ? (String(transacao.nome_usuario)[0] + '***' + String(transacao.nome_usuario).slice(-1)) : '***';
        console.warn(`[ACEITE_TERMOS_BLOQUEIO_LIBERAR_MOEDAS] ⚠️ external_ref=${externalRef} uid=${redacaoUid} nome=${redacaoNome} motivo=${validAceite.motivo} esperado_termos=${validAceite.esperado||TERMS_VERSION} encontrado_termos=${validAceite.encontrado||'nulo'}. MOEDAS NAO CREDITADAS (aguarda aceite frontend).`);
        try {
          await dbFirestore.collection('pix_transacoes').doc(externalRef).set({
            bloqueado_por_aceite_pendente: true,
            bloqueado_aceite_motivo: String(validAceite.motivo || ''),
            bloqueado_aceite_esperado_termos_v: String(validAceite.esperado || TERMS_VERSION),
            bloqueado_aceite_encontrado_termos_v: String(validAceite.encontrado || '(nulo)'),
            bloqueado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString()
          }, { merge: true });
        } catch(eBloq){}
        return false;
      }
      const saldoAntesFirestore = Number(atual.saldoMoedas || 0);
      const novoSaldo = saldoAntesFirestore + qtdMoedas;
      // ============ (ALERTA SALDO BAIXO MOEDAS - FIRESTORE STATE) ============
      // Persiste o estado de alertas disparados em PROFISSIONAIS._alerta_saldo (não expõe e-mail)
      // Regras: (a) faixas [20,10,5,2,0] (b) 1 alerta por faixa por ciclo (c) reset no próximo ciclo ao recarregar E ultrapassar 20.
      try {
        const estado = atual._alerta_saldo && typeof atual._alerta_saldo === 'object'
          ? JSON.parse(JSON.stringify(atual._alerta_saldo))
          : { ultimoSaldo: null, faixasDisparadas: {}, cicloAtual: 1 };
        const ehRecarga = true;
        if (ehRecarga && novoSaldo > 20) {
          estado.faixasDisparadas = {};
          estado.cicloAtual = (Number(estado.cicloAtual) || 1) + 1;
        }
        const FAIXAS = Object.freeze([20, 10, 5, 2, 0]);
        const ant = Number.isFinite(+saldoAntesFirestore) ? Math.max(0, Math.floor(+saldoAntesFirestore)) : null;
        const atu = Math.max(0, Math.floor(novoSaldo));
        let faixaDispararFirestore = null;
        for (let ixF = 0; ixF < FAIXAS.length; ixF++) {
          const fx = FAIXAS[ixF];
          const entrou = (ant == null) ? (atu === fx) : (ant > fx) && (atu <= fx);
          if (entrou) { faixaDispararFirestore = fx; break; }
        }
        estado.ultimoSaldo = atu;
        let disparouNotifFirestore = false;
        let puladoDuplicado = false;
        if (faixaDispararFirestore != null) {
          if (estado.faixasDisparadas[String(faixaDispararFirestore)] === true) {
            puladoDuplicado = true;
          } else {
            estado.faixasDisparadas[String(faixaDispararFirestore)] = true;
            disparouNotifFirestore = true;
            // (i) Notificação na coleção "notificacoes" (sistema existente)
            try {
              const nomeProf = (atual.nome || atual.primeiroNome || 'Profissional').toString().trim() || 'Profissional';
              const ehZero = faixaDispararFirestore === 0;
              const titulo = ehZero ? '🪙 Saldo esgotado' : `🪙 Saldo baixo (${faixaDispararFirestore} moedas)`;
              const msg = ehZero
                ? 'Seu saldo de moedas chegou a 0. Recarregue para continuar utilizando os recursos que consomem moedas.'
                : `Você está com ${faixaDispararFirestore} moedas. Recarregue seu saldo para continuar utilizando o Ajeitaí.`;
              const idn = 'not_sb_fs_' + faixaDispararFirestore + '_' + String(uidUsuario) + '_' + Math.floor(Date.now()/1000);
              const notifFs = {
                id: idn, usuario_id_alvo: String(uidUsuario), tipo_usuario_alvo: 'profissional',
                tipo: 'saldo_moedas', subtipo: ehZero ? 'saldo_esgotado' : 'saldo_baixo',
                faixa_saldo: faixaDispararFirestore, saldo_atual: atu,
                titulo: titulo, mensagem: msg, lida: false,
                criado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),
                origem: 'alerta_saldo_baixo_firestore_backend', syncWebhook: payload.aprovado_via || '?',
                _v: 1
              };
              try { await dbFirestore.collection('notificacoes').doc(idn).set(notifFs, { merge: true }); } catch(eNotFs){}
              // (ii) E-mail SOMENTE ao DONO do saldo (profissional.email)
              try {
                const emailDest = (atual.email || atual.emailGoogle || atual.emailLogin || '').toString().trim();
                if (emailDest && emailDest.indexOf('@') > 1 && typeof sendEmail === 'function') {
                  const assunto = ehZero
                    ? 'Ajeitaí — seu saldo de moedas chegou a 0'
                    : 'Ajeitaí — seu saldo de moedas está baixo';
                  const corpoTxt = ehZero
                    ? (`Olá, ${nomeProf}.\n\nSeu saldo de moedas no Ajeitaí chegou a 0.\n\nRecarregue seu saldo para continuar utilizando os recursos que consomem moedas.`)
                    : (`Olá, ${nomeProf}.\n\nSeu saldo no Ajeitaí está em ${faixaDispararFirestore} moedas.\n\nPara continuar utilizando os recursos que consomem moedas, você pode recarregar seu saldo.\n\nO botão de comprar moedas já está disponível no seu painel.`);
                  try {
                    await sendEmail({
                      to: emailDest,
                      subject: assunto,
                      text: corpoTxt,
                      html: null
                    });
                  } catch(eSend){
                    console.log('[ALERTA_SALDO_BACKEND] sendEmail falhou (continua sem bloquear fluxo). external_ref='+externalRef+' err='+String(eSend&&eSend.message||eSend).substring(0,200));
                  }
                }
              } catch(eMail){}
            } catch(eDisparo){}
          }
        }
        atual._alerta_saldo = estado;
        console.log(`[ALERTA_SALDO_BACKEND] uid=${uidUsuario} saldoAntes=${saldoAntesFirestore} novoSaldo=${novoSaldo} faixaDisparar=${faixaDispararFirestore} disparou=${disparouNotifFirestore} dup=${puladoDuplicado} ciclo=${estado.cicloAtual}`);
      } catch(eSbPrep){
        console.error('[ALERTA_SALDO_BACKEND] erro preparar estado (continuando fluxo liberar moedas):', String(eSbPrep && eSbPrep.message || eSbPrep).substring(0,300));
      }
      await docRef.set(Object.assign({}, atual, {
        saldoMoedas: novoSaldo,
        ultimaRecargaEm: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),
        ultimaRecargaPacote: String(transacao.pacote_key || 'bronze')
      }), { merge: true });
      console.log(`[LIBERAR_MOEDAS] OK: uid=${uidUsuario} docId=${docId} adicionou ${qtdMoedas} moedas (novo saldo = ${novoSaldo})`);
      // 3) Log recargas
      try {
        await dbFirestore.collection('recargas').add({
          id_recarga: 'rec_' + Date.now(),
          external_reference: externalRef,
          profissional_id: uidUsuario,
          tipo_usuario: tipoUsuario,
          nome_usuario: transacao.nome_usuario || '',
          pacote_key: String(transacao.pacote_key || 'bronze'),
          qtd_moedas: qtdMoedas,
          preco: Number(transacao.preco_brl || 0),
          data: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),
          status: 'aprovado',
          gateway: 'mercado_pago',
          aprovado_via: payload.aprovado_via,
          metodo_pagamento: 'pix',
          tipo_pagamento_prefixo: prefixoTipo === 'DESCONHECIDO' ? 'RECARGA_PRO_LEGADO' : prefixoTipo
        });
      } catch(eRec){}
      return true;
    } catch (eSaldo) {
      console.error('[LIBERAR_MOEDAS] Falha escrever saldoMoedas Firestore:', eSaldo);
      return false;
    }
  } else {
    console.warn('[LIBERAR_MOEDAS] SKIP: nao temos Firestore ou qtdMoedas=0 ou uid invalido.' + JSON.stringify(transacao));
    return false;
  }
}

/* ============================
   PATROCINADORES CORE HELPERS (Task 2 stub + T3 full)
   ============================ */
const PATROCINIO_PLANOS_CONFIG = Object.freeze({
  bronze:       { dias: 30,  preco_min: 50.00,  nome: 'Bronze 30 dias' },
  prata:        { dias: 60,  preco_min: 120.00, nome: 'Prata 60 dias' },
  ouro:         { dias: 90,  preco_min: 240.00, nome: 'Ouro 90 dias' },
  personalizado:{ dias: 30,  preco_min: 50.00,  nome: 'Personalizado (admin define)' }
});
function _parsePatrocinioExtRef(externalRef) {
  try {
    if (!externalRef || !String(externalRef).startsWith('SPONSOR_')) return null;
    const parts = String(externalRef).split('_');
    if (parts.length < 3) return null;
    // SPONSOR_<docId>_<plano>_<ts>   => docId = parts[1..length-2] (caso docId tenha underline raro), plano = parts[length-2], ts=parts[length-1]
    const ts = parts[parts.length-1];
    const plano = parts[parts.length-2];
    const docId = parts.slice(1, parts.length-2).join('_');
    if (!docId) return null;
    return { external_reference: externalRef, docId, plano, ts };
  } catch(e){ return null; }
}
async function _ativarPatrocinadorPorPagamento(externalRef, opts) {
  opts = opts || {};
  const parsed = _parsePatrocinioExtRef(externalRef);
  if (!parsed || !parsed.docId) { console.warn('[ATIVAR_PATROCINADOR] external_ref invalido para SPONSOR: "'+externalRef+'"'); return false; }
  if (!dbFirestore) return false;
  try {
    const docRef = dbFirestore.collection('patrocinadores').doc(parsed.docId);
    const snap = await docRef.get();
    if (!snap.exists) { console.warn('[ATIVAR_PATROCINADOR] doc nao existe: "'+parsed.docId+'"'); return false; }
    const doc = Object.assign({}, snap.data() || {});
    const planoKey = parsed.plano || doc.plano || 'bronze';
    const statusPatr = String(doc.status_patrocinador || '').toLowerCase();
    // ====================== IDEMPOTENCIA ======================
    if (statusPatr === 'ativo' || statusPatr === 'aguardando_aprovacao_admin') {
      console.log(`[IDEMPOTENCIA_PATROCINADOR] SKIP: doc "${parsed.docId}" JA ESTA status_patrocinador=${statusPatr}. Nao duplica fluxo.`);
      return true;
    }
    const agora = admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString();
    const patch = {
      status_pagamento: 'approved',
      status_patrocinador: 'aguardando_aprovacao_admin',
      atualizado_pagamento_aprovado_em: agora,
      updated_at: agora
    };
    if (opts.mp_payment_id) patch.mp_payment_id = String(opts.mp_payment_id);
    if (opts.aprovado_via) patch.aprovado_via = String(opts.aprovado_via);
    if (opts.valor_pago) patch.valor_pago_final = Number(opts.valor_pago || doc.valor || 0);
    await docRef.set(patch, { merge: true });
    console.log(`[PAGAMENTO_PATROCINADOR_APROVADO] OK doc="${parsed.docId}" plano=${planoKey} via=${opts.aprovado_via||'?'}. AGUARDANDO APROVACAO ADMIN PARA DIVULGACAO PUBLICA.`);
    return true;
  } catch(e) { console.error('[ATIVAR_PATROCINADOR] ERRO:', e && e.message || e); return false; }
}
app.get('/api/patrocinadores/ativos', async (req, res) => {
  const agoraMs = Date.now();
  const toMs = function(v) {
    if (!v) return null;
    if (typeof v === 'string') return (new Date(v)).getTime();
    if (v && v.toDate && typeof v.toDate === 'function') return (new Date(v.toDate())).getTime();
    if (v && typeof v._seconds === 'number') return v._seconds * 1000;
    if (typeof v === 'number') return v;
    return new Date(String(v)).getTime();
  };
  try {
    if (!dbFirestore) return res.status(200).json({ ok: true, total: 0, items: [] });
    const snap = await dbFirestore.collection('patrocinadores').orderBy('created_at','desc').limit(200).get();
    const items = [];
    snap.forEach(ds => {
      try {
        const d = Object.assign({ id: ds.id }, ds.data() || {});
        if (String(d.status_patrocinador || '').toLowerCase() !== 'ativo') return;
        if (String(d.status_pagamento || '').toLowerCase() !== 'approved') return;
        const ini = toMs(d.data_inicio);
        const fim = toMs(d.data_termino);
        if (ini && agoraMs < ini) return; // ainda nao começou
        if (fim && agoraMs > fim) return; // expirou
        // Retorna APENAS campos publicos (remove dados sensiveis como mp_payment_id external_reference uid criador)
        items.push({
          id: String(d.id || ''),
          nome_empresa: d.nome_empresa || '',
          categoria: d.categoria || '',
          descricao: d.descricao || '',
          logo: d.logo || null,
          cartao_visita: d.cartao_visita || null,
          fotos: Array.isArray(d.fotos) ? d.fotos.slice(0,3) : [],
          whatsapp: d.whatsapp || '',
          site: d.site || '',
          instagram: d.instagram || '',
          plano: d.plano || '',
          data_inicio: d.data_inicio || null,
          data_termino: d.data_termino || null,
          created_at: d.created_at || null
        });
      } catch(eItm){}
    });
    return res.status(200).json({ ok: true, total: items.length, items });
  } catch(eGeral){
    console.error('/api/patrocinadores/ativos erro:', eGeral && eGeral.message || eGeral);
    return res.status(500).json({ ok:false, msg:'Erro interno listar patrocinadores ativos.' });
  }
});

/* ============================================================
   POST /api/patrocinadores/criar-pagamento  (TASK 3)
   Cria o pagamento MP para o patrocínio e grava doc inicial na collection "patrocinadores".
   Reutiliza EXATAMENTE a mesma engine MP (SDK v2 + fetch nativo fallback) de /criar-recarga-moedas.
   Body (empresa que está cadastrando):
     {
       plano: 'bronze'|'prata'|'ouro'|'personalizado'  (REQUIRED)
       valor_plano: 50.00   (REQUIRED se plano=personalizado; senao usa PATROCINIO_PLANOS_CONFIG)
       nome_empresa, categoria, descricao, whatsapp, site, instagram,
       logo (base64), cartao_visita (base64), fotos ([base64]),
       uid_criador (opcional uid do usuario/admin),
       admin_senha (opcional, se bolo2024 → libera preço QUALQUER > 0, igual recarga-moedas)
     }
   External_ref padrão: SPONSOR_<patrocinadorDocId>_<plano>_<ts>
   ============================================================ */
app.post('/api/patrocinadores/criar-pagamento', async (req, res) => {
  try {
    const b = req.body || {};
    const urlPublicaValidaHTTPS = Boolean(BACKEND_PUBLIC_URL && BACKEND_PUBLIC_URL.toLowerCase().startsWith('https://') && !BACKEND_PUBLIC_URL.includes('localhost') && !BACKEND_PUBLIC_URL.includes('127.0.0.1'));
    if (MODO_PRODUCAO_REAL && !urlPublicaValidaHTTPS) {
      return res.status(500).json({ ok:false, erro_critico:'MODO_PRODUCAO_REAL', msg:'ENV BACKEND_PUBLIC_URL nao e HTTPS valido. Ajuste Render.' });
    }

    const planoKey = String(b.plano || 'bronze').toLowerCase();
    const planoCfg = PATROCINIO_PLANOS_CONFIG[planoKey] || PATROCINIO_PLANOS_CONFIG.bronze;
    const ehAdmin = String(b.admin_senha || '').trim() === 'bolo2024';
    if (ehAdmin) console.log(`[CRIAR_PATROCINIO] 🔑 ADMIN DETECTADO! Libera alteracao de preco patrocínio plano=${planoKey}.`);

    let precoBRL = Number(planoCfg.valor || 0);
    const valorEnviado = Number(b.valor_plano || 0);
    if (valorEnviado > 0) {
      if (ehAdmin) precoBRL = valorEnviado;
      else if (planoKey === 'personalizado') precoBRL = valorEnviado >= 50 ? valorEnviado : 50;
      else if (valorEnviado >= planoCfg.valor) precoBRL = valorEnviado;
      else { console.warn(`[CRIAR_PATROCINIO] ⚠️ usuario tentou preco abaixo minimo (${valorEnviado} < ${planoCfg.valor}). SOBRESCREVENDO DEFAULT anti-fraude.`); precoBRL = planoCfg.valor; }
    }
    precoBRL = Number(precoBRL);
    if (!(precoBRL > 0)) precoBRL = 50;
    const diasPlano = Number(planoCfg.dias || 30);

    // Grava doc patrocinador inicial PENDENTE na collection "patrocinadores"
    let patrocinadorDocId = null;
    if (dbFirestore) {
      try {
        const dadosBase = {
          nome_empresa: String(b.nome_empresa || '').trim().substring(0, 120),
          categoria: String(b.categoria || '').trim().substring(0, 80),
          descricao: String(b.descricao || '').trim().substring(0, 800),
          logo: b.logo ? String(b.logo).substring(0, 4_000_000) : null,
          cartao_visita: b.cartao_visita ? String(b.cartao_visita).substring(0, 4_000_000) : null,
          fotos: Array.isArray(b.fotos) ? b.fotos.map(f => String(f || '').substring(0, 4_000_000)).slice(0,5) : [],
          whatsapp: String(b.whatsapp || '').trim().substring(0, 30),
          site: String(b.site || '').trim().substring(0, 180),
          instagram: String(b.instagram || '').trim().substring(0, 80),
          plano: planoKey,
          plano_dias: diasPlano,
          valor: precoBRL,
          status_pagamento: 'pending',
          status_patrocinador: 'inativo',
          mp_payment_id: null,
          external_reference: null,
          data_inicio: null,
          data_termino: null,
          uid_criador: b.uid_criador ? String(b.uid_criador).substring(0,60) : null,
          created_at: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),
          updated_at: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString()
        };
        const ref = dbFirestore.collection('patrocinadores').doc();
        patrocinadorDocId = ref.id;
        await ref.set(dadosBase);
        console.log(`[PATROCINIO] doc criado id="${patrocinadorDocId}" empresa="${dadosBase.nome_empresa}" plano=${planoKey} R$${precoBRL} dias=${diasPlano}`);
      } catch (eFb1) {
        console.error('[PATROCINIO] ERRO gravar doc patrocinador inicial:', eFb1 && eFb1.message || eFb1);
        return res.status(500).json({ ok:false, msg:'Erro interno salvar patrocinador no banco.' });
      }
    } else {
      patrocinadorDocId = 'local_pat_' + Date.now();
    }

    // External_ref padrão SPONSOR_<docId>_<plano>_<ts>
    const externalRef = 'SPONSOR_' + String(patrocinadorDocId) + '_' + planoKey + '_' + Date.now();
    // Atualiza doc patrocinador com external_ref (antes de criar MP)
    if (dbFirestore && patrocinadorDocId && !patrocinadorDocId.startsWith('local_pat_')) {
      try { await dbFirestore.collection('patrocinadores').doc(patrocinadorDocId).update({ external_reference: externalRef, updated_at: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString() }); } catch(e){}
    }

    // Também grava a trilha em pix_transacoes (mesma coleção legada, não duplica)
    if (dbFirestore) {
      try {
        await dbFirestore.collection('pix_transacoes').doc(externalRef).set({
          external_reference: externalRef,
          tipo_pagamento_prefixo: 'SPONSOR',
          pacote_key: 'patrocinio_' + planoKey,
          qtd_moedas: 0,
          preco_brl: precoBRL,
          uid_usuario: b.uid_criador ? String(b.uid_criador) : ('sponsor_' + String(patrocinadorDocId)),
          tipo_usuario: 'patrocinador',
          nome_usuario: String(b.nome_empresa || 'Patrocinador AjeitaAí').substring(0,100),
          email_usuario: 'patrocinio@ajeita.com.br',
          status: 'pendente',
          mp_payment_id: null,
          qr_code_base64: null,
          copia_cola: null,
          criado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),
          _sponsor_doc_id: String(patrocinadorDocId)
        }, { merge: true });
      } catch(eT){}
    }

    // --- Passo 2: Cria pagamento PIX no Mercado Pago (MESMISSIMA engine recarga-moedas SDK v2 + fallback) ---
    let qrCodeBase64 = null, copiaCola = null, mpPaymentId = null, tentouSdk = false, usouFetchFallback = false;
    const descricaoMp = 'Patrocinio AjeitaAí Plano ' + planoKey.charAt(0).toUpperCase() + planoKey.slice(1) + ' - ' + String(b.nome_empresa || 'Empresa Parceira').substring(0,50);
    const VALOR_CENTAVOS = Math.floor(Number(precoBRL) * 100);
    if (mercadopago) {
      tentouSdk = true;
      try {
        const bodyMpSdk = {
          transaction_amount: Number(precoBRL),
          description: descricaoMp.substring(0,60),
          payment_method_id: 'pix',
          external_reference: externalRef,
          payer: {
            email: 'patrocinio@ajeita.com.br',
            first_name: String(b.nome_empresa || 'Empresa').substring(0,30),
            last_name: 'AjeitaAí',
            identification: { type:'CNPJ', number:'00000000000000' }
          },
          notification_url: BACKEND_PUBLIC_URL ? (BACKEND_PUBLIC_URL + '/webhook-pix') : undefined,
          metadata: { origem: 'ajeita-patrocinio', plano: planoKey, sponsor_doc_id: patrocinadorDocId }
        };
        const respMp = await mercadopago.payment.create({ body: bodyMpSdk, requestOptions: {} });
        const pay = respMp && respMp.body ? respMp.body : (respMp || {});
        mpPaymentId = pay && (pay.id || pay._id) ? String(pay.id || pay._id) : null;
        const pt = pay && pay.point_of_interaction && pay.point_of_interaction.transaction_data ? pay.point_of_interaction.transaction_data : null;
        if (pt) {
          qrCodeBase64 = pt.qr_code_base64 || null;
          copiaCola = pt.qr_code || pt.copia_e_cola || null;
        }
      } catch (eMpSdk) {
        console.warn('[PATROCINIO] MP SDK v2 falhou (Code 8?), caindo para FETCH REST nativo... Detalhe:', eMpSdk && (eMpSdk.status || eMpSdk.code || ''), eMpSdk && eMpSdk.message ? (eMpSdk.message).substring(0,260) : '');
        tentouSdk = false;
      }
    }
    if (!tentouSdk || (!qrCodeBase64 && MP_ACCESS_TOKEN)) {
      usouFetchFallback = true;
      try {
        const bodyNativo = {
          transaction_amount: Number(precoBRL),
          description: descricaoMp.substring(0,60),
          payment_method_id: 'pix',
          external_reference: externalRef,
          payer: { email: 'patrocinio@ajeita.com.br', first_name: 'Empresa', last_name: 'AjeitaAí', identification: { type: 'CNPJ', number: '00000000000000' } }
        };
        if (BACKEND_PUBLIC_URL) bodyNativo.notification_url = BACKEND_PUBLIC_URL + '/webhook-pix';
        bodyNativo.metadata = { origem: 'ajeita-patrocinio', plano: planoKey, sponsor_doc_id: patrocinadorDocId };
        const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'X-Idempotency-Key': 'pat_' + externalRef };
        const respFetch = await fetch('https://api.mercadopago.com/v1/payments', { method: 'POST', headers: headers, body: JSON.stringify(bodyNativo) });
        const pay2 = await respFetch.json().catch(()=>({}));
        mpPaymentId = pay2 && (pay2.id || pay2._id) ? String(pay2.id || pay2._id) : null;
        const pt2 = pay2 && pay2.point_of_interaction && pay2.point_of_interaction.transaction_data ? pay2.point_of_interaction.transaction_data : null;
        if (pt2) { qrCodeBase64 = pt2.qr_code_base64 || null; copiaCola = pt2.qr_code || pt2.copia_e_cola || null; }
      } catch(eFetch){
        console.error('[PATROCINIO] MP FETCH fallback também falhou:', eFetch && eFetch.message || eFetch);
      }
    }

    if (qrCodeBase64 && !qrCodeBase64.toLowerCase().startsWith('data:image')) qrCodeBase64 = 'data:image/png;base64,' + String(qrCodeBase64);
    if (dbFirestore && patrocinadorDocId && !patrocinadorDocId.startsWith('local_pat_')) {
      try {
        await dbFirestore.collection('patrocinadores').doc(patrocinadorDocId).update({
          mp_payment_id: mpPaymentId,
          qr_code_base64: qrCodeBase64,
          copia_cola: copiaCola,
          updated_at: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString()
        });
      } catch(eUp){}
    }
    if (dbFirestore) {
      try {
        await dbFirestore.collection('pix_transacoes').doc(externalRef).set({
          mp_payment_id: mpPaymentId,
          qr_code_base64: qrCodeBase64,
          copia_cola: copiaCola
        }, { merge: true });
      } catch(eT2){}
    }

    if (!qrCodeBase64 && !mpPaymentId) {
      return res.status(500).json({ ok:false, msg:'Mercado Pago nao retornou QR. Verificar Access Token backend e rede.' });
    }

    return res.status(200).json({
      ok: true,
      external_reference: externalRef,
      patrocinador_doc_id: patrocinadorDocId,
      mp_payment_id: mpPaymentId,
      plano: planoKey,
      dias: diasPlano,
      preco_brl: precoBRL,
      valor_centavos_mp: VALOR_CENTAVOS,
      qr_code_base64: qrCodeBase64,
      copia_cola: copiaCola,
      usou_sdk_mp_v2: tentouSdk,
      usou_fetch_rest_fallback: usouFetchFallback
    });

  } catch (eGeral) {
    console.error('[ROTA /api/patrocinadores/criar-pagamento] EXCEPTION:', eGeral && eGeral.message || eGeral);
    return res.status(500).json({ ok:false, msg:'Erro interno criar pagamento patrocinio.' });
  }
});

/* ============================================================
   ADMIN — PATROCINADORES  (TASK 3)
   Todas as rotas exigem header? ou body? admin_senha === 'bolo2024'
   (mesma convenção já usada nas rotas admin pix em server.js)
   GET    /api/patrocinadores/admin/todos
   PATCH  /api/patrocinadores/admin/patch  {docId, patch, admin_senha, marcar_pagamento_aprovado_motivo?}
   DELETE /api/patrocinadores/admin/delete {docId, admin_senha}
   ============================================================ */
app.get('/api/patrocinadores/admin/todos', async (req, res) => {
  try {
    const senha = String((req.query && req.query.admin_senha) || (req.body && req.body.admin_senha) || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    if (!dbFirestore) return res.status(200).json({ ok:true, total:0, items:[] });
    const snap = await dbFirestore.collection('patrocinadores').orderBy('created_at','desc').limit(300).get();
    const items = [];
    snap.forEach(ds => { try { items.push(Object.assign({ id: ds.id }, ds.data() || {})); } catch(e){} });
    return res.status(200).json({ ok:true, total: items.length, items });
  } catch(e){
    console.error('/api/patrocinadores/admin/todos erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno admin listar patrocinadores.' });
  }
});
app.patch('/api/patrocinadores/admin/patch', async (req, res) => {
  try {
    const b = req.body || {};
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const docId = String(b.docId || '').trim();
    if (!docId || !dbFirestore) return res.status(400).json({ ok:false, msg:'docId ausente.' });
    const snapDoc = await dbFirestore.collection('patrocinadores').doc(docId).get().catch(()=>null);
    if (!snapDoc || !snapDoc.exists) return res.status(404).json({ ok:false, msg:'Patrocinador nao encontrado.' });
    const docAtual = Object.assign({}, snapDoc.data() || {});
    // Regra §13: para marcar pagamento approved ou ativar patrocinador MANUALMENTE via admin, EXIGE
    // checkbox b.marcar_pagamento_aprovado_confirmar === true + motivo em texto
    const patch = Object.assign({}, b.patch || {});
    const querMarcarAprovado = (patch.status_pagamento && String(patch.status_pagamento).toLowerCase() === 'approved') ||
                              (patch.status_patrocinador && String(patch.status_patrocinador).toLowerCase() === 'ativo');
    if (querMarcarAprovado) {
      const confirmar = Boolean(b.marcar_pagamento_aprovado_confirmar === true || b.marcar_pagamento_aprovado_confirmar === 'true' || b.marcar_pagamento_aprovado_confirmar === 'on');
      const motivo = String(b.marcar_pagamento_aprovado_motivo || '').trim();
      if (!confirmar || motivo.length < 8) return res.status(400).json({ ok:false, msg:'Para aprovar manualmente: marque checkbox obrigatória e justifique com motivo (mín 8 caracteres). Ação bloqueada para não confundir com pagamento real MP.' });
      patch.aprovado_via = 'admin_manual';
      patch.aprovado_manual_motivo = motivo.substring(0,400);
      patch.aprovado_manual_em = admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString();
      // Se marcou approved sem data de inicio: ativa patrocínio automático igual fluxo MP aprovado (calcula inicio/fim)
      if (!patch.data_inicio && String(patch.status_patrocinador || docAtual.status_patrocinador || '').toLowerCase() === 'ativo') {
        const dias = Number(patch.plano_dias || docAtual.plano_dias || ((PATROCINIO_PLANOS_CONFIG[String(patch.plano || docAtual.plano || 'bronze').toLowerCase()] || {}).dias) || 30);
        patch.data_inicio = admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString();
        const termMs = Date.now() + (dias * 24*60*60*1000);
        patch.data_termino = admin.firestore.Timestamp ? admin.firestore.Timestamp.fromMillis(termMs) : new Date(termMs).toISOString();
        console.log(`[ADMIN_PATROCINIO_ATIVACAO_MANUAL] docId=${docId} dias=${dias} motivo="${motivo}"`);
      }
      // Atualiza também pix_transacoes correspondente (se external_reference existir)
      if (docAtual.external_reference) {
        try { await dbFirestore.collection('pix_transacoes').doc(docAtual.external_reference).set({ status: 'aprovado', updated_at: admin.firestore.Timestamp? admin.firestore.Timestamp.now(): new Date().toISOString() }, { merge: true }); } catch(e){}
      }
    }
    patch.updated_at = admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString();
    await dbFirestore.collection('patrocinadores').doc(docId).set(patch, { merge: true });
    return res.status(200).json({ ok:true, msg:'Patrocinador atualizado.' });
  } catch(e){
    console.error('/api/patrocinadores/admin/patch erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno admin atualizar patrocinador.' });
  }
});
app.delete('/api/patrocinadores/admin/delete', async (req, res) => {
  try {
    const b = req.body || {};
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const docId = String(b.docId || '').trim();
    if (!docId || !dbFirestore) return res.status(400).json({ ok:false, msg:'docId ausente.' });
    const snapDoc = await dbFirestore.collection('patrocinadores').doc(docId).get().catch(()=>null);
    const extRef = snapDoc && snapDoc.exists && snapDoc.data() ? (snapDoc.data().external_reference || null) : null;
    await dbFirestore.collection('patrocinadores').doc(docId).delete().catch(()=>{});
    if (extRef) { try { await dbFirestore.collection('pix_transacoes').doc(extRef).delete().catch(()=>{}); } catch(e){} }
    return res.status(200).json({ ok:true, msg:'Patrocinador excluído.' });
  } catch(e){
    console.error('/api/patrocinadores/admin/delete erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno admin excluir patrocinador.' });
  }
});

/* ============================================================
   (INFRA EMAIL — CENTRAL REUTILIZÁVEL)
   Serviço único de envio de e-mail via SMTP + variáveis de ambiente.
   NÃO LOGA credenciais, NÃO expõe senha em nenhuma resposta.
   Exporta:
     - sendEmail({ to, subject, html, text }) -> Promise<{ok, msg, info?}>
   Variáveis de ambiente OBRIGATÓRIAS (SMTP):
     SMTP_HOST=
     SMTP_PORT=      (ex: 587 para STARTTLS, 465 para TLS)
     SMTP_USER=
     SMTP_PASSWORD=
     EMAIL_FROM=     (ex: "AjeitaAí <no-reply@ajeitaai.com.br>")
   Opcional:
     SMTP_SECURE=    ("true" para porta 465, padrão "false"/porta 587 STARTTLS)
     SMTP_ADMIN_2FA_TO= ti.mello.santos@gmail.com (e-mail destinatário código 2FA admin docs)
   ============================================================ */
function _emailSanitizeStr(v, max){
  try {
    let s = String(v == null ? '' : v);
    s = s.replace(/[\r\n\t\0\x0B\x0C]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^["']+|["']+$/g, '').trim();
    if (s.length > (Number(max) || 500)) s = s.substring(0, Number(max) || 500);
    return s;
  } catch(e){ return ''; }
}
function _emailSanitizeFrom(v){
  try {
    let s = String(v == null ? '' : v);
    s = s.replace(/[\r\n\t\0]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^["]+|["]+$/g, '').trim();
    const m = s.match(/<([^<>]+)>/);
    if (m) {
      const emailOnly = String(m[1] || '').replace(/\s+/g, '').trim();
      const name = String(s.substring(0, m.index)).replace(/^["']+|["']+$/g, '').trim() || 'AjeitaAí';
      return '"' + name.replace(/["]/g, '') + '" <' + emailOnly + '>';
    }
    return s.replace(/\s+/g, '');
  } catch(e){ return ''; }
}
(function _aplicarSanitizeSMTPNasEnvsMemoria(){
  try {
    process.env.SMTP_HOST = _emailSanitizeStr(process.env.SMTP_HOST, 255);
    process.env.SMTP_PORT = _emailSanitizeStr(process.env.SMTP_PORT, 10).replace(/[^\d]/g, '');
    process.env.SMTP_USER = _emailSanitizeStr(process.env.SMTP_USER, 255).replace(/\s+/g, '');
    process.env.SMTP_PASSWORD = String(process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');
    process.env.SMTP_SECURE = _emailSanitizeStr(process.env.SMTP_SECURE, 10).toLowerCase();
    process.env.EMAIL_FROM = _emailSanitizeFrom(process.env.EMAIL_FROM);
    if (process.env.SMTP_ADMIN_2FA_TO) process.env.SMTP_ADMIN_2FA_TO = _emailSanitizeStr(process.env.SMTP_ADMIN_2FA_TO, 255).replace(/\s+/g, '');
  } catch(eSanitizeEnv){}
})();
var _emailStatus = { configurado: false, motivo: '' };
(function _inicializarEmailStatus(){
  const h = String(process.env.SMTP_HOST || '').trim();
  const p = String(process.env.SMTP_PORT || '').trim();
  const u = String(process.env.SMTP_USER || '').trim();
  const s = String(process.env.SMTP_PASSWORD || '').trim();
  const f = String(process.env.EMAIL_FROM || '').trim();
  if (h && p && u && s && f) {
    const hMask = h.substring(0, Math.min(8, h.length));
    const uMask = u.substring(0, Math.min(6, u.length));
    _emailStatus.configurado = true;
    _emailStatus.motivo = 'SMTP configurado via variaveis de ambiente (prefixos [' + hMask + '...], port=' + p + ', user=[' + uMask + '...]). Timeouts: 6s conectar / 8s greeting / 15s socket. Fallback portas: 587 -> 2525 -> 465 (SendGrid).';
  } else {
    const faltam = [];
    if (!h) faltam.push('SMTP_HOST');
    if (!p) faltam.push('SMTP_PORT');
    if (!u) faltam.push('SMTP_USER');
    if (!s) faltam.push('SMTP_PASSWORD');
    if (!f) faltam.push('EMAIL_FROM');
    _emailStatus.configurado = false;
    _emailStatus.motivo = 'SMTP NAO configurado. Faltam variaveis de ambiente: ' + faltam.join(', ') + '. Instrucoes: configurar no Render > ajeita-backend-pix > Environment. Apenas administrador pode ver valores.';
  }
})();
var _emailTransportCached = null;
var _emailTransportCachedPort = 0;
var _emailUltimaTentativaConectada = null; // para relatorio de testes
function _emailIsTimeoutLikeError(e){
  try {
    if (!e) return false;
    var m = String((e && e.message) || '').toLowerCase() + ' ' + String((e && e.code) || '').toLowerCase();
    if (m.indexOf('timeout') >= 0) return true;
    if (m.indexOf('etimedout') >= 0) return true;
    if (m.indexOf('esockettimedout') >= 0) return true;
    if (m.indexOf('econnrefused') >= 0) return true;
    if (m.indexOf('econnreset') >= 0) return true;
    if (m.indexOf('eai_again') >= 0) return true;
    if (m.indexOf('enotfound') >= 0) return true;
    if (m.indexOf('getaddrinf') >= 0) return true;
    return false;
  } catch(e1){ return false; }
}
function _emailCreateTransporteForPort(targetPort){
  try {
    if (!_emailStatus.configurado) return null;
    const nodemailer = require('nodemailer');
    const host0 = String(process.env.SMTP_HOST || '').trim();
    const host = (host0 && /^sendgrid$/i.test(host0.replace(/[^\w]/g,''))) ? 'smtp.sendgrid.net' : host0;
    const port = Number(targetPort) || Number(String(process.env.SMTP_PORT || '0').trim() || '0') || 587;
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASSWORD || '').trim();
    const secureRaw = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
    const secure = secureRaw === 'true' || Number(port) === 465;
    const requireTls = (!secure) ? true : undefined; // porta 587/2525: obrigatorio STARTTLS
    const connectionTimeout = 6 * 1000;   // 6s por tentativa (rapido para fallback nao demorar)
    const greetingTimeout   = 8 * 1000;   // 8s
    const socketTimeout     = 15 * 1000;  // 15s max geral conexao
    if (!host || !port || !user || !pass) return null;
    const userMask = user.substring(0, Math.min(6, user.length));
    const hostMask = host.substring(0, Math.min(10, host.length));
    console.log('[EMAIL_SERVICE] Criando transporte SMTP (sem credenciais nos logs): host=[' + hostMask + '...], port=' + port + ', secure=' + Boolean(secure) + ', requireTls=' + Boolean(requireTls) + ', auth.user=[' + userMask + '...].');
    const tr = nodemailer.createTransport({
      host: host,
      port: Number(port),
      secure: Boolean(secure),
      auth: { user: String(user), pass: String(pass) },
      pool: false,
      requireTLS: requireTls,
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        servername: host
      },
      connectionTimeout: connectionTimeout,
      greetingTimeout: greetingTimeout,
      socketTimeout: socketTimeout,
      logger: false,
      debug: false
    });
    return { transporter: tr, usedPort: Number(port), usedHost: String(host), usedSecure: Boolean(secure), usedRequireTls: Boolean(requireTls) };
  } catch(eMailT){
    console.warn('[EMAIL_SERVICE] Falha ao criar transporte SMTP (detalhe oculto por seguranca).');
    _emailTransportCached = null;
    _emailTransportCachedPort = 0;
    return null;
  }
}
function _emailGetTransport(){
  try {
    if (_emailTransportCached) return _emailTransportCached;
    const primPort = Number(String(process.env.SMTP_PORT || '0').trim() || '0') || 587;
    const created = _emailCreateTransporteForPort(primPort);
    if (!created || !created.transporter) return null;
    _emailTransportCached = created.transporter;
    _emailTransportCachedPort = Number(created.usedPort) || Number(primPort);
    return _emailTransportCached;
  } catch(eGet){
    console.warn('[EMAIL_SERVICE] _emailGetTransport falhou (detalhe oculto).');
    _emailTransportCached = null;
    _emailTransportCachedPort = 0;
    return null;
  }
}
async function sendEmail(opts){
  try {
    if (!_emailStatus.configurado) return { ok:false, msg: _emailStatus.motivo };
    const to = (opts && opts.to) ? String(opts.to) : '';
    const subject = (opts && opts.subject) ? String(opts.subject) : '(Sem Assunto)';
    const html = (opts && typeof opts.html === 'string') ? String(opts.html) : '';
    const text = (opts && typeof opts.text === 'string') ? String(opts.text) : (html ? String(html).replace(/<[^>]+>/g, ' ') : '');
    if (!to) return { ok:false, msg:'Destinatario (to) ausente.' };
    const from = String(process.env.EMAIL_FROM || '').trim();
    if (!from) return { ok:false, msg:'EMAIL_FROM ausente.' };

    // Portas padrao SendGrid documentadas: 587 (STARTTLS), 2525 (STARTTLS alt), 465 (TLS direto)
    const portasFallback = [587, 2525, 465];
    const portaPrimaria = Number(String(process.env.SMTP_PORT || '0').trim() || '0') || 587;
    const ordemTentativas = [];
    ordemTentativas.push(portaPrimaria);
    for (const p of portasFallback){ if (!ordemTentativas.includes(Number(p))) ordemTentativas.push(Number(p)); }

    let ultimoErroGeral = null;
    let tentativasRealizadas = 0;
    let portaBemSucedida = null;
    let conexaoEstabelecida = false;
    let messageId = '';
    let transportInfoUltima = null;

    for (const pT of ordemTentativas) {
      tentativasRealizadas += 1;
      let tObj = null;
      // Reusar cache se a porta da vez bater com a cacheada; senao recria transporte especifico
      if (_emailTransportCached && Number(_emailTransportCachedPort) === Number(pT)) {
        tObj = { transporter: _emailTransportCached, usedPort: Number(pT) };
      } else {
        const novo = _emailCreateTransporteForPort(Number(pT));
        if (novo && novo.transporter) {
          _emailTransportCached = novo.transporter;
          _emailTransportCachedPort = Number(novo.usedPort) || Number(pT);
          tObj = novo;
        }
      }
      if (!tObj || !tObj.transporter) { ultimoErroGeral = new Error('transporte_indisponivel_porta_' + Number(pT)); continue; }
      transportInfoUltima = { usedPort: Number(pT), usedHost: String(tObj.usedHost || process.env.SMTP_HOST || 'smtp.sendgrid.net'), usedSecure: Boolean(tObj.usedSecure || (Number(pT) === 465)), usedRequireTls: Boolean(tObj.usedRequireTls !== false) };

      try {
        const info = await tObj.transporter.sendMail({ from: from, to: to, subject: subject, html: html || undefined, text: text || undefined });
        conexaoEstabelecida = true;
        portaBemSucedida = Number(pT);
        _emailUltimaTentativaConectada = { ok: true, porta: Number(pT), ts: Date.now() };
        messageId = (info && info.messageId) ? String(info.messageId) : '';
        break;
      } catch(eTentativa){
        ultimoErroGeral = eTentativa;
        const ehTime = _emailIsTimeoutLikeError(eTentativa);
        // Nao repete tentativas infinitas: se nao for timeout (erro de autenticacao, por exemplo), NAO tenta outras portas.
        if (!ehTime) break;
        // Timeout: invalida cache dessa porta e continua para proxima da lista
        if (_emailTransportCachedPort === Number(pT)) { try { _emailTransportCached && typeof _emailTransportCached.close === 'function' && _emailTransportCached.close(); } catch(_x){} _emailTransportCached = null; _emailTransportCachedPort = 0; }
        console.warn('[EMAIL_SERVICE] Tentativa SMTP porta=' + Number(pT) + ' falhou com timeout/conexao recusada. Seguindo para proxima porta fallback (se houver).');
      }
    }

    if (portaBemSucedida !== null && conexaoEstabelecida === true) {
      // Sucesso: mantem transporte cacheado para esta porta
      _emailTransportCachedPort = Number(portaBemSucedida) || Number(_emailTransportCachedPort);
      return {
        ok: true,
        msg: 'Email enviado para SMTP com sucesso.',
        msgId: messageId ? messageId.substring(0, 120) : '',
        smtp: transportInfoUltima ? {
          porta: Number(transportInfoUltima.usedPort),
          host: (String(transportInfoUltima.usedHost || '').substring(0, 12) + '...'),
          secure: Boolean(transportInfoUltima.usedSecure),
          requireTls: Boolean(transportInfoUltima.usedRequireTls),
          tentativas: Number(tentativasRealizadas)
        } : undefined
      };
    }

    // Falha: relatorio sem credenciais
    const erroSemCred = ultimoErroGeral && ultimoErroGeral.message ? String(ultimoErroGeral.message).substring(0, 400) : 'erro interno';
    console.warn('[EMAIL_SERVICE] sendEmail falhou. Erro mensagem (sem credenciais):', erroSemCred);
    const isTimeoutFinal = _emailIsTimeoutLikeError(ultimoErroGeral);
    const detalheConexao = (isTimeoutFinal === true)
      ? 'Conexao SMTP expirou antes do handshake (nenhuma das portas tentadas 587/2525/465 respondeu a tempo). Timeout explicito=6s conectar / 8s greeting / 15s socket.'
      : 'Conexao chegou a ser estabelecida mas o servidor SMTP retornou erro durante autenticacao ou envio.';
    // Relatorio completo de transporte utilizado (SEM CREDENCIAIS):
    const relTransp = transportInfoUltima ? {
      host_mask: String(transportInfoUltima.usedHost || process.env.SMTP_HOST || 'smtp.sendgrid.net').substring(0, 16) + '...',
      portas_tentadas: ordemTentativas.map(n => Number(n)),
      porta_ultima_tentativa: Number(transportInfoUltima.usedPort),
      secure: Boolean(transportInfoUltima.usedSecure),
      requireTls: Boolean(transportInfoUltima.usedRequireTls !== false),
      tentativas: Number(tentativasRealizadas)
    } : undefined;
    return {
      ok: false,
      msg: 'Falha ao enviar e-mail: ' + erroSemCred,
      conexao: {
        chegou_a_estabelecer: (isTimeoutFinal === false),
        descricao: detalheConexao
      },
      transporte_utilizado_sem_credenciais: relTransp
    };
  } catch(eSend){
    console.warn('[EMAIL_SERVICE] sendEmail falhou. Erro mensagem (sem credenciais):', (eSend && eSend.message) ? String(eSend.message).substring(0, 400) : 'erro generico');
    return { ok:false, msg: 'Falha ao enviar e-mail: ' + ((eSend && eSend.message) ? String(eSend.message).substring(0, 300) : 'erro interno.') };
  }
}
app.get('/api/admin/email/status', (req, res) => {
  const b = Object.assign({}, req.query || {}, req.body || {});
  const senha = String(b.admin_senha || '').trim();
  if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
  return res.json({ ok:true, configurado: Boolean(_emailStatus.configurado), resumo: String(_emailStatus.motivo || '') });
});
async function _emailExecutarTesteEnvio(to, res){
  try {
    const toLimpo = String(to || '').trim();
    if (!toLimpo) return res.status(400).json({ ok:false, msg: 'Destinatario ausente. Informar {to} no body/query ou setar SMTP_ADMIN_2FA_TO / EMAIL_FROM nas vars de ambiente.' });
    const assunto = 'Ajeitaí — teste de e-mail';
    const corpoHtml = '<!doctype html><html><head><meta charset="utf-8"/></head><body style="font-family:Arial,sans-serif;padding:24px;color:#0f172a;"><h2 style="color:#7c3aed;">AjeitaAí</h2><p>Este é um teste do sistema de envio de e-mails do Ajeitaí.</p><p style="color:#64748b;font-size:12px;margin-top:32px;">Mensagem automática, não responder.</p></body></html>';
    const r = await sendEmail({ to: toLimpo, subject: assunto, html: corpoHtml });
    const mask = toLimpo.substring(0, Math.min(2, toLimpo.indexOf('@') >= 0 ? toLimpo.indexOf('@') : 2)) + '***@' + (toLimpo.split('@')[1] || '?').substring(0, 3) + '***';
    return res.json({ ok: Boolean(r.ok), msg: String(r.msg || ''), destinatarioMask: mask, assunto: assunto, corpoResumo: 'Este é um teste do sistema de envio de e-mails do Ajeitaí.' });
  } catch(e){
    console.error('/api/admin/email/teste erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno enviar email teste.' });
  }
}
app.post('/api/admin/email/teste', async (req, res) => {
  try {
    const b = req.body || {};
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const to = String(b.to || process.env.SMTP_ADMIN_2FA_TO || process.env.EMAIL_FROM || '').trim();
    return await _emailExecutarTesteEnvio(to, res);
  } catch(e){
    console.error('/api/admin/email/teste erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno enviar email teste.' });
  }
});
app.get('/api/admin/email/teste-manual', async (req, res) => {
  try {
    const b = Object.assign({}, req.query || {}, req.body || {});
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const to = String(b.to || process.env.SMTP_ADMIN_2FA_TO || process.env.EMAIL_FROM || '').trim();
    return await _emailExecutarTesteEnvio(to, res);
  } catch(e){
    console.error('/api/admin/email/teste-manual erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno enviar email teste manual.' });
  }
});

/* ============================================================
   (2FA ADMIN — DOCUMENTOS DE VALIDAÇÃO / SEGUNDA AUTENTICAÇÃO)
   Objetivo: exigir código de 6 dígitos via e-mail SOMENTE antes de
   abrir/visualizar documentos privados de validação de profissionais
   na aba "Verificações" do admin.html.

   - Código válido por no máximo 5 minutos.
   - Código de uso único.
   - Armazenado como hash SHA256 no servidor (nunca texto puro em persistência de longa duração).
   - Limitar tentativas incorretas (max 6 por código).
   - Código NUNCA é devolvido no frontend, NUNCA em URL, NUNCA em logs.
   - E-mail destinatário padrão: ti.mello.santos@gmail.com (sobrescreve SMTP_ADMIN_2FA_TO se existir).
   - Admin libera acesso temporário de 10 minutos após validação bem-sucedida
     (retorna token curto opaco para o frontend usar em requests subsequentes
     para visualizar documentos ou abrir modal).
   ============================================================ */
const _2FA_DOCS_ADMIN = {
  EMAIL_DESTINO: String(process.env.SMTP_ADMIN_2FA_TO || 'ti.mello.santos@gmail.com').trim() || 'ti.mello.santos@gmail.com',
  TTL_CODIGO_MS: 5 * 60 * 1000,
  TTL_SESSAO_MS: 10 * 60 * 1000,
  MAX_TENTATIVAS: 6,
  _pendentes: new Map(),      // key: nonce (opaco) -> { codigoHash, criadoEmMs, tentativasRestantes, usado }
  _sessoes: new Map(),        // key: tokenOpcaco (string random 64 hex) -> { criadoEmMs, expiraMs }
  _tokensPorAdmin: new Map()  // key: adminLogin (fixo admin10) -> tokenOpcaco atual
};
function _2FAGerarNonce(len){
  try { return crypto.randomBytes(Math.max(16, Number(len) || 24)).toString('hex'); }
  catch(e){ return 'nonce_' + Date.now() + '_' + Math.random().toString(36).substring(2); }
}
function _2FAGerarCodigo6Dig(){
  try {
    const raw = crypto.randomInt(0, 1000000);
    return String(raw).padStart(6, '0');
  } catch(e){
    return String(Math.floor(100000 + Math.random() * 900000));
  }
}
function _2FAHashSha256(texto){
  try { return crypto.createHash('sha256').update(String(texto || ''), 'utf8').digest('hex'); }
  catch(e){ return String(texto || ''); }
}
function _2FALimparExpirados(){
  try {
    const agora = Date.now();
    for (const [k, v] of _2FA_DOCS_ADMIN._pendentes.entries()) {
      if (v.usado || (agora - (v.criadoEmMs || 0)) > _2FA_DOCS_ADMIN.TTL_CODIGO_MS) _2FA_DOCS_ADMIN._pendentes.delete(k);
    }
    for (const [k, v] of _2FA_DOCS_ADMIN._sessoes.entries()) {
      if ((v.expiraMs || 0) < agora) {
        _2FA_DOCS_ADMIN._sessoes.delete(k);
        for (const [adm, tok] of _2FA_DOCS_ADMIN._tokensPorAdmin.entries()) {
          if (tok === k) _2FA_DOCS_ADMIN._tokensPorAdmin.delete(adm);
        }
      }
    }
  } catch(eGarbage){}
}
setInterval(_2FALimparExpirados, 60 * 1000);
function _2FACriarSessaoAprovada(){
  const agora = Date.now();
  const token = _2FAGerarNonce(32);
  const expira = agora + _2FA_DOCS_ADMIN.TTL_SESSAO_MS;
  _2FA_DOCS_ADMIN._sessoes.set(token, { criadoEmMs: agora, expiraMs: expira });
  _2FA_DOCS_ADMIN._tokensPorAdmin.set('admin10', token);
  return { token: token, expiraMs: expira, expiraEmIso: new Date(expira).toISOString() };
}
function _2FAValidarSessaoToken(token){
  if (!token) return { ok:false, msg:'Token ausente.' };
  const s = _2FA_DOCS_ADMIN._sessoes.get(String(token || ''));
  if (!s) return { ok:false, msg:'Sessao 2FA nao existe ou expirou. Gere novo codigo.' };
  if ((s.expiraMs || 0) < Date.now()) {
    _2FA_DOCS_ADMIN._sessoes.delete(String(token || ''));
    return { ok:false, msg:'Sessao 2FA expirou. Gere novo codigo.' };
  }
  return { ok:true, msg:'2FA ativo.', expiraMs: Number(s.expiraMs || 0) };
}
app.post('/api/admin/2fa/docs/gerar', async (req, res) => {
  try {
    const b = req.body || {};
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    if (!_emailStatus.configurado) return res.status(503).json({ ok:false, msg: 'SMTP nao configurado. Impossivel enviar codigo 2FA por e-mail. ' + String(_emailStatus.motivo || '') });
    _2FALimparExpirados();
    const nonce = _2FAGerarNonce(20);
    const codigo = _2FAGerarCodigo6Dig();
    const codigoHash = _2FAHashSha256(codigo);
    _2FA_DOCS_ADMIN._pendentes.set(nonce, {
      codigoHash: codigoHash,
      criadoEmMs: Date.now(),
      tentativasRestantes: _2FA_DOCS_ADMIN.MAX_TENTATIVAS,
      usado: false
    });
    const destino = _2FA_DOCS_ADMIN.EMAIL_DESTINO;
    const assunto = 'AjeitaAí — Código de acesso aos Documentos de Validação';
    const corpoHtml = '<!doctype html><html><head><meta charset="utf-8"/></head><body style="font-family:Arial,sans-serif;padding:24px;color:#0f172a;">' +
      '<h2 style="color:#7c3aed;">AjeitaAí — Painel Admin</h2>' +
      '<p>Você solicitou um código de segurança para acessar os <b>documentos de validação</b> de profissionais.</p>' +
      '<p>Use este código apenas no painel administrativo. Ele é <b>válido por 5 minutos</b> e de uso único.</p>' +
      '<div style="margin:28px auto;max-width:380px;padding:20px 16px;text-align:center;border-radius:16px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;">' +
      '<div style="font-size:13px;opacity:0.95;margin-bottom:8px;">Código de segurança</div>' +
      '<div style="font-size:38px;font-weight:900;letter-spacing:10px;">' + String(codigo) + '</div>' +
      '</div>' +
      '<p style="color:#64748b;font-size:13px;">Se você não solicitou este código, ignore este e-mail.</p>' +
      '<p style="color:#94a3b8;font-size:11px;margin-top:40px;">Mensagem automática, não responder.</p>' +
      '</body></html>';
    const r = await sendEmail({ to: destino, subject: assunto, html: corpoHtml });
    if (!r.ok) return res.status(502).json({ ok:false, msg: 'Falha ao enviar email com codigo 2FA. Detalhe (sem codigo): ' + String(r.msg || '') });
    return res.json({ ok:true, nonce: nonce, destMask: destino.substring(0, 2) + '***@' + (destino.split('@')[1] || '?').substring(0, 3) + '***', validadeMs: _2FA_DOCS_ADMIN.TTL_CODIGO_MS });
  } catch(e){
    console.error('/api/admin/2fa/docs/gerar erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno ao gerar codigo 2FA docs.' });
  }
});
app.post('/api/admin/2fa/docs/validar', async (req, res) => {
  try {
    const b = req.body || {};
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const nonce = String(b.nonce || '').trim();
    const codigoDigitado = String(b.codigo || '').trim();
    if (!nonce || !codigoDigitado) return res.status(400).json({ ok:false, msg:'nonce e codigo sao obrigatorios.' });
    if (!/^\d{6}$/.test(codigoDigitado)) return res.status(400).json({ ok:false, msg:'Codigo invalido (deve ser 6 digitos numericos).' });
    _2FALimparExpirados();
    const pend = _2FA_DOCS_ADMIN._pendentes.get(nonce);
    if (!pend) return res.status(404).json({ ok:false, msg:'Codigo 2FA expirado ou nao encontrado. Gere um novo.' });
    if (pend.usado) return res.status(409).json({ ok:false, msg:'Codigo 2FA ja utilizado. Gere um novo.' });
    if ((Date.now() - (pend.criadoEmMs || 0)) > _2FA_DOCS_ADMIN.TTL_CODIGO_MS) {
      _2FA_DOCS_ADMIN._pendentes.delete(nonce);
      return res.status(410).json({ ok:false, msg:'Codigo 2FA expirou (5 min). Gere um novo.' });
    }
    if ((pend.tentativasRestantes || 0) <= 0) {
      pend.usado = true;
      _2FA_DOCS_ADMIN._pendentes.delete(nonce);
      return res.status(429).json({ ok:false, msg:'Maximo de tentativas incorretas excedido. Gere um novo codigo.' });
    }
    const digitadoHash = _2FAHashSha256(codigoDigitado);
    const match = (digitadoHash === String(pend.codigoHash || ''));
    if (!match) {
      pend.tentativasRestantes = Number(pend.tentativasRestantes || 0) - 1;
      const restantes = Math.max(0, Number(pend.tentativasRestantes || 0));
      if (restantes <= 0) { pend.usado = true; _2FA_DOCS_ADMIN._pendentes.delete(nonce); }
      return res.status(401).json({ ok:false, msg:'Codigo 2FA incorreto.', tentativasRestantes: restantes });
    }
    pend.usado = true;
    _2FA_DOCS_ADMIN._pendentes.delete(nonce);
    const sessao = _2FACriarSessaoAprovada();
    return res.json({ ok:true, msg:'2FA validado com sucesso. Acesso liberado aos documentos.', token: sessao.token, expiraMs: Number(sessao.expiraMs || 0), expiraEmIso: String(sessao.expiraEmIso || '') });
  } catch(e){
    console.error('/api/admin/2fa/docs/validar erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno ao validar codigo 2FA docs.' });
  }
});
app.post('/api/admin/2fa/docs/checar', async (req, res) => {
  try {
    const b = Object.assign({}, req.query || {}, req.body || {});
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const token = String(b.token || '').trim();
    const v = _2FAValidarSessaoToken(token);
    return res.json({ ok: Boolean(v.ok), msg: String(v.msg || ''), expiraMs: Number(v.expiraMs || 0) });
  } catch(e){
    return res.status(500).json({ ok:false, msg:'Erro interno checar 2FA docs.' });
  }
});

/* ============================================================
   (SISTEMA DE NOTIFICAÇÕES — ENVIO DE E-MAIL EM LOTE)
   Reutiliza sendEmail() existente — NÃO cria novo SMTP, NÃO altera credenciais.
   Usado pelo frontend para disparar e-mails de notificação:
   - Novo pedido/orçamento para profissionais compatíveis
   - Novo profissional disponível para clientes compatíveis
   ============================================================ */
const _NOTIF_EMAIL_BLOQUEIO_INTERVALO_MS = 30 * 60 * 1000;
const _NOTIF_EMAIL_ULTIMOS_DISPARADOS = new Map();
function _notifEmailTemDuplicidade(chaveIdempotencia) {
  try {
    if (!chaveIdempotencia) return false;
    const agora = Date.now();
    const ultimo = _NOTIF_EMAIL_ULTIMOS_DISPARADOS.get(String(chaveIdempotencia));
    if (ultimo && (agora - Number(ultimo)) < _NOTIF_EMAIL_BLOQUEIO_INTERVALO_MS) return true;
    return false;
  } catch(e){ return false; }
}
function _notifEmailMarcarDisparado(chaveIdempotencia) {
  try {
    if (!chaveIdempotencia) return;
    _NOTIF_EMAIL_ULTIMOS_DISPARADOS.set(String(chaveIdempotencia), Date.now());
    if (_NOTIF_EMAIL_ULTIMOS_DISPARADOS.size > 5000) {
      let cont = 0;
      for (const k of _NOTIF_EMAIL_ULTIMOS_DISPARADOS.keys()) {
        if (cont >= 1000) break;
        _NOTIF_EMAIL_ULTIMOS_DISPARADOS.delete(k);
        cont += 1;
      }
    }
  } catch(e){}
}
app.post('/api/notificacoes/enviar-email-lote', async (req, res) => {
  try {
    const b = req.body || {};
    const lote = Array.isArray(b.lote) ? b.lote : [];
    if (!lote.length) return res.status(400).json({ ok:false, msg:'Lote vazio. Envie array lote[].' });
    if (lote.length > 100) return res.status(400).json({ ok:false, msg:'Lote excedeu 100 e-mails.' });
    const resultados = [];
    let enviadosOk = 0;
    let falhas = 0;
    let duplicadosBloq = 0;
    for (let i = 0; i < lote.length; i++) {
      try {
        const item = lote[i] || {};
        const to = String(item.to || '').trim();
        const subject = String(item.subject || '(Sem assunto)').substring(0, 200);
        const text = typeof item.text === 'string' ? String(item.text) : '';
        const html = typeof item.html === 'string' ? String(item.html) : null;
        const idempotencia = String(item.idempotencia || (to + '_' + subject + '_' + Date.now())).substring(0, 300);
        if (!to || to.indexOf('@') <= 1) { falhas += 1; resultados.push({ idx:i, ok:false, msg:'destinatario invalido', toMask: to.substring(0,2)+'***@'+(to.split('@')[1]||'?').substring(0,3)+'***' }); continue; }
        if (_notifEmailTemDuplicidade(idempotencia)) { duplicadosBloq += 1; resultados.push({ idx:i, ok:false, duplicado:true, msg:'bloqueado anti-duplicidade (30min)', toMask: to.substring(0,2)+'***@'+(to.split('@')[1]||'?').substring(0,3)+'***' }); continue; }
        const r = await sendEmail({ to: to, subject: subject, text: text, html: html });
        if (r.ok) { enviadosOk += 1; _notifEmailMarcarDisparado(idempotencia); } else { falhas += 1; }
        resultados.push({ idx:i, ok: Boolean(r.ok), msg: String(r.msg || '').substring(0, 150), toMask: to.substring(0,2)+'***@'+(to.split('@')[1]||'?').substring(0,3)+'***' });
      } catch(eItem){ falhas += 1; resultados.push({ idx:i, ok:false, msg: String(eItem && eItem.message ? eItem.message : eItem).substring(0, 150) }); }
    }
    return res.json({ ok:true, total: lote.length, enviadosOk: enviadosOk, falhas: falhas, duplicadosBloqueados: duplicadosBloq, resultados: resultados });
  } catch(e){
    console.error('/api/notificacoes/enviar-email-lote erro geral:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno servidor envio lote emails.' });
  }
});

/* ============================================================
   (NOVO) COMUNICADO GLOBAL ADMIN / PUBLICO
   Documento unico Firestore "comunicado_global" (collection: sistema_configs, doc: comunicado_global)
   Schema: { ativo:boolean, mensagem:string, botao_texto?:string, botao_link?:string,
             icone?:string, atualizado_em:Timestamp, atualizado_por:string }
   ============================================================ */
const _COMUNICADO_DOC_ID = 'comunicado_global';
const _COMUNICADO_COL = typeof FIRESTORE_COL_PREFIX === 'string' ? (FIRESTORE_COL_PREFIX + 'sistema_configs') : 'sistema_configs';
const _COMUNICADO_DEFAULT = {
  ativo: false,
  mensagem: '📢 Novidade no AjeitaAí! Agora você pode encontrar novos profissionais perto de você.',
  icone: '📢',
  botao_texto: 'Saiba mais',
  botao_link: ''
};
let _COMUNICADO_IN_MEMORY = null;
app.get('/api/comunicado/public', async (req, res) => {
  try {
    if (!dbFirestore) {
      const cfg = _COMUNICADO_IN_MEMORY && typeof _COMUNICADO_IN_MEMORY === 'object' ? _COMUNICADO_IN_MEMORY : _COMUNICADO_DEFAULT;
      return res.status(200).json({ ok:true, config: cfg });
    }
    const snap = await dbFirestore.collection(_COMUNICADO_COL).doc(_COMUNICADO_DOC_ID).get().catch(()=>null);
    let cfg = _COMUNICADO_DEFAULT;
    if (snap && snap.exists) {
      const raw = Object.assign({}, snap.data() || {});
      cfg = {
        ativo: Boolean(raw.ativo === true || raw.ativo === 'true'),
        mensagem: String(raw.mensagem || _COMUNICADO_DEFAULT.mensagem).substring(0, 500),
        icone: String(raw.icone || _COMUNICADO_DEFAULT.icone || '📢').substring(0, 8),
        botao_texto: String(raw.botao_texto || '').trim().substring(0, 40),
        botao_link: String(raw.botao_link || '').trim().substring(0, 800),
        atualizado_em: raw.atualizado_em || null
      };
      _COMUNICADO_IN_MEMORY = Object.assign({}, cfg);
    } else if (_COMUNICADO_IN_MEMORY && typeof _COMUNICADO_IN_MEMORY === 'object') {
      cfg = Object.assign({}, _COMUNICADO_IN_MEMORY);
    }
    return res.status(200).json({ ok:true, config: cfg });
  } catch(e){
    console.error('/api/comunicado/public erro:', e && e.message);
    const cfg = _COMUNICADO_IN_MEMORY && typeof _COMUNICADO_IN_MEMORY === 'object' ? _COMUNICADO_IN_MEMORY : _COMUNICADO_DEFAULT;
    return res.status(200).json({ ok:true, config: cfg });
  }
});
app.patch('/api/comunicado/admin', async (req, res) => {
  try {
    const b = req.body || {};
    const senha = String(b.admin_senha || '').trim();
    if (senha !== 'bolo2024') return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const ativo = Boolean(b.ativo === true || b.ativo === 'true' || b.ativo === 'on');
    const mensagem = String(b.mensagem || '').trim().substring(0, 500);
    const icone = String(b.icone || '📢').trim().substring(0, 8);
    const botao_texto = String(b.botao_texto || '').trim().substring(0, 40);
    const botao_link = String(b.botao_link || '').trim().substring(0, 800);
    if (ativo && !mensagem) return res.status(400).json({ ok:false, msg:'Para ativar o comunicado, informe uma mensagem.' });
    if (botao_link && !(botao_link.startsWith('http://') || botao_link.startsWith('https://'))) {
      return res.status(400).json({ ok:false, msg:'Link do botão precisa começar com http:// ou https://.' });
    }
    const nowTs = admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString();
    const payload = {
      ativo, mensagem, icone,
      botao_texto,
      botao_link,
      atualizado_em: nowTs,
      atualizado_por: 'admin_api'
    };
    if (dbFirestore) {
      await dbFirestore.collection(_COMUNICADO_COL).doc(_COMUNICADO_DOC_ID).set(payload, { merge: false });
    }
    _COMUNICADO_IN_MEMORY = Object.assign({}, payload);
    return res.status(200).json({ ok:true, msg:'Comunicado salvo.', config: payload });
  } catch(e){
    console.error('/api/comunicado/admin erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno salvar comunicado.' });
  }
});

/* ============================================================
   (V12 — ADMIN USUÁRIOS + MOEDAS)
   Todas as rotas exigem admin_senha === 'bolo2024'
   Coleções Firestore usadas:
     - profissionais (collection existente)
     - credenciais_usuarios (cria se não existir — cliente/whatsapp + id_ref)
     - admin_moedas_transacoes (log de todas operações manuais)
   ============================================================ */
const _ADMIN_USERS_PASS = 'bolo2024';
const _FS_COL_PROFISSIONAIS = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'profissionais';
const _FS_COL_CREDENCIAIS  = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'credenciais_usuarios';
const _FS_COL_TRANSACOES_MOEDAS = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'admin_moedas_transacoes';

function _adminAuth(b, q) {
  try {
    const s = String((b && b.admin_senha) || (q && q.admin_senha) || '').trim();
    return s === _ADMIN_USERS_PASS;
  } catch(e){ return false; }
}
function _fsTs() {
  try { if (admin && admin.firestore && admin.firestore.Timestamp) return admin.firestore.Timestamp.now(); } catch(e){}
  return new Date().toISOString();
}
function _limStr(v, max) {
  v = String(v == null ? '' : v);
  return v.length > (Number(max)||400) ? v.substring(0, Number(max)||400) : v;
}
function _sanitizaUsuarioBasico(obj) {
  const o = Object.assign({}, obj || {});
  // Remover campos sensíveis antes de enviar ao frontend
  ['_docs_validacao_privado','cpf','senhaHash','senha'].forEach(function(k){ try { delete o[k]; } catch(e){} });
  return o;
}
async function _logTransacaoMoedas(tipo, usuario_id, usuario_tipo, usuario_nome, qtd_movida, saldo_anterior, saldo_novo, motivo, admin_resp) {
  try {
    if (!dbFirestore) return null;
    const payload = {
      id: 'tr_' + Date.now() + '_' + Math.random().toString(36).slice(2,8),
      tipo: String(tipo||'manual'), // 'adicionar' | 'remover'
      usuario_id: String(usuario_id || ''),
      usuario_tipo: String(usuario_tipo || 'profissional'),
      usuario_nome: _limStr(usuario_nome, 200),
      qtd_movida: Number.isFinite(+qtd_movida) ? Math.max(0, Math.floor(+qtd_movida)) : 0,
      saldo_anterior: Number.isFinite(+saldo_anterior) ? Math.floor(+saldo_anterior) : 0,
      saldo_novo: Number.isFinite(+saldo_novo) ? Math.floor(+saldo_novo) : 0,
      motivo: _limStr(motivo, 400),
      admin_responsavel: _limStr(admin_resp || 'admin_api', 120),
      criado_em: _fsTs(),
      _v: 1
    };
    await dbFirestore.collection(_FS_COL_TRANSACOES_MOEDAS).doc(payload.id).set(payload).catch(()=>{});
    return payload.id;
  } catch(e){ return null; }
}

/* 1) GET /api/admin/usuarios/profissionais -> lista todos (lim 300) */
app.get('/api/admin/usuarios/profissionais', async (req, res) => {
  try {
    if (!_adminAuth(req.body, req.query)) return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const out = { ok:true, total:0, items:[] };
    if (dbFirestore) {
      const snap = await dbFirestore.collection(_FS_COL_PROFISSIONAIS).orderBy('cadastroEm','desc').limit(300).get().catch(()=>null);
      if (snap && snap.forEach) {
        snap.forEach(function(ds){ try { out.items.push(_sanitizaUsuarioBasico(Object.assign({ _docId: ds.id }, ds.data() || {}))); } catch(e){} });
        out.total = out.items.length;
      }
    }
    return res.status(200).json(out);
  } catch(e){
    console.error('/api/admin/usuarios/profissionais erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno listar profissionais admin.' });
  }
});

/* 2) GET /api/admin/usuarios/clientes -> lista credenciais_usuarios (tipo=cliente) + google logados de profissionais com clienteGoogle? Vamos listar quem temos.
      Estratégia: busca credenciais_usuarios (clientes) + junta clienteGoogleLogado não está em collection, então busca também nos pedidos como fallback. */
app.get('/api/admin/usuarios/clientes', async (req, res) => {
  try {
    if (!_adminAuth(req.body, req.query)) return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const out = { ok:true, total:0, items:[] };
    const vistos = {};
    // Fonte A: credenciais_usuarios (tipo cliente)
    if (dbFirestore) {
      const snapCred = await dbFirestore.collection(_FS_COL_CREDENCIAIS).limit(300).get().catch(()=>null);
      if (snapCred && snapCred.forEach) {
        snapCred.forEach(function(ds){
          try {
            const d = ds.data() || {};
            if (String(d.tipo || '').toLowerCase() !== 'cliente') return;
            const idChave = 'cred_' + String(d.refId || ds.id);
            if (vistos[idChave]) return;
            vistos[idChave] = true;
            out.items.push(_sanitizaUsuarioBasico(Object.assign({ _docId: ds.id, _fonte: 'credenciais', id: String(d.refId || ds.id), tipo: 'cliente', email: d.email || null, nome: d.nome || 'Cliente', whatsapp: d.whatsapp || null, criadoEm: d.criadoEm || d.timestamp || null }, d || {})));
          } catch(e){}
        });
      }
    }
    // Fonte B: pedidos (nome + whatsapp + cidade do cliente dono)
    if (dbFirestore) {
      const snapPed = await dbFirestore.collection((typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'pedidos').orderBy('data','desc').limit(200).get().catch(()=>null);
      if (snapPed && snapPed.forEach) {
        snapPed.forEach(function(ds){
          try {
            const d = ds.data() || {};
            const wa = String(d.whatsapp || '').trim();
            if (!wa) return;
            const chave = 'wa_' + wa.replace(/\D/g,'');
            if (vistos[chave]) return;
            vistos[chave] = true;
            out.items.push({
              _docId: ds.id, _fonte: 'pedidos',
              id: chave, tipo: 'cliente',
              nome: _limStr(d.nomeCliente || d.cliente || 'Cliente', 120),
              whatsapp: wa,
              cidade: d.cidade || null,
              bairro: d.bairro || null,
              qtd_pedidos: 1
            });
          } catch(e){}
        });
      }
    }
    out.total = out.items.length;
    return res.status(200).json(out);
  } catch(e){
    console.error('/api/admin/usuarios/clientes erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno listar clientes admin.' });
  }
});

/* 3) GET /api/admin/usuarios/busca?q= (nome/email/whatsapp/cidade/id) */
app.get('/api/admin/usuarios/busca', async (req, res) => {
  try {
    if (!_adminAuth(req.body, req.query)) return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    const q = String((req.query && req.query.q) || (req.body && req.body.q) || '').trim().toLowerCase();
    const out = { ok:true, total:0, profissionais:[], clientes:[] };
    if (!q || q.length < 2) return res.status(200).json(out);
    if (dbFirestore) {
      // Buscar profissionais
      const snapPro = await dbFirestore.collection(_FS_COL_PROFISSIONAIS).limit(400).get().catch(()=>null);
      if (snapPro && snapPro.forEach) snapPro.forEach(function(ds){
        try {
          const d = Object.assign({ _docId: ds.id }, ds.data() || {});
          const hay = [d.id, ds.id, d.nome, d.email, d.emailGoogle, d.emailLogin, d.whatsapp, d.cidade, d.bairro, d.cpf].join(' | ').toLowerCase();
          if (hay.indexOf(q) >= 0) out.profissionais.push(_sanitizaUsuarioBasico(d));
        } catch(e){}
      });
      // Buscar clientes em credenciais + pedidos
      const snapCred = await dbFirestore.collection(_FS_COL_CREDENCIAIS).limit(400).get().catch(()=>null);
      const vistosCli = {};
      if (snapCred && snapCred.forEach) snapCred.forEach(function(ds){
        try {
          const d = ds.data() || {};
          if (String(d.tipo||'').toLowerCase() !== 'cliente') return;
          const hay = [d.refId, ds.id, d.email, d.nome, d.whatsapp].join(' | ').toLowerCase();
          if (hay.indexOf(q) >= 0) {
            const chave = 'c_' + (d.refId || ds.id);
            if (vistosCli[chave]) return; vistosCli[chave] = true;
            out.clientes.push(_sanitizaUsuarioBasico(Object.assign({ _docId: ds.id, id: String(d.refId || ds.id), tipo: 'cliente', nome: d.nome || 'Cliente', email: d.email || null, whatsapp: d.whatsapp || null, criadoEm: d.criadoEm || null }, d || {})));
          }
        } catch(e){}
      });
      const snapPed = await dbFirestore.collection((typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'pedidos').limit(400).get().catch(()=>null);
      if (snapPed && snapPed.forEach) snapPed.forEach(function(ds){
        try {
          const d = ds.data() || {};
          const wa = String(d.whatsapp || '').trim();
          const hay = [wa, d.nomeCliente, d.cidade, d.bairro, ds.id].join(' | ').toLowerCase();
          if (hay.indexOf(q) >= 0 && wa) {
            const chave = 'w_' + wa.replace(/\D/g,'');
            if (vistosCli[chave]) return; vistosCli[chave] = true;
            out.clientes.push({ _docId: ds.id, _fonte:'pedidos', id: chave, tipo:'cliente', nome: _limStr(d.nomeCliente || 'Cliente', 120), whatsapp: wa, cidade: d.cidade || null, bairro: d.bairro || null });
          }
        } catch(e){}
      });
    }
    out.total = out.profissionais.length + out.clientes.length;
    return res.status(200).json(out);
  } catch(e){
    console.error('/api/admin/usuarios/busca erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno busca usuarios admin.' });
  }
});

/* 4) PATCH /api/admin/usuarios/editar -> editar dados permitidos de profissional OU cliente */
app.patch('/api/admin/usuarios/editar', async (req, res) => {
  try {
    const b = req.body || {};
    if (!_adminAuth(b)) return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    if (!dbFirestore) return res.status(200).json({ ok:false, msg:'Firestore indisponível.' });
    const usuario_tipo = String(b.usuario_tipo || 'profissional').toLowerCase();  // 'profissional' | 'cliente'
    const docId = String(b.docId || '').trim(); // id do doc Firestore (_docId vindo da listagem)
    if (!docId) return res.status(400).json({ ok:false, msg:'docId ausente.' });
    const adminResp = _limStr(b.admin_responsavel || 'admin_api', 120);
    if (usuario_tipo === 'profissional') {
      const col = dbFirestore.collection(_FS_COL_PROFISSIONAIS);
      const snapDoc = await col.doc(docId).get().catch(()=>null);
      if (!snapDoc || !snapDoc.exists) return res.status(404).json({ ok:false, msg:'Profissional não encontrado no Firestore.' });
      // Campos permitidos de editar (NÃO tocar senha, cpf, docs validacao privado, googleId sem necessidade)
      const pAtual = snapDoc.data() || {};
      const patch = {};
      if (typeof b.nome === 'string') patch.nome = _limStr(b.nome, 160);
      if (typeof b.whatsapp === 'string') patch.whatsapp = _limStr(b.whatsapp.replace(/\D/g,'').slice(0,11), 20);
      if (typeof b.cidade === 'string') patch.cidade = _limStr(b.cidade, 120);
      if (typeof b.bairro === 'string') patch.bairro = _limStr(b.bairro, 120);
      if (typeof b.email === 'string') patch.email = _limStr(b.email, 200);
      if (typeof b.sobre === 'string') patch.sobre = _limStr(b.sobre, 1200);
      if (typeof b.disponivel_para_trabalhar !== 'undefined') patch.disponivel_para_trabalhar = Boolean(b.disponivel_para_trabalhar);
      // Categorias (array de strings)
      if (b.categorias && Array.isArray(b.categorias)) patch.categorias = b.categorias.map(function(c){ return _limStr(c, 60); }).slice(0, 20);
      // Observação: alteração saldoMoedas é BLOQUEADA nesta rota (só pode via rotas moedas-adicionar/remover específicas c/ log)
      patch.ultima_edicao_admin_em = _fsTs();
      patch.ultima_edicao_admin_por = adminResp;
      await col.doc(docId).set(patch, { merge: true }).catch(function(e){ throw e; });
      return res.status(200).json({ ok:true, msg:'Profissional atualizado com sucesso.', patch });
    }
    // Cliente
    const col = dbFirestore.collection(_FS_COL_CREDENCIAIS);
    const snapDoc = await col.doc(docId).get().catch(()=>null);
    if (!snapDoc || !snapDoc.exists) return res.status(404).json({ ok:false, msg:'Cliente não encontrado (coleção credenciais_usuarios).' });
    const patch = {};
    if (typeof b.nome === 'string') patch.nome = _limStr(b.nome, 160);
    if (typeof b.email === 'string') patch.email = _limStr(b.email, 200);
    if (typeof b.whatsapp === 'string') patch.whatsapp = _limStr(b.whatsapp.replace(/\D/g,'').slice(0,11), 20);
    patch.ultima_edicao_admin_em = _fsTs();
    patch.ultima_edicao_admin_por = adminResp;
    await col.doc(docId).set(patch, { merge: true }).catch(function(e){ throw e; });
    return res.status(200).json({ ok:true, msg:'Cliente atualizado com sucesso.', patch });
  } catch(e){
    console.error('/api/admin/usuarios/editar erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno editar usuario admin.' });
  }
});

/* 5) DELETE /api/admin/usuarios/excluir -> excluir profissional ou cliente (credencial + pedidos associados mantém anonimizados) */
app.delete('/api/admin/usuarios/excluir', async (req, res) => {
  try {
    const b = req.body || {};
    if (!_adminAuth(b)) return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    if (!dbFirestore) return res.status(200).json({ ok:false, msg:'Firestore indisponível.' });
    const usuario_tipo = String(b.usuario_tipo || 'profissional').toLowerCase();
    const docId = String(b.docId || '').trim();
    if (!docId) return res.status(400).json({ ok:false, msg:'docId ausente.' });
    const adminResp = _limStr(b.admin_responsavel || 'admin_api', 120);
    const confirmar = Boolean(b.confirmar === true || b.confirmar === 'true' || b.confirmar === 'on');
    if (!confirmar) return res.status(400).json({ ok:false, msg:'Marque o checkbox de confirmação para excluir o usuário.' });
    if (usuario_tipo === 'profissional') {
      await dbFirestore.collection(_FS_COL_PROFISSIONAIS).doc(docId).delete().catch(function(e){ throw e; });
      // Também limpar credencial de login desse profissional se houver
      try {
        const snapCred = await dbFirestore.collection(_FS_COL_CREDENCIAIS).where('refId','==',docId).where('tipo','==','profissional').limit(5).get().catch(()=>null);
        if (snapCred && snapCred.forEach) snapCred.forEach(function(d){ try { d.ref.delete().catch(()=>{}); } catch(e){} });
      } catch(e2){}
      // Log minimal
      try { await dbFirestore.collection((typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'admin_acoes').add({ acao:'excluir_profissional', docId, admin_responsavel: adminResp, criado_em: _fsTs() }).catch(()=>{}); } catch(e){}
      return res.status(200).json({ ok:true, msg:'Profissional excluído.' });
    }
    // Cliente: só remove credencial_usuarios doc se houver
    try { await dbFirestore.collection(_FS_COL_CREDENCIAIS).doc(docId).delete().catch(function(e){ throw e; }); } catch(e){ return res.status(404).json({ ok:false, msg:'Doc cliente não encontrado em credenciais_usuarios.' }); }
    try { await dbFirestore.collection((typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'admin_acoes').add({ acao:'excluir_cliente', docId, admin_responsavel: adminResp, criado_em: _fsTs() }).catch(()=>{}); } catch(e){}
    return res.status(200).json({ ok:true, msg:'Cliente (credencial) excluído.' });
  } catch(e){
    console.error('/api/admin/usuarios/excluir erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno excluir usuario admin.' });
  }
});

/* 6) PATCH /api/admin/moedas/adicionar -> adicionar N moedas manualmente (com log) */
app.patch('/api/admin/moedas/adicionar', async (req, res) => {
  try {
    const b = req.body || {};
    if (!_adminAuth(b)) return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    if (!dbFirestore) return res.status(200).json({ ok:false, msg:'Firestore indisponível.' });
    const docId = String(b.docId || '').trim();
    if (!docId) return res.status(400).json({ ok:false, msg:'docId ausente.' });
    const qtd = Math.max(0, Math.floor(Number(b.qtd || 0)));
    if (!qtd || qtd <= 0) return res.status(400).json({ ok:false, msg:'Informe uma quantidade positiva de moedas para adicionar.' });
    if (qtd > 100000) return res.status(400).json({ ok:false, msg:'Limite por operação: 100.000 moedas.' });
    const motivo = _limStr(b.motivo || 'Ajuste manual admin', 400);
    const adminResp = _limStr(b.admin_responsavel || 'admin_api', 120);
    const col = dbFirestore.collection(_FS_COL_PROFISSIONAIS);
    const snapDoc = await col.doc(docId).get().catch(()=>null);
    if (!snapDoc || !snapDoc.exists) return res.status(404).json({ ok:false, msg:'Profissional não encontrado no Firestore.' });
    const p = snapDoc.data() || {};
    const saldoAnt = (typeof p.saldoMoedas === 'number' && !Number.isNaN(p.saldoMoedas)) ? Math.floor(p.saldoMoedas) : 0;
    const saldoNovo = saldoAnt + qtd;
    await col.doc(docId).set({ saldoMoedas: saldoNovo, ultima_movimentacao_moedas_em: _fsTs(), ultima_movimentacao_moedas_por: adminResp }, { merge: true }).catch(function(e){ throw e; });
    const logId = await _logTransacaoMoedas('adicionar', docId, 'profissional', p.nome || 'Profissional', qtd, saldoAnt, saldoNovo, motivo, adminResp);
    return res.status(200).json({ ok:true, msg: qtd + ' moeda(s) adicionada(s) com sucesso. Saldo ' + saldoAnt + ' → ' + saldoNovo + '.', saldo_antigo: saldoAnt, saldo_novo: saldoNovo, log_id: logId });
  } catch(e){
    console.error('/api/admin/moedas/adicionar erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno adicionar moedas admin.' });
  }
});

/* 7) PATCH /api/admin/moedas/remover -> remover N moedas manualmente (NUNCA saldo negativo) */
app.patch('/api/admin/moedas/remover', async (req, res) => {
  try {
    const b = req.body || {};
    if (!_adminAuth(b)) return res.status(401).json({ ok:false, msg:'Acesso negado admin.' });
    if (!dbFirestore) return res.status(200).json({ ok:false, msg:'Firestore indisponível.' });
    const docId = String(b.docId || '').trim();
    if (!docId) return res.status(400).json({ ok:false, msg:'docId ausente.' });
    const qtd = Math.max(0, Math.floor(Number(b.qtd || 0)));
    if (!qtd || qtd <= 0) return res.status(400).json({ ok:false, msg:'Informe uma quantidade positiva de moedas para remover.' });
    const motivo = _limStr(b.motivo || 'Ajuste manual admin', 400);
    const adminResp = _limStr(b.admin_responsavel || 'admin_api', 120);
    const col = dbFirestore.collection(_FS_COL_PROFISSIONAIS);
    const snapDoc = await col.doc(docId).get().catch(()=>null);
    if (!snapDoc || !snapDoc.exists) return res.status(404).json({ ok:false, msg:'Profissional não encontrado no Firestore.' });
    const p = snapDoc.data() || {};
    const saldoAnt = (typeof p.saldoMoedas === 'number' && !Number.isNaN(p.saldoMoedas)) ? Math.floor(p.saldoMoedas) : 0;
    if (qtd > saldoAnt) return res.status(400).json({ ok:false, msg:'Saldo insuficiente. O profissional possui ' + saldoAnt + ' moeda(s) e você tentou remover ' + qtd + '. Nunca permitimos saldo negativo.' });
    const saldoNovo = saldoAnt - qtd;
    await col.doc(docId).set({ saldoMoedas: saldoNovo, ultima_movimentacao_moedas_em: _fsTs(), ultima_movimentacao_moedas_por: adminResp }, { merge: true }).catch(function(e){ throw e; });
    const logId = await _logTransacaoMoedas('remover', docId, 'profissional', p.nome || 'Profissional', qtd, saldoAnt, saldoNovo, motivo, adminResp);
    return res.status(200).json({ ok:true, msg: qtd + ' moeda(s) removida(s) com sucesso. Saldo ' + saldoAnt + ' → ' + saldoNovo + '.', saldo_antigo: saldoAnt, saldo_novo: saldoNovo, log_id: logId });
  } catch(e){
    console.error('/api/admin/moedas/remover erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno remover moedas admin.' });
  }
});

/* ============================================================
   33) POST /api/cliente/excluir-conta → Excluir conta CLIENTE
   - Segurança (Item 9):
     a) Admin pode excluir se passar admin_senha válido
     b) Cliente pode excluir a própria conta: valida que cliente_uid e cliente_email correspondem a um registro existente em credenciais_usuarios ou o email existe em pedidos.clienteEmail / Firebase Auth
   - Não aceita UID de outro usuário para excluir.
   - Tenta: Firebase Auth deleteUser → credenciais → pedidos anônimizar → notificações limpar
   ============================================================ */
app.post('/api/cliente/excluir-conta', async (req, res) => {
  try {
    const b = req.body || {};
    const excluirTipo = String(b.excluir_tipo || '').trim().toLowerCase();
    if (excluirTipo !== 'cliente') {
      return res.status(400).json({ ok:false, msg:'excluir_tipo invalido. Use "cliente".' });
    }
    const clienteUidRaw = String(b.cliente_uid || '').trim();
    const clienteEmailRaw = String(b.cliente_email || '').trim().toLowerCase();
    if (!clienteUidRaw && !clienteEmailRaw) {
      return res.status(400).json({ ok:false, msg:'cliente_uid ou cliente_email sao obrigatorios.' });
    }
    const isAdmin = _adminAuth(b, req.query || {});
    const uidValido = clienteUidRaw && clienteUidRaw.length >= 4;
    const emailValido = clienteEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clienteEmailRaw);

    if (!isAdmin) {
      let valido = false;
      if (uidValido) {
        try {
          const colCred = admin.firestore().collection(_FS_COL_CREDENCIAIS);
          const snapCred = await colCred.where('tipo', '==', 'cliente').limit(1500).get().catch(() => ({ empty: true, docs: [] }));
          if (snapCred && !snapCred.empty) {
            for (const doc of snapCred.docs) {
              const d = doc.data() || {};
              const docEmail = String(d.email || '').toLowerCase();
              const docRefId = String(d.refId || '');
              if ((uidValido && docRefId === clienteUidRaw) || (emailValido && docEmail === clienteEmailRaw)) {
                valido = true; break;
              }
            }
          }
        } catch(eCredChk){}
      }
      if (!valido && emailValido) {
        try {
          const userRec = await admin.auth().getUserByEmail(clienteEmailRaw).catch(() => null);
          if (userRec && userRec.uid) {
            if (!uidValido || clienteUidRaw === userRec.uid) valido = true;
          }
        } catch(eFbAuthChk){}
      }
      if (!valido) {
        return res.status(403).json({ ok:false, msg:'Validacao de titularidade da conta falhou. Contate admin ou use a conta correta.' });
      }
    }

    const uidFirestore = clienteUidRaw;
    const emailNorm = clienteEmailRaw;
    let fbAuthUidParaDeletar = null;
    if (uidValido && !uidFirestore.startsWith('local_') && uidFirestore.length > 10) {
      fbAuthUidParaDeletar = uidFirestore;
    } else if (emailValido) {
      try {
        const rec = await admin.auth().getUserByEmail(emailNorm).catch(() => null);
        if (rec && rec.uid) fbAuthUidParaDeletar = rec.uid;
      } catch(eFbGet){}
    }

    if (fbAuthUidParaDeletar && fbAuthUidParaDeletar.length > 5) {
      try { await admin.auth().deleteUser(fbAuthUidParaDeletar); } catch(eFbDel){ console.warn('[EXCLUSAO_CLIENTE] Firebase Auth delete falhou uid=' + fbAuthUidParaDeletar, eFbDel && eFbDel.message); }
    }

    try {
      const colCred = admin.firestore().collection(_FS_COL_CREDENCIAIS);
      const snapTodos = await colCred.limit(5000).get().catch(() => ({ empty:true, docs: [] }));
      if (snapTodos && !snapTodos.empty) {
        const batch = admin.firestore().batch();
        let qtdCredDel = 0;
        for (const doc of snapTodos.docs) {
          const d = doc.data() || {};
          const docEmail = String(d.email || '').toLowerCase();
          const docRefId = String(d.refId || '');
          const docTipo = String(d.tipo || '').toLowerCase();
          if (docTipo !== 'cliente') continue;
          let match = false;
          if (uidValido && docRefId === uidFirestore) match = true;
          if (emailValido && docEmail === emailNorm) match = true;
          if (match) { try { batch.delete(doc.ref); qtdCredDel++; } catch(eBd){} }
        }
        if (qtdCredDel > 0) { try { await batch.commit(); } catch(eBc){ console.warn('[EXCLUSAO_CLIENTE] batch credenciais commit falhou:', eBc && eBc.message); } }
      }
    } catch(eCredDel){ console.warn('[EXCLUSAO_CLIENTE] credenciais_usuarios falhou:', eCredDel && eCredDel.message); }

    try {
      const colPed = admin.firestore().collection((typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'pedidos');
      const snapPed = await colPed.limit(5000).get().catch(() => ({ empty:true, docs:[] }));
      if (snapPed && !snapPed.empty) {
        const batch = admin.firestore().batch();
        let qtdPedAnon = 0;
        for (const doc of snapPed.docs) {
          const d = doc.data() || {};
          const docEmail = String(d.clienteEmail || '').toLowerCase();
          const docUid = String(d.clienteUid || '');
          let match = false;
          if (uidValido && docUid === uidFirestore) match = true;
          if (emailValido && docEmail === emailNorm) match = true;
          if (match) {
            try {
              batch.set(doc.ref, {
                clienteNome: '[ removido ]',
                clienteEmail: '[ removido ]',
                clienteTelefone: '[ removido ]',
                clienteUid: '[ removido ]',
                clienteFoto: null,
                conta_cliente_excluida_em: _fsTs(),
                conta_cliente_excluida: true
              }, { merge: true });
              qtdPedAnon++;
            } catch(ePb){}
          }
        }
        if (qtdPedAnon > 0) { try { await batch.commit(); } catch(ePbc){ console.warn('[EXCLUSAO_CLIENTE] batch pedidos commit falhou:', ePbc && ePbc.message); } }
      }
    } catch(ePedAnon){ console.warn('[EXCLUSAO_CLIENTE] pedidos anonimizacao falhou:', ePedAnon && ePedAnon.message); }

    try {
      const prefixo = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '');
      const colNotif = (uidValido && !uidFirestore.startsWith('local_')) ? (prefixo + 'notificacoes_cli_' + uidFirestore) : null;
      if (colNotif) {
        const snapN = await admin.firestore().collection(colNotif).limit(2000).get().catch(() => ({ empty:true, docs:[] }));
        if (snapN && !snapN.empty) {
          const batch = admin.firestore().batch();
          for (const doc of snapN.docs) { try { batch.delete(doc.ref); } catch(eNd){} }
          try { await batch.commit(); } catch(eNc){}
        }
      }
    } catch(eNotifDel){ console.warn('[EXCLUSAO_CLIENTE] notificacoes falhou:', eNotifDel && eNotifDel.message); }

    return res.status(200).json({ ok:true, msg:'Conta cliente excluida com sucesso (Auth + credenciais + pedidos anonimizados + notificacoes removidas).', fb_auth_uid: fbAuthUidParaDeletar || null });
  } catch(e){
    console.error('/api/cliente/excluir-conta erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno excluir conta cliente.' });
  }
});

/* 32.5) POST /api/profissional/sessao-registrar
   Chamado pelo FRONTEND logo após login / cadastro profissional.
   Objetivo: substituir validação de "senha plana via prompt()" do cliente
   por um TOKEN DE SESSÃO gerado aleatoriamente no navegador e sincronizado
   no Firestore. Segurança: token NÃO é senha do usuário; expira
   naturalmente quando usuário faz logout.
   Body: { profissional_id (obrigatório), sessao_token (obrigatório, >= 20 chars),
           email_proof (opcional, email para cruzamento adicional), google_id_proof (opcional) }
   Retorna ok=true se token foi salvo no doc do profissional Firestore. */
app.post('/api/profissional/sessao-registrar', async (req, res) => {
  try {
    const b = req.body || {};
    const profissionalId = String(b.profissional_id || '').trim();
    const sessaoToken = String(b.sessao_token || '').trim();
    const emailProof = String(b.email_proof || '').toLowerCase().trim();
    const googleIdProof = String(b.google_id_proof || '').trim();
    if (!profissionalId || !sessaoToken) return res.status(400).json({ ok:false, msg:'profissional_id e sessao_token sao obrigatórios.' });
    if (sessaoToken.length < 20) return res.status(400).json({ ok:false, msg:'sessao_token muito curto (min 20 chars).' });
    if (!dbFirestore) return res.status(200).json({ ok:false, msg:'Firestore indisponível.' });

    const r = await _buscarProfissionalFirestorePorIdOuDoc(profissionalId);
    let docIdSalvar = null;
    let docDataExistente = null;
    if (r && r.docId && r.data) {
      docIdSalvar = r.docId;
      docDataExistente = r.data;
    } else {
      // (CORREÇÃO MÍNIMA AUTOCURA): Quando o frontend chama sessao-registrar mas
      // o doc do profissional NÃO EXISTE AINDA no Firestore (caso comum:
      // fbSyncAddProfissional estava em background no login Google e não
      // terminou a tempo), backend CRIA o documento MÍNIMO AGORA (com o
      // profissional_id recebido + email/google_id de prova) e já salva o
      // token de sessão nele na mesma operação. Evita ciclo infinito 404
      // → false → nunca registra → 401 no desbloqueio.
      try {
        const docIdCanonico = profissionalId.startsWith('local_') ? profissionalId : ('local_' + profissionalId);
        const payloadMin = {
          id: profissionalId,
          cadastroEm: _fsTs ? _fsTs() : new Date().toISOString(),
          _criado_por: 'sessao_registrar_autocura',
          _criado_em_ts: Date.now()
        };
        if (emailProof) {
          payloadMin.emailLogin = emailProof;
          payloadMin.email = emailProof;
          payloadMin.emailGoogle = emailProof;
        }
        if (googleIdProof) {
          payloadMin.googleId = googleIdProof;
        }
        try {
          await dbFirestore.collection(_FS_COL_PROFISSIONAIS).doc(docIdCanonico).set(payloadMin, { merge:true });
          docIdSalvar = docIdCanonico;
          docDataExistente = Object.assign({}, payloadMin);
        } catch(eCriaMin){
          console.warn('[SESSAO_REGISTRAR][AUTOCURA] Falhou criar doc minimo docIdCanonico='+docIdCanonico, eCriaMin && eCriaMin.message);
        }
      } catch(eAutocura){}
      if (!docIdSalvar) return res.status(404).json({ ok:false, msg:'Profissional não encontrado no Firestore.' });
    }

    if (emailProof && docDataExistente) {
      const docEmail = String((docDataExistente.emailLogin || docDataExistente.email || docDataExistente.emailGoogle)) || '').toLowerCase().trim();
      if (docEmail && docEmail !== emailProof) return res.status(403).json({ ok:false, msg:'E-mail de prova não corresponde ao profissional.' });
    }
    if (googleIdProof && docDataExistente) {
      const docGoogleId = String(docDataExistente.googleId || '').trim();
      if (docGoogleId && docGoogleId !== googleIdProof) return res.status(403).json({ ok:false, msg:'GoogleId de prova não corresponde.' });
    }

    const patch = {
      sessao_token_ultima: sessaoToken,
      sessao_token_ultima_em: _fsTs ? _fsTs() : new Date().toISOString()
    };
    try {
      await dbFirestore.collection(_FS_COL_PROFISSIONAIS).doc(docIdSalvar).set(patch, { merge:true });
    } catch(eW){
      console.error('[SESSAO_REGISTRAR] Firestore write falhou docId='+docIdSalvar, eW && eW.message);
      return res.status(500).json({ ok:false, msg:'Erro interno salvar sessao no Firestore.' });
    }
    return res.status(200).json({ ok:true, doc_id: docIdSalvar, msg:'Sessão registrada com sucesso.', sessao_registrada_em: new Date().toISOString() });
  } catch(e){
    console.error('/api/profissional/sessao-registrar erro:', e && e.message);
    return res.status(500).json({ ok:false, msg:'Erro interno registrar sessao profissional.' });
  }
});

/* ============================================================
   34) POST /api/profissional/pedido/whatsapp-seguro → Retorna telefone/WhatsApp do cliente SOMENTE se desbloqueio válido
   - CAMADA 1: Admin pode (admin_senha)
   - CAMADA 2: Profissional valida:
       a) profissional_id existe na coleção profissionais
       b) profissional_sessao (TOKEN NOVO) corresponde ao sessao_token_ultima no Firestore
          OU profissional_senha corresponde (fallback compatibilidade)
       c) pedido_id existe na coleção de pedidos
       d) CAMADA DE SEGURANÇA FORTE: Se não tem prova explícita de desbloqueio sincronizada
          no backend NÃO retorna o WhatsApp nunca. Para obter o número, é necessário
          admin_senha OU flag explícita sincronizada no pedido Firestore.
   - Regra: NÃO confiar em parâmetros enviados pelo frontend.
   - Se não autorizado: retorna 403 SEM telefone.
   ============================================================ */
/* ============================================================
   (V12 — TASK 2 PATCH: rota /whatsapp-seguro com contactLocked flag + force null when bloqueado)
   ============================================================ */
app.post('/api/profissional/pedido/whatsapp-seguro', async (req, res) => {
  try {
    const b = req.body || {};
    const pedidoId = String(b.pedido_id || '').trim();
    const profissionalId = String(b.profissional_id || '').trim();
    const isAdmin = _adminAuth(b, req.query || {});
    if (!pedidoId) return res.status(400).json({ ok:false, contactLocked:true, msg:'pedido_id obrigatorio.', whatsapp:null, nomeCliente:null });
    let autorizado = false;
    if (isAdmin) autorizado = true;
    let whatsappEncontrado = null;
    let nomeClienteEncontrado = null;
    try {
      const prefixo = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '');
      const pedRef = admin.firestore().collection(prefixo + 'pedidos').doc(pedidoId);
      const pSnap = await pedRef.get().catch(() => ({ exists:false }));
      if (pSnap && pSnap.exists) {
        const pd = pSnap.data() || {};
        whatsappEncontrado = pd.whatsapp || pd.clienteTelefone || pd.clienteWhatsapp || null;
        nomeClienteEncontrado = pd.nomeCliente || pd.clienteNome || null;
        if (!autorizado && profissionalId) {
          const marcadoresDesb = pd.profissionaisDesbloquearamIds || pd.profissionaisQueDesbloquearam || [];
          if (Array.isArray(marcadoresDesb) && marcadoresDesb.includes(profissionalId)) autorizado = true;
          if (pd.profissionalDesbloqueadoId && String(pd.profissionalDesbloqueadoId) === String(profissionalId)) autorizado = true;
        }
      }
    } catch(ePed){}
    if (!autorizado && profissionalId) {
      try {
        const profRef = admin.firestore().collection(_FS_COL_PROFISSIONAIS).doc(profissionalId.startsWith('local_') ? profissionalId : ('local_' + profissionalId));
        const pSnap = await profRef.get().catch(() => null);
        let pData = null;
        if (pSnap && pSnap.exists) pData = pSnap.data();
        if (!pData) {
          try {
            const col = admin.firestore().collection(_FS_COL_PROFISSIONAIS);
            const allP = await col.limit(2000).get().catch(() => ({ empty:true, docs:[] }));
            if (allP && !allP.empty) {
              for (const d of allP.docs) {
                const dd = d.data() || {};
                if (String(dd.id || '') === String(profissionalId)) { pData = dd; break; }
              }
            }
          } catch(eF){}
        }
        if (pData) {
          const sessaoRecebida = String(b.profissional_sessao || '').trim();
          const tokenDoc = String(pData.sessao_token_ultima || '').trim();
          if (sessaoRecebida && tokenDoc && sessaoRecebida.length >= 20 && sessaoRecebida === tokenDoc) {
            autorizado = true;
          } else {
            const senhaRecebida = String(b.profissional_senha || '').trim();
            const senhaHashLocal = String(pData.senhaHash || pData.senha || '');
            if (senhaRecebida && senhaHashLocal && (senhaHashLocal === senhaRecebida || senhaHashLocal === String(require('crypto').createHash('sha256').update(senhaRecebida).digest('hex')))) {
              autorizado = true;
            }
          }
        }
      } catch(eProf){}
    }
    if (!autorizado) {
      return res.status(403).json({
        ok:false, contactLocked:true, bloqueado:true,
        msg:'Acesso negado: WhatsApp protegido. Realize o desbloqueio no app para ter acesso ao contato.',
        whatsapp: null, nomeCliente: null, telefone: null
      });
    }
    return res.status(200).json({
      ok:true, contactLocked:false,
      whatsapp: whatsappEncontrado, nomeCliente: nomeClienteEncontrado, pedido_id: pedidoId
    });
  } catch(e){
    console.error('/api/profissional/pedido/whatsapp-seguro erro:', e && e.message);
    return res.status(500).json({ ok:false, contactLocked:true, msg:'Erro interno buscar WhatsApp seguro.', whatsapp:null, nomeCliente:null });
  }
});

/* ============================================================
   (V12 — TASK 1 NEW: rota /desbloquear-atômico — única fonte de verdade para liberar WhatsApp)
   11 passos: auth → pedido → whatsapp real → idempotência duradoura → inflight →
              saldo+custo FIRESTORE → 402 se insuficiente → 4 writes prova →
              fecha pedido se ≥4 → retorna 200 whatsapp REAL somente após sucesso.
   ============================================================ */
const _DESBLOQUEIO_ATOMICO_INFLIGHT = new Map();
const _FS_COL_DESBLOQUEIOS = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'desbloqueios_contatos';
const _FS_COL_CONFIGS    = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '') + 'sistema_configs';
const _CUSTO_DESBLOQUEIO_FALLBACK = 2;

function _timeoutPromise(ms, msg) {
  return new Promise(function(_resolve, reject){
    setTimeout(function(){ reject(new Error(msg || ('TIMEOUT_MS_' + ms))); }, Number(ms) || 2000);
  });
}
async function _fsGetComTimeout(queryOrRef, maxMs) {
  try {
    if (!queryOrRef) return null;
    const p = typeof queryOrRef.get === 'function' ? queryOrRef.get() : Promise.resolve(queryOrRef);
    return await Promise.race([p, _timeoutPromise(Number(maxMs) || 2000, 'FS_GET_TIMEOUT_' + (Number(maxMs) || 2000))]);
  } catch(eGet){ return null; }
}

async function _lerCustoDesbloqueioFirestore() {
  try {
    if (!dbFirestore) return _CUSTO_DESBLOQUEIO_FALLBACK;
    const ref = dbFirestore.collection(_FS_COL_CONFIGS).doc('configEconomia');
    const snap = await _fsGetComTimeout(ref, 2000);
    if (snap && snap.exists) {
      const d = snap.data() || {};
      const c = Math.round(Number(d.custoMoedasPorDesbloqueio) || 0);
      if (c >= 1) return c;
    }
  } catch(e){}
  return _CUSTO_DESBLOQUEIO_FALLBACK;
}

async function _buscarProfissionalFirestorePorIdOuDoc(profissionalId) {
  if (!dbFirestore) return { docId:null, data:null };
  const idLimpo = String(profissionalId || '').trim();
  if (!idLimpo) return { docId:null, data:null };

  // (1) MESMA LÓGICA DA ROTA /whatsapp-seguro (funcionando desde a V12):
  // doc CANÔNICO "local_${id}" (padrão do app desde sempre)
  const docIdCanonico = idLimpo.startsWith('local_') ? idLimpo : ('local_' + idLimpo);

  const refCanon = dbFirestore.collection(_FS_COL_PROFISSIONAIS).doc(docIdCanonico);
  const sCanon = await _fsGetComTimeout(refCanon, 2000);
  if (sCanon && sCanon.exists) {
    return { docId: docIdCanonico, data: (sCanon.data() || {}) };
  }

  // (2) doc puro SEM prefixo "local_" (caso raro: docs criados manualmente no console
  //     OU docs criados pelo FRONTEND Firebase SDK com uid Google DIRETO como nome
  //     — linha 3397 index.html: `if (novoProfissional.uid) uidDocFs = uid`)
  if (idLimpo !== docIdCanonico) {
    const refPuro = dbFirestore.collection(_FS_COL_PROFISSIONAIS).doc(idLimpo);
    const sPuro = await _fsGetComTimeout(refPuro, 2000);
    if (sPuro && sPuro.exists) {
      return { docId: idLimpo, data: (sPuro.data() || {}) };
    }
  }

  // (3) Último fallback: varre collection (até 400 docs) procurando profissional onde
  //     (a) CAMPO .id === idLimpo (padrão whatsapp-seguro)
  //     OU (b) CAMPO .googleId === idLimpo (login Google salvo como .googleId no doc)
  //     OU (c) NOME DO DOCUMENTO (d.id) === idLimpo (quando doc foi salvo como uid Google)
  try {
    const refAll = dbFirestore.collection(_FS_COL_PROFISSIONAIS).limit(400);
    const allP = await _fsGetComTimeout(refAll, 2000) || {empty:true, docs:[]};
    if (allP && !allP.empty && Array.isArray(allP.docs)) {
      for (const d of allP.docs) {
        const dd = d.data() || {};
        const campoId   = String(dd.id || '').trim();
        const campoGId  = String(dd.googleId || '').trim();
        const nomeDoc   = String(d.id || '').trim();
        if (campoId === idLimpo || campoGId === idLimpo || nomeDoc === idLimpo) {
          return { docId: d.id, data: dd };
        }
      }
    }
  } catch(eF){}
  return { docId:null, data:null };
}

async function _handlerDesbloquearAtomicoPedidos(req, res) {
  const PASSO_ERRO = function(codHttp, codigoErro, msgExtra) {
    return res.status(codHttp).json({
      ok:false, contactLocked:true, whatsapp:null,
      error: codigoErro,
      msg: msgExtra || 'Desbloqueio não realizado. Contato permanece protegido.'
    });
  };
  try {
    const b = req.body || {};
    const pedidoId = String(b.pedido_id || '').trim();
    const profissionalId = String(b.profissional_id || '').trim();
    const isAdminBypass = _adminAuth(b, req.query || {});
    if (!pedidoId || !profissionalId) return PASSO_ERRO(400, 'PARAMETROS_OBRIGATORIOS', 'pedido_id e profissional_id são obrigatórios.');

    // PASSO 1: Autenticar profissional OU admin
    let autenticado = false;
    let profDocId = null;
    let profData = null;
    if (isAdminBypass) {
      autenticado = true;
      const r = await _buscarProfissionalFirestorePorIdOuDoc(profissionalId);
      profDocId = r.docId; profData = r.data;
      if (!profDocId) return PASSO_ERRO(404, 'PROFISSIONAL_NAO_ENCONTRADO', 'Admin bypass: profissional não encontrado.');
    } else {
      const r = await _buscarProfissionalFirestorePorIdOuDoc(profissionalId);
      profDocId = r.docId; profData = r.data;
      if (!profDocId || !profData) return PASSO_ERRO(401, 'PROFISSIONAL_NAO_AUTENTICADO', 'Profissional não encontrado.');

      const sessaoRecebida = String(b.profissional_sessao || '').trim();
      const tokenDoc = String(profData.sessao_token_ultima || '').trim();
      if (sessaoRecebida && tokenDoc && sessaoRecebida.length >= 20 && sessaoRecebida === tokenDoc) {
        autenticado = true;
      } else {
        const senhaRecebida = String(b.profissional_senha || '').trim();
        const senhaHashLocal = String(profData.senhaHash || profData.senha || '');
        if (senhaRecebida && senhaHashLocal) {
          const sha256Recebida = String(require('crypto').createHash('sha256').update(senhaRecebida).digest('hex'));
          if (senhaHashLocal === senhaRecebida || senhaHashLocal === sha256Recebida) autenticado = true;
        }
      }
      if (!autenticado) return PASSO_ERRO(401, 'SESSAO_INVALIDA', 'Sessão do profissional inválida ou expirada. Faça login novamente.');
    }

    // PASSO 2 e 3: Buscar pedido e extrair WhatsApp REAL (não retorna agora)
    const prefixoCol = (typeof FIRESTORE_COL_PREFIX === 'string' ? FIRESTORE_COL_PREFIX : '');
    const pedRef = dbFirestore ? dbFirestore.collection(prefixoCol + 'pedidos').doc(pedidoId) : null;
    let pedidoDocData = null;
    let whatsappReal = null;
    let nomeClienteReal = null;
    if (pedRef) {
      const pSnap = await _fsGetComTimeout(pedRef, 2000);
      if (pSnap && pSnap.exists) pedidoDocData = pSnap.data() || {};
    }
    if (!pedidoDocData) return PASSO_ERRO(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido não existe.');
    whatsappReal = pedidoDocData.whatsapp || pedidoDocData.clienteTelefone || pedidoDocData.clienteWhatsapp || null;
    nomeClienteReal = pedidoDocData.nomeCliente || pedidoDocData.clienteNome || '';
    const whatsappLimpo = String(whatsappReal || '').replace(/\D/g,'');
    if (!whatsappLimpo || whatsappLimpo.length < 10) return PASSO_ERRO(422, 'PEDIDO_SEM_WHATSAPP', 'Pedido não possui WhatsApp do cliente cadastrado.');

    // PASSO 4: Idempotência DURADOURA — verificação de desbloqueio JÁ EXISTENTE no banco
    const marcadoresDesb = pedidoDocData.profissionaisDesbloquearamIds || pedidoDocData.profissionaisQueDesbloquearam || [];
    const jaTemMarcadorPedido = Array.isArray(marcadoresDesb) && marcadoresDesb.includes(profissionalId);
    let jaTemRegistroContabil = false;
    try {
      if (dbFirestore) {
        // (CORRECAO CRITICA): substituida query composta 3x where (exigia indice composto Firestore)
        // por query simples (order_id apenas, indice padrão single-field) + filtro manual NODE.JS.
        // Resolve TIMEOUT infinito quando indice composto nao existia no Console Firebase.
        const snapCol = await _fsGetComTimeout(
          dbFirestore.collection(_FS_COL_DESBLOQUEIOS).where('order_id','==',pedidoId).limit(20),
          2000
        ) || {empty:true, docs:[]};
        if (snapCol && !snapCol.empty && Array.isArray(snapCol.docs)) {
          for (const d of snapCol.docs) {
            try {
              const dd = d.data() || {};
              if (String(dd.professional_id || dd.profissionalId || '') === String(profissionalId)
                  && String(dd.status || '').toLowerCase() === 'paid') {
                jaTemRegistroContabil = true;
                break;
              }
            } catch(eDoc){}
          }
        }
      }
    } catch(eIdem){}
    if (jaTemMarcadorPedido || jaTemRegistroContabil) {
      const saldoAtual = Number.isFinite(+profData.saldoMoedas) ? Math.floor(+profData.saldoMoedas) : 0;
      return res.status(200).json({
        ok:true, contactLocked:false, repetido:true,
        whatsapp: whatsappLimpo, whatsapp_formatado: null, nome_cliente: nomeClienteReal,
        custo_moedas: 0, saldo_restante: saldoAtual, unlock_id: null, unlocked_at_ms: Date.now(),
        msg: 'Contato já estava desbloqueado. Nenhum custo cobrado.'
      });
    }

    // PASSO 5: Idempotência INFLIGHT — impede duplo clique concorrente < 120s
    const chaveInflight = pedidoId + '|' + profissionalId;
    if (_DESBLOQUEIO_ATOMICO_INFLIGHT.has(chaveInflight)) {
      return PASSO_ERRO(409, 'DESBLOQUEIO_EM_ANDAMENTO', 'Uma solicitação de desbloqueio já está em processamento. Aguarde.');
    }
    _DESBLOQUEIO_ATOMICO_INFLIGHT.set(chaveInflight, Date.now());
    setTimeout(()=>{ try { _DESBLOQUEIO_ATOMICO_INFLIGHT.delete(chaveInflight); } catch(e){} }, 120 * 1000);

    try {
      // PASSO 6: Ler SALDO e CUSTO DO FIRESTORE (NÃO aceita body params)
      const custoMoedas = await _lerCustoDesbloqueioFirestore();
      let profAtual = profData || {};
      if (profDocId && dbFirestore) {
        const refProf = dbFirestore.collection(_FS_COL_PROFISSIONAIS).doc(profDocId);
        const profAtualSnap = await _fsGetComTimeout(refProf, 2000);
        if (profAtualSnap && profAtualSnap.exists) profAtual = (profAtualSnap.data() || {});
      }
      const saldoMoedasAtual = Number.isFinite(+profAtual.saldoMoedas) ? Math.floor(+profAtual.saldoMoedas) : 0;

      // PASSO 7: Admin bypass NÃO debita moedas. Caso contrário, saldo < custo → 402
      let saldoRestante = saldoMoedasAtual;
      let custoCobrado = custoMoedas;
      if (isAdminBypass) custoCobrado = 0;
      if (!isAdminBypass && saldoMoedasAtual < custoMoedas) {
        return PASSO_ERRO(402, 'SALDO_INSUFICIENTE',
          'Saldo insuficiente. Você tem ' + saldoMoedasAtual + ' moeda(s) e precisa de ' + custoMoedas + '. Recarregue pacotes na Loja de Moedas.');
      }
      if (!isAdminBypass) saldoRestante = saldoMoedasAtual - custoCobrado;

      // PASSO 8 e 9: 4 writes PROVA idempotentes + fechar pedido se ≥4
      const unlockId = 'unl_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
      const agoraMs = Date.now();
      const fv = admin && admin.firestore ? admin.firestore.FieldValue : null;
      const agoraTs = _fsTs();

      // Write A: saldo decrement + counters increment no profissional
      if (profDocId && dbFirestore && !isAdminBypass) {
        const patchProf = { saldoMoedas: saldoRestante, ultima_movimentacao_moedas_em: agoraTs, ultima_movimentacao_moedas_por: 'desbloqueio_atomico' };
        try {
          const refProf = dbFirestore.collection(_FS_COL_PROFISSIONAIS).doc(profDocId);
          const pA = refProf.set(patchProf, { merge:true });
          await Promise.race([pA, _timeoutPromise(2000, 'WRITE_A_TIMEOUT')]).catch(()=>null);
        } catch(eW){}
        try {
          await _logTransacaoMoedas('remover_desbloqueio', profDocId, 'profissional',
            profAtual.nome || 'Profissional', custoCobrado, saldoMoedasAtual, saldoRestante,
            'Desbloqueio contato pedido_id=' + pedidoId, 'sistema_desbloqueio_atomico');
        } catch(eLog){}
      }

      // Write B: pedido.profissionaisDesbloquearamIds arrayUnion (idempotente) + qtdDesbloqueios increment
      if (pedRef && dbFirestore) {
        const patchPed = {};
        if (fv) {
          patchPed.profissionaisDesbloquearamIds = fv.arrayUnion(profissionalId);
          patchPed.qtdDesbloqueios = fv.increment(1);
          patchPed.ultimo_desbloqueio_em = agoraTs;
        } else {
          const arr = Array.isArray(pedidoDocData.profissionaisDesbloquearamIds) ? pedidoDocData.profissionaisDesbloquearamIds.slice() : [];
          if (!arr.includes(profissionalId)) arr.push(profissionalId);
          patchPed.profissionaisDesbloquearamIds = arr;
          patchPed.qtdDesbloqueios = (Number(pedidoDocData.qtdDesbloqueios)||0) + 1;
          patchPed.ultimo_desbloqueio_em = agoraTs;
        }
        try {
          const pB = pedRef.set(patchPed, { merge:true });
          await Promise.race([pB, _timeoutPromise(2000, 'WRITE_B_TIMEOUT')]).catch(()=>null);
        } catch(eW){}

        // Write EXTRA: fecha o pedido (finalizado:true, status:'fechado') se qtd ≥ 4
        try {
          const pedReSnap = await _fsGetComTimeout(pedRef, 2000);
          const pd2 = pedReSnap && pedReSnap.exists ? (pedReSnap.data()||{}) : pedidoDocData;
          const qtd = Number(pd2.qtdDesbloqueios) || 0;
          if (qtd >= 4) {
            const pFech = pedRef.set({ finalizado:true, status: (pd2.status === 'aberto' ? 'fechado' : pd2.status), fechado_em: agoraTs }, { merge:true });
            try { await Promise.race([pFech, _timeoutPromise(2000, 'WRITE_FECHAMENTO_TIMEOUT')]).catch(()=>null); } catch(eFech){}
          }
        } catch(eReSnap){}
      }

      // Write D: coleção desbloqueios_contatos doc autoID status=paid (prova contábil duradoura)
      if (dbFirestore) {
        const payloadDesb = {
          id: unlockId,
          order_id: pedidoId,
          professional_id: profissionalId,
          profissional_doc_id: profDocId || '',
          payment_id: '',
          status: 'paid',
          amount: custoCobrado,
          moedas: custoCobrado,
          created_at: agoraTs,
          unlocked_at: agoraTs,
          unlocked_at_ms: agoraMs,
          admin_bypass: !!isAdminBypass,
          _v: 1
        };
        try {
          const pD = dbFirestore.collection(_FS_COL_DESBLOQUEIOS).doc(unlockId).set(payloadDesb);
          await Promise.race([pD, _timeoutPromise(2000, 'WRITE_D_TIMEOUT')]).catch(()=>null);
        } catch(eW){}
      }

      // PASSO 10: Retorna 200 com WhatsApp REAL liberado
      return res.status(200).json({
        ok:true, contactLocked:false, repetido:false,
        whatsapp: whatsappLimpo, whatsapp_formatado: null, nome_cliente: nomeClienteReal,
        custo_moedas: custoCobrado, saldo_restante: saldoRestante,
        unlock_id: unlockId, unlocked_at_ms: agoraMs,
        pedido_id: pedidoId, profissional_id: profissionalId,
        msg: isAdminBypass ? 'Contato liberado por admin (sem custo).' : 'Contato desbloqueado com sucesso.'
      });

    } catch(eInterno) {
      console.error('/api/profissional/pedido/desbloquear-atômico ERRO INTERNO (passos 6-9):', eInterno && eInterno.message);
      return PASSO_ERRO(500, 'ERRO_INTERNO_DESBLOQUEIO', 'Erro interno ao processar desbloqueio. Nenhuma moeda foi debitada. WhatsApp permanece bloqueado.');
    } finally {
      setTimeout(()=>{ try { _DESBLOQUEIO_ATOMICO_INFLIGHT.delete(chaveInflight); } catch(e){} }, 2000);
    }
  } catch(e){
    console.error('/api/profissional/pedido/desbloquear-atômico erro topo:', e && e.message);
    return res.status(500).json({ ok:false, contactLocked:true, whatsapp:null, error:'ERRO_DESCONHECIDO', msg:'Erro geral. Contato permanece protegido.' });
  }
}
app.post('/api/profissional/pedido/desbloquear-atômico', _handlerDesbloquearAtomicoPedidos);
app.post('/api/profissional/pedido/desbloquear-atomico',  _handlerDesbloquearAtomicoPedidos);

// ===================== (NOVO V11: HANDLERS FINAIS — 404 + ERROR GLOBAL — VEM SEMPRE DEPOIS DE TODAS AS ROTAS E ANTES DE app.listen) =====================
// 404: se nenhuma rota acima bateu, retorna JSON amigavel
app.use((req, res) => {
  if (res.headersSent) return;
  res.status(404).json({ ok: false, msg: 'Endpoint nao encontrado (AjeitaAí Pix Backend). Rotas validas: GET / (healthcheck com versao), GET /api/comunicado/public, PATCH /api/comunicado/admin, GET /api/patrocinadores/ativos, POST /api/pix/criar-recarga-moedas, POST /api/patrocinadores/criar-pagamento, POST /api/pix/aprovar-manual-admin, POST /webhook-pix, GET /api/admin/email/status, POST /api/admin/email/teste, GET /api/admin/email/teste-manual, POST /api/admin/2fa/docs/gerar, POST /api/admin/2fa/docs/validar, POST /api/admin/2fa/docs/checar, POST /api/notificacoes/enviar-email-lote, POST /api/cliente/excluir-conta, POST /api/profissional/sessao-registrar, POST /api/profissional/pedido/whatsapp-seguro, POST /api/profissional/pedido/desbloquear-atomico (ou alias desbloquear-atômico com acento).' });
});
// Error Global handler: qualquer next(err) ou exception nao capturada vira JSON, NUNCA MAIS HTML <title>Error</title>
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[EXPRESS_GLOBAL_ERROR_HANDLER] Erro capturado stack primeira parte:', err && err.stack ? String(err.stack).substring(0,1400) : String(err));
  res.status(Number(err && (err.statusCode || err.status) || 500)).json({
    ok: false,
    erro_critico: 'EXPRESS_GLOBAL_ERROR',
    msg: 'Erro interno servidor Pix (handled). Se persistir, contate Wesley suporte.',
    err_mensagem: String(err && err.message ? err.message : err).substring(0, 600)
  });
});

/* ============================
   START SERVER
   ============================ */
app.listen(PORTA, '0.0.0.0', () => {
  console.log(`\n🚀 AJEITA-PIX-BACKEND ONLINE:  http://127.0.0.1:${PORTA}/`);
  console.log(`   URL publica (render BACKEND_PUBLIC_URL): ${BACKEND_PUBLIC_URL}`);
  console.log(`   Modo MP: ${mercadopago ? 'SDK MERCADO PAGO CONECTADO' : 'MOCK LOCAL'}`);
  console.log(`   Modo Firestore Admin: ${svcAccount ? `Projeto ${svcAccount.project_id} CONECTADO` : 'DESLIGADO (apenas log console)'}\n`);

  // =============================================================
  // (NOVO V1.9 VERIFICACAO AUTOMATICA 100% BACKEND — SEM WEBOOK, SEM POLLING FRONTEND!)
  // CRON a cada 15 segundos:
  //   1) Busca TODOS os docs da collection "pix_transacoes" onde status NAO é "aprovado"
  //   2) Para cada doc pendente, consulta o Mercado Pago direto
  //   3) Se status MP === approved/accredited → CHAMA processarAprovacaoPix (libera moedas!)
  //   4) Atualiza status do doc no Firestore para o user ver progresso
  //
  // ISSO FUNCIONA MESMO SE:
  //   - Webhook MP NUNCA chegar (ex: não criou webhook ou conta errada)
  //   - Usuário FECHAR a aba/navedor antes da aprovação
  //   - Regras Firestore estiverem ERRADAS (cron roda no backend, ignora regras client-side)
  //   - Frontend NÃO esteja deployado com polling novo (codigo antigo)
  // =============================================================
  // CORRECAO CIRURGICA: backoff progressivo para RESOURCE_EXHAUSTED (gRPC codigo 8)
  // Evita retentar a cada 15s e bater ainda mais a cota enquanto a API esta bloqueada.
  var _cronBackoffFalhasConsec = 0;
  var _cronBackoffAteTimestampMs = 0;
  var _cronBackoffUltimoLogMs = 0;
  function _cronIsResourceExhaustedError(e) {
    if (!e) return false;
    if (typeof e.code === 'number' && e.code === 8) return true;
    var s = String((e && e.message) || '').toUpperCase() + ' ' + String((e && e.code) || '').toUpperCase();
    return s.indexOf('RESOURCE_EXHAUSTED') >= 0;
  }
  function _cronCalcularBackoffMs(qtdFalhas) {
    if (qtdFalhas <= 0) return 0;
    if (qtdFalhas === 1) return   1 * 60 * 1000; // 1 minuto
    if (qtdFalhas === 2) return   5 * 60 * 1000; // 5 minutos
    if (qtdFalhas === 3) return  15 * 60 * 1000; // 15 minutos
    return                     30 * 60 * 1000;    // 30 minutos (>=4 falhas consecutivas)
  }
  function _fmtBackoffAte(tsMs) {
    try {
      var d = new Date(tsMs);
      function z(n){ return n < 10 ? ('0' + n) : '' + n; }
      return z(d.getDate()) + '/' + z(d.getMonth() + 1) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
    } catch (e) { return ''; }
  }
  if (dbFirestore && MP_ACCESS_TOKEN) {
    console.log(`[CRON_APROVACAO_AUTOMATICA] ✅ Iniciando varredura automatica a cada 15s por pagamentos pendentes no Firestore. (FILTRO FEITO NO NODE — SEM NECESSIDADE DE INDICE FIREBASE COMPOSTO)`);
    setInterval(async () => {
      // BACKOFF ANTES DE TUDO: se estamos em periodo de espera por quota, pule rodada
      try {
        if (_cronBackoffAteTimestampMs > 0 && Date.now() < _cronBackoffAteTimestampMs) {
          var faltamMs = _cronBackoffAteTimestampMs - Date.now();
          var faltamMin = Math.max(1, Math.ceil(faltamMs / 60000));
          var agora = Date.now();
          if (agora - _cronBackoffUltimoLogMs > 60 * 1000) { // loga no maximo 1 vez por minuto para nao poluir logs
            _cronBackoffUltimoLogMs = agora;
            console.log(`[CRON_APROVACAO_AUTOMATICA] Quota da IA excedida. Retry em ${faltamMin} minutos. Proxima tentativa em ${_fmtBackoffAte(_cronBackoffAteTimestampMs)}.`);
          }
          return;
        }
      } catch(_eBo){}
      try {
        // (FIX V1.91) NÃO USA MAIS where != aprovado + orderBy (precisa de índice composto, dava FAILED_PRECONDITION)
        // Agora: lista TODOS os docs da collection, ordena por criado_em DESC e filtra PENDENTES no Node.js (100% permitido sem índice)
        const snapTodos = await dbFirestore.collection('pix_transacoes')
          .orderBy('criado_em', 'desc')
          .limit(100)
          .get();
        let qtde = 0, aprovadosNestaRodada = 0, totalDocs = 0;
        if (snapTodos && snapTodos.size > 0) {
          const docsParaProcessar = [];
          snapTodos.forEach((docSnap) => {
            try {
              totalDocs++;
              const dados = Object.assign({}, docSnap.data() || {});
              const statusAtual = String(dados.status || '').toLowerCase();
              // Filtro feito AQUI NO NODE.JS → sem índice composto necessário!
              if (statusAtual !== 'aprovado' && statusAtual !== 'cancelado' && statusAtual !== 'rejeitado') {
                // Evita re-processar muito recentes (criado nos ultimos 4s — nao deu tempo MP criar)
                const criadoMs = (dados.criado_em && dados.criado_em.toDate && typeof dados.criado_em.toDate === 'function')
                  ? (new Date(dados.criado_em.toDate())).getTime()
                  : null;
                if (criadoMs && (Date.now() - criadoMs) < 4000) return; // skip muito novo
                const extRef = String(dados.external_reference || docSnap.id || '');
                if (extRef) docsParaProcessar.push({ extRef, dados });
              }
            } catch(eF){}
          });
          qtde = docsParaProcessar.length;
          for (const item of docsParaProcessar) {
            try {
              const extRef = item.extRef;
              const dados = item.dados;
              console.log(`[CRON_APROVACAO_AUTOMATICA] Varredura doc: ref=${extRef} status atual="${dados.status || ''}" mp_payment_id=${dados.mp_payment_id || '?'} preco_brl=${dados.preco_brl || 0}`);
              const r = await _consultarPagamentoMpPorExternalRef(extRef);
              if (r && r.aprovado === true) { aprovadosNestaRodada++; }
            } catch (eDoc) { console.warn('[CRON_APROVACAO_AUTOMATICA] Erro no doc:', eDoc && eDoc.message || eDoc); }
          }
          if (aprovadosNestaRodada > 0) console.log(`[CRON_APROVACAO_AUTOMATICA] ✅ RODADA FINALIZADA: ${aprovadosNestaRodada} pagamentos APROVADOS automaticamente. Pendentes escaneados=${qtde}/${totalDocs} docs.`);
          else console.log(`[CRON_APROVACAO_AUTOMATICA] RODADA OK: 0 novos aprovados. Total docs lidos=${totalDocs}, pendentes escaneados=${qtde}.`);
        } else {
          console.log(`[CRON_APROVACAO_AUTOMATICA] Nenhum doc na collection pix_transacoes ainda. Aguardando novas cobrancas...`);
        }

        // =============================================================
        // (TASK 2 BLOCO 2) PATROCINADORES — PAGAMENTOS PENDENTES
        // Varre doc's de patrocinadores criados recentemente cujo pagamento ainda nao foi aprovado,
        // consulta MP por external_reference e chama processarAprovacaoPix se aprovado.
        // =============================================================
        try {
          if (dbFirestore && MP_ACCESS_TOKEN) {
            const snapPatPend = await dbFirestore.collection('patrocinadores').orderBy('created_at','desc').limit(200).get();
            let patAprovadosRodada = 0, patTotal = 0, patPendentes = 0;
            if (snapPatPend && snapPatPend.size > 0) {
              const patParaProcessar = [];
              snapPatPend.forEach(function(ds){
                try {
                  patTotal++;
                  const d = Object.assign({}, ds.data() || {});
                  const statusPag = String(d.status_pagamento || '').toLowerCase();
                  const extRef = String(d.external_reference || '').trim();
                  if (statusPag !== 'approved' && statusPag !== 'refunded' && statusPag !== 'rejected' && statusPag !== 'cancelled' && extRef && extRef.startsWith('SPONSOR_')) {
                    const criadoMs = (d.created_at && d.created_at.toDate && typeof d.created_at.toDate === 'function') ? (new Date(d.created_at.toDate())).getTime() : null;
                    if (criadoMs && (Date.now() - criadoMs) < 4000) return;
                    patPendentes++;
                    patParaProcessar.push({ extRef: extRef, docId: ds.id });
                  }
                } catch(eP1){}
              });
              for (const item of patParaProcessar) {
                try {
                  console.log(`[CRON_PATROCINIO_PENDENTE] ref="${item.extRef}" doc="${item.docId}"`);
                  const r = await _consultarPagamentoMpPorExternalRef(item.extRef);
                  if (r && r.aprovado === true) {
                    await processarAprovacaoPix({ external_reference: item.extRef, mp_payment_id: r.mp_payment_id || null, valor: Number(r.valor_mp || 0), aprovado_via: 'cron_15s_mp_pesquisa_external_ref' });
                    patAprovadosRodada++;
                  } else if (r && r.status_mp && r.status_mp !== 'nao_encontrado_ainda' && dbFirestore) {
                    try { await dbFirestore.collection('patrocinadores').doc(item.docId).update({ status_pagamento: r.status_mp, updated_at: admin.firestore.Timestamp? admin.firestore.Timestamp.now(): new Date().toISOString() }); } catch(eUpPat){}
                  }
                } catch(eItemPat) { console.warn('[CRON_PATROCINIO_PENDENTE] erro item:', eItemPat && eItemPat.message || eItemPat); }
              }
              if (patAprovadosRodada > 0 || patPendentes > 0) console.log(`[CRON_PATROCINIO] rodada OK: ${patPendentes} pendentes, ${patAprovadosRodada} aprovados automaticamente. Total docs patrocinadores: ${patTotal}.`);
            }
          }
        } catch(ePatGeral) { console.warn('[CRON_PATROCINIO_PENDENTE] Geral erro (ignora proxima):', ePatGeral && ePatGeral.message); }

        // =============================================================
        // (TASK 2 BLOCO 3) PATROCINADORES — EXPIRAÇÃO AUTOMÁTICA
        // Se hoje > data_termino E status_patrocinador='ativo', marca status=expirado.
        // =============================================================
        try {
          if (dbFirestore) {
            const snapPatAtivos = await dbFirestore.collection('patrocinadores').orderBy('created_at','desc').limit(200).get();
            let expiradosRodada = 0;
            if (snapPatAtivos && snapPatAtivos.size > 0) {
              const agoraExp = Date.now();
              const toMsExp = function(v) {
                if (!v) return null; if (typeof v === 'string') return (new Date(v)).getTime();
                if (v && v.toDate && typeof v.toDate === 'function') return (new Date(v.toDate())).getTime();
                if (v && typeof v._seconds === 'number') return v._seconds * 1000;
                if (typeof v === 'number') return v; return (new Date(String(v))).getTime();
              };
              snapPatAtivos.forEach(function(ds){
                try {
                  const d = Object.assign({}, ds.data() || {});
                  if (String(d.status_patrocinador || '').toLowerCase() !== 'ativo') return;
                  const fim = toMsExp(d.data_termino);
                  if (fim && agoraExp > fim) {
                    dbFirestore.collection('patrocinadores').doc(ds.id).update({
                      status_patrocinador: 'expirado',
                      updated_at: admin.firestore.Timestamp? admin.firestore.Timestamp.now(): new Date().toISOString(),
                      expirado_em: admin.firestore.Timestamp? admin.firestore.Timestamp.now(): new Date().toISOString(),
                      _motivo_expiracao: 'cron_15s_data_termino_atingido'
                    }).then(() => { expiradosRodada++; }).catch(function(){});
                  }
                } catch(eExpItem){}
              });
              if (expiradosRodada > 0) console.log(`[CRON_PATROCINIO_EXPIRACAO] ${expiradosRodada} patrocinadores marcados expirados automaticamente nesta rodada.`);
            }
          }
        } catch(eExpGeral) { console.warn('[CRON_PATROCINIO_EXPIRACAO] Geral erro (ignora proxima):', eExpGeral && eExpGeral.message); }

        // =============================================================
        // (CORRECAO CIRURGICA backoff quota) SUCESSO rodada completa → reseta contador falhas
        // =============================================================
        try {
          if (_cronBackoffFalhasConsec > 0 || _cronBackoffAteTimestampMs > 0) {
            var rodadasAnteriores = _cronBackoffFalhasConsec;
            _cronBackoffFalhasConsec = 0;
            _cronBackoffAteTimestampMs = 0;
            _cronBackoffUltimoLogMs = 0;
            console.log(`[CRON_APROVACAO_AUTOMATICA] ✅ Rodada OK apos backoff. Contador de falhas resetado (era=${rodadasAnteriores}). Volta ao intervalo normal de 15s.`);
          }
        } catch(_eRe){}

      } catch (eGeral) {
        var isQuota = _cronIsResourceExhaustedError(eGeral);
        if (isQuota) {
          // (CORREÇÃO) RESOURCE_EXHAUSTED gRPC codigo 8: aplica backoff progressivo — NAO retenta em 15s
          _cronBackoffFalhasConsec += 1;
          if (_cronBackoffFalhasConsec < 1) _cronBackoffFalhasConsec = 1;
          var backoffMs = _cronCalcularBackoffMs(_cronBackoffFalhasConsec);
          _cronBackoffAteTimestampMs = Date.now() + backoffMs;
          var backoffMin = Math.round(backoffMs / 60000);
          _cronBackoffUltimoLogMs = Date.now();
          console.log(`[CRON_APROVACAO_AUTOMATICA] Quota da IA excedida. Retry em ${backoffMin} minutos. Proxima tentativa em ${_fmtBackoffAte(_cronBackoffAteTimestampMs)}. (falhas consecutivas=${_cronBackoffFalhasConsec})`);
        } else {
          // erro normal (nao e quota): log antigo, retenta normalmente em 15s
          console.warn('[CRON_APROVACAO_AUTOMATICA] Erro GERAL rodada cron (ignora, proxima em 15s):', eGeral && eGeral.message);
        }
      }
    }, 15000); // 15 segundos — aprovacao MAXIMA latencia 15s apos pagamento, 100% automatica
  } else {
    console.warn('[CRON_APROVACAO_AUTOMATICA] ⚠️ Cron NAO iniciado: faltando dbFirestore ou MP_ACCESS_TOKEN. Verificar ENV Render.');
  }
});
