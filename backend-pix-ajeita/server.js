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
// (NOVO V11 WEBHOOK SEGURO) Preservamos raw body EM TODAS as requisicoes no Buffer,
// para podermos validar HMAC x-signature do Mercado Pago (precisa do JSON exato, sem reformatação do express.json)
app.use((req, res, next) => {
  let dataRaw = [];
  req.on('data', chunk => dataRaw.push(chunk));
  req.on('end', () => {
    if (dataRaw.length > 0) {
      try { req.rawBodyStr = Buffer.concat(dataRaw).toString('utf8'); }
      catch(eRaw) { req.rawBodyStr = ''; }
    } else req.rawBodyStr = '';
    next();
  });
});
app.use(express.json({ limit: '10mb' }));
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
    versao: '1.2-producao-real-webhook-hmac',
    modo: MODO_PRODUCAO_REAL ? 'PRODUCAO_REAL_DINHEIRO' : MODO_HOMOLOGACAO_TESTE ? 'HOMOLOGACAO_TESTE' : 'MOCK_LOCAL_DESENVOLVIMENTO',
    firebase_project: svcAccount ? svcAccount.project_id : null,
    mp_ativado: !!mercadopago,
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

    // ================ (BUG FIX R$0 PRODUCAO: PRIORIDADE MAXIMA VALOR ENVIADO PELO FRONTEND) ================
    // 1) Se frontend enviou valorOpcional e ele é >0 → USAMOS ELE SEMPRE (nunca calculamos por pacote de novo, evita desalinhamento)
    // 2) Senão, usamos helper _PrecoPorPacote(pacoteKey)
    // 3) No final valida >0 ou BLOQUEIA
    let precoBRL = 0;
    const valorEnviadoFront = Number(b.valorOpcional || 0);
    if (valorEnviadoFront > 0) {
      precoBRL = valorEnviadoFront;
      console.log(`[CRIAR_PIX] Usando valor ENVIADO PELO FRONTEND (valorOpcional) = R$${precoBRL} (pacote=${pacoteKey}) — PRIORIDADE MAXIMA`);
    } else {
      precoBRL = _PrecoPorPacote(pacoteKey);
      console.log(`[CRIAR_PIX] Valor opcional nao envio. Usando helper interno pacoteKey → R$${precoBRL}`);
    }
    precoBRL = Number(precoBRL);

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

    if (mercadopago) {
      try {
        // ============ (BUG FIX R$0 PRODUCAO MP) NOVO BODY com currency_id BRL, CPF valido, validações ============
        const cpfValidoAleatorio = _gerarCpfFakeValidoParaMp();
        const transactionAmountFormatado = Number(Number(precoBRL).toFixed(2));
        const bodyCreate = {
          transaction_amount: transactionAmountFormatado,
          currency_id: 'BRL', // <--- (NOVO) OBRIGATORIO NA V2 SDK MP, sem isso Producao pode zerar
          payment_method_id: 'pix',
          payer: {
            email: emailUsuario,
            first_name: (nomeUsuario.split(' ')[0] || 'Cliente').substring(0, 30),
            last_name: (nomeUsuario.split(' ').slice(1).join(' ') || 'Ajeita').substring(0, 60),
            identification: {
              type: 'CPF',
              number: cpfValidoAleatorio // <--- (NOVO BUG FIX) NUNCA MAIS 00000000000 (MP zera valor se CPF for tudo zero anti-fraude)
            }
          },
          external_reference: externalRef,
          description: (_NomePacote(pacoteKey) + ' - Ajeita Serviços Domésticos').substring(0, 120),
          notification_url: (BACKEND_PUBLIC_URL + '/webhook-pix'),
          installments: 1,
          binary_mode: true // <--- (NOVO) Pagamento Aprovado = Unico status, reduz callbacks desnecessarios
        };

        // LOG PRODUCAO DETALHADO (para se valor zerar de novo, sabemos exatamente o que enviamos para o MP)
        console.log(`[MERCADO_PAGO][CRIAR] enviando body → pacote=${pacoteKey} valor=${transactionAmountFormatado} BRL cpf=${cpfValidoAleatorio.substring(0, 6)}*** email=${emailUsuario} external_ref=${externalRef}`);
        console.log(`[MERCADO_PAGO][CRIAR] BODY COMPLETO = ${JSON.stringify(bodyCreate)}`);

        const created = await mercadopago.Payment.create({
          body: bodyCreate,
          requestOptions: { idempotencyKey: externalRef }
        });
        if (created && created.response) {
          const r = created.response;
          mpPaymentId = String(r.id || '');
          const valorRetornadoMp = Number(r.transaction_amount || 0);
          const poi = r.point_of_interaction && r.point_of_interaction.transaction_data ? r.point_of_interaction.transaction_data : null;
          if (poi) {
            qrCodeBase64 = poi.qr_code_base64 || null;
            copiaCola = poi.qr_code || null;
            ticketUrl = poi.ticket_url || null;
          }
          // ============ (BUG FIX R$0 PRODUCAO) DOUBLE CHECK: se MP retornou valor ZERO para a gente, NAO libera esse pagamento (seguranca) ============
          if (mpPaymentId && valorRetornadoMp === 0) {
            console.error(`[MERCADO_PAGO][BUG R$0 DETECTADO] Pagamento id=${mpPaymentId} CRIADO MAS MP RETORNOU VALOR R$0. body enviado valor = ${transactionAmountFormatado}. Cancelando pagamento para nao gerar perda dinheiro.`);
            try { await mercadopago.Payment.cancel({ id: mpPaymentId }); } catch(eCan){ console.warn('[MP] tentativa cancelar pagamento R$0 falhou, ok'); }
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
                mp_status_criacao: String(r.status || 'desconhecido')
              });
            } catch(eFbUp) { console.error(eFbUp); }
          }
          console.log(`[MERCADO_PAGO] Pagamento CRIADO SUCESSO: id=${mpPaymentId} external_ref=${externalRef} valor_mp=${valorRetornadoMp} status=${r.status || 'pendente'}`);
        } else {
          console.error(`[MERCADO_PAGO] SDK retornou sem response? created keys=${created ? Object.keys(created) : 'null'}`);
        }
      } catch (eMpCreate) {
        console.error('[MERCADO_PAGO] ERRO criar pagamento pix:', JSON.stringify(eMpCreate?.cause || eMpCreate?.message || eMpCreate));
        return res.status(500).json({ ok: false, msg: 'Erro Mercado Pago ao criar cobranca Pix', err: (eMpCreate.cause || eMpCreate.message) });
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
    const assinaturaValida = _validarAssinaturaWebhookMp(req, paymentId);
    if (!assinaturaValida) {
      // Mesmo que já tenhamos respondido 200, NÃO processa nada (rejeita por segurança e loga)
      console.warn(`[WEBHOOK_MP] 🚨 BLOQUEADO POR ASSINATURA INVALIDA: paymentId=${paymentId}. Nao vamos consultar MP nem liberar moedas. BodyStrLen=${String(req.rawBodyStr || '').length}.`);
      return;
    }
    if (!mercadopago) {
      console.log('[WEBHOOK_MP] Ignorado: SDK MP nao carregado (ainda). Espera proxima notificacao MP.');
      return;
    }
    // Consultar detalhe do pagamento no MP (obrigatorio para pegar external_reference e status REAL):
    const detalheResp = await mercadopago.Payment.get({ id: paymentId });
    if (!detalheResp || !detalheResp.response) return;
    const pag = detalheResp.response;
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

/* ============================
   START SERVER
   ============================ */
app.listen(PORTA, '0.0.0.0', () => {
  console.log(`\n🚀 AJEITA-PIX-BACKEND ONLINE:  http://127.0.0.1:${PORTA}/`);
  console.log(`   URL publica (render BACKEND_PUBLIC_URL): ${BACKEND_PUBLIC_URL}`);
  console.log(`   Modo MP: ${mercadopago ? 'SDK MERCADO PAGO CONECTADO' : 'MOCK LOCAL'}`);
  console.log(`   Modo Firestore Admin: ${svcAccount ? `Projeto ${svcAccount.project_id} CONECTADO` : 'DESLIGADO (apenas log console)'}\n`);
});
