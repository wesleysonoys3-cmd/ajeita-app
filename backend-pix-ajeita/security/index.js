'use strict';

const VERSION = '1.0.0-monitor-first';

const redact = require('./redact');
const storeMod = require('./store');
const collector = require('./collector');
const analyzerMod = require('./analyzer');
const protectorMod = require('./protector');
const healthMod = require('./health');
const aiMod = require('./ai');
const dashboard = require('./dashboard');

const store = storeMod.securityStore;
const analyzer = analyzerMod.securityAnalyzer;
const protector = protectorMod.securityProtector;
const ai = aiMod.securityAI;

if (store && analyzer && typeof store._wireAnalyzer !== 'function') {
  try { store._wireAnalyzer = analyzer; } catch (e) {}
}

if (protector && typeof protector.listActiveBlocks !== 'function') {
  protector.listActiveBlocks = function () {
    const r = [];
    try { if (typeof protector._cleanupExpirados === 'function') protector._cleanupExpirados(); } catch (e) {}
    try {
      if (protector.blocksByIpHash && typeof protector.blocksByIpHash.entries === 'function') {
        for (const [ipHash, blk] of protector.blocksByIpHash.entries()) {
          r.push({ ipHash, ts: (blk && blk.tsCriado) || 0, expireAt: (blk && blk.tsExpireMs) || 0, actionId: (blk && blk.actionId) || '', real: !!(blk && blk.realAplicado) });
        }
      }
    } catch (e) {}
    return r;
  };
}

if (protector && typeof protector.setMode === 'function') {
  const _origSetMode = protector.setMode.bind(protector);
  protector.setMode = function (novoModo, senha1, senha2, motivo) {
    const modo = String(novoModo || '').toLowerCase();
    if (modo === 'off') {
      return _origSetMode(novoModo, senha1, senha2, senha2, motivo);
    }
    if (modo === 'protect' || modo === 'monitor') {
      const r = _origSetMode(novoModo, senha1, senha2, undefined, motivo);
      if (r && r.ok) {
        return Object.assign({ ok: true, mode_antes: modo === 'protect' ? 'monitor' : 'protect', mode_depois: r.mode || modo }, r || {});
      }
      return Object.assign({ ok: false, httpCode: r && (r.status || r.httpCode) || 401 }, r || {});
    }
    const r = _origSetMode(novoModo, senha1, senha2, undefined, motivo);
    return Object.assign({ ok: !!(r && r.ok), httpCode: r && (r.status || r.httpCode) || 400 }, r || {});
  };
}

let health = null;
try {
  const hc = healthMod.SecurityHealth || null;
  if (hc) {
    health = new hc({ analyzer, store, protector });
  } else health = healthMod.securityHealth || null;
} catch (e) { health = null; }

if (health && health.analyzer == null) { try { health.analyzer = analyzer; } catch (e) {} }
if (health && health.store == null) { try { health.store = store; } catch (e) {} }
if (health && health.protector == null) { try { health.protector = protector; } catch (e) {} }

if (ai && ai.store == null) { try { ai.store = store; } catch (e) {} }
if (analyzer && typeof analyzer._wire === 'undefined') {
  try { analyzer._ai = ai; } catch (e) {}
}

const securityBundle = {
  store, analyzer, protector, health, ai, redact,
  VERSION
};

const middleware = (function () {
  try {
    if (collector && typeof collector.makeSecurityMiddleware === 'function') {
      return collector.makeSecurityMiddleware({ store, redact, analyzer, protector });
    }
  } catch (e) {
    console.warn('[SECURITY_AGENT] makeSecurityMiddleware falhou: ' + String((e && e.message) || e).substring(0, 200));
  }
  return function _sec_mw_off(req, res, next) { if (typeof next === 'function') next(); };
})();

const errorHandler = (function () {
  try {
    if (collector && typeof collector.wrapExpressErrorHandler === 'function') {
      const eh = collector.wrapExpressErrorHandler({ store, redact, analyzer, protector });
      return function (err, req, res, next) {
        try { eh(err, req, res, () => {}); } catch (eIn) {}
        if (typeof next === 'function') { try { next(err); } catch (eNext) {} }
      };
    }
  } catch (e) {
    console.warn('[SECURITY_AGENT] errorHandler wrap falhou: ' + String((e && e.message) || e).substring(0, 200));
  }
  return function (err, req, res, next) { if (typeof next === 'function') next(err); };
})();

function createEventManual(opts) {
  try {
    if (collector && typeof collector.createEventManual === 'function') {
      return collector.createEventManual(Object.assign({ store, redact, analyzer, protector }, opts || {}));
    }
  } catch (e) {}
  return null;
}

function registerRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  try {
    if (dashboard && typeof dashboard.registerAdminEndpoints === 'function') {
      dashboard.registerAdminEndpoints({ app, security: securityBundle });
    }
  } catch (e) {
    console.warn('[SECURITY_AGENT] registerAdminEndpoints falhou: ' + String((e && e.message) || e).substring(0, 200));
  }
}

module.exports = {
  middleware,
  errorHandler,
  registerRoutes,
  createEventManual,
  VERSION,
  store,
  analyzer,
  protector,
  health,
  ai,
  redact,
  dashboard,
  collector,
  healthMod,
  aiMod,
  storeMod,
  analyzerMod,
  protectorMod
};
