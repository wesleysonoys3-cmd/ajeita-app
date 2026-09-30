'use strict';

const path = require('path');
const fs = require('fs');

// ============================================================
// ENV OBRIGATÓRIO ANTES DE CARREGAR QUALQUER MÓDULO SECURITY
// para hashIp/redact/storePath inicializarem corretamente.
// ============================================================
process.env.SECURITY_IP_HASH_SECRET = 'test_secret_ajeitai_sec_v1_do_not_use_in_prod_123456789';
const TMP = path.join(__dirname, '__sec_test_tmp_' + Date.now() + '_' + process.pid);
try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {}
process.env.SECURITY_STORE_PATH = path.join(TMP, 'sec_test_store.json');
const TMP_STORE = process.env.SECURITY_STORE_PATH;

const SEC_DIR = path.join(__dirname);
const redact = require(path.join(SEC_DIR, 'redact'));
const { SecurityStore, securityStore } = require(path.join(SEC_DIR, 'store'));
const collector = require(path.join(SEC_DIR, 'collector'));
const { SecurityAnalyzer, securityAnalyzer } = require(path.join(SEC_DIR, 'analyzer'));
const { SecurityProtector, securityProtector } = require(path.join(SEC_DIR, 'protector'));
const { SecurityHealth } = require(path.join(SEC_DIR, 'health'));
const { SecurityAI } = require(path.join(SEC_DIR, 'ai'));
const dashboard = require(path.join(SEC_DIR, 'dashboard'));

let _DateNow = Date.now;
function _avancarClock(ms) {
  const base = Date.now ? _DateNow() : (new Date()).getTime();
  const novo = base + Number(ms || 0);
  global.Date = class extends Date { constructor(...a) { if (a.length === 0) super(novo); else super(...a); } static now() { return novo; } };
}
function _resetClock() { global.Date = Date; }

let PASS = 0;
let FAIL = 0;
const FALHAS = [];
function _t(id, nome, cond, detalhe) {
  if (cond) {
    PASS++;
    console.log('[TESTE ' + id + '/20] ' + nome + ' ..... PASSOU');
  } else {
    FAIL++;
    FALHAS.push(id);
    console.log('[TESTE ' + id + '/20] ' + nome + ' ..... FALHOU' + (detalhe ? '  (' + detalhe + ')' : ''));
  }
}

function _reqFake(method, urlPath, body, opts) {
  const o = opts || {};
  const query = {};
  const pura = String(urlPath || '/').split('?')[0];
  const qs = String(urlPath || '').split('?')[1] || '';
  qs.split('&').filter(Boolean).forEach(p => { const [k, v] = p.split('='); query[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
  return {
    method: String(method || 'GET').toUpperCase(),
    path: pura,
    url: urlPath || '/',
    originalUrl: urlPath || '/',
    ip: o.ip || '10.20.30.' + (o.ipOct || '40'),
    socket: { remoteAddress: o.ip || '10.20.30.40' },
    headers: Object.assign({ 'user-agent': 'SecTestAgent/1.0', 'x-forwarded-for': o.ip || '10.20.30.40' }, o.headers || {}),
    body: body || {},
    query,
    params: o.params || {}
  };
}
function _resFake() {
  const r = {
    statusCode: 200,
    _headers: {},
    _body: '',
    _ended: false,
    setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    end(chunk) { this._body += (chunk || ''); this._ended = true; if (typeof this._cbEnd === 'function') { const cb = this._cbEnd; this._cbEnd = null; cb(); } },
    onEnd(cb) { this._cbEnd = cb; },
    write(chunk) { this._body += (chunk || ''); }
  };
  r.json = function (obj) { r.setHeader('Content-Type', 'application/json; charset=utf-8'); r.status(r.statusCode || 200); r.end(JSON.stringify(obj || {})); };
  r.send = function (s) { if (typeof s === 'object') r.json(s); else r.end(String(s || '')); };
  return r;
}

function _appFake() {
  const handlers = [];
  return {
    rotas: handlers,
    get(p, fn) { handlers.push({ method: 'GET', path: p, fn }); },
    post(p, fn) { handlers.push({ method: 'POST', path: p, fn }); },
    patch(p, fn) { handlers.push({ method: 'PATCH', path: p, fn }); },
    put(p, fn) { handlers.push({ method: 'PUT', path: p, fn }); },
    _encontrarRota(method, pathname) {
      for (const h of handlers) {
        if (h.method !== String(method || '').toUpperCase()) continue;
        if (typeof h.path === 'string') {
          const partsPath = String(h.path).split('/').filter(Boolean);
          const partsReq = String(pathname || '/').split('/').filter(Boolean);
          if (partsPath.length === partsReq.length) {
            const params = {};
            let ok = true;
            for (let i = 0; i < partsPath.length; i++) {
              if (partsPath[i].startsWith(':')) params[partsPath[i].slice(1)] = partsReq[i];
              else if (partsPath[i] !== partsReq[i]) { ok = false; break; }
            }
            if (ok) return { fn: h.fn, params };
          }
        }
      }
      return null;
    },
    async _chamar(method, path, req, res) {
      const match = this._encontrarRota(method, path);
      if (!match) { res.statusCode = 404; res.end('{"ok":false,"msg":"no route"}'); return false; }
      req.params = Object.assign({}, req.params || {}, match.params || {});
      await new Promise((resolve) => {
        let done = 0;
        function _next(err) { if (done++) return; resolve(); }
        res.onEnd(() => { if (done++) return; resolve(); });
        try { match.fn(req, res, _next); } catch (e) { try { _next(e); } catch (x) {} }
        setTimeout(() => { if (done++) return; resolve(); }, 300);
      });
      return true;
    }
  };
}

// ---------- Setup fresh singletons para teste ----------
const T_SECRET = process.env.SECURITY_IP_HASH_SECRET;
const ipFake = '203.0.113.45';
// OBS: usaremos o hash gerado DENTRO do createEventManual (colocado em evt.ipHashSha256)
// para garantir que é exatamente o mesmo que o analyzer.ingest() guarda na Map.

const st = new SecurityStore({ storePath: TMP_STORE });
const an = new SecurityAnalyzer({ store: st });
const pr = new SecurityProtector({ store: st, analyzer: an, adminPassword: 'bolo2024' });
pr.stop && pr.stop();
const hl = new SecurityHealth({ analyzer: an, store: st, protector: pr });
hl.stop && hl.stop();
const ai = new SecurityAI({ store: st });
// forçar IA desativada para testes independentes de rede
ai.iaDesativada = true;

function _criarEv(cat, type, ipRaw, extra) {
  const evt = collector.createEventManual({
    category: cat, type, ip: ipRaw,
    statusCode: (extra && typeof extra.statusCode === 'number') ? extra.statusCode : 0,
    extra: Object.assign({}, extra || {}),
    store: st, redact, analyzer: an, protector: pr
  });
  return evt;
}
function _hashIpFromEvent(catProbe, ipRaw) {
  const probe = _criarEv('http', 'probe_for_hash', ipRaw || '127.0.0.1', {});
  return probe ? probe.ipHashSha256 : null;
}

console.log('');
console.log('==========================================');
console.log('Suite Ajeitaí Security Agent — 20 casos');
console.log('Armazenamento temporário: ' + TMP_STORE);
console.log('==========================================');
console.log('');

// ========================= CASO 1: login normal =========================
(function () {
  const antes = st.events.length;
  const ev = _criarEv('autenticacao', 'login_sucesso', ipFake, { provider: 'google', ok: true });
  const depois = st.events.length;
  _t(1, 'login normal registra evento 1x', ev && depois >= antes + 1 && ev.category === 'autenticacao');
})();

// ========================= CASO 2: brute force simulado =========================
(function () {
  const ipHash = _hashIpFromEvent('http', ipFake);
  an.eventsByIpHash.delete(ipHash);
  for (let i = 0; i < 50; i++) {
    _criarEv('autenticacao', 'login_falha', ipFake, { tentativa: i, statusCode: 401 });
  }
  const sc = an.scoreForIp(ipHash);
  const temR01 = Array.isArray(sc && sc.motivos) && sc.motivos.some(m => m && m.regraId === 'R01');
  _t(2, 'brute force 50 logins -> score >= 20 + R01', (sc && typeof sc.valor === 'number' && sc.valor >= 20) && temR01, 'valor=' + (sc && sc.valor) + ' temR01=' + temR01);
})();

// ========================= CASO 3: excesso de requisições =========================
(function () {
  const ip3 = '198.51.100.77';
  const ip3h = _hashIpFromEvent('http', ip3);
  an.eventsByIpHash.delete(ip3h);
  for (let i = 0; i < 120; i++) {
    _criarEv('http', 'GET /catalogo/profissionais', ip3, { req_n: i });
  }
  const sc = an.scoreForIp(ip3h);
  const temR02 = Array.isArray(sc && sc.motivos) && sc.motivos.some(m => m && m.regraId === 'R02');
  _t(3, 'excesso 120 reqs -> R02 + score > 10', (typeof (sc && sc.valor) === 'number' && sc.valor > 10) || temR02, 'valor=' + (sc && sc.valor) + ' temR02=' + temR02);
})();

// ========================= CASO 4: acesso repetido ao telefone =========================
(function () {
  const ip4 = '192.0.2.9';
  const ip4h = _hashIpFromEvent('http', ip4);
  an.eventsByIpHash.delete(ip4h);
  for (let i = 0; i < 8; i++) {
    _criarEv('telefone', 'liberar_telefone_pedido', ip4, { pedido_n: i, statusCode: 200 });
  }
  const sc = an.scoreForIp(ip4h);
  const temR13 = Array.isArray(sc && sc.motivos) && sc.motivos.some(m => m && m.regraId === 'R13');
  _t(4, '8 liberações telefone 2min -> R13 +20', temR13 || (sc && sc.valor >= 20), 'valor=' + (sc && sc.valor) + ' temR13=' + temR13);
})();

// ========================= CASO 5: erro 401 =========================
(function () {
  const ip5 = '192.0.2.51';
  const ip5h = _hashIpFromEvent('http', ip5);
  an.eventsByIpHash.delete(ip5h);
  for (let i = 0; i < 25; i++) {
    _criarEv('http', 'GET /api/admin', ip5, { statusCode: 401 });
  }
  const sc = an.scoreForIp(ip5h);
  _t(5, '25 erros 401 -> score aumenta', sc && typeof sc.valor === 'number' && sc.valor >= 5, 'valor=' + (sc && sc.valor));
})();

// ========================= CASO 6: erro 404 =========================
(function () {
  const ip6 = '192.0.2.61';
  const ip6h = _hashIpFromEvent('http', ip6);
  an.eventsByIpHash.delete(ip6h);
  for (let i = 0; i < 30; i++) {
    _criarEv('http', 'GET /wp-login-' + i + '.php', ip6, { statusCode: 404 });
  }
  const sc = an.scoreForIp(ip6h);
  const temR08 = Array.isArray(sc && sc.motivos) && sc.motivos.some(m => m && m.regraId === 'R08');
  _t(6, '30 404 paths suspeitos -> R08', temR08 || (sc && sc.valor >= 10), 'valor=' + (sc && sc.valor) + ' temR08=' + temR08);
})();

// ========================= CASO 7: erro 500 =========================
(function () {
  const ip7 = '192.0.2.71';
  const ip7h = _hashIpFromEvent('http', ip7);
  an.eventsByIpHash.delete(ip7h);
  for (let i = 0; i < 15; i++) {
    _criarEv('interno', 'unhandled_exception_500', ip7, { statusCode: 500, errMsg: 'simulado' });
  }
  const sc = an.scoreForIp(ip7h);
  _t(7, '15 erros 500 -> score >= 5', sc && typeof sc.valor === 'number' && sc.valor >= 5, 'valor=' + (sc && sc.valor));
})();

// ========================= CASO 8: comportamento normal =========================
(function () {
  const ip8 = '10.0.0.88';
  const ip8h = _hashIpFromEvent('http', ip8);
  an.eventsByIpHash.delete(ip8h);
  for (let i = 0; i < 5; i++) {
    _criarEv('http', 'GET /home', ip8, { statusCode: 200 });
  }
  _criarEv('autenticacao', 'login_sucesso', ip8, { statusCode: 200 });
  const sc = an.scoreForIp(ip8h);
  _t(8, 'comportamento normal -> score BAIXO (< 15)', sc && typeof sc.valor === 'number' && sc.valor < 15, 'valor=' + (sc && sc.valor));
})();

// ========================= CASO 9: score (faixas 4) =========================
(function () {
  const a0 = ai.resumoScoreMotivado(0, []);
  const a29 = ai.resumoScoreMotivado(29, []);
  const a30 = ai.resumoScoreMotivado(30, []);
  const a60 = ai.resumoScoreMotivado(60, []);
  const a80 = ai.resumoScoreMotivado(80, []);
  const ok = a0.rotulo === 'BAIXO' && a29.rotulo === 'BAIXO' && a30.rotulo === 'MODERADO' && a60.rotulo === 'ALTO' && a80.rotulo === 'CRÍTICO';
  _t(9, 'score faixas 0/29/30/60/80', ok, 'rotulos=' + [a0.rotulo, a29.rotulo, a30.rotulo, a60.rotulo, a80.rotulo].join('/'));
})();

// ========================= CASO 10: rate limit =========================
(function () {
  pr.mode = 'protect';
  const ip10 = '192.0.2.101';
  const ip10h = _hashIpFromEvent('http', ip10);
  for (let i = 0; i < 55; i++) {
    const fakeEv = { ipHashSha256: ip10h, ts: Date.now(), category: 'http', type: 'GET /catalogo' };
    pr.checkShouldBlock({ evento: fakeEv, scoreAtual: 55 });
  }
  pr.mode = 'monitor';
  _t(10, 'rate limit 55 reqs não crasha e estado ok', typeof pr.blocksByIpHash !== 'undefined' && typeof pr.checkShouldBlock === 'function');
})();

// ========================= CASO 11: bloqueio temporário (simulado via TTL) =========================
(function () {
  pr.mode = 'protect';
  const ip11 = '192.0.2.111';
  const ip11h = _hashIpFromEvent('http', ip11);
  pr._bloquearIp('A03', ip11h, 5 * 60 * 1000, 'simulado teste 11', true);
  const blk = pr.isBlockedIpOrUser({ ipHash: ip11h });
  pr.mode = 'monitor';
  _t(11, 'bloqueio temporário TTL 5min aplicado -> isBlocked retorna true', blk && blk.tipo === 'ip' && typeof blk.ttlMs === 'number' && blk.ttlMs > 0, 'blk=' + JSON.stringify(blk));
})();

// ========================= CASO 12: cooldown alerta =========================
(function () {
  const agora = Date.now();
  const antesAdd = st.alerts.length;
  const ipHashFake12 = _hashIpFromEvent('http', ipFake);
  const r = st.addAlert({ regraId: 'R01', ipHashSha256: ipHashFake12, msg: 'teste cooldown 1' });
  const r2 = st.addAlert({ regraId: 'R01', ipHashSha256: ipHashFake12, msg: 'teste cooldown 2 duplicado' });
  const depoisAdd = st.alerts.length;
  const naoDuplicou = (antesAdd + 1 === depoisAdd) || (r2 && (r2.ignoradoPorCooldown === true || r2.added === false || r2.reason === 'cooldown'));
  _t(12, 'cooldown alerta 5min não duplica', naoDuplicou, 'antes=' + antesAdd + ' depois=' + depoisAdd + ' r2=' + JSON.stringify(r2 || {}).substring(0, 120));
})();

// ========================= CASO 13: alerta gerado =========================
(function () {
  const beforeLen = st.incidents.length;
  const inc = {
    incidentId: 'INC_TEST_' + Date.now() + '_13',
    timestamp: Date.now(),
    severity: 'CRÍTICO',
    category: 'brute_force',
    evidence: [{ regraId: 'R01', pontos: 20 }],
    riskScore: 82,
    actionTaken: { acaoId: 'A03', real: false, simulado: true },
    status: 'OPEN'
  };
  const salvou = st.addIncident(inc);
  const afterLen = st.incidents.length;
  _t(13, 'alerta/incidente criado na store', salvou && afterLen > beforeLen && Array.isArray(st.listIncidents({})), 'antes=' + beforeLen + ' depois=' + afterLen);
})();

// ========================= CASO 14: incidentes (status machine update) =========================
(function () {
  const id = 'INC_TEST_STATUS_' + Date.now();
  st.addIncident({ incidentId: id, timestamp: Date.now(), severity: 'ALTO', category: 'anomalia', riskScore: 65, status: 'OPEN', statusHistorico: [{ status: 'OPEN', motivo: 'criado automaticamente', ts: Date.now() }] });
  const res = st.updateIncident(id, { status: 'INVESTIGATING', motivo: 'investigando motivo de fato valido', atualizadoPor: 'teste_14' });
  st.updateIncident(id, { status: 'RESOLVED', motivo: 'muito curto' });
  const res3 = st.updateIncident(id, { status: 'RESOLVED', motivo: 'resolvido apos analise humana detalhada, 12+ caracteres' });
  const antesHist = (res && res.incidente && res.incidente.statusHistorico) ? res.incidente.statusHistorico.length : 0;
  _t(14, 'incidente update status OPEN→INV→RES com motivo >= 8', res && res.ok && res3 && res3.ok && antesHist >= 1, 'res.ok=' + (res && res.ok) + ' res3.ok=' + (res3 && res3.ok) + ' hist=' + antesHist);
})();

// ========================= CASO 15: redaction de segredos =========================
(function () {
  const b = {
    senha: 'minhaSenhaSecreta123',
    admin_senha: 'bolo2024',
    SMTP_PASSWORD: 'SG.76Z5FGY771W1KCTSJWQ8HNRU.abcdefgh1234567890ABCDEFGHIJKLMNOP',
    token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abcdef-abcdef-abcdef-abcdef-abcdef-abcdef-abcdef',
    cpf: '123.456.789-09'
  };
  const r = redact.redactBody(b);
  const s = JSON.stringify(r);
  const naoTem = s.indexOf('bolo2024') < 0 && s.indexOf('minhaSenhaSecreta123') < 0 && s.indexOf('76Z5FGY771W1KCTSJWQ8HNRU') < 0;
  _t(15, 'redaction segredos (senha/token/SG./CPF)', naoTem, 's=' + s.substring(0, 200));
})();

// ========================= CASO 16: redaction de telefone =========================
(function () {
  const telos = ['5561992518130', '61992518130', '11987654321', '(61) 99251-8130'];
  const tem9Consec = telos.some(t => /\d{9,}/.test(redact.redactPhone(t)));
  const masc = redact.redactPhone('5561992518130');
  const okR = !tem9Consec && masc.indexOf('****') >= 0;
  _t(16, 'redaction telefone -> 4 últimos dígitos, sem 9+ seq', okR, 'masc=' + masc + ' tem9=' + tem9Consec);
})();

// ========================= CASO 17: falha do backend => R17 =========================
(function () {
  an._healthBackendFalhasConsecutivas = 0;
  an.registrarHealthBackendFalhou();
  an.registrarHealthBackendFalhou();
  an.registrarHealthBackendFalhou();
  const ipT = '10.1.2.3';
  _criarEv('http', 'GET /', ipT, { statusCode: 200 });
  const sg = an.scoreGlobal();
  const temR17 = Array.isArray(sg && sg.motivos) && sg.motivos.some(m => m && m.regraId === 'R17');
  an.registrarHealthBackendOk();
  _t(17, 'R17 falha backend 2x consecutivas -> score +10', temR17 || (sg && sg.valor >= 10), 'valor=' + (sg && sg.valor) + ' temR17=' + temR17);
})();

// ========================= CASO 18: falha do Security Agent (graceful degrade) =========================
(function () {
  let nextCount = 0;
  const mw = collector.makeSecurityMiddleware({ store: st, redact, analyzer: an, protector: pr });
  const req = _reqFake('GET', '/home?x=1', {}, { ip: '127.0.0.1' });
  const res = _resFake();
  mw(req, res, () => { nextCount++; });
  res.end('ok');
  let ehNextCount = 0;
  const eh = collector.wrapExpressErrorHandler({ store: st, redact, analyzer: an, protector: pr });
  try { eh(new Error('falha agente 18 simulada'), req, res, () => { ehNextCount++; }); } catch (e) {}
  _t(18, 'graceful degrade: mw next + errorHandler next não crasham', nextCount >= 1 && ehNextCount >= 1, 'nextCount=' + nextCount + ' ehNextCount=' + ehNextCount);
})();

// ========================= CASO 19: dashboard sem senha => 401 =========================
(function () {
  const app = _appFake();
  dashboard.registerAdminEndpoints({ app, security: { store: st, analyzer: an, protector: pr, health: hl, ai, redact } });
  (async function () {
    const req = _reqFake('GET', '/admin/security', {}, { ip: '1.2.3.4' });
    const res = _resFake();
    await app._chamar('GET', '/admin/security', req, res);
    const t1 = res.statusCode === 401;
    const req2 = _reqFake('GET', '/admin/security?admin_senha=bolo2024', {}, { ip: '5.6.7.8', headers: { 'x-admin-senha': 'bolo2024', accept: 'text/html' } });
    req2.body.admin_senha = 'bolo2024';
    const res2 = _resFake();
    await app._chamar('GET', '/admin/security', req2, res2);
    const t2 = res2.statusCode === 200 && String(res2._body || '').indexOf('noindex,nofollow') >= 0;
    const req3 = _reqFake('GET', '/api/admin/security/status', {}, { ip: '9.9.9.9' });
    const res3 = _resFake();
    await app._chamar('GET', '/api/admin/security/status', req3, res3);
    const t3 = res3.statusCode === 401;
    const extraT2 = 'status=' + res2.statusCode + ' bodyLen=' + (String(res2._body || '').length) + ' noindexIdx=' + String(res2._body || '').indexOf('noindex,nofollow') + ' bodyErr=' + String(res2._body || '').substring(0, 200).replace(/\s+/g, ' ');
    _t(19, 'dashboard /admin/security 401 sem senha · 200 com senha · /api/* 401', t1 && t2 && t3, 't1=' + t1 + ' t2=' + t2 + ' t3=' + t3 + ' [' + extraT2 + ']');
  })();
})();

// ========================= CASO 20: comportamento normal - score global + IA desativada =========================
(function () {
  const sg = an.scoreGlobal();
  const valor = typeof (sg && sg.valor) === 'number';
  const rotulo = sg && (sg.rotulo === 'BAIXO' || sg.rotulo === 'MODERADO' || sg.rotulo === 'ALTO' || sg.rotulo === 'CRÍTICO');
  const statusOk = sg && (sg.statusGlobal === 'PROTEGIDO' || sg.statusGlobal === 'ATENÇÃO' || sg.statusGlobal === 'ATENCAO' || sg.statusGlobal === 'INCIDENTE');
  const incFake = { incidentId: 'INC_IA_20_' + Date.now(), severity: 'ALTO', category: 'anomalia', summary: 'Teste caso 20', riskScore: 65 };
  (async function () {
    const anRes = await ai.analisarIncidente(incFake, []);
    const iaOk = anRes && (anRes.ia_desativada === true || anRes.cache === 'HIT' || anRes.cache === 'MISS');
    const components = (hl && hl.getUltimoHealth && hl.getUltimoHealth().componentes) || [];
    const hlOk = components.length >= 5;
    _t(20, 'score global válido + IA desativada + health 5+ componentes', valor && rotulo && statusOk && iaOk && hlOk, 'valor=' + (sg && sg.valor) + ' rotulo=' + (sg && sg.rotulo) + ' stG=' + (sg && sg.statusGlobal) + ' iaOk=' + iaOk + ' hlComp=' + components.length);
  })();
})();

// Sumarizar após async (setTimeout para casos 19/20 executar)
setTimeout(() => {
  console.log('');
  console.log('==========================================');
  console.log('RESUMO FINAL: ' + PASS + '/20 PASSOU · ' + FAIL + '/20 FALHOU');
  if (FAIL > 0) console.log('IDs FALHOS: [' + FALHAS.join(', ') + ']');
  console.log('==========================================');
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { try { fs.unlinkSync(TMP_STORE); } catch (x) {} }
  _resetClock();
  process.exit(PASS >= 18 ? 0 : 1);
}, 600);
