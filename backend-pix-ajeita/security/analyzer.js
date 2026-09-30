'use strict';

const JANELA_IP_RETENCAO_MS = 24 * 60 * 60 * 1000;
const LIMPEZA_INTERVALO_MS = 60 * 1000;

function rotuloScore(valor) {
  const v = Math.max(0, Math.min(100, valor | 0));
  if (v <= 29) return 'BAIXO';
  if (v <= 59) return 'MODERADO';
  if (v <= 79) return 'ALTO';
  return 'CRÍTICO';
}

function _contar(lista, predicate, janelaMs, fromTs) {
  const base = typeof fromTs === 'number' ? fromTs : (lista.length > 0 ? (lista[lista.length - 1] && lista[lista.length - 1].ts) : Date.now());
  if (!base) return 0;
  const inicio = base - janelaMs;
  let n = 0;
  for (let i = lista.length - 1; i >= 0; i--) {
    const e = lista[i];
    const ts = e && e.ts;
    if (!ts) continue;
    if (ts < inicio) break;
    try { if (predicate(e)) n++; } catch (x) {}
  }
  return n;
}

function _mesmoPath(lista, pathMasked, janelaMs, fromTs) {
  return _contar(lista, (e) => e.pathMasked === pathMasked, janelaMs, fromTs);
}

function _countByKey(lista, keyFn, janelaMs, fromTs) {
  const base = typeof fromTs === 'number' ? fromTs : Date.now();
  const inicio = base - janelaMs;
  const counts = new Map();
  for (let i = lista.length - 1; i >= 0; i--) {
    const e = lista[i];
    if (!e || !e.ts || e.ts < inicio) break;
    try {
      const k = keyFn(e);
      if (k == null) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    } catch (x) {}
  }
  return counts;
}

class SecurityAnalyzer {
  constructor(opts) {
    const o = opts || {};
    this.store = o.store || null;
    this.eventsByIpHash = new Map();
    this.eventsByUidHash = new Map();
    this.ultimosScoresPorIp = new Map();
    this.ultimosScoresPorUid = new Map();
    this.ultimaChamadaIaAconteceu = false;
    this.ultimaChamadaIaEm = 0;
    this._healthBackendFalhasConsecutivas = 0;
    this._limpezaTimer = null;
    this._iniciarLimpeza();
  }

  _iniciarLimpeza() {
    if (typeof setInterval !== 'function') return;
    if (this._limpezaTimer) return;
    try {
      this._limpezaTimer = setInterval(() => this._limparAntigos(), LIMPEZA_INTERVALO_MS);
      if (this._limpezaTimer && typeof this._limpezaTimer.unref === 'function') this._limpezaTimer.unref();
    } catch (e) {}
  }

  stop() {
    if (this._limpezaTimer) { try { clearInterval(this._limpezaTimer); } catch (e) {} this._limpezaTimer = null; }
  }

  _limparAntigos() {
    const agora = Date.now();
    const corte = agora - JANELA_IP_RETENCAO_MS;
    for (const [ip, arr] of this.eventsByIpHash.entries()) {
      if (!Array.isArray(arr)) { this.eventsByIpHash.delete(ip); continue; }
      while (arr.length > 0 && arr[0] && arr[0].ts < corte) arr.shift();
      if (arr.length === 0) this.eventsByIpHash.delete(ip);
    }
    for (const [uid, arr] of this.eventsByUidHash.entries()) {
      if (!Array.isArray(arr)) { this.eventsByUidHash.delete(uid); continue; }
      while (arr.length > 0 && arr[0] && arr[0].ts < corte) arr.shift();
      if (arr.length === 0) this.eventsByUidHash.delete(uid);
    }
    const corteScore = agora - 30 * 60 * 1000;
    for (const [k, v] of this.ultimosScoresPorIp.entries()) {
      if (!v || v.ts < corteScore) this.ultimosScoresPorIp.delete(k);
    }
    for (const [k, v] of this.ultimosScoresPorUid.entries()) {
      if (!v || v.ts < corteScore) this.ultimosScoresPorUid.delete(k);
    }
  }

  _adicionarEventoMap(map, chave, evento) {
    if (!chave || typeof chave !== 'string') return;
    let arr = map.get(chave);
    if (!arr) { arr = []; map.set(chave, arr); }
    arr.push(evento);
    if (arr.length > 5000) {
      map.set(chave, arr.slice(Math.max(0, arr.length - 2500)));
    }
  }

  ingest(evt) {
    if (!evt || typeof evt !== 'object') return 0;
    if (!evt.ts) evt.ts = Date.now();
    if (evt.ipHashSha256) this._adicionarEventoMap(this.eventsByIpHash, evt.ipHashSha256, evt);
    if (evt.uid) this._adicionarEventoMap(this.eventsByUidHash, evt.uid, evt);
    const ipScore = evt.ipHashSha256 ? this.scoreForIp(evt.ipHashSha256) : { valor: 0, motivos: [{ regraId: 'NONE', pontos: 0, evidencia: 'sem_ip' }], janela_ms: 0 };
    const uidScore = evt.uid ? this.scoreForUid(evt.uid) : null;
    const scoreAtual = uidScore && uidScore.valor > ipScore.valor ? uidScore.valor : ipScore.valor;
    if (evt.ipHashSha256) {
      this.ultimosScoresPorIp.set(evt.ipHashSha256, { valor: ipScore.valor, motivos: ipScore.motivos, ts: evt.ts, scoreObj: ipScore });
    }
    if (evt.uid) {
      this.ultimosScoresPorUid.set(evt.uid, { valor: (uidScore && uidScore.valor) || 0, motivos: (uidScore && uidScore.motivos) || [], ts: evt.ts });
    }
    return scoreAtual;
  }

  registrarHealthBackendFalhou() {
    this._healthBackendFalhasConsecutivas++;
    return this._healthBackendFalhasConsecutivas;
  }
  registrarHealthBackendOk() { this._healthBackendFalhasConsecutivas = 0; return 0; }

  _aplicarRegras(listaEventos, tipoJanela, chaveIdentidade) {
    const motivos = [];
    const agora = listaEventos.length > 0 ? (listaEventos[listaEventos.length - 1] && listaEventos[listaEventos.length - 1].ts) : Date.now();
    if (!Array.isArray(listaEventos) || listaEventos.length === 0) {
      return { soma: 0, motivos: [{ regraId: 'OK_EMPTY', pontos: 0, evidencia: 'Janela sem eventos suspeitos.' }] };
    }

    const loginLike = (e) => {
      const c = (e.category || '').toLowerCase();
      const t = (e.type || '').toLowerCase();
      const p = (e.pathMasked || '').toLowerCase();
      if (c === 'login' || c === 'autenticacao' || c === 'recuperacao_senha') return true;
      if (c === 'admin_alteracao' && e.isAdminRoute && !e.adminAuthenticated) return true;
      if (e.statusCode === 401) return true;
      if (/login|auth|autentic|oauth|google|senha|redefin|recuperar/.test(t + ' ' + p)) return true;
      return false;
    };
    const nLogin = _contar(listaEventos, loginLike, 30 * 1000, agora);
    if (nLogin >= 8) motivos.push({ regraId: 'R01', pontos: 20, evidencia: nLogin + ' tentativas de login/autenticação em 30s (limite 8).' });
    else if (nLogin >= 5) motivos.push({ regraId: 'R01', pontos: 10, evidencia: nLogin + ' tentativas de login em 30s.' });

    const total10s = _contar(listaEventos, () => true, 10 * 1000, agora);
    if (total10s >= 50) motivos.push({ regraId: 'R02', pontos: 25, evidencia: total10s + ' requisições em 10s (pico tráfego).' });
    else if (total10s >= 25) motivos.push({ regraId: 'R02', pontos: 12, evidencia: total10s + ' requisições em 10s.' });

    const ultimoEvt = listaEventos[listaEventos.length - 1];
    if (ultimoEvt && ultimoEvt.pathMasked) {
      const nMesmoPath = _mesmoPath(listaEventos, ultimoEvt.pathMasked, 2 * 60 * 1000, agora);
      if (nMesmoPath >= 30) motivos.push({ regraId: 'R03', pontos: 15, evidencia: nMesmoPath + ' chamadas a "' + ultimoEvt.pathMasked + '" em 2 minutos.' });
      else if (nMesmoPath >= 15) motivos.push({ regraId: 'R03', pontos: 7, evidencia: nMesmoPath + ' chamadas a "' + ultimoEvt.pathMasked + '" em 2min.' });
    }

    const n404 = _contar(listaEventos, (e) => e.statusCode === 404 || (e.statusCode >= 400 && e.statusCode < 410 && e.statusCode !== 401), 5 * 60 * 1000, agora);
    if (n404 >= 10) motivos.push({ regraId: 'R04', pontos: 15, evidencia: n404 + ' respostas 4xx (404/403 etc) em 5min.' });

    const uaBot = (e) => /bot|crawl|spider|scrapy|curl|python-requests|wget|httpclient|go-http-client|java\/|okhttp/i.test(e.uaRedacted || '') || (e.extra && e.extra.scraping);
    const nBot = _contar(listaEventos, uaBot, 2 * 60 * 1000, agora);
    if (nBot >= 8 && total10s >= 15) motivos.push({ regraId: 'R05', pontos: 20, evidencia: 'Padrão scraping detectado: UA suspeito + ' + nBot + ' requisições em 2min.' });
    else if (nBot >= 4) motivos.push({ regraId: 'R05', pontos: 8, evidencia: nBot + ' requisições de UA suspeito em 2min.' });

    const cadastro = (e) => e.category === 'cadastro' || /cadastro|registro|signup|criar-conta/.test((e.pathMasked || '') + ' ' + (e.type || ''));
    const nCad = _contar(listaEventos, cadastro, 10 * 60 * 1000, agora);
    if (nCad >= 5) motivos.push({ regraId: 'R06', pontos: 20, evidencia: nCad + ' contas criadas em 10 minutos (anormal).' });

    if (tipoJanela === 'uid' && chaveIdentidade) {
      const ipsDistintos = new Set();
      const desde = agora - 10 * 60 * 1000;
      for (let i = listaEventos.length - 1; i >= 0; i--) {
        const e = listaEventos[i]; if (!e || !e.ts || e.ts < desde) break;
        if (e.ipHashSha256) ipsDistintos.add(e.ipHashSha256);
      }
      if (ipsDistintos.size >= 5) motivos.push({ regraId: 'R07', pontos: 20, evidencia: 'Sessão/UID ' + ipsDistintos.size + ' IPs diferentes em 10min (anormal).' });
    } else if (tipoJanela === 'ip' && total10s >= 30) {
      const pathsDistintos = new Set();
      const desde = agora - 60 * 1000;
      for (let i = listaEventos.length - 1; i >= 0; i--) {
        const e = listaEventos[i]; if (!e || !e.ts || e.ts < desde) break;
        if (e.pathMasked) pathsDistintos.add(e.pathMasked);
      }
      if (pathsDistintos.size >= 15 && nBot >= 2) motivos.push({ regraId: 'R07', pontos: 15, evidencia: pathsDistintos.size + ' paths distintos/minuto + tráfego alto, padrão scanner.' });
    }

    const nPag = _contar(listaEventos, (e) => e.category === 'pagamento' && /criar|recarga|pagamento|pix/i.test(e.type || ''), 2 * 60 * 1000, agora);
    if (nPag >= 3) motivos.push({ regraId: 'R09', pontos: 20, evidencia: nPag + ' tentativas de pagamento em 2 minutos.' });
    else if (nPag >= 2) motivos.push({ regraId: 'R09', pontos: 8, evidencia: nPag + ' pagamentos em 2min.' });

    const n4xx = _contar(listaEventos, (e) => e.statusCode >= 400 && e.statusCode < 500, 2 * 60 * 1000, agora);
    if (n4xx >= 20) motivos.push({ regraId: 'R10', pontos: 15, evidencia: n4xx + ' erros 4xx em 2 minutos (anormal).' });

    const adminFail = (e) => e.isAdminRoute && !e.adminAuthenticated && (e.statusCode === 401 || e.statusCode === 403 || (e.extra && e.extra.admin_auth_attempt));
    const nAdm = _contar(listaEventos, adminFail, 40 * 1000, agora);
    if (nAdm >= 4) motivos.push({ regraId: 'R11', pontos: 20, evidencia: nAdm + ' tentativas admin não autenticadas em 40s.' });

    const n5xx = _contar(listaEventos, (e) => e.statusCode >= 500, 5 * 60 * 1000, agora);
    if (n5xx >= 5) motivos.push({ regraId: 'R12', pontos: 15, evidencia: n5xx + ' erros 5xx em 5 minutos (anormal).' });
    else if (n5xx >= 2) motivos.push({ regraId: 'R12', pontos: 6, evidencia: n5xx + ' erros 5xx em 5min.' });

    const nTel = _contar(listaEventos, (e) => e.category === 'acesso_telefone_cliente' || e.type && /telefone|whatsapp|liberar|desbloquear/.test(e.type), 2 * 60 * 1000, agora);
    if (nTel >= 5) motivos.push({ regraId: 'R13', pontos: 20, evidencia: nTel + ' liberações de telefone em 2 minutos.' });
    else if (nTel >= 3) motivos.push({ regraId: 'R13', pontos: 10, evidencia: nTel + ' liberações de telefone em 2min.' });

    const nR14 = _contar(listaEventos, (e) => e.extra && e.extra.regra_R14_profissional_sem_saldo, 5 * 60 * 1000, agora);
    if (nR14 >= 1) motivos.push({ regraId: 'R14', pontos: 25, evidencia: nR14 + ' evento(s) R14: profissional sem saldo tentou liberar telefone.' });

    const webhookDuplicado = (() => {
      const desde = agora - 5 * 60 * 1000;
      const m = new Map();
      for (let i = listaEventos.length - 1; i >= 0; i--) {
        const e = listaEventos[i]; if (!e || !e.ts || e.ts < desde) break;
        if (e.category !== 'webhook') continue;
        const sig = (e.extra && (e.extra.x_signature || e.extra.data_id || e.extra.external_reference)) || '__no_sig__';
        if (sig === '__no_sig__') continue;
        m.set(sig, (m.get(sig) || 0) + 1);
      }
      let maxDup = 0;
      for (const v of m.values()) if (v > maxDup) maxDup = v;
      return maxDup;
    })();
    if (webhookDuplicado >= 3) motivos.push({ regraId: 'R15', pontos: 15, evidencia: 'Webhook duplicado ' + webhookDuplicado + 'x em 5min (mesma assinatura/external_ref).' });

    const nR16 = _contar(listaEventos, (e) => e.extra && (e.extra.regra_R16_inconsistencia_mp || e.extra.regra_R16_inconsistencia_pagamento), 10 * 60 * 1000, agora);
    if (nR16 >= 1) motivos.push({ regraId: 'R16', pontos: 20, evidencia: nR16 + ' inconsistência pagamento vs liberação de recurso.' });

    if (this._healthBackendFalhasConsecutivas >= 2) {
      motivos.push({ regraId: 'R17', pontos: 10, evidencia: this._healthBackendFalhasConsecutivas + ' falhas consecutivas health-check backend.' });
    }

    if (motivos.length === 0) motivos.push({ regraId: 'OK', pontos: 0, evidencia: 'Nenhuma regra violada. Janela de eventos ok.' });

    let soma = 0;
    for (const m of motivos) soma += (m.pontos | 0);
    return { soma, motivos };
  }

  scoreForIp(ipHash) {
    const lista = this.eventsByIpHash.get(ipHash) || [];
    const res = this._aplicarRegras(lista, 'ip', ipHash);
    const valor = Math.min(100, Math.max(0, res.soma | 0));
    this.ultimaChamadaIaAconteceu = valor >= 60 && res.motivos.length >= 3;
    if (this.ultimaChamadaIaAconteceu) this.ultimaChamadaIaEm = Date.now();
    return {
      valor,
      motivos: res.motivos,
      janela_ms: JANELA_IP_RETENCAO_MS,
      observacoes: [],
      rotulo: rotuloScore(valor),
      totalEventosJanela: lista.length
    };
  }

  scoreForUid(uidHash) {
    const lista = this.eventsByUidHash.get(uidHash) || [];
    const res = this._aplicarRegras(lista, 'uid', uidHash);
    const valor = Math.min(100, Math.max(0, res.soma | 0));
    return {
      valor,
      motivos: res.motivos,
      janela_ms: JANELA_IP_RETENCAO_MS,
      observacoes: [],
      rotulo: rotuloScore(valor),
      totalEventosJanela: lista.length
    };
  }

  scoreGlobal() {
    let maxIp = 0;
    let maxIpMotivos = [{ regraId: 'OK', pontos: 0, evidencia: 'Sem eventos suspeitos (IP).' }];
    let maxUid = 0;
    for (const [, s] of this.ultimosScoresPorIp.entries()) {
      if (s.valor > maxIp) { maxIp = s.valor; maxIpMotivos = s.motivos || maxIpMotivos; }
    }
    for (const [, s] of this.ultimosScoresPorUid.entries()) {
      if (s.valor > maxUid) maxUid = s.valor;
    }
    const erros5xxUltimos = (() => {
      const agora = Date.now();
      const desde = agora - 5 * 60 * 1000;
      let n = 0;
      for (const [, lista] of this.eventsByIpHash.entries()) {
        for (let i = lista.length - 1; i >= 0 && lista[i] && lista[i].ts >= desde; i--) {
          if (lista[i].statusCode >= 500) n++;
        }
      }
      return n;
    })();
    const spike5xx = erros5xxUltimos >= 5 ? 30 : (erros5xxUltimos >= 2 ? 10 : 0);
    const valorSemCap = Math.max(maxIp, maxUid, spike5xx);
    const valor = Math.min(100, Math.max(0, valorSemCap | 0));
    const rotulo = rotuloScore(valor);
    const motivosAgg = maxIp > 0 ? maxIpMotivos : [{ regraId: 'OK', pontos: 0, evidencia: 'Score global baixo. Nenhum IP/UID suspeito.' }];
    if (spike5xx > maxIp && spike5xx > maxUid) motivosAgg.push({ regraId: 'R12_SPIKE', pontos: spike5xx, evidencia: 'Spike 5xx recente: ' + erros5xxUltimos + ' erros/5min.' });
    const incidentsAbertos = this.store && typeof this.store.listIncidents === 'function'
      ? this.store.listIncidents({ status: 'OPEN' }).length + this.store.listIncidents({ status: 'INVESTIGATING' }).length + this.store.listIncidents({ status: 'CONTAINED' }).length
      : 0;
    let statusGlobal;
    if (valor >= 60 || incidentsAbertos >= 2) statusGlobal = 'INCIDENTE';
    else if (valor >= 30 || incidentsAbertos >= 1) statusGlobal = 'ATENÇÃO';
    else statusGlobal = 'PROTEGIDO';
    return {
      valor,
      motivos: motivosAgg,
      rotulo,
      statusGlobal,
      maxIpScore: maxIp,
      maxUidScore: maxUid,
      spikeScore5xx: spike5xx,
      erros5xxJanela5min: erros5xxUltimos,
      incidentsAbertos
    };
  }
}

const securityAnalyzer = new SecurityAnalyzer();

module.exports = {
  SecurityAnalyzer,
  securityAnalyzer,
  rotuloScore,
  JANELA_IP_RETENCAO_MS,
  LIMPEZA_INTERVALO_MS
};
