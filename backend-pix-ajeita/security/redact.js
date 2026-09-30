'use strict';

const crypto = require('crypto');
const path = require('path');

const _ipHashSecretDefault = (() => {
  try {
    return process.env.SECURITY_IP_HASH_SECRET || crypto.randomBytes(32).toString('hex');
  } catch (e) {
    return 'fallback-secret-' + Date.now();
  }
})();

const CHAVES_SENSIVEIS_BODY = new Set([
  'senha', 'password', 'pass', 'token', 'access_token', 'secret',
  'admin_senha', 'senhaAdmin', 'cpf', 'rg', 'telefone', 'whatsapp',
  'celular', 'email', 'from', 'to', 'reply_to', 'SMTP_PASSWORD',
  'api_key', 'apikey', 'authorization', 'Authorization'
]);

function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function redactSenhasTokens(str) {
  if (typeof str !== 'string' || !str) return str;
  let s = str;
  s = s.replace(/(SMTP_PASSWORD\s*[=:]\s*)([^\s&,"'`]+)/gi, '$1[REDACTED_SMTP]');
  s = s.replace(/(MERCADO_PAGO_ACCESS_TOKEN\s*[=:]\s*)([^\s&,"'`]+)/gi, '$1[REDACTED_MP]');
  s = s.replace(/(MP_WEBHOOK_SECRET\s*[=:]\s*)([^\s&,"'`]+)/gi, '$1[REDACTED_MP_SECRET]');
  s = s.replace(/(admin_senha\s*[=:]\s*)([^\s&,"'`]+)/gi, '$1[REDACTED_ADMIN]');
  s = s.replace(/(senhaAdmin\s*[=:]\s*)([^\s&,"'`]+)/gi, '$1[REDACTED_ADMIN]');
  s = s.replace(/(apikey\s*[=:]\s*)([^\s&,"'`]+)/gi, '$1[REDACTED_APIKEY]');
  s = s.replace(/(api_key\s*[=:]\s*)([^\s&,"'`]+)/gi, '$1[REDACTED_APIKEY]');
  s = s.replace(/(SG\.[A-Za-z0-9._\-]{20,})/g, '[REDACTED_SG_KEY]');
  s = s.replace(/(Bearer\s+)([A-Za-z0-9._\-]{20,})/gi, '$1[REDACTED_BEARER]');
  s = s.replace(/(["']?)(secret|token|access_token|password|senha)\1\s*[:=]\s*(["']?)([^"'&\s,]{8,})\3/gi, (m, q1, k, q2, v) => {
    return `${q1}${k}${q1}:${q2}[REDACTED_${k.toUpperCase()}]${q2}`;
  });
  s = s.replace(/\b[A-Za-z0-9]{32,}\b/g, (m) => {
    if (/^[0-9]+$/.test(m)) return m;
    if (/^(SG\.|APP_USR-|sk-|pk-)/.test(m)) return '[REDACTED_LONGKEY]';
    return m;
  });
  return s;
}

function redactPhone(str) {
  if (typeof str !== 'string' || !str) return str;
  let s = str;
  s = s.replace(/\b(\d{2})?(\d{2})(\d{4,5})(\d{4})\b/g, (match, ddi, ddd, meio, fim) => {
    const p1 = ddi || '';
    const p2 = ddd || '';
    return p1 + p2 + '****' + fim;
  });
  s = s.replace(/\b(\d{10,13})\b/g, (m) => {
    if (m.length >= 11) {
      return m.substring(0, Math.max(2, m.length - 8)) + '****' + m.substring(m.length - 4);
    }
    return '****' + m.substring(m.length - 4);
  });
  s = s.replace(/\b(\d{9,})\b/g, (m) => '****' + m.substring(Math.max(0, m.length - 4)));
  return s;
}

function redactEmail(str) {
  if (typeof str !== 'string' || !str) return str;
  return str.replace(/([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+)\.([A-Za-z]{2,})/g, (m, local, domain, tld) => {
    const l1 = local.charAt(0) || '';
    const d1 = domain.charAt(0) || '';
    return `${l1}***@${d1}***.${tld.substring(0, 3)}`;
  });
}

function redactIp(str) {
  if (typeof str !== 'string' || !str) return str;
  return str.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, '$1.$2.$3.xxx');
}

function hashIp(ip, secret) {
  const sec = (typeof secret === 'string' && secret.length > 0) ? secret : _ipHashSecretDefault;
  if (!ip || typeof ip !== 'string') return 'unknown_ip_hash';
  try {
    return crypto.createHmac('sha256', sec).update(String(ip)).digest('hex');
  } catch (e) {
    return 'hash_error_' + Math.random().toString(36).slice(2, 10);
  }
}

function hashUid(uid, secret) {
  const sec = (typeof secret === 'string' && secret.length > 0) ? secret : _ipHashSecretDefault;
  if (!uid || (typeof uid !== 'string' && typeof uid !== 'number')) return 'unknown_uid_hash';
  try {
    return crypto.createHmac('sha256', sec).update(String(uid)).digest('hex');
  } catch (e) {
    return 'hash_error_' + Math.random().toString(36).slice(2, 10);
  }
}

function redactUserAgent(ua) {
  if (typeof ua !== 'string' || !ua) return '';
  let s = ua.substring(0, 120);
  s = s.replace(/[A-Za-z0-9]{30,}/g, (m) => m.substring(0, 6) + '...');
  return s;
}

function _redactChaveSensivelValor(chave, valor) {
  const k = String(chave).toLowerCase();
  if (typeof valor === 'string') {
    if (k === 'email' || k === 'from' || k === 'to' || k === 'reply_to') {
      return redactEmail(valor);
    }
    if (k === 'telefone' || k === 'whatsapp' || k === 'celular') {
      return redactPhone(valor);
    }
    if (k === 'cpf' || k === 'rg') {
      return '[REDACTED_DOC]';
    }
    if (['senha', 'password', 'pass', 'token', 'access_token', 'secret',
         'admin_senha', 'senhaadmin', 'smtp_password', 'api_key', 'apikey',
         'authorization'].includes(k)) {
      return '[REDACTED_' + k.toUpperCase().replace(/[^A-Z0-9]/g,'_') + ']';
    }
    let v = redactSenhasTokens(valor);
    v = redactPhone(v);
    v = redactEmail(v);
    return v;
  }
  if (typeof valor === 'number') return valor;
  if (valor === null || valor === undefined) return valor;
  return valor;
}

function redactBody(payload, depth) {
  const d = typeof depth === 'number' ? depth : 0;
  if (d > 4) {
    if (typeof payload === 'string') return redactSenhasTokens(redactPhone(redactEmail(payload)));
    if (_isPlainObject(payload) || Array.isArray(payload)) return '[REDACTED_DEPTH]';
    return payload;
  }
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === 'string') {
    let v = redactSenhasTokens(payload);
    v = redactPhone(v);
    v = redactEmail(v);
    return v;
  }
  if (typeof payload === 'number' || typeof payload === 'boolean') return payload;
  if (Array.isArray(payload)) {
    return payload.map((it) => redactBody(it, d + 1));
  }
  if (_isPlainObject(payload)) {
    const out = {};
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (CHAVES_SENSIVEIS_BODY.has(k) || CHAVES_SENSIVEIS_BODY.has(k.toLowerCase())) {
        out[k] = _redactChaveSensivelValor(k, v);
      } else {
        out[k] = redactBody(v, d + 1);
      }
    }
    return out;
  }
  if (payload instanceof Date) return payload;
  try {
    return String(payload);
  } catch (e) {
    return '[REDACTED_UNKNOWN]';
  }
}

function redact(str) {
  if (typeof str !== 'string' || !str) return str;
  let s = redactSenhasTokens(str);
  s = redactPhone(s);
  s = redactEmail(s);
  return s;
}

module.exports = {
  CHAVES_SENSIVEIS_BODY,
  _ipHashSecret: _ipHashSecretDefault,
  redactSenhasTokens,
  redactPhone,
  redactEmail,
  redactIp,
  hashIp,
  hashUid,
  redactUserAgent,
  redactBody,
  redact
};
