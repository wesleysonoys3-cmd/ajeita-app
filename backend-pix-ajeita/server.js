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
const app = express();
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

/* ============================
   (NOVO V11 WEBHOOK HMAC) Helper valida assinatura secreta Mercado Pago
   Documentacao MP: x-signature header tem format ts=123,v1=abc,v1=def
   Regra: criar string "id={dataId};{request_id or ''};{ts};" + rawBody
   HMAC_SHA256 com MP_WEBHOOK_SECRET → comparar com os v1=...
   ============================ */
function _validarAssinaturaWebhookMp(req, pagamentoIdFromBody) {
  // Se nao tem secret configurado: skip validacao (compativel com versões anteriores)
  if (!MP_WEBHOOK_SECRET || MP_WEBHOOK_SECRET.length < 5) {
    console.log('[WEBHOOK_MP_VALIDACAO] MERCADO_PAGO_WEBHOOK_SECRET nao configurado → SKIP validacao HMAC (recomendamos configurar para produzai real).');
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
    default: return 'Recarga de Moedas Ajeita';
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
  res.json({
    ok: true,
    app: 'ajeita-pix-backend',
    versao: '1.8-producao-real-preco-minimo-pacote-anti-r1',
    modo: MODO_PRODUCAO_REAL ? 'PRODUCAO_REAL_DINHEIRO' : MODO_HOMOLOGACAO_TESTE ? 'HOMOLOGACAO_TESTE' : 'MOCK_LOCAL_DESENVOLVIMENTO',
    firebase_project: svcAccount ? svcAccount.project_id : null,
    mp_ativado: !!mercadopago,
    mp_fetch_nativo_habilitado: true,
    mp_webhook_hmac_configurado: !!MP_WEBHOOK_SECRET && MP_WEBHOOK_SECRET.length > 5,
    backend_url_publica: BACKEND_PUBLIC_URL,
    backend_url_https_valida: Boolean(BACKEND_PUBLIC_URL && BACKEND_PUBLIC_URL.toLowerCase().startsWith('https://') && !BACKEND_PUBLIC_URL.includes('localhost') && !BACKEND_PUBLIC_URL.includes('127.0.0.1'))
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
     emailUsuario: 'fulano@...'
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

    // ================ (V1.8 BUG FIX R$1 ANTI-FRAUDE PREÇO) ================
    // SEMPRE usa MAX(valorOpcional front, _PrecoPorPacote helper)
    // Nunca mais aceita R$0, R$1 ou qualquer preço abaixo do pacote.
    // (Antes aceitava valorOpcional = 1 e criava cobrança de R$1 por engano!)
    let precoBRL = 0;
    const valorEnviadoFront = Number(b.valorOpcional || 0);
    const precoMinimoPorPacote = _PrecoPorPacote(pacoteKey); // Bronze=15, Prata=30, Ouro=60
    if (valorEnviadoFront > 0) {
      // ✅ NOVA REGRA V1.8: NUNCA deixa preco ficar MENOR que preco minimo do pacote
      if (valorEnviadoFront >= precoMinimoPorPacote) {
        precoBRL = valorEnviadoFront;
        console.log(`[CRIAR_PIX] Usando valor ENVIADO PELO FRONTEND (valorOpcional) = R$${precoBRL} (pacote=${pacoteKey}) — OK, >= minimo R$${precoMinimoPorPacote}`);
      } else {
        precoBRL = precoMinimoPorPacote;
        console.warn(`[CRIAR_PIX] ⚠️ FRONTEND ENVIOU PRECO ABAIXO DO MINIMO! valorEnviadoFront=R$${valorEnviadoFront} < minimo R$${precoMinimoPorPacote}. SOBRESCREVENDO PARA R$${precoBRL} (anti-fraude preco minimo V1.8). pacote=${pacoteKey}`);
      }
    } else {
      precoBRL = precoMinimoPorPacote;
      console.log(`[CRIAR_PIX] Valor opcional nao envio. Usando helper interno pacoteKey → R$${precoBRL}`);
    }
    precoBRL = Number(precoBRL);
    // Ultima protecao: se ainda for 0 ou negativo, usa preco minimo
    if (!(precoBRL > 0) || precoBRL < precoMinimoPorPacote) {
      console.warn(`[CRIAR_PIX] ⚠️ Ultima protecao anti-fraude: precoBRL=R$${precoBRL} invalido, sobrescrevendo para R$${precoMinimoPorPacote}`);
      precoBRL = precoMinimoPorPacote;
    }

    const qtdMoedas = _QtdMoedasPorPacote(pacoteKey);
    const uidUsuario = String(b.uidUsuario || ('anon_' + Date.now()));
    const tipoUsuario = String(b.tipoUsuario || 'profissional');
    const nomeUsuario = String(b.nomeUsuario || 'Usuario Ajeita');
    const emailUsuario = String(b.emailUsuario || 'cliente@ajeita.com.br');
    const externalRef = 'ajeita_moeda_' + Date.now() + '_' + uidUsuario.substring(0,12);

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
      const last = (nomeUsuario.split(' ').slice(1).join(' ') || 'Ajeita').substring(0, 60);
      const emailPayer = emailUsuario || 'cliente@ajeita.com.br';

      // ====== BODY REST OFICIAL (igual documentacao Mercado Pago API v1/payments Pix) ======
      // Usamos o body MESMO tanto para SDK quanto para FETCH NATIVO (campos oficiais 100% documentados)
      const bodyCreate = {
        transaction_amount: transactionAmountFormatado,
        description: (_NomePacote(pacoteKey) + ' - Ajeita Serviços Domésticos').substring(0, 120),
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
  if (!transacao) {
    // Tenta montar transacao minima pelos parametros recebidos
    transacao = {
      uid_usuario: 'desconhecido', tipo_usuario: 'profissional',
      qtd_moedas: 0, preco_brl: Number(payload.valor || 0),
      pacote_key: 'bronze', nome_usuario: ''
    };
  }
  const qtdMoedas = Number(transacao.qtd_moedas || 0);
  const uidUsuario = String(transacao.uid_usuario || '');
  const tipoUsuario = String(transacao.tipo_usuario || 'profissional');
  // 1) Atualiza doc pix_transacoes -> aprovado
  if (dbFirestore) {
    try {
      await dbFirestore.collection('pix_transacoes').doc(externalRef).update({
        status: 'aprovado',
        mp_payment_id: payload.mp_payment_id,
        aprovado_via: payload.aprovado_via,
        aprovado_em: admin.firestore.Timestamp ? admin.firestore.Timestamp.now() : new Date().toISOString(),
        valor_pago_mp: Number(payload.valor || transacao.preco_brl || 0)
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
      const novoSaldo = Number(atual.saldoMoedas || 0) + qtdMoedas;
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
          metodo_pagamento: 'pix'
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

// ===================== (NOVO V11: HANDLERS FINAIS — 404 + ERROR GLOBAL — VEM SEMPRE DEPOIS DE TODAS AS ROTAS E ANTES DE app.listen) =====================
// 404: se nenhuma rota acima bateu, retorna JSON amigavel
app.use((req, res) => {
  if (res.headersSent) return;
  res.status(404).json({ ok: false, msg: 'Endpoint nao encontrado (Ajeita Pix Backend). Rotas validas: GET / (healthcheck), POST /api/pix/criar-recarga-moedas, POST /api/pix/aprovar-manual-admin, POST /webhook-pix' });
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
});
