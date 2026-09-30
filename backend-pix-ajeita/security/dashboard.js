'use strict';

const ADMIN_PASSWORD_DEFAULT = 'bolo2024';

function _lerSenhaAdmin(req) {
  if (!req) return null;
  const q = (req.query && (req.query.admin_senha || req.query.admin_password)) || null;
  const b = (req.body && (req.body.admin_senha || req.body.admin_password || req.body.senha_confirmacao)) || null;
  const h = (req.headers && (req.headers['x-admin-senha'] || req.headers['X-Admin-Senha'] || req.headers['x-admin-password'])) || null;
  return String(q || b || h || '').trim() || null;
}

function _authOk(req) {
  const sent = _lerSenhaAdmin(req);
  if (!sent) return false;
  const esperada = String(process.env.SECURITY_ADMIN_PASSWORD || ADMIN_PASSWORD_DEFAULT).trim();
  return sent === esperada;
}

function _res401(res, json) {
  try {
    res.statusCode = 401;
    if (json) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, msg: 'Acesso negado Security Agent. Credencial inválida ou ausente.' }));
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('401 Acesso negado Security Agent. Credencial inválida ou ausente.');
    }
  } catch (e) {}
}

function _corSeveridade(rotulo) {
  const r = String(rotulo || 'BAIXO').toUpperCase();
  if (r === 'BAIXO') return { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-300', badge: 'bg-emerald-600' };
  if (r === 'MODERADO') return { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-300', badge: 'bg-amber-500' };
  if (r === 'ALTO') return { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-300', badge: 'bg-orange-600' };
  if (r === 'CRÍTICO' || r === 'CRITICO') return { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-300', badge: 'bg-red-600' };
  return { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-300', badge: 'bg-gray-600' };
}

function _corStatusGlobal(s) {
  const x = String(s || 'PROTEGIDO').toUpperCase();
  if (x === 'PROTEGIDO') return { badge: 'bg-emerald-600', text: 'text-emerald-700', pulse: 'bg-emerald-500' };
  if (x === 'ATENÇÃO' || x === 'ATENCAO') return { badge: 'bg-amber-500', text: 'text-amber-700', pulse: 'bg-amber-400' };
  if (x === 'INCIDENTE') return { badge: 'bg-red-600', text: 'text-red-700', pulse: 'bg-red-500' };
  return { badge: 'bg-gray-600', text: 'text-gray-700', pulse: 'bg-gray-500' };
}

function _fmtTs(ts) {
  if (!ts) return '-';
  try {
    const d = new Date(Number(ts) || 0);
    function z(n) { return n < 10 ? '0' + n : '' + n; }
    if (isNaN(d.getTime())) return '-';
    return z(d.getDate()) + '/' + z(d.getMonth() + 1) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  } catch (e) { return String(ts); }
}

function _escHtml(str) {
  return String(str == null ? '' : str).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDashboardHTML(opts) {
  const o = opts || {};
  const statusGeral = String(o.statusGlobal || 'PROTEGIDO');
  const score = typeof o.score === 'number' ? o.score : 0;
  const rotulo = String(o.rotulo || 'BAIXO');
  const mode = String(o.mode || 'monitor').toUpperCase();
  const metrics = o.metrics || {};
  const eventos15 = Array.isArray(o.eventos15) ? o.eventos15 : [];
  const incidentes = Array.isArray(o.incidentes) ? o.incidentes : [];
  const healthStatus = o.healthStatus || { healthStatus: 'OK', componentes: [] };
  const motivoList = Array.isArray(o.motivoList) ? o.motivoList : [];
  const blocks = Array.isArray(o.blocks) ? o.blocks : [];
  const cStatus = _corStatusGlobal(statusGeral);
  const cRisco = _corSeveridade(rotulo);

  const cardsTopo = [
    { k: 'eventos_analisados', label: 'Eventos Analisados', v: Number(metrics.eventos_analisados || 0).toLocaleString('pt-BR'), color: 'text-blue-600', icon: '📊' },
    { k: 'eventos_suspeitos', label: 'Eventos Suspeitos', v: Number(metrics.eventos_suspeitos || 0), color: 'text-amber-600', icon: '⚠️' },
    { k: 'bloqueios_temp', label: 'Bloqueios Temporários', v: Number(metrics.bloqueios_temp || blocks.length || 0), color: 'text-orange-600', icon: '🛑' },
    { k: 'incidentes', label: 'Incidentes', v: Number(metrics.incidentes || incidentes.length || 0), color: 'text-red-600', icon: '🚨' },
    { k: 'ips_monitorados', label: 'IPs Monitorados', v: Number(metrics.ips_monitorados || 0), color: 'text-violet-600', icon: '🌐' },
    { k: 'health', label: 'Saúde Infra', v: String(healthStatus.healthStatus || 'OK'), color: healthStatus.healthStatus === 'OK' ? 'text-emerald-600' : (healthStatus.healthStatus === 'DEGRADADO' ? 'text-amber-600' : 'text-red-600'), icon: '💚' }
  ];

  const linhasEventos = eventos15.slice(0, 15).map((e, idx) => {
    const evC = _corSeveridade(e && e.riscoRotulo || 'BAIXO');
    return `<tr class="border-b border-gray-100 hover:bg-gray-50">
      <td class="px-3 py-2 text-xs text-gray-500">${idx + 1}</td>
      <td class="px-3 py-2 text-xs font-mono text-gray-700">${_fmtTs(e && e.ts)}</td>
      <td class="px-3 py-2"><span class="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">${_escHtml(e && e.category || '')}</span></td>
      <td class="px-3 py-2 text-xs text-gray-800">${_escHtml((e && e.type || '').substring(0, 60))}</td>
      <td class="px-3 py-2 text-xs font-mono text-gray-600">${_escHtml((e && e.ip || '').substring(0, 30))}</td>
      <td class="px-3 py-2 text-xs font-mono text-gray-600">${_escHtml((e && e.pathMasked || '').substring(0, 50))}</td>
      <td class="px-3 py-2 text-xs font-mono">${_escHtml(String(e && e.statusCode || '-'))}</td>
      <td class="px-3 py-2 text-center"><span class="inline-block px-2 py-0.5 rounded text-white text-xs ${evC.badge}">${typeof (e && e.riscoScore) === 'number' ? e.riscoScore : '-'}</span></td>
      <td class="px-3 py-2 text-xs text-gray-600">${_escHtml(String((e && e.actionTaken != null && typeof e.actionTaken === 'object') ? JSON.stringify(e.actionTaken).substring(0, 30) : (e && e.actionTaken || '')).substring(0, 20))}</td>
    </tr>`;
  }).join('');

  const linhasIncidentes = incidentes.slice(0, 12).map(inc => {
    const iC = _corSeveridade(inc && inc.severity || 'ALTO');
    return `<tr class="border-b border-gray-100 hover:bg-gray-50">
      <td class="px-3 py-2 text-xs font-mono text-gray-700">${_escHtml((inc && inc.incidentId || '').substring(0, 18))}</td>
      <td class="px-3 py-2 text-xs">${_fmtTs(inc && inc.timestamp)}</td>
      <td class="px-3 py-2"><span class="inline-block px-2 py-0.5 rounded text-white text-xs ${iC.badge}">${_escHtml(inc && inc.severity || '-')}</span></td>
      <td class="px-3 py-2 text-xs text-gray-700">${_escHtml((inc && inc.category || '').substring(0, 30))}</td>
      <td class="px-3 py-2 text-center"><span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-gray-800 text-white">${typeof (inc && inc.riskScore) === 'number' ? inc.riskScore : '-'}</span></td>
      <td class="px-3 py-2 text-xs text-gray-700">${_escHtml((inc && inc.status || 'OPEN').substring(0, 15))}</td>
      <td class="px-3 py-2 text-xs text-gray-700">${_escHtml(String((inc && inc.actionTaken != null && typeof inc.actionTaken === 'object') ? JSON.stringify(inc.actionTaken).substring(0, 35) : (inc && inc.actionTaken || '')).substring(0, 25))}</td>
    </tr>`;
  }).join('');

  const linhasHealth = (healthStatus.componentes || []).slice(0, 8).map(c => {
    const b = String(c.status || 'PENDING').toUpperCase();
    const cor = b === 'OK' ? 'bg-emerald-100 text-emerald-700' : (b === 'FALHA' ? 'bg-red-100 text-red-700' : (b === 'DEGRADADO' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-700'));
    return `<tr class="border-b border-gray-100 hover:bg-gray-50">
      <td class="px-3 py-2 text-xs font-semibold text-gray-800">${_escHtml(c.componente || '')}</td>
      <td class="px-3 py-2 text-center"><span class="inline-block px-3 py-1 rounded-full text-xs font-bold ${cor}">${b}</span></td>
      <td class="px-3 py-2 text-xs text-gray-700">${_escHtml((c.detalhe || '').substring(0, 120))}</td>
      <td class="px-3 py-2 text-xs text-gray-500">${_fmtTs(c.ultimaChecagemEm)}</td>
      <td class="px-3 py-2 text-xs text-gray-500">${typeof c.segundosDesde === 'number' ? c.segundosDesde + 's' : '-'}</td>
    </tr>`;
  }).join('');

  const linhasMotivos = motivoList.slice(0, 10).map(m => `<tr class="border-b border-gray-100">
    <td class="px-3 py-2 text-xs font-mono text-gray-700">${_escHtml((m && m.regraId || '').substring(0, 10))}</td>
    <td class="px-3 py-2 text-xs text-gray-800">${_escHtml((m && m.evidencia || '').substring(0, 120))}</td>
    <td class="px-3 py-2 text-center"><span class="inline-block px-2 py-0.5 rounded text-white text-xs font-bold bg-indigo-600">+${Number(m && m.pontos || 0)}</span></td>
  </tr>`).join('');

  const linhasBlocks = blocks.slice(0, 10).map(b => `<tr class="border-b border-gray-100">
    <td class="px-3 py-2 text-xs font-mono text-gray-700">${_escHtml((b && b.ipHash || '').substring(0, 16))}</td>
    <td class="px-3 py-2 text-xs">${_fmtTs(b && b.ts)}</td>
    <td class="px-3 py-2 text-xs">${_fmtTs(b && b.expireAt)}</td>
    <td class="px-3 py-2 text-xs text-gray-700">${_escHtml(b && b.actionId || '')}</td>
    <td class="px-3 py-2 text-center"><span class="inline-block px-2 py-0.5 rounded text-white text-xs ${b && b.real === true ? 'bg-red-600' : 'bg-amber-500'}">${b && b.real === true ? 'REAL' : 'SIMULADO'}</span></td>
  </tr>`).join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Ajeitaí Security — Painel de Monitoramento</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
@keyframes pulseDot { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.5); opacity: 0.6; } }
.pulse-dot { animation: pulseDot 1.8s ease-in-out infinite; display: inline-block; width: 10px; height: 10px; border-radius: 9999px; margin-right: 6px; }
</style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen">
<header class="bg-gradient-to-r from-slate-900 via-indigo-900 to-purple-900 text-white shadow-lg">
  <div class="max-w-7xl mx-auto px-4 py-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-white/10 backdrop-blur flex items-center justify-center text-2xl">🛡️</div>
        <div>
          <h1 class="text-xl md:text-2xl font-extrabold tracking-tight">AJEITAÍ SECURITY</h1>
          <p class="text-xs md:text-sm text-indigo-100/80">Painel do Agente de Segurança · Monitoramento contínuo</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-xs md:text-sm">
        <span class="inline-flex items-center rounded-full px-3 py-1.5 bg-white/10 backdrop-blur border border-white/20"><span class="pulse-dot ${cStatus.pulse}"></span> <span class="font-bold">${_escHtml(statusGeral)}</span></span>
        <span class="inline-flex items-center rounded-full px-3 py-1.5 ${cRisco.badge} text-white font-bold">RISCO ${score}/100 · ${_escHtml(rotulo)}</span>
        <span class="inline-flex items-center rounded-full px-3 py-1.5 bg-black/30 border border-white/10 font-bold">MODO: ${_escHtml(mode)}</span>
        <span class="text-indigo-100/80">Atualizado em: ${_fmtTs(Date.now())}</span>
      </div>
    </div>
  </div>
</header>
<main class="max-w-7xl mx-auto px-4 py-6 space-y-6">

<section class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
  ${cardsTopo.map(c => `<div class="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex items-start gap-3">
    <div class="text-2xl">${c.icon}</div>
    <div class="min-w-0 flex-1">
      <div class="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">${_escHtml(c.label)}</div>
      <div class="mt-1 text-2xl font-extrabold ${c.color} break-all">${_escHtml(String(c.v))}</div>
    </div>
  </div>`).join('')}
</section>

<section class="grid grid-cols-1 lg:grid-cols-3 gap-4">
  <div class="lg:col-span-1 bg-white rounded-xl shadow-sm border border-slate-200 p-4">
    <h2 class="font-bold text-slate-800 mb-2 flex items-center gap-2">🎯 Motivos do Score Atual</h2>
    <div class="overflow-x-auto">
      <table class="w-full text-left"><thead class="text-xs uppercase text-slate-500"><tr><th class="px-3 py-1">Regra</th><th class="px-3 py-1">Evidência</th><th class="px-3 py-1 text-center">Pts</th></tr></thead>
      <tbody class="text-sm">${linhasMotivos || '<tr><td colspan="3" class="px-3 py-4 text-center text-xs text-slate-400">Nenhuma regra violada.</td></tr>'}</tbody></table>
    </div>
  </div>
  <div class="lg:col-span-1 bg-white rounded-xl shadow-sm border border-slate-200 p-4">
    <h2 class="font-bold text-slate-800 mb-2 flex items-center gap-2">🛑 Bloqueios Temporários</h2>
    <div class="overflow-x-auto">
      <table class="w-full text-left"><thead class="text-xs uppercase text-slate-500"><tr><th class="px-3 py-1">IP Hash</th><th class="px-3 py-1">Início</th><th class="px-3 py-1">Expira</th><th class="px-3 py-1">Ação</th><th class="px-3 py-1 text-center">Tipo</th></tr></thead>
      <tbody class="text-sm">${linhasBlocks || '<tr><td colspan="5" class="px-3 py-4 text-center text-xs text-slate-400">Nenhum bloqueio ativo.</td></tr>'}</tbody></table>
    </div>
  </div>
  <div class="lg:col-span-1 bg-white rounded-xl shadow-sm border border-slate-200 p-4">
    <h2 class="font-bold text-slate-800 mb-2 flex items-center gap-2">💚 Saúde da Infraestrutura</h2>
    <div class="overflow-x-auto">
      <table class="w-full text-left"><thead class="text-xs uppercase text-slate-500"><tr><th class="px-3 py-1">Componente</th><th class="px-3 py-1 text-center">Status</th><th class="px-3 py-1">Detalhe</th><th class="px-3 py-1">Última</th><th class="px-3 py-1">Idade</th></tr></thead>
      <tbody class="text-sm">${linhasHealth || '<tr><td colspan="5" class="px-3 py-4 text-center text-xs text-slate-400">Aguardando primeira checagem.</td></tr>'}</tbody></table>
    </div>
  </div>
</section>

<section class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
  <h2 class="font-bold text-slate-800 mb-2 flex items-center gap-2">📋 Últimos 15 Eventos de Segurança</h2>
  <div class="overflow-x-auto">
    <table class="w-full text-left"><thead class="text-xs uppercase text-slate-500 border-b border-slate-200"><tr>
      <th class="px-3 py-2">#</th><th class="px-3 py-2">Horário</th><th class="px-3 py-2">Categoria</th><th class="px-3 py-2">Tipo</th><th class="px-3 py-2">IP</th><th class="px-3 py-2">Endpoint</th><th class="px-3 py-2">HTTP</th><th class="px-3 py-2 text-center">Score</th><th class="px-3 py-2">Ação</th>
    </tr></thead>
    <tbody class="text-sm">${linhasEventos || '<tr><td colspan="9" class="px-3 py-8 text-center text-xs text-slate-400">Nenhum evento registrado ainda.</td></tr>'}</tbody></table>
  </div>
</section>

<section class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
  <h2 class="font-bold text-slate-800 mb-2 flex items-center gap-2">🚨 Incidentes de Segurança</h2>
  <div class="overflow-x-auto">
    <table class="w-full text-left"><thead class="text-xs uppercase text-slate-500 border-b border-slate-200"><tr>
      <th class="px-3 py-2">ID</th><th class="px-3 py-2">Horário</th><th class="px-3 py-2">Severidade</th><th class="px-3 py-2">Categoria</th><th class="px-3 py-2 text-center">Score</th><th class="px-3 py-2">Status</th><th class="px-3 py-2">Ação Tomada</th>
    </tr></thead>
    <tbody class="text-sm">${linhasIncidentes || '<tr><td colspan="7" class="px-3 py-8 text-center text-xs text-slate-400">Nenhum incidente registrado.</td></tr>'}</tbody></table>
  </div>
</section>

<section class="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
  <h2 class="font-bold text-slate-800 mb-3 flex items-center gap-2">⚙️ Controles Administrativos</h2>
  <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
    <div class="p-3 border rounded-lg border-slate-200 bg-slate-50">
      <div class="font-bold mb-1">Modo Atual</div>
      <div class="mb-2 text-xs text-slate-600">Padrão MONITOR (não bloqueia). Para PROTECT informe 2x a senha admin.</div>
      <div class="flex gap-2">
        <input id="modo_senha1" type="password" placeholder="senha admin" class="flex-1 border rounded px-2 py-1 text-xs">
        <input id="modo_senha2" type="password" placeholder="confirmar (2x)" class="flex-1 border rounded px-2 py-1 text-xs">
        <select id="modo_val" class="border rounded px-2 py-1 text-xs bg-white"><option value="monitor">MONITOR</option><option value="protect">PROTECT</option><option value="off">OFF</option></select>
        <button id="btn_modo" class="bg-indigo-600 text-white px-3 py-1 rounded text-xs font-bold hover:bg-indigo-700">Alterar</button>
      </div>
      <div id="modo_msg" class="mt-2 text-xs"></div>
    </div>
    <div class="p-3 border rounded-lg border-slate-200 bg-slate-50">
      <div class="font-bold mb-1">Atualizar Incidente</div>
      <div class="mb-2 text-xs text-slate-600">Status: OPEN → INVESTIGATING → CONTAINED → RESOLVED. Motivo ≥ 8 chars.</div>
      <div class="flex flex-col gap-1">
        <input id="inc_id" type="text" placeholder="incidentId" class="border rounded px-2 py-1 text-xs">
        <input id="inc_motivo" type="text" placeholder="motivo (≥8 caracteres)" class="border rounded px-2 py-1 text-xs">
        <select id="inc_status" class="border rounded px-2 py-1 text-xs bg-white"><option value="OPEN">OPEN</option><option value="INVESTIGATING">INVESTIGATING</option><option value="CONTAINED">CONTAINED</option><option value="RESOLVED">RESOLVED</option></select>
        <div class="flex gap-2"><input id="inc_senha" type="password" placeholder="senha admin" class="flex-1 border rounded px-2 py-1 text-xs"><button id="btn_inc" class="bg-slate-800 text-white px-3 py-1 rounded text-xs font-bold hover:bg-slate-900">Salvar</button></div>
      </div>
      <div id="inc_msg" class="mt-2 text-xs"></div>
    </div>
    <div class="p-3 border rounded-lg border-slate-200 bg-slate-50">
      <div class="font-bold mb-1">Consultas Rápidas</div>
      <div class="mb-2 text-xs text-slate-600">Endpoint /api/admin/security/* retorna JSON detalhado.</div>
      <div class="space-y-1 text-xs">
        <div><code>/api/admin/security/status</code> — métricas e score global</div>
        <div><code>/api/admin/security/events?limit=100</code> — eventos</div>
        <div><code>/api/admin/security/score?ip_hash=X</code> — score por IP hash</div>
        <div><code>/api/admin/security/incidents</code> — incidentes</div>
        <div><code>/api/admin/security/health</code> — saúde infra</div>
      </div>
    </div>
  </div>
</section>

<footer class="text-center text-xs text-slate-400 pb-6 pt-2">
  Ajeitaí Security Agent · versão 1.0.0-monitor-first · Dados sensíveis sempre mascarados/redigidos no dashboard.
</footer>
</main>
<script>
const SENHA = (new URLSearchParams(location.search)).get('admin_senha') || '';
function req(path, opts) {
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  return fetch(path + sep + 'admin_senha=' + encodeURIComponent(SENHA), opts || {}).then(r => r.json().catch(() => ({})));
}
setInterval(() => {
  req('/api/admin/security/status').then(d => {
    if (!d) return;
    const score = typeof d.score === 'number' ? d.score : 0;
    document.title = 'Ajeitaí Security — Risco ' + score + '/100 (' + (d.rotulo || '-') + ')';
  });
}, 3000);
document.getElementById('btn_modo').addEventListener('click', async () => {
  const msg = document.getElementById('modo_msg');
  const s1 = document.getElementById('modo_senha1').value;
  const s2 = document.getElementById('modo_senha2').value;
  const m = document.getElementById('modo_val').value;
  const body = { mode: m, senha_confirmacao: s1, senha_confirmacao_2: s2, motivo: 'Dashboard admin alteração manual via interface web.' };
  const r = await req('/api/admin/security/mode', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  msg.textContent = JSON.stringify(r || {});
  if (r && r.ok) msg.className = 'mt-2 text-xs text-emerald-700'; else msg.className = 'mt-2 text-xs text-red-700';
});
document.getElementById('btn_inc').addEventListener('click', async () => {
  const msg = document.getElementById('inc_msg');
  const id = document.getElementById('inc_id').value.trim();
  if (!id) { msg.textContent = 'Informe o incidentId.'; msg.className = 'mt-2 text-xs text-amber-700'; return; }
  const body = { status: document.getElementById('inc_status').value, motivo: document.getElementById('inc_motivo').value, admin_senha: document.getElementById('inc_senha').value };
  const r = await fetch('/api/admin/security/incidents/' + encodeURIComponent(id) + '?admin_senha=' + encodeURIComponent(SENHA), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json().catch(() => ({})));
  msg.textContent = JSON.stringify(r || {});
  if (r && r.ok) msg.className = 'mt-2 text-xs text-emerald-700'; else msg.className = 'mt-2 text-xs text-red-700';
});
</script>
</body>
</html>`;
}

function _sendJson(res, code, obj) {
  try {
    res.statusCode = typeof code === 'number' ? code : 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj || {}));
  } catch (e) {}
}

function registerAdminEndpoints(opts) {
  const o = opts || {};
  const app = o.app;
  const sec = o.security || {};
  const store = sec.store || null;
  const analyzer = sec.analyzer || null;
  const protector = sec.protector || null;
  const health = sec.health || null;
  const ai = sec.ai || null;
  const redact = sec.redact || null;

  if (!app || typeof app.get !== 'function') return;

  const _rlSelf = {};

  function _rateSelfAdmin(ipHash, limit, janelaMs) {
    const agora = Date.now();
    const chave = String(ipHash || 'anon');
    let r = _rlSelf[chave];
    if (!r || agora - r.janela > janelaMs) r = { janela: agora, contador: 0 };
    r.contador++;
    _rlSelf[chave] = r;
    return r.contador > limit;
  }

  function _ipHashFromReq(req) {
    try {
      const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '127.0.0.1';
      if (redact && typeof redact.hashIp === 'function') return redact.hashIp(String(ip), process.env.SECURITY_IP_HASH_SECRET || 'ajeitai-sec-default-secret-do-not-use');
      return String(ip);
    } catch (e) { return 'anon'; }
  }

  function _capturarScoreGlobal() {
    if (analyzer && typeof analyzer.scoreGlobal === 'function') {
      try { return analyzer.scoreGlobal(); } catch (e) {}
    }
    return { valor: 0, motivos: [], rotulo: 'BAIXO', statusGlobal: 'PROTEGIDO' };
  }

  function _metrics() {
    const ev = (store && typeof store.events === 'object' && Array.isArray(store.events)) ? store.events : [];
    const inc = (store && typeof store.incidents === 'object' && Array.isArray(store.incidents)) ? store.incidents : [];
    const suspeitos = ev.filter(e => e && typeof e.riscoScore === 'number' && e.riscoScore >= 30).length;
    const ips = new Set(ev.map(e => e && e.ipHashSha256).filter(Boolean));
    return {
      eventos_analisados: ev.length,
      eventos_suspeitos: suspeitos,
      bloqueios_temp: protector && typeof protector.blocksByIpHash === 'object' ? (protector.blocksByIpHash.size || protector.blocksByIpHash.length || 0) : 0,
      incidentes: inc.length,
      ips_monitorados: ips.size
    };
  }

  function _ultimosEventos(limit) {
    const l = Math.min(Number(limit) || 15, 500);
    const ev = (store && typeof store.events === 'object' && Array.isArray(store.events)) ? store.events.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, l) : [];
    const g = _capturarScoreGlobal();
    return ev.map(e => Object.assign({}, e, {
      riscoScore: typeof (e && e.riscoScore) === 'number' ? e.riscoScore : (g.valor || 0),
      riscoRotulo: (e && e.riscoRotulo) || g.rotulo || 'BAIXO'
    }));
  }

  app.get('/admin/security', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 120, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit painel admin. Tente novamente em 1 minuto.' }); return; }
    if (!_authOk(req)) { _res401(res, /html/.test(String(req.headers && req.headers.accept || '')) ? false : true); return; }
    try {
      const sg = _capturarScoreGlobal();
      const blocks = protector && typeof protector.listActiveBlocks === 'function' ? protector.listActiveBlocks() : [];
      const html = renderDashboardHTML({
        statusGlobal: sg.statusGlobal || 'PROTEGIDO',
        score: typeof sg.valor === 'number' ? sg.valor : 0,
        rotulo: sg.rotulo || 'BAIXO',
        mode: (protector && protector.mode) || 'monitor',
        metrics: _metrics(),
        eventos15: _ultimosEventos(15),
        incidentes: (store && typeof store.listIncidents === 'function') ? store.listIncidents({}).slice(0, 12) : [],
        healthStatus: (health && typeof health.getUltimoHealth === 'function') ? health.getUltimoHealth() : { healthStatus: 'OK', componentes: [] },
        motivoList: Array.isArray(sg.motivos) ? sg.motivos : [],
        blocks: blocks
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (e) { _sendJson(res, 500, { ok: false, msg: 'Erro ao renderizar dashboard: ' + String((e && e.message) || e).substring(0, 200) }); }
  });

  app.get('/api/admin/security/status', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 60, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit /api/admin/security/status. Máximo 60/min.' }); return; }
    if (!_authOk(req)) { _res401(res, true); return; }
    try {
      const sg = _capturarScoreGlobal();
      _sendJson(res, 200, {
        ok: true,
        statusLabel: sg.statusGlobal || 'PROTEGIDO',
        score: typeof sg.valor === 'number' ? sg.valor : 0,
        rotulo: sg.rotulo || 'BAIXO',
        mode: (protector && protector.mode) || 'monitor',
        metrics: _metrics(),
        healthStatus: (health && typeof health.getUltimoHealth === 'function') ? health.getUltimoHealth() : null,
        ultimaAtualizacao: Date.now()
      });
    } catch (e) { _sendJson(res, 500, { ok: false, msg: String((e && e.message) || e).substring(0, 200) }); }
  });

  app.get('/api/admin/security/events', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 60, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit eventos.' }); return; }
    if (!_authOk(req)) { _res401(res, true); return; }
    try {
      const limit = Math.min(Number(req.query && req.query.limit) || 100, 500);
      const cat = String((req.query && req.query.category) || '').trim();
      const ev = store && typeof store.listEvents === 'function' ? store.listEvents({ limit, category: cat || undefined }) : [];
      _sendJson(res, 200, { ok: true, total: ev.length, eventos: ev });
    } catch (e) { _sendJson(res, 500, { ok: false, msg: String((e && e.message) || e).substring(0, 200) }); }
  });

  app.get('/api/admin/security/score', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 60, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit score.' }); return; }
    if (!_authOk(req)) { _res401(res, true); return; }
    try {
      const ipH = String((req.query && req.query.ip_hash) || '').trim();
      const uidH = String((req.query && req.query.uid_hash) || '').trim();
      const global = _capturarScoreGlobal();
      const ipScore = ipH && analyzer && typeof analyzer.scoreForIp === 'function' ? analyzer.scoreForIp(ipH) : null;
      const uidScore = uidH && analyzer && typeof analyzer.scoreForUid === 'function' ? analyzer.scoreForUid(uidH) : null;
      let resumoIa = null;
      if (ai && typeof ai.resumoScoreMotivado === 'function') resumoIa = ai.resumoScoreMotivado(global.valor, global.motivos || []);
      _sendJson(res, 200, { ok: true, global, porIpHash: ipScore, porUidHash: uidScore, resumo_explicativo: resumoIa });
    } catch (e) { _sendJson(res, 500, { ok: false, msg: String((e && e.message) || e).substring(0, 200) }); }
  });

  app.get('/api/admin/security/incidents', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 60, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit incidents.' }); return; }
    if (!_authOk(req)) { _res401(res, true); return; }
    try {
      const st = String((req.query && req.query.status) || '').trim();
      const incs = store && typeof store.listIncidents === 'function' ? store.listIncidents({ status: st || undefined }) : [];
      _sendJson(res, 200, { ok: true, total: incs.length, incidents: incs });
    } catch (e) { _sendJson(res, 500, { ok: false, msg: String((e && e.message) || e).substring(0, 200) }); }
  });

  app.patch('/api/admin/security/incidents/:id', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 30, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit patch incident.' }); return; }
    if (!_authOk(req)) { _res401(res, true); return; }
    try {
      const id = String((req.params && req.params.id) || '').trim();
      const body = req.body || {};
      const statusNovo = String(body.status || '').trim().toUpperCase();
      const motivo = String(body.motivo || '').trim();
      const STATUS_VALIDOS = ['OPEN', 'INVESTIGATING', 'CONTAINED', 'RESOLVED'];
      if (!id) { _sendJson(res, 400, { ok: false, msg: 'Informe o incidentId.' }); return; }
      if (STATUS_VALIDOS.indexOf(statusNovo) < 0) { _sendJson(res, 400, { ok: false, msg: 'Status inválido. Use: OPEN | INVESTIGATING | CONTAINED | RESOLVED.' }); return; }
      if (motivo.length < 8) { _sendJson(res, 400, { ok: false, msg: 'Motivo muito curto. Mínimo 8 caracteres.' }); return; }
      if (!store || typeof store.updateIncident !== 'function') { _sendJson(res, 501, { ok: false, msg: 'Store sem updateIncident.' }); return; }
      const r = store.updateIncident(id, { status: statusNovo, motivo, atualizadoEm: Date.now(), atualizadoPor: 'admin_security_dashboard' });
      if (r && r.ok) _sendJson(res, 200, { ok: true, incidente: r.incidente, msg: 'Incidente atualizado.' });
      else _sendJson(res, 404, { ok: false, msg: 'Incidente não encontrado ou atualização falhou.', detalhe: r });
    } catch (e) { _sendJson(res, 500, { ok: false, msg: String((e && e.message) || e).substring(0, 200) }); }
  });

  app.patch('/api/admin/security/mode', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 20, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit change mode.' }); return; }
    if (!_authOk(req)) { _res401(res, true); return; }
    try {
      const body = req.body || {};
      const novo = String(body.mode || '').trim().toLowerCase();
      const s1 = String(body.senha_confirmacao || '').trim();
      const s2 = String(body.senha_confirmacao_2 || '').trim();
      const motivo = String(body.motivo || '').trim();
      const MODOS_VALIDOS = ['monitor', 'protect', 'off'];
      if (MODOS_VALIDOS.indexOf(novo) < 0) { _sendJson(res, 400, { ok: false, msg: 'Modo inválido. Use monitor | protect | off.' }); return; }
      if (!protector || typeof protector.setMode !== 'function') { _sendJson(res, 501, { ok: false, msg: 'Protector sem setMode.' }); return; }
      const r = protector.setMode(novo, s1, s2, motivo);
      if (r && r.ok) _sendJson(res, 200, { ok: true, mode_antes: r.mode_antes, mode_depois: r.mode_depois, msg: 'Modo alterado.' });
      else _sendJson(res, typeof (r && r.httpCode) === 'number' ? r.httpCode : 400, Object.assign({ ok: false, msg: 'Alteração de modo rejeitada.' }, r || {}));
    } catch (e) { _sendJson(res, 500, { ok: false, msg: String((e && e.message) || e).substring(0, 200) }); }
  });

  app.get('/api/admin/security/health', (req, res) => {
    if (_rateSelfAdmin(_ipHashFromReq(req), 30, 60 * 1000)) { _sendJson(res, 429, { ok: false, msg: 'Rate limit health.' }); return; }
    if (!_authOk(req)) { _res401(res, true); return; }
    try {
      const h = health && typeof health.getUltimoHealth === 'function' ? health.getUltimoHealth() : null;
      _sendJson(res, 200, { ok: true, health: h });
    } catch (e) { _sendJson(res, 500, { ok: false, msg: String((e && e.message) || e).substring(0, 200) }); }
  });
}

module.exports = {
  renderDashboardHTML,
  registerAdminEndpoints,
  ADMIN_PASSWORD_DEFAULT,
  _authOk,
  _lerSenhaAdmin
};
