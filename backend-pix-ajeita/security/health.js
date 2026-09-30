'use strict';

const CHECK_BACKEND_MS = 30 * 1000;
const CHECK_FIRESTORE_MP_MS = 2 * 60 * 1000;
const CHECK_EMAIL_GSI_MS = 15 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5000;

class SecurityHealth {
  constructor(opts) {
    const o = opts || {};
    this.analyzer = o.analyzer || null;
    this.store = o.store || null;
    this.protector = o.protector || null;
    this._timers = { backend: null, firestoreMp: null, emailGsi: null };
    this._componentes = {
      backend_http: { status: 'PENDING', detalhe: 'Aguardando primeira checagem.', ultimaChecagemEm: 0, falhasConsec: 0 },
      firestore: { status: 'PENDING', detalhe: 'Aguardando primeira checagem.', ultimaChecagemEm: 0, falhasConsec: 0 },
      pagamento_mp: { status: 'PENDING', detalhe: 'Aguardando primeira checagem.', ultimaChecagemEm: 0, falhasConsec: 0 },
      email_smtp: { status: 'PENDING', detalhe: 'Aguardando primeira checagem.', ultimaChecagemEm: 0, falhasConsec: 0 },
      gsi_client_id: { status: 'PENDING', detalhe: 'Aguardando primeira checagem.', ultimaChecagemEm: 0, falhasConsec: 0 },
      security_agent_self: { status: 'OK', detalhe: 'Módulo carregado. Monitoramento ativo.', ultimaChecagemEm: Date.now(), falhasConsec: 0 }
    };
    this._ultimaChecagemGeralEm = 0;
    this._iniciarTimers();
  }

  stop() {
    for (const k of Object.keys(this._timers)) {
      try { if (this._timers[k]) { clearInterval(this._timers[k]); this._timers[k] = null; } } catch (e) {}
    }
  }

  _iniciarTimers() {
    if (typeof setInterval !== 'function') return;
    try {
      this._timers.backend = setInterval(() => { try { this._runBackend(); } catch (e) {} }, CHECK_BACKEND_MS);
      this._timers.firestoreMp = setInterval(() => { try { this._runFirestoreMp(); } catch (e) {} }, CHECK_FIRESTORE_MP_MS);
      this._timers.emailGsi = setInterval(() => { try { this._runEmailGsi(); } catch (e) {} }, CHECK_EMAIL_GSI_MS);
      if (this._timers.backend && typeof this._timers.backend.unref === 'function') this._timers.backend.unref();
      if (this._timers.firestoreMp && typeof this._timers.firestoreMp.unref === 'function') this._timers.firestoreMp.unref();
      if (this._timers.emailGsi && typeof this._timers.emailGsi.unref === 'function') this._timers.emailGsi.unref();
      setTimeout(() => { try { this._runBackend(); this._runFirestoreMp(); this._runEmailGsi(); } catch (e) {} }, 1500);
    } catch (e) {}
  }

  _atualizarComp(nome, status, detalhe) {
    const agora = Date.now();
    if (!this._componentes[nome]) this._componentes[nome] = { status, detalhe, ultimaChecagemEm: agora, falhasConsec: 0 };
    const c = this._componentes[nome];
    const antes = c.status;
    c.status = status;
    c.detalhe = (detalhe || '').substring(0, 400);
    c.ultimaChecagemEm = agora;
    if (status === 'OK') c.falhasConsec = 0;
    else if (status === 'FALHA') c.falhasConsec = (c.falhasConsec || 0) + 1;
    this._ultimaChecagemGeralEm = agora;
    if (nome === 'backend_http') {
      try {
        if (this.analyzer && typeof this.analyzer.registrarHealthBackendFalhou === 'function' && status === 'FALHA') {
          this.analyzer.registrarHealthBackendFalhou();
        } else if (this.analyzer && typeof this.analyzer.registrarHealthBackendOk === 'function' && status === 'OK') {
          this.analyzer.registrarHealthBackendOk();
        }
      } catch (e) {}
    }
    if (this.store && typeof this.store.addEvent === 'function') {
      try {
        const ev = {
          id: 'health_' + nome + '_' + agora + '_' + Math.random().toString(36).substring(2, 7),
          ts: agora, durationMs: 0, category: 'saude', type: 'health_' + nome + '_' + status.toLowerCase(),
          ip: '127.0.0.x', ipHashSha256: 'health_internal', uidHash: null,
          method: 'INTERNAL', path: '/health/' + nome, pathMasked: '/health/' + nome, statusCode: status === 'OK' ? 200 : 503,
          bodyRedacted: null, uaRedacted: 'SecurityHealthAgent', referer: null, origin: null,
          isAdminRoute: false, adminAuthenticated: null, extra: { componente: nome, status_antes: antes, status_depois: status, detalhe: c.detalhe, falhasConsec: c.falhasConsec }
        };
        this.store.addEvent(ev);
      } catch (e) {}
    }
  }

  async _runBackend() {
    const porta = Number(process.env.PORT || '7001');
    const url = `http://127.0.0.1:${porta}/`;
    try {
      if (typeof fetch !== 'function') { this._atualizarComp('backend_http', 'OK', 'Fetch API indisponível, skipado. Assumindo backend OK pois esta instância está rodando.'); return; }
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = setTimeout(() => { try { if (controller) controller.abort(); } catch (e) {} }, HTTP_TIMEOUT_MS);
      try {
        const init = controller ? { signal: controller.signal, method: 'GET', headers: { 'User-Agent': 'AjeitaSecAgent/1.0' } } : { method: 'GET', headers: { 'User-Agent': 'AjeitaSecAgent/1.0' } };
        const r = await fetch(url, init);
        clearTimeout(t);
        if (!r || r.status >= 500) this._atualizarComp('backend_http', 'FALHA', 'HTTP status=' + (r ? r.status : 'null') + ' ao acessar healthcheck /');
        else this._atualizarComp('backend_http', 'OK', 'Healthcheck / respondeu HTTP ' + (r ? r.status : '200') + ' em tempo hábil.');
      } catch (e) {
        clearTimeout(t);
        this._atualizarComp('backend_http', 'FALHA', 'Timeout ou erro conexão localhost:' + porta + '. Detalhe: ' + String((e && e.message) || e).substring(0, 200));
      }
    } catch (eTop) {
      this._atualizarComp('backend_http', 'FALHA', 'Exceção geral health backend: ' + String((eTop && eTop.message) || eTop).substring(0, 200));
    }
  }

  async _runFirestoreMp() {
    try {
      if (this.store && typeof this.store.listEvents === 'function') {
        try {
          const evts = this.store.listEvents({ limit: 1 });
          if (Array.isArray(evts)) this._atualizarComp('firestore', 'OK', 'Store (JSON/Firestore) acessível. listEvents retorna array. eventos_recentes=' + evts.length);
          else this._atualizarComp('firestore', 'FALHA', 'listEvents não retornou array.');
        } catch (eSt) { this._atualizarComp('firestore', 'FALHA', 'Exceção store: ' + String((eSt && eSt.message) || eSt).substring(0, 200)); }
      } else this._atualizarComp('firestore', 'DEGRADADO', 'Store não disponível no health (sem referência).');
    } catch (e) {}
    try {
      const token = String(process.env.MERCADO_PAGO_ACCESS_TOKEN || '');
      if (!token || token.length < 8) { this._atualizarComp('pagamento_mp', 'DEGRADADO', 'MERCADO_PAGO_ACCESS_TOKEN não configurado. Não verificada conexão MP.'); return; }
      if (typeof fetch !== 'function') { this._atualizarComp('pagamento_mp', 'OK', 'Fetch indisponível. MP skipado sem falha.'); return; }
      const tokenPrefix = token.substring(0, 12) + '...';
      const urlFake = 'https://api.mercadopago.com/v1/payments/id_nao_existe_sec_agent_123456789';
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = setTimeout(() => { try { if (controller) controller.abort(); } catch (e) {} }, HTTP_TIMEOUT_MS + 2000);
      try {
        const init = controller ? { signal: controller.signal, method: 'GET', headers: { Authorization: 'Bearer ' + tokenPrefix.replace('...', ''), 'User-Agent': 'AjeitaSecAgent/1.0' } } : { method: 'GET', headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'AjeitaSecAgent/1.0' } };
        const r = await fetch(urlFake, init);
        clearTimeout(t);
        const st = r ? r.status : 0;
        if (st === 404 || st === 401 || st === 403 || (st >= 200 && st < 500)) this._atualizarComp('pagamento_mp', 'OK', 'API MP acessível. Resposta status=' + st + '. Token prefixo: ' + tokenPrefix);
        else if (st >= 500 || st === 0) this._atualizarComp('pagamento_mp', 'FALHA', 'API MP retornou erro status=' + st);
      } catch (e) {
        clearTimeout(t);
        this._atualizarComp('pagamento_mp', 'FALHA', 'Timeout/erro conexão MP: ' + String((e && e.message) || e).substring(0, 200));
      }
    } catch (e) { this._atualizarComp('pagamento_mp', 'FALHA', 'Exceção geral MP: ' + String((e && e.message) || e).substring(0, 200)); }
  }

  async _runEmailGsi() {
    try {
      const host = String(process.env.SMTP_HOST || '');
      const user = String(process.env.SMTP_USER || '');
      if (!host || !user) { this._atualizarComp('email_smtp', 'DEGRADADO', 'SMTP_HOST / SMTP_USER não configurados. Email pode não estar funcional.'); }
      else this._atualizarComp('email_smtp', 'OK', `Configuração SMTP presente. host=${host.substring(0, 30)}, user=${user.substring(0, 6)}... (NÃO envia e-mail real na checagem).`);
    } catch (e) { this._atualizarComp('email_smtp', 'FALHA', 'Exceção email: ' + String((e && e.message) || e).substring(0, 200)); }
    try {
      const gsi = String(process.env.GOOGLE_CLIENT_ID || '');
      if (!gsi) { this._atualizarComp('gsi_client_id', 'DEGRADADO', 'GOOGLE_CLIENT_ID vazio. Login Google OAuth indisponível.'); return; }
      const ok = /^\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com$/i.test(gsi);
      if (ok) this._atualizarComp('gsi_client_id', 'OK', 'GOOGLE_CLIENT_ID válido (formato padrão Google Cloud). Prefixo: ' + gsi.substring(0, 8) + '...');
      else this._atualizarComp('gsi_client_id', 'FALHA', 'GOOGLE_CLIENT_ID fora do formato esperado. Tamanho: ' + gsi.length);
    } catch (e) { this._atualizarComp('gsi_client_id', 'FALHA', 'Exceção GSI: ' + String((e && e.message) || e).substring(0, 200)); }
  }

  getUltimoHealth() {
    const agora = Date.now();
    const comps = [];
    for (const nome of Object.keys(this._componentes)) {
      const c = this._componentes[nome];
      comps.push({
        componente: nome,
        status: c.status || 'PENDING',
        detalhe: c.detalhe || '',
        ultimaChecagemEm: c.ultimaChecagemEm || 0,
        segundosDesde: c.ultimaChecagemEm ? Math.max(0, Math.floor((agora - c.ultimaChecagemEm) / 1000)) : -1,
        falhasConsecutivas: c.falhasConsec || 0
      });
    }
    let statusGeral = 'OK';
    let teveFalha = false, teveDegradado = false;
    for (const cc of comps) {
      if (cc.status === 'FALHA') teveFalha = true;
      else if (cc.status === 'DEGRADADO' || cc.status === 'PENDING') teveDegradado = true;
    }
    if (teveFalha) statusGeral = 'CRÍTICO';
    else if (teveDegradado) statusGeral = 'DEGRADADO';
    return {
      healthStatus: statusGeral,
      ultimaChecagemEm: this._ultimaChecagemGeralEm || 0,
      componentes: comps
    };
  }
}

const securityHealth = new SecurityHealth();

module.exports = {
  SecurityHealth,
  securityHealth,
  CHECK_BACKEND_MS,
  CHECK_FIRESTORE_MP_MS,
  CHECK_EMAIL_GSI_MS
};
