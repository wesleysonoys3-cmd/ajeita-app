'use strict';

const CACHE_TTL_MS = 10 * 60 * 1000;
const BACKOFF_PASSOS_MS = [1 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];

class SecurityAI {
  constructor(opts) {
    const o = opts || {};
    this.store = o.store || null;
    this.chamadasContador = 0;
    this.cache = new Map();
    this.cacheHit = 0;
    this.cacheMiss = 0;
    this.quotaExcedidaMs = 0;
    this.backoffStep = 0;
    this.ultimaChamadaRede = 0;
    this.chaveDefault = process.env.OPENAI_API_KEY || process.env.OPEN_ROUTER_API_KEY || process.env.GOOGLE_API_KEY || null;
    this.iaDesativada = !this.chaveDefault;
    this._mensagens = [];
    this._lastErroMsg = null;
    this._lastErroCode = 0;
  }

  _limparCache() {
    const agora = Date.now();
    for (const [k, v] of this.cache.entries()) {
      if (!v || !v.ts || (agora - v.ts) > CACHE_TTL_MS) this.cache.delete(k);
    }
  }

  deveChamar(opts) {
    const o = opts || {};
    const score = typeof o.score === 'number' ? o.score : 0;
    const evDistCat = typeof o.eventosDistintosCategoria === 'number' ? o.eventosDistintosCategoria : 0;
    const manual = !!o.solicitacaoManual;
    if (manual) return true;
    if (score >= 60 && evDistCat >= 3) return true;
    if (o.investigandoIncidente === true) return true;
    if (o.resumoSemanal === true) return true;
    return false;
  }

  _estaEmBackoff() {
    const agora = Date.now();
    if (this.quotaExcedidaMs > 0 && agora < this.quotaExcedidaMs) return true;
    if (this.quotaExcedidaMs > 0 && agora >= this.quotaExcedidaMs) this.quotaExcedidaMs = 0;
    return false;
  }

  _tratarErroRede(erroMsg, codigo) {
    const m = String(erroMsg || '').toLowerCase();
    const cod = String(codigo || '');
    const isQuota = /resource_exhausted|code.?8|quota.?exceeded|429|too many requests|rate.?limit/i.test(m) || cod === '8' || cod === '429' || /code.?8/.test(cod);
    if (isQuota) {
      const passo = Math.min(this.backoffStep, BACKOFF_PASSOS_MS.length - 1);
      const ms = BACKOFF_PASSOS_MS[passo] || BACKOFF_PASSOS_MS[BACKOFF_PASSOS_MS.length - 1];
      this.quotaExcedidaMs = Date.now() + ms;
      this.backoffStep = Math.min(this.backoffStep + 1, BACKOFF_PASSOS_MS.length - 1);
      this._lastErroMsg = erroMsg;
      this._lastErroCode = 8;
      return true;
    }
    this._lastErroMsg = erroMsg;
    this._lastErroCode = 500;
    return false;
  }

  resetBackoff() { this.backoffStep = 0; this.quotaExcedidaMs = 0; this._lastErroMsg = null; this._lastErroCode = 0; }

  async _chamarRedeLLM(promptSystem, promptUser, maxTokens) {
    this.ultimaChamadaRede = Date.now();
    this.chamadasContador++;
    if (this.iaDesativada) return { ia_desativada: true, motivo: 'Nenhuma LLM key configurada. Modo apenas regras locais.' };
    if (this._estaEmBackoff()) {
      return { ia_falhou: true, fallbackMotivo: 'Backoff quota LLM ativo (code 8 / 429). Reseta ' + new Date(this.quotaExcedidaMs).toISOString(), backoff: true };
    }
    try {
      let provider = 'openai';
      let url = 'https://api.openai.com/v1/chat/completions';
      let authKey = process.env.OPENAI_API_KEY || '';
      if (!authKey && process.env.OPEN_ROUTER_API_KEY) {
        authKey = process.env.OPEN_ROUTER_API_KEY;
        url = 'https://openrouter.ai/api/v1/chat/completions';
        provider = 'openrouter';
      }
      if (!authKey && process.env.GOOGLE_API_KEY) {
        authKey = process.env.GOOGLE_API_KEY;
        url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(authKey);
        provider = 'google';
      }
      if (!authKey) return { ia_desativada: true, motivo: 'Sem chave LLM disponível nesta tentativa.' };
      let corpo;
      if (provider === 'google') {
        corpo = { contents: [{ parts: [{ text: promptSystem + '\n\n' + promptUser }] }], generationConfig: { maxOutputTokens: maxTokens || 600, temperature: 0.2 } };
      } else {
        corpo = { model: provider === 'openrouter' ? 'microsoft/phi-3-mini-128k-instruct:free' : 'gpt-4o-mini', max_tokens: maxTokens || 600, temperature: 0.2, messages: [{ role: 'system', content: promptSystem }, { role: 'user', content: promptUser }] };
      }
      if (typeof fetch !== 'function') {
        return { ia_falhou: true, fallbackMotivo: 'Fetch API indisponível. Usar apenas regras locais (análise score).' };
      }
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) };
      if (provider !== 'google') init.headers.Authorization = 'Bearer ' + authKey;
      const r = await fetch(url, init);
      if (!r || r.status === 429 || r.status >= 500) {
        this._tratarErroRede('HTTP ' + (r ? r.status : 'null') + ' provider=' + provider, String(r ? r.status : 0));
        return { ia_falhou: true, fallbackMotivo: 'Erro HTTP=' + (r ? r.status : 'null') + ' provider=' + provider + '. backoff=' + this.quotaExcedidaMs, statusCode: r ? r.status : 0 };
      }
      const json = await r.json();
      let texto = '';
      if (provider === 'google') texto = (((json.candidates || [])[0] || {}).content || {}).text || JSON.stringify(json).substring(0, 600);
      else texto = (((json.choices || [])[0] || {}).message || {}).content || JSON.stringify(json).substring(0, 600);
      this.resetBackoff();
      return { ok: true, provider, texto, model: json.model || json.geminiModel || 'default' };
    } catch (e) {
      this._tratarErroRede(e && e.message ? e.message : String(e), '');
      return { ia_falhou: true, fallbackMotivo: 'Exceção: ' + String((e && e.message) || e).substring(0, 200) };
    }
  }

  async analisarIncidente(incidente, eventos) {
    this._limparCache();
    const cacheKey = 'inc_' + (incidente && incidente.incidentId ? incidente.incidentId : 'no_id');
    const cached = this.cache.get(cacheKey);
    const agora = Date.now();
    if (cached && cached.ts && (agora - cached.ts) < CACHE_TTL_MS) {
      this.cacheHit++;
      return Object.assign({}, cached.result, { cache: 'HIT' });
    }
    this.cacheMiss++;
    if (this.iaDesativada) {
      return { ia_desativada: true, motivo: 'Nenhuma LLM key configurada. Modo apenas regras locais.', incidentId: incidente && incidente.incidentId };
    }
    if (this._estaEmBackoff()) {
      return { ia_falhou: true, fallbackMotivo: 'Backoff quota LLM ativo. Reseta em ' + Math.max(0, Math.ceil((this.quotaExcedidaMs - agora) / 1000)) + 's.' };
    }
    const s0 = typeof Date !== 'undefined' ? agora : 0;
    const scoreRisco = (incidente && typeof incidente.riskScore === 'number') ? incidente.riskScore : 0;
    const sever = (incidente && incidente.severity) || 'ALTO';
    const cat = (incidente && incidente.category) || 'anomalia';
    const evStr = Array.isArray(eventos) ? eventos.slice(0, 20).map(e => '  • [' + new Date(e.ts || 0).toISOString().substring(11, 19) + '] ' + (e.category || '') + ' ' + (e.type || '') + ' sc=' + (e.statusCode || 0) + ' ip=' + (e.ip || '')).join('\n') : '';
    const system = 'Você é Ajeitaí Security Agent, analista de segurança sênior brasileiro. Regras: 1) linguagem objetiva pt-BR; 2) máximo 3 ações humanas recomendadas sem código destrutivo; 3) NÃO inventar comandos shell; 4) NÃO sugerir apagar usuário/pedido; 5) concluir com 3 bullets CONCIDOS/PROBABILIDADE/PRÓXIMOS PASSOS.';
    const user = `RELATÓRIO INCIDENTE: 
  ID: ${incidente && incidente.incidentId}
  Severidade: ${sever}
  Categoria: ${cat}
  Score risco: ${scoreRisco}/100
  Resumo: ${(incidente && incidente.summary) || 'Sem resumo.'}
  Eventos recentes:
${evStr || '  (nenhum evento anexado)'}

Gere análise curta (≤400 palavras):`;
    const rede = await this._chamarRedeLLM(system, user, 800);
    const resultadoFmt = rede && rede.ok
      ? { ok: true, texto: 'Relatório IA: ' + String(rede.texto || '').replace(/\r?\n/g, ' ').substring(0, 1500), tokens_usados_est: (rede.texto || '').split(/\s+/).length * 2, provider: rede.provider }
      : Object.assign({ ia_falhou: true, fallbackMotivo: (rede && rede.fallbackMotivo) || 'Chamada LLM falhou.' }, rede || {});
    this.cache.set(cacheKey, { ts: Date.now(), result: resultadoFmt });
    return Object.assign({ cache: 'MISS', tempo_ms: typeof Date !== 'undefined' ? (Date.now() - s0) : 0 }, resultadoFmt);
  }

  resumoScoreMotivado(score, motivos) {
    const v = Math.max(0, Math.min(100, typeof score === 'number' ? score | 0 : 0));
    const lista = Array.isArray(motivos) ? motivos : [];
    let faixa = 'BAIXO';
    if (v >= 30) faixa = 'MODERADO';
    if (v >= 60) faixa = 'ALTO';
    if (v >= 80) faixa = 'CRÍTICO';
    const nRegras = lista.filter(m => m && typeof m.pontos === 'number' && m.pontos > 0).length;
    const totalPontos = lista.reduce((acc, m) => acc + (m && typeof m.pontos === 'number' ? m.pontos : 0), 0);
    const motivosStr = lista.map(m => m && (m.regraId + ':' + (m.pontos || 0))).join(', ').substring(0, 300) || 'Nenhum motivo registrado.';
    let explicacao = '';
    if (v === 0) explicacao = 'Sem anomalias. Tráfego e ações dentro dos padrões esperados.';
    else if (v <= 29) explicacao = 'Risco baixo. Apenas ruído ou 1 regra leve.';
    else if (v <= 59) explicacao = 'Atenção. ' + nRegras + ' regra(s) violada(s). Monitoramento aumentado.';
    else if (v <= 79) explicacao = 'Risco ALTO. ' + nRegras + ' regras distintas violadas. Se modo=protect, rate limits e bloqueios temporários podem ser aplicados.';
    else explicacao = 'RISCO CRÍTICO. Requer investigação humana imediata: ' + nRegras + ' regras; soma bruta=' + totalPontos + ' pontos (cap em 100).';
    return {
      ok: true,
      score: v,
      rotulo: faixa,
      regras_quantidade: nRegras,
      soma_bruta: totalPontos,
      resumo_pt: explicacao,
      detalhe_regra_ids: motivosStr,
      usou_ia_real: false
    };
  }
}

const securityAI = new SecurityAI();

module.exports = {
  SecurityAI,
  securityAI,
  CACHE_TTL_MS,
  BACKOFF_PASSOS_MS
};
