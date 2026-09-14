# DEBUG SESSION: google-login-final-fix
**Status:** [OPEN] | **Data:** 2026-09-13
**Sintoma Usuário:** "ainda nao esta entrando pelo google resolva de uma vez por todas"
**Contexto:** App Ajeita single file index.html, Google Identity Services (GSI) v3, OAuth Client ID fixo 709414286122-tu642dhpa9dnp158keo816ln1a52npu6.apps.googleusercontent.com, persistência localStorage.

---

## 🎯 HIPÓTESES FALSIFICÁVEIS (3-5)
| # | Hipótese | Como falsificar via instrumentação |
|---|---|---|
| H1 | **GSI não inicializa corretamente** → `google.accounts.id.initialize()` NÃO é chamado, ou Client ID na meta tag e JS const estão diferentes | Logar momento exato + parâmetros do initialize, + diff Client ID meta tag vs `const GOOGLE_CLIENT_ID` |
| H2 | **Callback handleGoogleCredentialResponse NÃO é disparado** GSI notification callback retorna "not_displayed" ou erro, e o fallback timer + redirect OAuth não são acionados | Instrumentar TODAS as funções do fluxo: `chamarPromptSeguro`, `abrirLoginGoogle`, `handleGoogleCredentialResponse`, `gsiFallbackRedirectOAuthAbrir`, GSI `onNotification` callback completo com payload |
| H3 | **Credential NÃO é parseada corretamente** (JWT inválido, campos name/faltando, tipo de sessão errado) → `clienteGoogleLogado` fica null mesmo após sucesso GSI | Logar token completo JWT bruto, decoded JWT fields, `atualizarHeaderPorSessao` booleanos após persist, renderBottomNav abas |
| H4 | **Persistência localStorage quebra** → dado salvo mas ao carregar `carregarDadosStorageBootstrap` dá JSON.parse error ou atribui para var errada | Logar `setItem` payload e `getItem` recuperação, typeof clienteGoogleLogado após boot |
| H5 | **Origens autorizadas OAuth incompatível / FedCM bloqueia** → Browser não carrega GSI por politica third-party cookie/FedCM new mandate, caiu no NetworkError FedCM get() rejects visto no console | Logar `navigator.cookieEnabled`, GSI version, se `google.accounts.id` object existe após load, instrumentar erro FedCM completo |

---

## 🔬 INSTRUMENTAÇÃO
- [pending] Inserir pontos de log (não console.log! → report via Debug Server HTTP)
- [pending] Coletar runtime evidence pre-fix
- [pending] Determinar hipótese verdadeira
- [pending] Aplicar minimal fix
- [pending] Coletar post-fix evidence
- [pending] Comparar pre vs post

---

## 📊 EVIDÊNCIA PRÉ-FIX (runtime)
_será preenchido após rodar instrumentação_

---

## 💊 MINIMAL FIX
_será descrito aqui após evidência_

---

## 📊 EVIDÊNCIA PÓS-FIX
_será preenchido após rodar fix_
