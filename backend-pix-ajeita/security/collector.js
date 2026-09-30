'use strict';

const CATEGORIAS_VALIDAS = new Set([
  'http', 'login', 'cadastro', 'recuperacao_senha', 'autenticacao',
  'sessao', 'endpoint', 'erro_http', 'tentativas_repetidas',
  'pedido_criado', 'acesso_dados_cliente', 'acesso_telefone_cliente',
  'pagamento', 'webhook', 'admin_alteracao', 'interno', 'saude'
]);

const CHAVES_ADMIN_SENHA_BODY = ['admin_senha', 'senhaAdmin', 'senha_admin'];
const CAMINHOS_ADMIN = /\/(admin|api\/admin)\b/i;
const CAMINHOS_PAGAMENTO = /\/(api\/pix|webhook|pagamento|patrocinadores\/criar-pagamento)\b/i;
const CAMINHOS_WEBHOOK = /\/webhook/i;
const CAMINHOS_TELEFONE = /\/(telefone|whatsapp|contato|cliente.*telefone|liberar-telefone|pedido.*desbloqu)/i;

function _defaultIfNull(v, fallback) { return v == null ? fallback : v; }
function _safeString(v, maxLen) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (maxLen && s.length > maxLen) s = s.substring(0, maxLen);
  return s;
}

function maskPath(p) {
  if (typeof p !== 'string') return '/';
  let s = p;
  s = s.replace(/\/api\/pix\/consultar-status\/[^\/?#]+/g, '/api/pix/consultar-status/:externalRef');
  s = s.replace(/\/api\/admin\/security\/incidents\/[^\/?#]+/g, '/api/admin/security/incidents/:id');
  s = s.replace(/\/api\/pix\/aprovar-manual-admin\/?[^\/?#]*/g, '/api/pix/aprovar-manual-admin');
  s = s.replace(/\/api\/patrocinadores\/(admin|ativos)\/[^\/?#]+/g, (m, p1) => '/api/patrocinadores/' + p1 + '/:id');
  s = s.replace(/\b\d{6,}\b/g, ':id');
  s = s.replace(/\/[0-9a-fA-F-]{12,}(?=[\/?#]|$)/g, '/:uid');
  return s;
}

function detectarCategoria(req, pathMasked, statusCode, extra) {
  const pm = pathMasked || '';
  const sc = statusCode || 0;
  const method = (req && req.method || '').toUpperCase();
  if (CAMINHOS_WEBHOOK.test(pm)) return 'webhook';
  if (CAMINHOS_TELEFONE.test(pm)) return 'acesso_telefone_cliente';
  if (CAMINHOS_PAGAMENTO.test(pm)) return 'pagamento';
  if (pm.indexOf('/pedido') !== -1 && method === 'POST') return 'pedido_criado';
  if (CAMINHOS_ADMIN.test(pm)) return 'admin_alteracao';
  if (/\/(login|auth|autenticacao|oauth|google)\b/i.test(pm)) return 'autenticacao';
  if (/\/(cadastro|registro|signup|criar-conta)\b/i.test(pm)) return 'cadastro';
  if (/\/(recuperar|resetar|forgot|senha.*reset)\b/i.test(pm)) return 'recuperacao_senha';
  if (/\/(sessao|session|logout)\b/i.test(pm)) return 'sessao';
  if (extra && typeof extra.category === 'string' && CATEGORIAS_VALIDAS.has(extra.category)) return extra.category;
  if (sc >= 400 && sc < 500) return 'erro_http';
  if (sc >= 500) return 'interno';
  return 'http';
}

function makeSecurityMiddleware(opts) {
  const o = opts || {};
  const store = o.store || null;
  const redact = o.redact || (require('./redact'));
  const analyzer = o.analyzer || null;
  const protector = o.protector || null;

  function finalizeEvent(ctx) {
    try {
      const req = ctx.req;
      const res = ctx.res;
      const now = Date.now();
      const durationMs = Math.max(0, now - (ctx.startTs || now));
      const statusCode = typeof ctx.statusCodeOverride === 'number' ? ctx.statusCodeOverride
        : (typeof res.statusCode === 'number' ? res.statusCode : 0);
      const ipCapturado = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
      const ipHashSha256 = redact.hashIp(ipCapturado);
      const ipMasked = redact.redactIp(ipCapturado);
      let uidRaw = null;
      if (req && typeof req.headers === 'object' && req.headers['x-uid-hmac']) uidRaw = req.headers['x-uid-hmac'];
      if (!uidRaw && req && typeof req.headers === 'object' && req.headers['x-user-uid']) uidRaw = req.headers['x-user-uid'];
      const uidHash = uidRaw ? redact.hashUid(uidRaw) : null;
      let method = req && req.method ? String(req.method).toUpperCase().substring(0, 8) : 'UNKNOWN';
      const rawPath = req && req.originalUrl ? req.originalUrl : (req && req.url ? req.url : '/');
      const pathMasked = maskPath(rawPath);
      let bodyRedacted = {};
      try {
        if (req && req.body) {
          const cloned = JSON.parse(JSON.stringify(req.body));
          bodyRedacted = redact.redactBody(cloned);
        }
      } catch (e) { bodyRedacted = { _parse_error: true, _msg: String(e.message || e).substring(0, 120) }; }
      const uaRedacted = redact.redactUserAgent(req && req.headers ? req.headers['user-agent'] : '');
      const referer = _safeString(req && req.headers ? req.headers['referer'] || req.headers['referrer'] : '', 300);
      const origin = _safeString(req && req.headers ? req.headers['origin'] : '', 200);
      const isAdminRoute = CAMINHOS_ADMIN.test(pathMasked);
      let adminAuthenticated = false;
      if (isAdminRoute) {
        const senhaEsperada = process.env.SECURITY_ADMIN_PASSWORD || 'bolo2024';
        const candidatas = [];
        if (req && typeof req.query === 'object') candidatas.push(req.query.admin_senha);
        if (req && typeof req.body === 'object') CHAVES_ADMIN_SENHA_BODY.forEach(k => candidatas.push(req.body[k]));
        if (req && typeof req.headers === 'object') candidatas.push(req.headers['x-admin-senha']);
        const found = candidatas.find(c => typeof c === 'string');
        if (found === senhaEsperada) adminAuthenticated = true;
      }
      let adminTentativa = null;
      if (isAdminRoute && !adminAuthenticated) {
        const candidatas = [];
        if (req && typeof req.query === 'object' && req.query.admin_senha != null) candidatas.push('query');
        if (req && typeof req.body === 'object') CHAVES_ADMIN_SENHA_BODY.forEach(k => { if (req.body[k] != null) candidatas.push('body:' + k); });
        if (req && typeof req.headers === 'object' && req.headers['x-admin-senha'] != null) candidatas.push('header');
        if (candidatas.length > 0) adminTentativa = candidatas.join(',');
      }
      const extra = ctx.extraObj || {};
      if (adminTentativa) extra.admin_auth_attempt = adminTentativa;
      if (ctx.errMsgShort) extra.errMsg = ctx.errMsgShort;
      if (ctx.errStackFirstLine) extra.errStackFirstLine = ctx.errStackFirstLine;
      let typeLabel;
      if (extra && typeof extra.type === 'string') typeLabel = extra.type.substring(0, 80);
      else typeLabel = method + ' ' + pathMasked;
      const category = detectarCategoria(req, pathMasked, statusCode, extra);
      const evtId = 'evt_' + now + '_' + Math.random().toString(36).slice(2, 10);
      const evento = {
        id: evtId,
        ts: now,
        durationMs: durationMs,
        category: category,
        type: typeLabel,
        ip: ipMasked,
        ipHashSha256: ipHashSha256,
        uid: uidHash,
        method: method,
        path: _safeString(rawPath, 300),
        pathMasked: pathMasked,
        statusCode: statusCode,
        bodyRedacted: bodyRedacted,
        uaRedacted: uaRedacted,
        referer: referer,
        origin: origin,
        isAdminRoute: isAdminRoute,
        adminAuthenticated: adminAuthenticated,
        extra: extra
      };
      try { if (store && typeof store.addEvent === 'function') store.addEvent(evento); } catch (e) {}
      let scoreAtual = null;
      try {
        if (analyzer && typeof analyzer.ingest === 'function') scoreAtual = analyzer.ingest(evento);
      } catch (e) {
        if (evento.extra) evento.extra.analyzerError = String((e && e.message) || e).substring(0, 200);
      }
      try {
        if (protector && typeof protector.checkShouldBlock === 'function') {
          const decisao = protector.checkShouldBlock({ evento, scoreAtual });
          if (decisao && typeof decisao === 'object') {
            evento.protection = Object.assign({}, decisao);
            if (evento.extra) {
              if (decisao.acao_simulada) evento.extra.acao_simulada = decisao.acao_simulada;
              if (decisao.acaoId) evento.extra.protectionAcaoId = decisao.acaoId;
              if (decisao.motivo) evento.extra.protectionMotivo = decisao.motivo;
            }
          }
        }
      } catch (e) {}
      return evento;
    } catch (eBig) {
      try { console.warn('[SECURITY_collector] finalizeEvent falhou:', String(eBig.message || eBig).substring(0, 200)); } catch (nope) {}
      return null;
    }
  }

  return function securityMiddleware(req, res, next) {
    const ctx = {
      req: req,
      res: res,
      startTs: Date.now(),
      statusCodeOverride: null,
      extraObj: {},
      errMsgShort: null,
      errStackFirstLine: null,
      finalizado: false
    };
    req._secCtx = ctx;
    res.sec_buildEvent = function (statusCodeOverride, extra) {
      if (typeof statusCodeOverride === 'number') ctx.statusCodeOverride = statusCodeOverride;
      if (extra && typeof extra === 'object') Object.assign(ctx.extraObj, extra);
    };
    const origEnd = res.end;
    const origStatus = res.status;
    res.status = function (code) {
      if (typeof code === 'number') ctx.statusCodeOverride = code;
      return typeof origStatus === 'function' ? origStatus.apply(this, arguments) : this;
    };
    res.end = function patchedEnd(chunk, encoding, callback) {
      try {
        if (!ctx.finalizado) {
          ctx.finalizado = true;
          finalizeEvent(ctx);
        }
      } catch (e) {}
      return origEnd.apply(this, arguments);
    };
    try {
      if (protector && typeof protector.isBlockedIpOrUser === 'function') {
        const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
        const ipHash = redact.hashIp(ip);
        let uidHash = null;
        if (req && req.headers) {
          const raw = req.headers['x-uid-hmac'] || req.headers['x-user-uid'];
          if (raw) uidHash = redact.hashUid(raw);
        }
        const blocked = protector.isBlockedIpOrUser({ ipHash, uidHash });
        if (blocked && protector && protector.mode && protector.mode !== 'monitor') {
          ctx.extraObj.bloqueio_antecipado = true;
          ctx.statusCodeOverride = 403;
          try { finalizeEvent(ctx); } catch (e) {}
          res.statusCode = 403;
          res.setHeader('Retry-After', String(Math.ceil(((blocked.ttlMs || 1800000) / 1000))));
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          const body = JSON.stringify({ ok: false, msg: 'Bloqueio temporário Security Agent. Tente novamente em alguns minutos.', bloqueio: { motivo: blocked.motivo || 'anomalia', ttl_s: Math.ceil((blocked.ttlMs || 1800000) / 1000) } });
          res.end = origEnd;
          return res.end(body);
        }
      }
    } catch (e) {
      try { console.warn('[SECURITY_collector] block pre-check failed:', String(e.message || e).substring(0, 120)); } catch (nope) {}
    }
    next();
  };
}

function wrapExpressErrorHandler(opts) {
  const o = opts || {};
  const store = o.store || null;
  const redact = o.redact || (require('./redact'));
  const analyzer = o.analyzer || null;
  return function securityErrorHandler(err, req, res, next) {
    try {
      if (req && req._secCtx) {
        const ctx = req._secCtx;
        if (err instanceof Error) {
          ctx.errMsgShort = String(err.message || '').substring(0, 300);
          if (typeof err.stack === 'string') {
            const linhas = err.stack.split('\n');
            ctx.errStackFirstLine = (linhas[1] || '').substring(0, 200);
          }
        }
        ctx.statusCodeOverride = (res && typeof res.statusCode === 'number') ? res.statusCode : 500;
        if (ctx.extraObj) {
          ctx.extraObj.unhandled_exception = true;
          ctx.extraObj.errName = err && err.name ? String(err.name).substring(0, 60) : '';
        }
      } else {
        try {
          const ipRaw = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
          const evt = {
            id: 'evt_err_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            ts: Date.now(),
            durationMs: 0,
            category: 'interno',
            type: 'unhandled_exception',
            ip: redact.redactIp(ipRaw),
            ipHashSha256: redact.hashIp(ipRaw),
            uid: null,
            method: req && req.method ? String(req.method).toUpperCase().substring(0, 8) : 'UNKNOWN',
            path: req && (req.originalUrl || req.url) ? String(req.originalUrl || req.url).substring(0, 300) : '/',
            pathMasked: req ? maskPath(req.originalUrl || req.url || '/') : '/',
            statusCode: (res && typeof res.statusCode === 'number') ? res.statusCode : 500,
            bodyRedacted: {},
            uaRedacted: req && req.headers ? redact.redactUserAgent(req.headers['user-agent']) : '',
            referer: '',
            origin: '',
            isAdminRoute: false,
            adminAuthenticated: false,
            extra: {
              unhandled_exception: true,
              errMsg: err ? String(err.message || '').substring(0, 300) : '',
              errStackFirstLine: err && err.stack ? err.stack.split('\n')[1].substring(0, 200) : '',
              errName: err && err.name ? String(err.name).substring(0, 60) : ''
            }
          };
          if (store && typeof store.addEvent === 'function') store.addEvent(evt);
          if (analyzer && typeof analyzer.ingest === 'function') try { analyzer.ingest(evt); } catch (nope) {}
        } catch (nested) {}
      }
    } catch (eOuter) {}
    if (typeof next === 'function') next(err);
  };
}

function createEventManual(opts) {
  const o = opts || {};
  const store = o.store || null;
  const redact = o.redact || (require('./redact'));
  const analyzer = o.analyzer || null;
  const protector = o.protector || null;
  const category = typeof o.category === 'string' ? o.category : 'http';
  const type = typeof o.type === 'string' ? o.type.substring(0, 80) : 'manual_event';
  const ipRaw = typeof o.ip === 'string' ? o.ip : (typeof o.ipCapturado === 'string' ? o.ipCapturado : 'unknown');
  const uidRaw = o.uid || o.uidRaw || null;
  const now = Date.now();
  const evt = {
    id: 'evt_man_' + now + '_' + Math.random().toString(36).slice(2, 10),
    ts: now,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
    category: CATEGORIAS_VALIDAS.has(category) ? category : 'http',
    type: type,
    ip: redact.redactIp(ipRaw),
    ipHashSha256: redact.hashIp(ipRaw),
    uid: uidRaw ? redact.hashUid(uidRaw) : null,
    method: typeof o.method === 'string' ? o.method.toUpperCase().substring(0, 8) : '',
    path: typeof o.path === 'string' ? o.path.substring(0, 300) : '',
    pathMasked: typeof o.pathMasked === 'string' ? o.pathMasked : maskPath(typeof o.path === 'string' ? o.path : '/manual'),
    statusCode: typeof o.statusCode === 'number' ? o.statusCode : 0,
    bodyRedacted: o.body ? redact.redactBody(JSON.parse(JSON.stringify(o.body))) : {},
    uaRedacted: typeof o.userAgent === 'string' ? redact.redactUserAgent(o.userAgent) : '',
    referer: typeof o.referer === 'string' ? o.referer.substring(0, 300) : '',
    origin: typeof o.origin === 'string' ? o.origin.substring(0, 200) : '',
    isAdminRoute: !!o.isAdminRoute,
    adminAuthenticated: !!o.adminAuthenticated,
    extra: o.extra && typeof o.extra === 'object' ? redact.redactBody(o.extra) : {}
  };
  try { if (store && typeof store.addEvent === 'function') store.addEvent(evt); } catch (e) {}
  let scoreAtual = null;
  try { if (analyzer && typeof analyzer.ingest === 'function') scoreAtual = analyzer.ingest(evt); } catch (e) {}
  try {
    if (protector && typeof protector.checkShouldBlock === 'function') {
      const dec = protector.checkShouldBlock({ evento: evt, scoreAtual });
      if (dec && typeof dec === 'object') evt.protection = Object.assign({}, dec);
    }
  } catch (e) {}
  return evt;
}

module.exports = {
  CATEGORIAS_VALIDAS,
  maskPath,
  detectarCategoria,
  makeSecurityMiddleware,
  wrapExpressErrorHandler,
  createEventManual
};
