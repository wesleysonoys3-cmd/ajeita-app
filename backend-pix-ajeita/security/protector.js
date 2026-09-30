'use strict';

const MODO_VALIDO = new Set(['monitor', 'protect', 'off']);
const ACOES_PROIBIDAS = Object.freeze([
  'deleteUser', 'deletePedido', 'deleteAnyData', 'alterarSenhaUsuario',
  'alterarConfiguracaoCritica', 'desligarServidor', 'executarComandoShell',
  'alterarCodigo', 'dropDatabase', 'revokeAll'
]);
const ACOES_PROIBIDAS_SET = new Set(ACOES_PROIBIDAS);
const CLEANUP_INTERVAL_MS = 30 * 1000;
const SELF_ADMIN_WINDOW_MS = 60 * 1000;
const SELF_ADMIN_MAX = 60;
const DEFAULT_BLOCK_TEMP_IP_MS = 30 * 60 * 1000;
const DEFAULT_RATE_LIMIT_TTL_MS = 5 * 60 * 1000;

class SecurityProtector {
  constructor(opts) {
    const o = opts || {};
    this.store = o.store || null;
    this.analyzer = o.analyzer || null;
    this.mode = this._normalizarModo(process.env.SECURITY_MODE || 'monitor');
    this._adminPassword = process.env.SECURITY_ADMIN_PASSWORD || 'bolo2024';
    this.blocksByIpHash = new Map();
    this.rateLimitByIpHash = new Map();
    this.sessoesInvalidadas = new Map();
    this.aumentarMonitoramentoAteMs = null;
    this._cleanupTimer = null;
    this._selfAdminRate = new Map();
    this._iniciarCleanup();
  }

  _normalizarModo(m) {
    const s = String(m || '').toLowerCase().trim();
    return MODO_VALIDO.has(s) ? s : 'monitor';
  }

  _iniciarCleanup() {
    if (typeof setInterval !== 'function') return;
    if (this._cleanupTimer) return;
    try {
      this._cleanupTimer = setInterval(() => this._cleanupExpirados(), CLEANUP_INTERVAL_MS);
      if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
    } catch (e) {}
  }

  stop() {
    if (this._cleanupTimer) { try { clearInterval(this._cleanupTimer); } catch (e) {} this._cleanupTimer = null; }
  }

  _cleanupExpirados() {
    const agora = Date.now();
    for (const [ip, blk] of this.blocksByIpHash.entries()) {
      if (!blk || (blk.tsExpireMs && blk.tsExpireMs < agora)) this.blocksByIpHash.delete(ip);
    }
    for (const [ip, jan] of this.rateLimitByIpHash.entries()) {
      if (!jan || (jan.janelaStartTs && (agora - jan.janelaStartTs) > 2 * SELF_ADMIN_WINDOW_MS)) this.rateLimitByIpHash.delete(ip);
    }
    for (const [uid, ts] of this.sessoesInvalidadas.entries()) {
      if (typeof ts !== 'number' || (agora - ts) > (60 * 60 * 1000)) this.sessoesInvalidadas.delete(uid);
    }
    for (const [ip, jan] of this._selfAdminRate.entries()) {
      if (!jan || !jan.startTs || (agora - jan.startTs) > SELF_ADMIN_WINDOW_MS * 2) this._selfAdminRate.delete(ip);
    }
    if (this.aumentarMonitoramentoAteMs && this.aumentarMonitoramentoAteMs < agora) this.aumentarMonitoramentoAteMs = null;
  }

  setMode(novoModo, senha1, senha2, senha3, motivo) {
    const normalizado = this._normalizarModo(novoModo);
    if (normalizado === 'monitor') {
      if (senha1 !== this._adminPassword) return { ok: false, status: 401, msg: 'Credencial admin inválida para mudar SECURITY_MODE.' };
      this.mode = 'monitor';
      this._logAdminAudit('SET_MODE', { de: this.mode, para: normalizado });
      return { ok: true, mode: 'monitor' };
    }
    if (normalizado === 'protect') {
      if (senha1 !== this._adminPassword || senha2 !== this._adminPassword || senha1 !== senha2) {
        return { ok: false, status: 401, msg: 'SECURITY_MODE=protect requer duas confirmações idênticas da senha admin.' };
      }
      this.mode = 'protect';
      this._logAdminAudit('SET_MODE', { de: this.mode, para: 'protect' });
      return { ok: true, mode: 'protect' };
    }
    if (normalizado === 'off') {
      if (senha1 !== this._adminPassword || senha2 !== this._adminPassword || senha3 !== this._adminPassword) {
        return { ok: false, status: 401, msg: 'SECURITY_MODE=off requer três confirmações idênticas da senha admin.' };
      }
      if (typeof motivo !== 'string' || motivo.length < 12) {
        return { ok: false, status: 400, msg: 'SECURITY_MODE=off requer motivo explícito com pelo menos 12 caracteres.' };
      }
      this.mode = 'off';
      this._logAdminAudit('SET_MODE', { de: this.mode, para: 'off', motivo });
      return { ok: true, mode: 'off' };
    }
    return { ok: false, status: 400, msg: 'Modo inválido: ' + String(novoModo).substring(0, 20) };
  }

  _logAdminAudit(tipo, dados) {
    try {
      if (this.store && typeof this.store.addAdminAudit === 'function') {
        this.store.addAdminAudit({
          tipo: String(tipo).substring(0, 60),
          modoAnterior: this.mode,
          dados: typeof dados === 'object' ? dados : { raw: String(dados).substring(0, 400) }
        });
      }
    } catch (e) {}
  }

  acaoProibida(acaoId) {
    const id = String(acaoId || '').substring(0, 60);
    const proibida = ACOES_PROIBIDAS_SET.has(id) || /delete|drop|alterar_senha|alterar.*senha|executar.*shell|desligar|reboot|shutdown/i.test(id);
    this._logAdminAudit('TENTATIVA_ACAO_PROIBIDA', { acaoId: id, bloqueado: proibida });
    return {
      forbidden: true,
      proibida: proibida,
      motivo: 'acao_nao_reversivel_requer_humano',
      acaoId: id
    };
  }

  isBlockedIpOrUser(opts) {
    if (this.mode === 'off') return null;
    const o = opts || {};
    const agora = Date.now();
    this._cleanupExpirados();
    if (o.ipHash) {
      const blk = this.blocksByIpHash.get(o.ipHash);
      if (blk && (!blk.tsExpireMs || blk.tsExpireMs > agora)) {
        return {
          tipo: 'ip',
          ttlMs: blk.tsExpireMs ? Math.max(0, blk.tsExpireMs - agora) : DEFAULT_BLOCK_TEMP_IP_MS,
          motivo: blk.motivo || 'Anomalia detectada pelo Security Agent',
          actionId: blk.actionId || 'A03',
          real: !!blk.realAplicado
        };
      }
    }
    if (o.uidHash && this.sessoesInvalidadas.has(o.uidHash)) {
      const desde = this.sessoesInvalidadas.get(o.uidHash);
      if (agora - desde < (60 * 60 * 1000)) {
        return { tipo: 'uid', ttlMs: Math.max(0, (60 * 60 * 1000) - (agora - desde)), motivo: 'Sessão invalidada (A04)', actionId: 'A04', real: true };
      } else {
        this.sessoesInvalidadas.delete(o.uidHash);
      }
    }
    return null;
  }

  _bloquearIp(acaoId, ipHash, ttlMs, motivo, realMode) {
    const agora = Date.now();
    const ttl = ttlMs || DEFAULT_BLOCK_TEMP_IP_MS;
    const entry = { actionId: acaoId, tsCriado: agora, tsExpireMs: agora + ttl, ttlMs: ttl, motivo: motivo || 'Bloqueio temporário.', realAplicado: !!realMode };
    this.blocksByIpHash.set(ipHash, entry);
    return entry;
  }

  _incrementarJanelaRate(ipHash, janelaMs) {
    const agora = Date.now();
    let jan = this.rateLimitByIpHash.get(ipHash);
    if (!jan || (agora - jan.janelaStartTs) > janelaMs) {
      jan = { janelaStartTs: agora, contadorJanela: 0 };
      this.rateLimitByIpHash.set(ipHash, jan);
    }
    jan.contadorJanela++;
    return jan.contadorJanela;
  }

  _gerarIncidenteAutomatico(opts) {
    const o = opts || {};
    try {
      if (this.store && typeof this.store.addIncident === 'function') {
        const id = this.store.addIncident({
          severity: o.severity || 'ALTO',
          category: o.category || 'anomalia',
          evidence: o.evidence || [],
          riskScore: o.riskScore || 0,
          actionTaken: {
            acaoId: o.acaoId || '',
            real: !!o.realAplicado,
            simulado: !o.realAplicado,
            descricao: o.descricaoAcao || ''
          },
          summary: o.summary || 'Incidente automático Security Agent'
        });
        return id;
      }
    } catch (e) {}
    return null;
  }

  _gerarAlerta(opts) {
    const o = opts || {};
    try {
      if (this.store && typeof this.store.addAlert === 'function') {
        return this.store.addAlert({
          regraId: o.regraId || '',
          ipHash: o.ipHash || '',
          uidHash: o.uidHash || '',
          score: o.score || 0,
          severity: o.severity || 'ALTO',
          mensagem: o.mensagem || 'Alerta automático Security Agent.',
          regras: o.regrasIds || []
        });
      }
    } catch (e) {}
    return { added: false };
  }

  rateLimitSelfAdminRequest(ipHash) {
    const agora = Date.now();
    let jan = this._selfAdminRate.get(ipHash);
    if (!jan || (agora - jan.startTs) > SELF_ADMIN_WINDOW_MS) {
      jan = { startTs: agora, count: 0 };
      this._selfAdminRate.set(ipHash, jan);
    }
    jan.count++;
    if (jan.count > SELF_ADMIN_MAX) {
      return { blocked: true, retryAfter: Math.ceil(((jan.startTs + SELF_ADMIN_WINDOW_MS) - agora) / 1000), contador: jan.count };
    }
    return { blocked: false, contador: jan.count };
  }

  checkShouldBlock(opts) {
    const o = opts || {};
    const evento = o.evento || null;
    const scoreAtual = typeof o.scoreAtual === 'number' ? o.scoreAtual : 0;
    if (this.mode === 'off') return { bloquear: false, modo: 'off' };
    if (!evento) return { bloquear: false, modo: this.mode };
    const ipHash = evento.ipHashSha256 || '';
    const uidHash = evento.uid || '';
    const regras = (this.analyzer && evento.ipHashSha256)
      ? (this.analyzer.ultimosScoresPorIp && this.analyzer.ultimosScoresPorIp.get(evento.ipHashSha256) || { motivos: [] })
      : { motivos: [] };
    const motivosIds = (regras.motivos || []).map(m => m.regraId);
    const regrasDistintas = new Set(motivosIds.filter(id => id && id !== 'OK' && id !== 'OK_EMPTY'));
    const acoesConsideradas = [];
    let bloquear = false;
    let statusCode = 0;
    let headerRetryAfterMs = 0;
    let bodyMsg = '';
    let acaoSelecionada = 'NENHUMA';

    if (scoreAtual >= 30) {
      acoesConsideradas.push('A05');
      this.aumentarMonitoramentoAteMs = Date.now() + (30 * 60 * 1000);
    }
    if (scoreAtual >= 50 && uidHash) {
      acoesConsideradas.push('A01');
      this.rateLimitByIpHash.set('UID_RATE_' + uidHash, {
        janelaStartTs: Date.now(),
        contadorJanela: 100,
        limitAtNext: true
      });
    }
    if (scoreAtual >= 50 && ipHash) {
      const countReq = this._incrementarJanelaRate(ipHash, 10 * 1000);
      if (countReq >= 10) {
        acoesConsideradas.push('A02');
        statusCode = 429;
        headerRetryAfterMs = DEFAULT_RATE_LIMIT_TTL_MS;
        bodyMsg = 'Excesso de requisições. Rate limit temporário aplicado.';
        acaoSelecionada = 'A02';
      }
    }
    const regrasAltoRisco = motivosIds.some(r => r === 'R10' || r === 'R11' || r === 'R14' || r === 'R16');
    if (scoreAtual >= 60 && regrasDistintas.size >= 2) {
      acoesConsideradas.push('A03');
      statusCode = statusCode || 403;
      if (this.mode !== 'monitor' && ipHash) this._bloquearIp('A03', ipHash, DEFAULT_BLOCK_TEMP_IP_MS, 'Score ≥60 + 2+ regras distintas (A03)', true);
      acaoSelecionada = 'A03';
    } else if (scoreAtual >= 60 && !regrasAltoRisco && regrasDistintas.size === 1) {
      acoesConsideradas.push('A03_condicional');
      statusCode = statusCode || 0;
      acaoSelecionada = 'A05+A06';
    }
    if (regrasAltoRisco && uidHash && scoreAtual >= 60) {
      acoesConsideradas.push('A04');
      this.sessoesInvalidadas.set(uidHash, Date.now());
      acaoSelecionada = acaoSelecionada || 'A04';
    }
    if (scoreAtual >= 60 || regrasAltoRisco || scoreAtual >= 30 && regrasDistintas.size >= 2) {
      acoesConsideradas.push('A06');
      const sev = scoreAtual >= 80 ? 'CRITICO' : (scoreAtual >= 60 ? 'ALTO' : 'MODERADO');
      const alertaR = this._gerarAlerta({
        regraId: Array.from(regrasDistintas)[0] || 'A06',
        ipHash: ipHash,
        uidHash: uidHash,
        score: scoreAtual,
        severity: sev,
        mensagem: 'Score=' + scoreAtual + '/100. Regras=' + Array.from(regrasDistintas).join(',') + '.',
        regrasIds: Array.from(regrasDistintas)
      });
      if (scoreAtual >= 60) {
        this._gerarIncidenteAutomatico({
          severity: sev,
          category: regrasDistintas.has('R11') ? 'admin' : (regrasDistintas.has('R13') || regrasDistintas.has('R14') ? 'telefone_cliente' : 'anomalia_rede'),
          riskScore: scoreAtual,
          acaoId: acaoSelecionada,
          realAplicado: this.mode === 'protect' && statusCode !== 0,
          descricaoAcao: acoesConsideradas.join('+') + ' (mode=' + this.mode + ')',
          summary: 'Incidente automático: score=' + scoreAtual + ' regras=' + Array.from(regrasDistintas).join(','),
          evidence: [
            { ts: Date.now(), tipo: 'evento_acionador', id: evento.id, tipo_evt: evento.type, statusCode: evento.statusCode }
          ]
        });
      }
    }

    const simulado = this.mode === 'monitor';
    if (simulado && statusCode) {
      bloquear = false;
      statusCode = 0;
    } else if (statusCode) {
      bloquear = true;
    }
    return {
      bloquear,
      statusCode,
      headerRetryAfterMs,
      bodyJson: statusCode ? {
        ok: false,
        msg: bodyMsg || 'Ação Security Agent aplicada.',
        bloqueio: { simulado, acaoId: acaoSelecionada, ttl_s: Math.ceil((headerRetryAfterMs || DEFAULT_BLOCK_TEMP_IP_MS) / 1000) }
      } : null,
      acaoId: acaoSelecionada,
      real: !simulado && !!bloquear,
      acao_simulada: simulado && acoesConsideradas.length > 0 ? (acoesConsideradas.join('+') + ' — NÃO executada (SECURITY_MODE=monitor). Score=' + scoreAtual) : null,
      modo: this.mode,
      scoreConsiderado: scoreAtual,
      regrasIdsConsideradas: Array.from(regrasDistintas),
      aumentarMonitoramentoAteMs: this.aumentarMonitoramentoAteMs
    };
  }
}

const securityProtector = new SecurityProtector();

module.exports = {
  SecurityProtector,
  securityProtector,
  ACOES_PROIBIDAS,
  MODO_VALIDO,
  CLEANUP_INTERVAL_MS,
  SELF_ADMIN_MAX,
  SELF_ADMIN_WINDOW_MS,
  DEFAULT_BLOCK_TEMP_IP_MS,
  DEFAULT_RATE_LIMIT_TTL_MS
};
