require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const admin = require('firebase-admin');

/* ============================
   FIREBASE ADMIN INIT (SERVICE ACCOUNT JSON)
   - Pegamos FIREBASE_SERVICE_ACCOUNT_JSON de ENV VAR (cole todo JSON bruto,
     exatamente como voce faz no buscabar: $env:FIREBASE_SERVICE_ACCOUNT_JSON=(Get-Content ...json -Raw))
   ============================ */
const svcAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}';
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
   ============================ */
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
let mercadopago = null;
try {
  const { MercadoPagoConfig, Payment, Preference } = require('mercado-pago');
  if (MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.length > 10) {
    const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN, options: { timeout: 10000 } });
    mercadopago = { Payment: new Payment(mpClient), Preference: new Preference(mpClient) };
    console.log(`[MERCADO_PAGO] SDK inicializado. Access Token prefixo: ${MP_ACCESS_TOKEN.substring(0, 12)}...`);
  } else {
    console.warn('[MERCADO_PAGO] AVISO: MERCADO_PAGO_ACCESS_TOKEN vazio ou invalido. Modo MOCK (simulacao local) ativado.');
  }
} catch (eInitMp) {
  console.error('[MERCADO_PAGO] Falha carregar SDK mercado-pago:', eInitMp);
}

const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || 'http://127.0.0.1:7001';
const PORTA = Number(process.env.PORT || '7001');
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

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
function uidDocLocal(idProfissionalOuCliente) { return 'local_' + String(idProfissionalOuCliente || 'anonimo'); }

/* ============================
   ROTA RAIZ (Health Check / Render ping)
   ============================ */
app.get('/', (req, res) => {
  res.json({
    ok: true,
    app: 'ajeita-pix-backend',
    firebase_project: svcAccount ? svcAccount.project_id : null,
    mp_ativado: !!mercadopago,
    backend_url_publica: BACKEND_PUBLIC_URL
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
    const pacoteKey = String(b.pacoteKey || 'bronze').toLowerCase();
    const qtdMoedas = _QtdMoedasPorPacote(pacoteKey);
    const precoBRL = Number(b.valorOpcional) || _PrecoPorPacote(pacoteKey);
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

    if (mercadopago) {
      try {
        const bodyCreate = {
          transaction_amount: Number(precoBRL.toFixed(2)),
          payment_method_id: 'pix',
          payer: {
            email: emailUsuario,
            first_name: nomeUsuario.split(' ')[0],
            last_name: nomeUsuario.split(' ').slice(1).join(' ') || 'Ajeita',
            identification: { type: 'CPF', number: '00000000000' }
          },
          external_reference: externalRef,
          description: _NomePacote(pacoteKey) + ' - Ajeita Serviços Domésticos',
          notification_url: (BACKEND_PUBLIC_URL + '/webhook-pix'),
          installments: 1
        };
        const created = await mercadopago.Payment.create({
          body: bodyCreate,
          requestOptions: { idempotencyKey: externalRef }
        });
        if (created && created.response) {
          const r = created.response;
          mpPaymentId = String(r.id || '');
          const poi = r.point_of_interaction && r.point_of_interaction.transaction_data ? r.point_of_interaction.transaction_data : null;
          if (poi) {
            qrCodeBase64 = poi.qr_code_base64 || null;
            copiaCola = poi.qr_code || null;
            ticketUrl = poi.ticket_url || null;
          }
          if (dbFirestore) {
            try {
              await dbFirestore.collection('pix_transacoes').doc(docTransacaoId).update({
                mp_payment_id: mpPaymentId,
                qr_code_base64: qrCodeBase64,
                copia_cola: copiaCola,
                ticket_url: ticketUrl
              });
            } catch(eFbUp) { console.error(eFbUp); }
          }
          console.log(`[MERCADO_PAGO] Pagamento criado: id=${mpPaymentId} external_ref=${externalRef}`);
        }
      } catch (eMpCreate) {
        console.error('[MERCADO_PAGO] ERRO criar pagamento pix:', JSON.stringify(eMpCreate?.cause || eMpCreate?.message || eMpCreate));
        return res.status(500).json({ ok: false, msg: 'Erro Mercado Pago ao criar cobranca Pix', err: (eMpCreate.cause || eMpCreate.message) });
      }
    } else {
      // MOCK LOCAL (se nao tiver token MP) -> gerar QR vazio, marcar
      console.warn('[MERCADO_PAGO_MOCK] Modo MOCK: Mercado Pago nao configurado. Pagamento simulado.');
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
   ============================ */
app.post('/webhook-pix', async (req, res) => {
  res.status(200).send('OK'); // Resposta IMEDIATA ao MP (obrigação para não repetir webhook)
  try {
    const body = req.body || {};
    const action = String(body.action || '');
    const type = String(body.type || body.data?.type || '');
    const paymentId = String(body.data?.id || body.id || '');
    if (!mercadopago || !paymentId || !action || !action.includes('payment')) {
      // Webhook vazio / invalido / nao temos SDK para consultar detalhe. Ignora.
      console.log(`[WEBHOOK_MP] Ignorado: action=${action} paymentId=${paymentId}`);
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
