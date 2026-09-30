'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_FILENAME = 'security_data.json';
const EVENTS_ROTATE_THRESHOLD = 10000;
const EVENTS_RETAIN_AFTER_ROTATE = 500;
const FLUSH_INTERVAL_MS = 2000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function _emptyData(criadoEmOverride) {
  return {
    events: [],
    incidents: [],
    alerts: [],
    sessions: {},
    adminAudit: [],
    health: {},
    meta: {
      criadoEm: criadoEmOverride || Date.now(),
      rotacoes: 0,
      flushCount: 0,
      versao: '1.0.0-monitor-first'
    },
    _internals: {
      alertsLastAtByKey: {}
    }
  };
}

class SecurityStore {
  constructor(opts) {
    const o = opts || {};
    this.storePath = o.storePath || process.env.SECURITY_STORE_PATH ||
      path.join(__dirname, DEFAULT_STORE_FILENAME);
    this.backend = (o.backend || process.env.SECURITY_STORE || 'file').toLowerCase();
    this._flushIntervalMs = o.flushIntervalMs || FLUSH_INTERVAL_MS;
    this._rotateThreshold = o.rotateThreshold || EVENTS_ROTATE_THRESHOLD;
    this._retainAfterRotate = o.retainAfterRotate || EVENTS_RETAIN_AFTER_ROTATE;
    this._alertCooldownMs = o.alertCooldownMs || ALERT_COOLDOWN_MS;
    this._data = null;
    this._dirtySince = 0;
    this._pendingFlush = false;
    this._flushTimer = null;
    this._firestoreClient = null;
    this._inicializar();
  }

  _inicializar() {
    if (this.backend === 'firestore') {
      try {
        const fb = require('firebase-admin');
        if (fb && fb.apps && fb.apps.length > 0) {
          this._firestoreClient = fb.firestore();
        }
      } catch (e) {
        this._firestoreClient = null;
      }
      if (!this._firestoreClient) {
        this.backend = 'file';
      }
    }

    if (this.backend === 'file') {
      try {
        if (fs.existsSync(this.storePath)) {
          const raw = fs.readFileSync(this.storePath, 'utf8');
          const parsed = JSON.parse(raw);
          const empty = _emptyData(parsed && parsed.meta && parsed.meta.criadoEm);
          this._data = Object.assign({}, empty, parsed);
          if (!this._data._internals) this._data._internals = { alertsLastAtByKey: {} };
        } else {
          this._data = _emptyData();
          fs.writeFileSync(this.storePath, JSON.stringify(this._data, null, 0), { mode: 0o600 });
        }
      } catch (e) {
        this._data = _emptyData();
        try { fs.writeFileSync(this.storePath, JSON.stringify(this._data, null, 0), { mode: 0o600 }); } catch (er) {}
      }
      this._startFlushTimer();
    } else {
      this._data = _emptyData();
    }
  }

  _startFlushTimer() {
    if (typeof setInterval !== 'function' || this.backend !== 'file') return;
    if (this._flushTimer) return;
    try {
      this._flushTimer = setInterval(() => {
        if (this._dirtySince > 0) {
          this.flush().catch(() => {});
        }
      }, this._flushIntervalMs);
      if (this._flushTimer && typeof this._flushTimer.unref === 'function') {
        this._flushTimer.unref();
      }
    } catch (e) {}
  }

  stop() {
    if (this._flushTimer) {
      try { clearInterval(this._flushTimer); } catch (e) {}
      this._flushTimer = null;
    }
  }

  get events() { return this._data.events || []; }
  get incidents() { return this._data.incidents || []; }
  get alerts() { return this._data.alerts || []; }
  get meta() { return this._data.meta || {}; }
  get sessions() { return this._data.sessions || {}; }
  get adminAudit() { return this._data.adminAudit || []; }
  get health() { return this._data.health || {}; }

  addEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    if (!evt.id) evt.id = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    if (!evt.ts) evt.ts = Date.now();
    this._data.events.push(evt);
    this._dirtySince = Date.now();
    if (this._data.events.length > this._rotateThreshold * 1.2) {
      try { this.rotate(); } catch (e) {}
    }
  }

  addIncident(inc) {
    if (!inc || typeof inc !== 'object') return;
    if (!inc.incidentId) inc.incidentId = 'inc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (!inc.timestamp) inc.timestamp = Date.now();
    if (!inc.status) inc.status = 'OPEN';
    if (!inc.statusHistorico) inc.statusHistorico = [{ status: inc.status, ts: inc.timestamp, motivo: 'Criado automaticamente pelo Security Agent.' }];
    if (!inc.evidence) inc.evidence = [];
    this._data.incidents.push(inc);
    this._dirtySince = Date.now();
    return inc.incidentId;
  }

  _alertaChave(alert) {
    const regraId = alert.regraId || alert.ruleId || 'any';
    const ipHash = alert.ipHash || alert.ipHashSha256 || 'any';
    return regraId + '|' + ipHash;
  }

  addAlert(alert) {
    if (!alert || typeof alert !== 'object') return { added: false, reason: 'invalid' };
    const now = Date.now();
    const chave = this._alertaChave(alert);
    const ultimo = this._data._internals.alertsLastAtByKey[chave];
    if (ultimo && (now - ultimo) < this._alertCooldownMs) {
      return { added: false, reason: 'cooldown', cooldownMsLeft: this._alertCooldownMs - (now - ultimo) };
    }
    if (!alert.alertId) alert.alertId = 'alt_' + now + '_' + Math.random().toString(36).slice(2, 8);
    if (!alert.timestamp) alert.timestamp = now;
    this._data._internals.alertsLastAtByKey[chave] = now;
    this._data.alerts.push(alert);
    this._dirtySince = Date.now();
    return { added: true, alertId: alert.alertId };
  }

  listEvents(opts) {
    const o = opts || {};
    const limit = typeof o.limit === 'number' ? Math.max(0, Math.min(500, o.limit)) : 50;
    const category = typeof o.category === 'string' && o.category ? o.category : null;
    let arr = this._data.events;
    if (category) arr = arr.filter(e => e.category === category);
    arr = arr.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return arr.slice(0, limit);
  }

  listIncidents(opts) {
    const o = opts || {};
    const status = typeof o.status === 'string' && o.status ? o.status : null;
    let arr = this._data.incidents.slice();
    if (status) arr = arr.filter(i => i.status === status);
    arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return arr;
  }

  updateIncident(incId, patch, motivo) {
    if (!incId) return { ok: false, msg: 'incidentId ausente' };
    const inc = this._data.incidents.find(i => i.incidentId === incId);
    if (!inc) return { ok: false, msg: 'incidente não encontrado' };
    const motivoStr = typeof motivo === 'string' ? motivo : (patch && typeof patch.motivo === 'string' ? patch.motivo : 'Atualização manual');
    const patches = typeof patch === 'object' && patch ? Object.assign({}, patch) : {};
    delete patches.motivo;
    delete patches.incidentId;
    delete patches.timestamp;
    if (patches.status) {
      if (!['OPEN','INVESTIGATING','CONTAINED','RESOLVED'].includes(patches.status)) {
        return { ok: false, msg: 'status inválido' };
      }
      if (typeof motivoStr !== 'string' || motivoStr.length < 8) {
        return { ok: false, msg: 'motivo deve ter >=8 caracteres' };
      }
      inc.statusHistorico = inc.statusHistorico || [];
      inc.statusHistorico.push({ status: patches.status, ts: Date.now(), motivo: motivoStr });
      inc.status = patches.status;
      delete patches.status;
    }
    for (const k of Object.keys(patches)) {
      if (k === 'evidence' && Array.isArray(patches.evidence)) {
        inc.evidence = (inc.evidence || []).concat(patches.evidence);
      } else {
        inc[k] = patches[k];
      }
    }
    inc.updatedAt = Date.now();
    this._dirtySince = Date.now();
    return { ok: true, incidente: inc };
  }

  listAlerts(opts) {
    const o = opts || {};
    const limit = typeof o.limit === 'number' ? Math.max(0, Math.min(300, o.limit)) : 50;
    return this._data.alerts.slice().sort((a,b) => (b.timestamp||0) - (a.timestamp||0)).slice(0, limit);
  }

  setHealth(key, value) {
    if (typeof key !== 'string') return;
    this._data.health[key] = Object.assign({ ultimaChecagemEm: Date.now() }, value || {});
    this._dirtySince = Date.now();
  }

  addAdminAudit(entry) {
    if (!entry || typeof entry !== 'object') return;
    if (!entry.auditId) entry.auditId = 'adm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (!entry.timestamp) entry.timestamp = Date.now();
    this._data.adminAudit.push(entry);
    if (this._data.adminAudit.length > 500) this._data.adminAudit = this._data.adminAudit.slice(-500);
    this._dirtySince = Date.now();
  }

  rotate() {
    if (this.backend !== 'file') return { ok: false, reason: 'backend_nao_arquivo' };
    const now = Date.now();
    if (this._data.events.length <= this._rotateThreshold) {
      return { ok: false, reason: 'abaixo_threshold', events: this._data.events.length };
    }
    const oldPath = this.storePath.replace(/\.json$/i, '') + '.old_' + now + '.json';
    try {
      fs.writeFileSync(oldPath, JSON.stringify(this._data, null, 0), { mode: 0o600 });
    } catch (e) {
      return { ok: false, reason: 'escrita_old_falhou', msg: String(e.message || e).substring(0, 200) };
    }
    const eventsNovo = this._data.events.slice().sort((a,b) => (b.ts||0) - (a.ts||0)).slice(0, this._retainAfterRotate);
    const novosDados = _emptyData(this._data.meta.criadoEm);
    novosDados.events = eventsNovo;
    novosDados.incidents = this._data.incidents;
    novosDados.alerts = this._data.alerts.slice(-1000);
    novosDados.sessions = this._data.sessions;
    novosDados.adminAudit = this._data.adminAudit.slice(-500);
    novosDados.health = this._data.health;
    novosDados.meta = Object.assign({}, this._data.meta, {
      rotacoes: (this._data.meta.rotacoes || 0) + 1,
      ultimaRotacaoEm: now
    });
    novosDados._internals = this._data._internals || { alertsLastAtByKey: {} };
    this._data = novosDados;
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this._data, null, 0), { mode: 0o600 });
    } catch (e) {
      return { ok: false, reason: 'escrita_novo_falhou', msg: String(e.message || e).substring(0, 200) };
    }
    this._dirtySince = 0;
    return { ok: true, rotacoes: this._data.meta.rotacoes, eventosRetidos: this._data.events.length };
  }

  async flush() {
    if (this.backend !== 'file') return { ok: false, reason: 'backend_nao_arquivo' };
    const inicio = Date.now();
    if (!this._dirtySince && this._pendingFlush) return { ok: false, reason: 'limpo' };
    this._pendingFlush = true;
    try {
      const copy = {
        events: this._data.events,
        incidents: this._data.incidents,
        alerts: this._data.alerts,
        sessions: this._data.sessions,
        adminAudit: this._data.adminAudit,
        health: this._data.health,
        meta: Object.assign({}, this._data.meta, { ultimoFlushEm: inicio, flushCount: (this._data.meta.flushCount || 0) + 1 }),
        _internals: this._data._internals
      };
      await new Promise((resolve, reject) => {
        fs.writeFile(this.storePath + '.tmp', JSON.stringify(copy, null, 0), { mode: 0o600 }, (werr) => {
          if (werr) return reject(werr);
          fs.rename(this.storePath + '.tmp', this.storePath, (rerr) => {
            if (rerr) return reject(rerr);
            resolve();
          });
        });
      });
      this._dirtySince = 0;
      this._data.meta = copy.meta;
      return { ok: true, durationMs: Date.now() - inicio, events: copy.events.length };
    } catch (e) {
      return { ok: false, msg: String(e.message || e).substring(0, 200) };
    } finally {
      this._pendingFlush = false;
    }
  }

  _eventosCountDesde(fromMs) {
    const f = typeof fromMs === 'number' ? fromMs : 0;
    return this._data.events.reduce((acc, e) => ((e.ts || 0) >= f ? acc + 1 : acc), 0);
  }
}

const securityStore = new SecurityStore();

module.exports = {
  SecurityStore,
  securityStore,
  EVENTS_ROTATE_THRESHOLD,
  EVENTS_RETAIN_AFTER_ROTATE,
  FLUSH_INTERVAL_MS,
  ALERT_COOLDOWN_MS
};
