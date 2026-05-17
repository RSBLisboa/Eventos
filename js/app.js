/* =============================================================================
 *  Eventos · Admin RSB Lisboa
 *
 *  Single-page app que substitui a base de dados Access. Faz tudo no browser:
 *    - Edição de evento.json (metadata)
 *    - Importação de inscritos via Excel + publicação da lista pública
 *    - Vista de presenças em tempo real
 *    - Emissão de certificados (numeração + hash SHA-256 + link)
 *    - Geração de .eml em zip para envio via Outlook desktop
 *
 *  Persistência:
 *    - Pública (GitHub Pages, repo Presencas/data/):
 *        evento.json, inscritos.json, presencas.json, certificados.json
 *    - Pública (GitHub Pages, repo Certificados/):
 *        certs.json (apenas nº+data+anulado para validar.html)
 *    - Privada (sessionStorage do browser, apaga ao fechar separador):
 *        emails dos inscritos (nunca commitados no GitHub)
 *
 *  Auth: PIN local (hash em CONFIG) + GitHub PAT em sessionStorage.
 * ========================================================================== */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURAÇÃO
  // ═══════════════════════════════════════════════════════════════════════════
  const CONFIG = {
    githubOwner:   'RSBLisboa',
    repoData:      'Presencas',     // onde vive evento/inscritos/presencas/certificados.json
    repoCerts:     'Certificados',  // onde vive certs.json + index.html dos certificados
    branch:        'main',
    baseUrlCerts:  'https://rsblisboa.github.io/Certificados/',
    urlTablet:     'https://rsblisboa.github.io/Presencas/',

    // Hash SHA-256 hex da password admin (RSBL18Mai2026).
    // Unificada com Presencas SPA. Para mudar, ver tools/cifrar-pat.html.
    pinHash: 'ddf8f268f1f55f479bca66b18836d46c2c10f99317ec7814edc58371a93d4536',

    // PAT cifrado com a password admin (PBKDF2 150k + AES-GCM, base64 de salt|iv|ct).
    // Gerar com tools/cifrar-pat.html neste repo.
    patCifrado: '',

    // Polling do estado de presenças (só na tab activa).
    presencasPollMs: 30000
  };

  // Decifra o PAT embutido com a password admin.
  async function decifrarPATComPassword(password) {
    if (!CONFIG.patCifrado) throw new Error('PAT cifrado não configurado.');
    const bundle = Uint8Array.from(atob(CONFIG.patCifrado), c => c.charCodeAt(0));
    const salt = bundle.slice(0, 16);
    const iv = bundle.slice(16, 28);
    const ct = bundle.slice(28);
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  const TEMPLATE_EMAIL_DEFAULT = `<!DOCTYPE html><html><body style="font-family:Segoe UI,Calibri,sans-serif;color:#1a1a1a;line-height:1.6;max-width:600px;margin:auto;padding:24px">
<p style="background:#E30613;color:#fff;padding:12px 16px;margin:0 0 24px;font-weight:bold;letter-spacing:.04em;text-transform:uppercase">Regimento de Sapadores Bombeiros de Lisboa</p>
<p>Exmo./a. Senhor/a <strong>{{Nome}}</strong>,</p>
<p>Em nome do Regimento de Sapadores Bombeiros de Lisboa, agradecemos a sua presença na <strong>{{Titulo}}</strong>, realizada a <strong>{{DataEvento}}</strong> no <strong>{{Local}}</strong>.</p>
<p>A sua participação contribuiu para o reforço da articulação e partilha técnica entre as entidades que diariamente respondem a este tipo de incidentes, e foi para nós uma honra acolhê-lo nesta sessão.</p>
<p>Em baixo encontra o link único para o seu certificado de participação, com o número <strong>{{NumeroCertificado}}</strong>.</p>
<p style="text-align:center;margin:24px 0"><a href="{{Link}}" style="background:#E30613;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Abrir o meu certificado</a></p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="margin:0 0 4px">Com os melhores cumprimentos,</p>
{{AssinaturaImagem}}
<p style="margin:4px 0 0;font-weight:600;color:#1a1a1a">{{Signatario}}</p>
<p style="margin:2px 0 0;font-size:12px;color:#666">{{SignatarioCargo}}</p>
<p style="margin:18px 0 0;font-size:11px;color:#888">Regimento de Sapadores Bombeiros de Lisboa · Câmara Municipal de Lisboa · rsb.esbl@cm-lisboa.pt</p>
</body></html>`;

  // ═══════════════════════════════════════════════════════════════════════════
  // ESTADO
  // ═══════════════════════════════════════════════════════════════════════════
  const ST = {
    evento: null,
    eventoSha: null,
    inscritos: [],          // sem email (público)
    inscritosSha: null,
    inscritosUltimoPublicado: [],  // snapshot do publicado (para detectar alterações)
    inscritosAdmin: {},     // map id → email (privado, sessionStorage)
    presencas: null,        // raw payload
    presencasSha: null,
    certificados: [],       // [{numero, idInscricao, hash, link, dataEmissao, dataEnvioEmail, anulado}]
    certificadosSha: null,
    pollTimer: null,
    activeTab: 'setup',
    syncStatus: 'idle'
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // UTIL
  // ═══════════════════════════════════════════════════════════════════════════
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  async function sha256Hex(s) {
    const buf = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function utf8ToBase64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function base64ToUtf8(b) { return decodeURIComponent(escape(atob(b))); }

  function nowIso() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtHora(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }
  function dataPorExtenso(iso) {
    const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return parseInt(m[3],10) + ' de ' + meses[parseInt(m[2],10)-1] + ' de ' + m[1];
  }
  function escapeHtml(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function normalizar(s) {
    return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function aplicarPlaceholders(tpl, vars) {
    let out = tpl;
    for (const k in vars) {
      out = out.split('{{' + k + '}}').join(vars[k] == null ? '' : vars[k]);
    }
    return out;
  }
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2800);
  }
  function setSync(status, text) {
    ST.syncStatus = status;
    const bar = $('sync-bar');
    bar.className = 'sync-bar ' + status;
    $('sync-text').textContent = text;
  }
  function setLoading(visible, text) {
    if (text) $('loading-text').textContent = text;
    $('loading').classList.toggle('hide', !visible);
  }
  function confirmar(titulo, msg) {
    return new Promise(resolve => {
      $('cf-titulo').textContent = titulo;
      $('cf-msg').textContent = msg;
      $('modal-confirm').classList.remove('hide');
      const close = ok => {
        $('modal-confirm').classList.add('hide');
        $('cf-ok').removeEventListener('click', okH);
        $('cf-cancel').removeEventListener('click', cH);
        resolve(ok);
      };
      const okH = () => close(true);
      const cH = () => close(false);
      $('cf-ok').addEventListener('click', okH);
      $('cf-cancel').addEventListener('click', cH);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GITHUB API
  // ═══════════════════════════════════════════════════════════════════════════
  function ghHeaders() {
    const tok = sessionStorage.getItem('gh_token');
    if (!tok) throw new Error('Sem token em sessão.');
    return {
      'Authorization': 'Bearer ' + tok,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  function ghContentsUrl(repo, path) {
    return `https://api.github.com/repos/${CONFIG.githubOwner}/${repo}/contents/${encodeURI(path)}?ref=${CONFIG.branch}`;
  }
  async function ghValidarToken() {
    const url = `https://api.github.com/repos/${CONFIG.githubOwner}/${CONFIG.repoData}`;
    const res = await fetch(url, { headers: ghHeaders() });
    if (res.status === 401 || res.status === 403)
      throw new Error('Token inválido ou sem permissões.');
    if (!res.ok) throw new Error('GitHub respondeu ' + res.status);
    return true;
  }
  async function ghLer(path, repo) {
    repo = repo || CONFIG.repoData;
    const res = await fetch(ghContentsUrl(repo, path), { headers: ghHeaders(), cache: 'no-store' });
    if (res.status === 404) return { sha: null, payload: null };
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    const j = await res.json();
    const text = base64ToUtf8(j.content.replace(/\n/g, ''));
    let payload = null;
    try { payload = JSON.parse(text); } catch (e) { payload = text; }
    return { sha: j.sha, payload };
  }
  async function ghEscrever(path, payload, sha, message, repo) {
    repo = repo || CONFIG.repoData;
    const body = {
      message: message || `update ${path} · ${nowIso()}`,
      content: utf8ToBase64(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)),
      branch: CONFIG.branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(
      `https://api.github.com/repos/${CONFIG.githubOwner}/${repo}/contents/${encodeURI(path)}`,
      { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) }
    );
    if (res.status === 409 || res.status === 422) {
      const e = new Error('CONFLICT');
      e.code = 'CONFLICT';
      throw e;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`PUT ${path}: ${res.status} ${t}`);
    }
    const j = await res.json();
    return j.content.sha;
  }
  // Escrita binária (PNG/JPEG). content já vem em base64 (sem prefix data:).
  async function ghEscreverBinario(path, base64Content, sha, message, repo) {
    repo = repo || CONFIG.repoData;
    const body = {
      message: message || `update ${path} · ${nowIso()}`,
      content: base64Content,
      branch: CONFIG.branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(
      `https://api.github.com/repos/${CONFIG.githubOwner}/${repo}/contents/${encodeURI(path)}`,
      { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`PUT ${path}: ${res.status} ${t}`);
    }
    return (await res.json()).content.sha;
  }
  async function ghApagar(path, sha, message, repo) {
    repo = repo || CONFIG.repoData;
    if (!sha) return false;
    const body = {
      message: message || `delete ${path} · ${nowIso()}`,
      sha: sha,
      branch: CONFIG.branch
    };
    const res = await fetch(
      `https://api.github.com/repos/${CONFIG.githubOwner}/${repo}/contents/${encodeURI(path)}`,
      { method: 'DELETE', headers: ghHeaders(), body: JSON.stringify(body) }
    );
    if (!res.ok && res.status !== 404) {
      const t = await res.text();
      throw new Error(`DELETE ${path}: ${res.status} ${t}`);
    }
    return true;
  }

  // Escrita com retry uma vez em caso de conflict (refetch + reaplica).
  async function ghEscreverComRetry(path, novoPayloadFn, shaActualFn, message, repo) {
    try {
      return await ghEscrever(path, novoPayloadFn(), shaActualFn(), message, repo);
    } catch (e) {
      if (e.code !== 'CONFLICT') throw e;
      // Refetch + tentar de novo
      const { sha, payload } = await ghLer(path, repo);
      // Não fazemos merge automático aqui — o caller deve passar funções que
      // reagem ao state actualizado se precisar (para os nossos casos é OK
      // sobrepor com o que está em ST, since admin é single-user).
      return await ghEscrever(path, novoPayloadFn(), sha, message, repo);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION STORAGE (emails)
  // ═══════════════════════════════════════════════════════════════════════════
  const SS_EMAILS = 'rsb_eventos_emails';
  function ssGravarEmails() {
    sessionStorage.setItem(SS_EMAILS, JSON.stringify(ST.inscritosAdmin));
  }
  function ssCarregarEmails() {
    try {
      const raw = sessionStorage.getItem(SS_EMAILS);
      if (raw) ST.inscritosAdmin = JSON.parse(raw);
    } catch (e) { ST.inscritosAdmin = {}; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════════════════════════════════════════
  async function tentarLogin() {
    const pass = $('in-pin').value;
    const erro = $('login-erro');
    erro.classList.add('hide');

    if (!pass) {
      erro.textContent = 'Introduz a password admin.';
      erro.classList.remove('hide');
      return;
    }
    const hash = await sha256Hex(pass);
    if (hash !== CONFIG.pinHash) {
      erro.textContent = 'Password incorrecta.';
      erro.classList.remove('hide');
      return;
    }
    let token;
    try {
      token = await decifrarPATComPassword(pass);
    } catch (e) {
      erro.textContent = 'Falha a decifrar o PAT — código desactualizado?';
      erro.classList.remove('hide');
      return;
    }
    sessionStorage.setItem('gh_token', token);
    try {
      await ghValidarToken();
    } catch (e) {
      sessionStorage.removeItem('gh_token');
      erro.textContent = 'PAT cifrado inválido ou expirou: ' + e.message;
      erro.classList.remove('hide');
      return;
    }
    sessionStorage.setItem('autenticado', '1');
    $('modal-login').classList.add('hide');
    iniciar();
  }
  function precisaLogin() {
    return !sessionStorage.getItem('autenticado') || !sessionStorage.getItem('gh_token');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CARREGAMENTO INICIAL
  // ═══════════════════════════════════════════════════════════════════════════
  async function iniciar() {
    setLoading(true, 'A carregar dados…');
    ssCarregarEmails();
    try {
      // Carregar em paralelo (entregas + apreciacao acrescentados para o dashboard)
      const [evt, ins, pres, certs, entr, apr] = await Promise.all([
        ghLer('data/evento.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/inscritos.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/presencas.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/certificados.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/entregas.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/apreciacao.json').catch(() => ({ sha: null, payload: null }))
      ]);

      ST.entregas = (entr.payload && entr.payload.entregas) || [];
      ST.apreciacao = (apr.payload && apr.payload.respostas) || [];

      ST.eventoSha = evt.sha;
      ST.evento = evt.payload || eventoDefault();
      // Backwards-compat: se o evento.json antigo tinha 'secret' inline, remove-o
      // (o SECRET deve viver só em sessionStorage). Avisa o admin.
      if (ST.evento.secret) {
        const legacySecret = ST.evento.secret;
        delete ST.evento.secret;
        if (!getSecret()) setSecret(legacySecret);
        toast('⚠️ Detectado SECRET legacy em evento.json. Foi removido do JSON e copiado para a tua sessão. Clica "Guardar configuração" para republicar sem o SECRET.', 'err');
      }

      ST.inscritosSha = ins.sha;
      ST.inscritos = (ins.payload && ins.payload.inscritos) || [];
      ST.inscritosUltimoPublicado = JSON.parse(JSON.stringify(ST.inscritos));

      ST.presencasSha = pres.sha;
      ST.presencas = pres.payload;

      ST.certificadosSha = certs.sha;
      ST.certificados = (certs.payload && certs.payload.certificados) || [];

      // Render
      hidratarSetup();
      renderDashboard();
      renderInscritos();
      renderPresencas();
      renderEmissao();
      renderEnvio();
      atualizarBadges();
      mostrarAuthStatus();

      $('evt-titulo-h').textContent = ST.evento.titulo || 'RSB Lisboa';
      $('link-tablet').href = CONFIG.urlTablet;

      setSync('ok', 'Dados carregados · ' + new Date().toLocaleTimeString('pt-PT'));
      setLoading(false);

      iniciarPolling();
    } catch (e) {
      console.error(e);
      setSync('err', 'Erro: ' + e.message);
      toast('Erro a carregar: ' + e.message, 'err');
      setLoading(false);
    }
  }

  function eventoDefault() {
    // Valores pré-preenchidos para o evento de 18/05/2026.
    // Substituir manualmente para outros eventos.
    return {
      schema: 'evento@1',
      id: 1,
      titulo: 'Sessão Técnica em Substâncias Perigosas',
      data: '2026-05-18',
      local: 'Auditório do Metropolitano de Lisboa',
      horaInicio: '09:00',
      horaFim: '12:00',
      cargaHoraria: '3 horas',
      proxNumeroCert: 1,
      descricao: 'dedicada ao reforço de conhecimentos técnicos e à sensibilização para os riscos associados à intervenção operacional em cenários envolvendo substâncias perigosas.',
      signatario: 'TCor Eng. Alexandre Rodrigues',
      signatarioCargo: 'Comandante do RSBL',
      assinaturaComandantePng: '',   // data URL base64 PNG, carregada via Setup
      assinaturaCarregadaEm: '',     // ISO timestamp
      users: [],                     // 5 max · {nome, passHash} · usado em balcao/p.html/porta
      msFormsUrl: '',                // URL do MS Forms com placeholders {id} {nome} {cargo} {entidade}
      emailFrom: '',
      emailCc: '',
      emailSubject: 'Certificado de Participação · Sessão Técnica em Substâncias Perigosas',
      emailBody: TEMPLATE_EMAIL_DEFAULT
      // NOTA: secret NÃO entra aqui — fica em sessionStorage por segurança.
      // Ver getSecret() / setSecret() abaixo.
    };
  }

  // SECRET: armazenado APENAS em sessionStorage do admin. Nunca é publicado
  // no GitHub (que pode estar num repo Public). Cada admin tem de o introduzir
  // uma vez por sessão.
  function getSecret() { return sessionStorage.getItem('rsb_secret') || ''; }
  function setSecret(s) {
    if (s) sessionStorage.setItem('rsb_secret', s);
    else sessionStorage.removeItem('rsb_secret');
  }
  // Bridge Apps Script — secret igualmente em sessionStorage (URL pode estar
  // em evento.json porque é só um endpoint Google).
  function getBridgeSecret() { return sessionStorage.getItem('rsb_bridge_secret') || ''; }
  function setBridgeSecret(s) {
    if (s) sessionStorage.setItem('rsb_bridge_secret', s);
    else sessionStorage.removeItem('rsb_bridge_secret');
  }

  function iniciarPolling() {
    clearInterval(ST.pollTimer);
    ST.pollTimer = setInterval(async () => {
      if (ST.activeTab !== 'presencas') return;
      try {
        const { sha, payload } = await ghLer('data/presencas.json');
        if (sha !== ST.presencasSha) {
          ST.presencasSha = sha;
          ST.presencas = payload;
          renderPresencas();
          atualizarBadges();
        }
      } catch (e) { /* silencioso */ }
    }, CONFIG.presencasPollMs);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP TAB
  // ═══════════════════════════════════════════════════════════════════════════
  function hidratarSetup() {
    const e = ST.evento;
    $('evt-id').value = e.id || 1;
    $('evt-data').value = e.data || '';
    $('evt-titulo').value = e.titulo || '';
    $('evt-local').value = e.local || '';
    $('evt-h-inicio').value = e.horaInicio || '';
    $('evt-h-fim').value = e.horaFim || '';
    $('evt-carga').value = e.cargaHoraria || '';
    $('evt-prox-num').value = e.proxNumeroCert || 1;
    $('evt-descricao').value = e.descricao || '';
    $('evt-sig-nome').value = e.signatario || '';
    $('evt-sig-cargo').value = e.signatarioCargo || '';
    renderAssinaturaPreview(e.assinaturaComandantePng);
    if ($('evt-ms-forms-url')) $('evt-ms-forms-url').value = e.msFormsUrl || '';
    $('evt-email-from').value = e.emailFrom || '';
    $('evt-email-cc').value = e.emailCc || '';
    $('evt-email-subject').value = e.emailSubject || '';
    $('evt-email-body').value = e.emailBody || TEMPLATE_EMAIL_DEFAULT;
    $('evt-secret').value = getSecret();
    $('evt-bridge-url').value = e.bridgeUrl || '';
    $('evt-bridge-secret').value = getBridgeSecret();
    $('evt-bridge-from').value = e.bridgeFrom || '';
    renderUsersGrid();
  }

  function renderUsersGrid() {
    const grid = $('users-grid');
    if (!grid) return;
    const e = ST.evento || {};
    const users = Array.isArray(e.users) ? e.users : [];
    const linhas = [
      '<div style="font-size:11px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">#</div>',
      '<div style="font-size:11px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Nome de utilizador</div>',
      '<div style="font-size:11px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Palavra-passe</div>',
      '<div style="font-size:11px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Estado</div>'
    ];
    for (let i = 0; i < 5; i++) {
      const u = users[i] || { nome: '', passHash: '' };
      const temPass = !!u.passHash;
      linhas.push(`<div style="color:var(--texto-mute);font-weight:600">${i + 1}</div>`);
      linhas.push(`<input type="text" id="user-nome-${i}" value="${escapeHtml(u.nome || '')}" placeholder="(slot vazio)" style="padding:7px 10px;font-size:13px;font-family:inherit;border:1px solid var(--linha);border-radius:6px">`);
      linhas.push(`<input type="password" id="user-pass-${i}" value="" placeholder="${temPass ? '(actual — deixar vazio para manter)' : 'definir nova'}" style="padding:7px 10px;font-size:13px;font-family:inherit;border:1px solid var(--linha);border-radius:6px">`);
      const pillCor = u.nome && temPass ? '#1e8a3a' : (u.nome ? '#c46c00' : '#aaa');
      const pillTxt = u.nome && temPass ? 'Activo' : (u.nome ? 'Sem pass' : 'Vazio');
      linhas.push(`<span style="background:${pillCor};color:#fff;font-size:11px;padding:3px 8px;border-radius:999px;font-weight:600;text-align:center">${pillTxt}</span>`);
    }
    grid.innerHTML = linhas.join('');
  }
  function lerSetup() {
    const e = ST.evento || eventoDefault();
    e.schema = 'evento@1';
    e.id = parseInt($('evt-id').value, 10) || 1;
    e.data = $('evt-data').value;
    e.titulo = $('evt-titulo').value.trim();
    e.local = $('evt-local').value.trim();
    e.horaInicio = $('evt-h-inicio').value;
    e.horaFim = $('evt-h-fim').value;
    e.cargaHoraria = $('evt-carga').value.trim();
    e.proxNumeroCert = parseInt($('evt-prox-num').value, 10) || 1;
    e.descricao = $('evt-descricao').value.trim();
    e.signatario = $('evt-sig-nome').value.trim();
    e.signatarioCargo = $('evt-sig-cargo').value.trim();
    if ($('evt-ms-forms-url')) e.msFormsUrl = $('evt-ms-forms-url').value.trim();
    e.emailFrom = $('evt-email-from').value.trim();
    e.emailCc = $('evt-email-cc').value.trim();
    e.emailSubject = $('evt-email-subject').value.trim();
    e.emailBody = $('evt-email-body').value;
    // SECRET vai para sessionStorage, NÃO para o JSON.
    setSecret($('evt-secret').value.trim());
    // Garantir que se herdou um secret legacy (de evento.json antigo), apaga-o.
    delete e.secret;
    // Bridge: URL e "from" vão para evento.json (não-sensíveis).
    // O bridge secret vai para sessionStorage.
    e.bridgeUrl = $('evt-bridge-url').value.trim();
    e.bridgeFrom = $('evt-bridge-from').value.trim();
    setBridgeSecret($('evt-bridge-secret').value.trim());
    e.actualizadoEm = nowIso();
    return e;
  }
  // Lê os 5 slots de users do Setup. Para cada slot, preserva o hash anterior
  // se a password ficar vazia (modo "manter actual"). Hash SHA-256 da password
  // ANTES de gravar em evento.json.
  async function lerUsersSetup() {
    const anteriores = (ST.evento && Array.isArray(ST.evento.users)) ? ST.evento.users : [];
    const out = [];
    for (let i = 0; i < 5; i++) {
      const nome = ($('user-nome-' + i) ? $('user-nome-' + i).value : '').trim();
      const pass = ($('user-pass-' + i) ? $('user-pass-' + i).value : '');
      if (!nome) continue; // slot vazio
      let passHash = '';
      if (pass) {
        passHash = await sha256Hex(pass);
      } else if (anteriores[i] && anteriores[i].nome === nome && anteriores[i].passHash) {
        passHash = anteriores[i].passHash; // manter o hash anterior se o nome não mudou
      }
      out.push({ nome, passHash });
    }
    return out;
  }
  async function setupGuardar() {
    const e = lerSetup();
    if (!e.titulo || !e.data) {
      toast('Título e data são obrigatórios.', 'err');
      return;
    }
    e.users = await lerUsersSetup();
    setLoading(true, 'A publicar evento.json…');
    try {
      ST.eventoSha = await ghEscreverComRetry(
        'data/evento.json',
        () => e,
        () => ST.eventoSha,
        `evento: ${e.titulo} · ${nowIso()}`
      );
      ST.evento = e;
      $('evt-titulo-h').textContent = e.titulo || 'RSB Lisboa';
      renderUsersGrid(); // refresca pills "Activo/Sem pass/Vazio"
      toast('Configuração guardada.', 'ok');
      setLoading(false);
    } catch (err) {
      setLoading(false);
      toast('Erro: ' + err.message, 'err');
    }
  }
  async function setupRecarregar() {
    setLoading(true, 'A recarregar…');
    try {
      const { sha, payload } = await ghLer('data/evento.json');
      ST.eventoSha = sha;
      ST.evento = payload || eventoDefault();
      hidratarSetup();
      $('evt-titulo-h').textContent = ST.evento.titulo || 'RSB Lisboa';
      toast('Recarregado.', 'ok');
      setLoading(false);
    } catch (err) {
      setLoading(false);
      toast('Erro: ' + err.message, 'err');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KILL SWITCH — desautoriza todos os tablets de uma vez
  // ═══════════════════════════════════════════════════════════════════════════
  async function mostrarAuthStatus() {
    const el = $('auth-status');
    if (!el) return;
    try {
      const { payload } = await ghLer('data/auth.json', CONFIG.repoData);
      const v = payload && payload.authVersao;
      const dt = payload && payload.actualizadoEm;
      el.innerHTML = '🔐 Versão actual: <strong>' + (v || '?') + '</strong>' +
        (dt ? ' · actualizada em ' + escapeHtml(dt) : '');
    } catch (_) {
      el.textContent = 'Não foi possível ler data/auth.json no repo Presencas.';
    }
  }

  async function revogarTablets() {
    const ok = await confirmar(
      'Desautorizar tablets',
      'Esta acção força logout em todos os tablets configurados. Cada operador terá de reintroduzir a password admin no próximo acesso. Continuar?'
    );
    if (!ok) return;
    setLoading(true, 'A desautorizar tablets…');
    try {
      const { sha, payload } = await ghLer('data/auth.json', CONFIG.repoData)
        .catch(() => ({ sha: null, payload: null }));
      const versaoActual = (payload && parseInt(payload.authVersao, 10)) || 0;
      const novoPayload = {
        schema: 'auth@1',
        authVersao: versaoActual + 1,
        actualizadoEm: nowIso()
      };
      await ghEscrever('data/auth.json', novoPayload, sha,
        'revoke: desautorizar tablets · v' + (versaoActual + 1),
        CONFIG.repoData);
      setLoading(false);
      toast('Tablets desautorizados · versão ' + (versaoActual + 1), 'ok');
      mostrarAuthStatus();
    } catch (err) {
      setLoading(false);
      toast('Erro: ' + err.message, 'err');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INSCRITOS TAB
  // ═══════════════════════════════════════════════════════════════════════════
  // Mapeia estado do Excel para vocabulário canónico (igual ao Access).
  function mapearEstado(s) {
    const v = normalizar(s);
    if (!v) return 'Pendente';
    if (v.indexOf('confirm') >= 0) return 'Confirmada';
    if (v.indexOf('recusa') >= 0) return 'Recusada';
    if (v.indexOf('espera') >= 0 || v.indexOf('wait') >= 0) return 'Lista de espera';
    if (v.indexOf('cancel') >= 0) return 'Cancelada';
    return 'Pendente';
  }

  // Converte qualquer valor truthy do Excel para Boolean (incluindo "Sim", "X", checkmark).
  function toBool(v) {
    if (v == null || v === '') return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = String(v).toLowerCase().trim();
    return s === 'true' || s === 'verdadeiro' || s === 'sim' || s === 'yes' ||
           s === '1' || s === 'x' || s === '✓';
  }

  function detectarColuna(headers, candidatos) {
    const norm = headers.map(h => normalizar(String(h || '')));
    for (const c of candidatos) {
      const cn = normalizar(c);
      const idx = norm.findIndex(h => h === cn || h.startsWith(cn));
      if (idx >= 0) return idx;
    }
    return -1;
  }
  function processarExcel(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        // Folha "Convidados" se existir, senão a primeira
        const sheetName = wb.SheetNames.find(n => normalizar(n) === 'convidados') || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (rows.length < 2) {
          toast('Excel sem linhas de dados.', 'err');
          return;
        }
        const headers = rows[0].map(h => String(h || '').trim());
        const idxNome       = detectarColuna(headers, ['nome']);
        const idxEmail      = detectarColuna(headers, ['email', 'mail']);
        const idxCargo      = detectarColuna(headers, ['cargo', 'posto']);
        const idxEntidade   = detectarColuna(headers, ['entidade', 'corpora']);
        const idxCategoria  = detectarColuna(headers, ['categoria']);
        const idxEstado     = detectarColuna(headers, ['estado_inscri', 'estado de ins', 'estado inscri']);
        const idxNaoEnviar  = detectarColuna(headers, ['nao enviar', 'não enviar', 'naoenviar']);
        const idxEraConv    = detectarColuna(headers, ['era_convidado', 'era convidado', 'eraconvidado', 'convidado']);

        if (idxNome < 0) {
          toast('Coluna "Nome" não encontrada no Excel.', 'err');
          return;
        }

        // Construir lista
        const inscritos = [];
        const emails = {};
        let id = 1;
        let multiEmail = 0, semEmailCount = 0, naoEnviarCount = 0;
        // Tentar manter IDs existentes se a primeira coluna parecer um ID inteiro
        const idxId = detectarColuna(headers, ['id_convidado', 'id convidado', 'idinscricao']);
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          const nome = String(r[idxNome] || '').trim();
          if (!nome) continue;
          const inscritoId = (idxId >= 0 && parseInt(r[idxId], 10)) ? parseInt(r[idxId], 10) : id++;

          // Email — pode ter múltiplos separados por `;` ou `,`. Normalizamos
          // para comma-separated (RFC 5322 / mailto: aceita).
          let emailRaw = idxEmail >= 0 ? String(r[idxEmail] || '').trim() : '';
          let email = '';
          if (emailRaw) {
            const partes = emailRaw.split(/[;,]\s*/).map(s => s.trim()).filter(Boolean);
            if (partes.length > 1) multiEmail++;
            email = partes.join(', ');
          }

          const cargo = idxCargo >= 0 ? String(r[idxCargo] || '').trim() : '';
          const entidade = idxEntidade >= 0 ? String(r[idxEntidade] || '').trim() : '';
          const categoria = idxCategoria >= 0 ? String(r[idxCategoria] || '').trim() : '';
          const estadoRaw = idxEstado >= 0 ? String(r[idxEstado] || '').trim() : '';
          // Mapear estado para o mesmo vocabulário do Access
          const estado = mapearEstado(estadoRaw);
          // Flag "Não enviar Mail"
          const naoEnviar = idxNaoEnviar >= 0 ? toBool(r[idxNaoEnviar]) : false;
          // Era convidado? (Sim/Não). Default "Sim" se não tem coluna (assume todos eram convidados).
          let eraConvidado = 'Sim';
          if (idxEraConv >= 0) {
            const v = String(r[idxEraConv] || '').trim().toLowerCase();
            if (v === 'não' || v === 'nao' || v === 'no' || v === 'false' || v === '0') eraConvidado = 'Não';
            else if (v === 'sim' || v === 'yes' || v === 'true' || v === '1' || v === 'x') eraConvidado = 'Sim';
          }

          if (!email) semEmailCount++;
          if (naoEnviar) naoEnviarCount++;

          inscritos.push({ id: inscritoId, nome, cargo, entidade, categoria, estado, naoEnviar, eraConvidado });
          if (email && !naoEnviar) emails[inscritoId] = email;
        }

        if (inscritos.length === 0) {
          toast('Nenhum inscrito encontrado.', 'err');
          return;
        }

        // Preservar campos desconhecidos (token, email, temMail, idRespostaForms)
        // dos inscritos antigos com o mesmo id — caso contrario, importar Excel apaga
        // os tokens gerados externamente. Match estritamente por id.
        let tokensPreservados = 0;
        const indexAntigo = new Map((ST.inscritos || []).map(i => [i.id, i]));
        const inscritosMerged = inscritos.map(novo => {
          const antigo = indexAntigo.get(novo.id);
          if (!antigo) return novo;
          const merged = Object.assign({}, antigo, novo);
          if (antigo.token) tokensPreservados++;
          return merged;
        });

        // Stage no estado
        ST.inscritos = inscritosMerged.sort((a, b) => normalizar(a.nome).localeCompare(normalizar(b.nome)));
        ST.inscritosAdmin = emails;
        ssGravarEmails();

        renderInscritos();
        renderEmissao();
        renderEnvio();
        atualizarBadges();
        marcarAlteradoSeDiferente();
        const detalhes = [];
        if (multiEmail) detalhes.push(`${multiEmail} com múltiplos emails (juntados com vírgula)`);
        if (semEmailCount) detalhes.push(`${semEmailCount} sem email`);
        if (naoEnviarCount) detalhes.push(`${naoEnviarCount} flagged "Não enviar Mail" (excluídos do envio)`);
        if (tokensPreservados) detalhes.push(`${tokensPreservados} tokens preservados`);
        toast(`${inscritos.length} inscritos lidos${detalhes.length ? '. ' + detalhes.join(', ') : ''}. Clica "Publicar" para os tornar visíveis à app de presenças.`, 'ok');
      } catch (err) {
        console.error(err);
        toast('Erro a ler Excel: ' + err.message, 'err');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderInscritos() {
    const previewEl = $('inscritos-preview');
    const publicaEl = $('inscritos-publica');

    // Aplicar busca (se preenchida)
    const busca = (ST.inscritosBusca || '').trim();
    let lista = ST.inscritos;
    if (busca) {
      const q = normalizar(busca);
      lista = ST.inscritos.filter(i => {
        const emailLocal = ST.inscritosAdmin[i.id] || '';
        return normalizar(i.nome || '').includes(q)
          || normalizar(i.cargo || '').includes(q)
          || normalizar(i.entidade || '').includes(q)
          || normalizar(i.email || '').includes(q)
          || normalizar(emailLocal).includes(q)
          || normalizar(i.token || '').includes(q)
          || String(i.id || '').includes(q);
      });
    }

    // Preview do Excel (em sessão)
    if (ST.inscritos.length > 0) {
      const semEmail = ST.inscritos.filter(i => !ST.inscritosAdmin[i.id] && !i.email).length;
      previewEl.classList.remove('hide');
      const filtroInfo = busca
        ? ` · A mostrar <strong>${lista.length}</strong> resultados para "${escapeHtml(busca)}"`
        : '';
      previewEl.innerHTML = `
        <div class="alert ${semEmail > 0 ? 'warn' : 'ok'}">
          <strong>${ST.inscritos.length}</strong> inscritos em sessão
          ${semEmail > 0 ? ` · <strong>${semEmail}</strong> sem email (não receberão certificado)` : ''}
          ${filtroInfo}
        </div>` + tabelaInscritos(lista, true);
    } else {
      previewEl.classList.add('hide');
      previewEl.innerHTML = '';
    }

    // Lista pública (do GitHub)
    publicaEl.innerHTML = ST.inscritos.length > 0
      ? `<div class="alert info">Lista actual em sessão: <strong>${ST.inscritos.length}</strong> inscritos. Estado no GitHub é actualizado quando clicares "Publicar".</div>`
      : '<div class="alert warn">Sem inscritos. Faz upload do Excel acima.</div>';
  }

  function tabelaInscritos(lista, comEmail) {
    if (lista.length === 0) return '<div class="alert warn">Sem registos.</div>';
    const linhas = lista.map(i => {
      let colEmail = '';
      if (comEmail) {
        // Prioridade: email da sessão local (recém-carregado do Excel) > email do JSON público.
        const emSession = ST.inscritosAdmin[i.id];
        const emJson = (i.email || '').trim();
        const em = emSession || emJson;
        const origem = emSession ? 'sessão' : (emJson ? 'JSON' : '');
        colEmail = em
          ? `<td class="truncate"><span class="small mono" title="origem: ${origem}">${escapeHtml(em)}</span></td>`
          : `<td><span class="small" style="color:var(--erro)">— sem email —</span></td>`;
      }
      const eraConv = i.eraConvidado;
      const pillEra = eraConv === 'Não' || eraConv === 'Nao'
        ? '<span class="pill amarelo" title="Auto-inscrito · não estava na lista original">Auto</span>'
        : (eraConv === 'Sim' ? '<span class="pill cinza" title="Estava na lista de convidados original">Conv.</span>' : '');
      const flagNaoEnviar = i.naoEnviar ? '<span class="pill amarelo" title="Flag: Não enviar mail">🚫</span>' : '';
      return `<tr class="hover" data-row-id="${i.id}">
        <td><span class="small mono" style="color:var(--texto-mute)">${escapeHtml(String(i.id || ''))}</span></td>
        <td>${escapeHtml(i.nome)} ${flagNaoEnviar}</td>
        <td><span class="small">${escapeHtml(i.cargo || '—')}</span></td>
        <td><span class="small">${escapeHtml(i.entidade || '—')}</span></td>
        ${colEmail}
        <td><span class="estado-pill-click" data-id="${i.id}" style="cursor:pointer" title="Click para ciclar estado">${pillEstado(i.estado)}</span></td>
        <td>${pillEra}</td>
        <td><button class="acao-edit" data-id="${i.id}" style="background:transparent;border:1px solid var(--linha);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:13px" title="Editar">✏️</button></td>
      </tr>`;
    }).join('');
    return `<div style="max-height:480px;overflow:auto;border:1px solid var(--linha);border-radius:6px">
      <table>
        <thead><tr>
          <th style="width:50px">ID</th>
          <th>Nome</th><th>Cargo</th><th>Entidade</th>
          ${comEmail ? '<th>Email (sessão)</th>' : ''}
          <th style="width:120px">Estado</th>
          <th style="width:70px">Origem</th>
          <th style="width:48px"></th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>`;
  }

  // Ciclo de estados (clique na pill)
  const CICLO_ESTADOS = ['Pendente', 'Confirmada', 'Lista de espera', 'Cancelada', 'Recusada'];
  function proximoEstado(estado) {
    const i = CICLO_ESTADOS.indexOf(estado);
    return CICLO_ESTADOS[(i + 1) % CICLO_ESTADOS.length];
  }
  function pillEstado(s) {
    const v = (s || '').toLowerCase();
    if (v.indexOf('confirm') >= 0) return '<span class="pill verde">Confirmada</span>';
    if (v.indexOf('espera') >= 0) return '<span class="pill amarelo">Espera</span>';
    if (v.indexOf('cancel') >= 0 || v.indexOf('recusa') >= 0) return '<span class="pill vermelho">' + escapeHtml(s) + '</span>';
    return '<span class="pill cinza">' + escapeHtml(s || 'Pendente') + '</span>';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EDIÇÃO DE INSCRITOS (modal + ciclo de estado + add new)
  // ═══════════════════════════════════════════════════════════════════════════
  // ST.inscritosUltimoPublicado: snapshot do que está em data/inscritos.json
  // (usado para detectar alterações não publicadas).
  function marcarAlteradoSeDiferente() {
    const igual = JSON.stringify(ST.inscritos) === JSON.stringify(ST.inscritosUltimoPublicado || []);
    const el = $('inscritos-unsaved');
    if (el) el.classList.toggle('hide', igual);
  }

  function abrirEditModal(id) {
    const i = ST.inscritos.find(x => x.id == id);  // == para coerção (string vs int)
    if (!i) { toast('Inscrito não encontrado.', 'err'); return; }
    $('edit-titulo').textContent = 'Editar inscrito';
    $('edit-novo').value = '0';
    $('edit-id').value = i.id;
    // Meta com ID + Token (readonly, info)
    const tokenPart = i.token ? ' · Token: ' + i.token : '';
    $('edit-meta').textContent = 'ID: ' + i.id + tokenPart;
    $('edit-nome').value = i.nome || '';
    // Email: prioridade sessão local (recém-importado) > JSON público
    $('edit-email').value = ST.inscritosAdmin[i.id] || i.email || '';
    $('edit-cargo').value = i.cargo || '';
    $('edit-entidade').value = i.entidade || '';
    $('edit-estado').value = i.estado || 'Pendente';
    $('edit-era-conv').value = (i.eraConvidado === 'Não' || i.eraConvidado === 'Nao' || i.eraConvidado === false) ? 'Não' : 'Sim';
    $('edit-nao-enviar').checked = !!i.naoEnviar;
    $('edit-autoriza').checked = !!i.autorizaContacto;
    $('edit-delete').style.display = '';
    $('modal-edit-inscrito').classList.remove('hide');
    setTimeout(() => $('edit-nome').focus(), 60);
  }

  function abrirAddModal() {
    // Próximo ID livre
    let maxId = 0;
    for (const i of ST.inscritos) {
      const n = parseInt(i.id, 10);
      if (!isNaN(n) && n > maxId) maxId = n;
    }
    const novoId = maxId + 1;
    $('edit-titulo').textContent = 'Adicionar inscrito';
    $('edit-novo').value = '1';
    $('edit-id').value = novoId;
    $('edit-meta').textContent = 'Novo · ID: ' + novoId + ' · Token gerado no acto da publicação';
    $('edit-nome').value = '';
    $('edit-email').value = '';
    $('edit-cargo').value = '';
    $('edit-entidade').value = '';
    $('edit-estado').value = 'Confirmada';
    $('edit-era-conv').value = 'Não';
    $('edit-nao-enviar').checked = false;
    $('edit-autoriza').checked = false;
    $('edit-delete').style.display = 'none';
    $('modal-edit-inscrito').classList.remove('hide');
    setTimeout(() => $('edit-nome').focus(), 60);
  }

  function fecharEditModal() {
    $('modal-edit-inscrito').classList.add('hide');
  }

  function salvarEdit() {
    const novo = $('edit-novo').value === '1';
    const id = parseInt($('edit-id').value, 10);
    const nome = $('edit-nome').value.trim();
    if (!nome) { toast('Nome é obrigatório.', 'err'); $('edit-nome').focus(); return; }

    const email = $('edit-email').value.trim();
    const dados = {
      id: id,
      nome: nome,
      cargo: $('edit-cargo').value.trim(),
      entidade: $('edit-entidade').value.trim(),
      email: email,                                // publicado em inscritos.json (schema@2)
      autorizaContacto: $('edit-autoriza').checked,
      estado: $('edit-estado').value,
      eraConvidado: $('edit-era-conv').value,
      naoEnviar: $('edit-nao-enviar').checked
    };

    if (novo) {
      // Verificar duplicado de ID
      if (ST.inscritos.some(x => x.id == id)) {
        toast('Já existe um inscrito com este ID.', 'err');
        return;
      }
      ST.inscritos.push(dados);
    } else {
      const idx = ST.inscritos.findIndex(x => x.id == id);
      if (idx < 0) { toast('Inscrito não encontrado.', 'err'); return; }
      // Preservar campos desconhecidos (token, email, temMail, idRespostaForms, etc.)
      // que possam ter sido escritos no JSON por outro fluxo (workflow, Office Script).
      ST.inscritos[idx] = Object.assign({}, ST.inscritos[idx], dados);
    }

    // Email duplica em sessionStorage (cache local, util para .eml com bcc, etc.).
    if (email && !dados.naoEnviar) {
      ST.inscritosAdmin[id] = email;
    } else {
      delete ST.inscritosAdmin[id];
    }
    ssGravarEmails();

    // Reordenar alfabeticamente
    ST.inscritos.sort((a, b) => normalizar(a.nome).localeCompare(normalizar(b.nome)));

    fecharEditModal();
    renderInscritos();
    renderEmissao();
    renderEnvio();
    atualizarBadges();
    marcarAlteradoSeDiferente();
    toast(novo ? 'Inscrito adicionado (não publicado).' : 'Inscrito actualizado (não publicado).', 'ok');
  }

  async function apagarInscrito() {
    const id = parseInt($('edit-id').value, 10);
    const i = ST.inscritos.find(x => x.id == id);
    if (!i) return;
    const ok = await confirmar('Apagar inscrito',
      `Apagar "${i.nome}"? A operação só é permanente após "Publicar inscritos.json".`);
    if (!ok) return;
    ST.inscritos = ST.inscritos.filter(x => x.id != id);
    delete ST.inscritosAdmin[id];
    ssGravarEmails();
    fecharEditModal();
    renderInscritos();
    renderEmissao();
    renderEnvio();
    atualizarBadges();
    marcarAlteradoSeDiferente();
    toast('Inscrito removido (não publicado).', 'ok');
  }

  function ciclarEstado(id) {
    const i = ST.inscritos.find(x => x.id == id);
    if (!i) return;
    i.estado = proximoEstado(i.estado || 'Pendente');
    renderInscritos();
    marcarAlteradoSeDiferente();
  }

  async function inscritosPublicar() {
    if (ST.inscritos.length === 0) {
      toast('Carrega o Excel primeiro.', 'err');
      return;
    }
    if (!ST.evento || !ST.evento.id) {
      toast('Configura o evento na tab Setup primeiro.', 'err');
      return;
    }

    // Guard: detectar perda de tokens antes de publicar.
    // Compara tokens no estado actual vs no ultimo publicado (carregado no load).
    const tokensActuais = (ST.inscritos || []).filter(i => i.token).length;
    const tokensPublicados = (ST.inscritosUltimoPublicado || []).filter(i => i.token).length;
    if (tokensPublicados > 0 && tokensActuais < tokensPublicados) {
      const perdidos = tokensPublicados - tokensActuais;
      const okPerda = await confirmar(
        '⚠️ AVISO: vais perder tokens',
        `O JSON publicado tinha ${tokensPublicados} tokens; estás prestes a publicar uma versão com apenas ${tokensActuais}. Perderás ${perdidos} tokens — os QR codes desses participantes deixarão de funcionar para a Apreciação. Confirma SÓ se sabes o que estás a fazer.`
      );
      if (!okPerda) return;
    }

    const ok = await confirmar('Publicar inscritos',
      `Vai escrever ${ST.inscritos.length} inscritos em data/inscritos.json (sem emails). Continuar?`);
    if (!ok) return;

    const payload = {
      schema: 'inscritos@2',
      evento: {
        id: ST.evento.id,
        titulo: ST.evento.titulo,
        data: ST.evento.data,
        local: ST.evento.local,
        horaInicio: ST.evento.horaInicio,
        horaFim: ST.evento.horaFim,
        cargaHoraria: ST.evento.cargaHoraria
      },
      exportadoEm: nowIso(),
      total: ST.inscritos.length,
      inscritos: ST.inscritos
    };

    setLoading(true, 'A publicar inscritos.json…');
    try {
      ST.inscritosSha = await ghEscreverComRetry(
        'data/inscritos.json',
        () => payload,
        () => ST.inscritosSha,
        `inscritos: ${ST.inscritos.length} · ${nowIso()}`
      );
      // Snapshot do que ficou publicado (referência para "alterações por publicar")
      ST.inscritosUltimoPublicado = JSON.parse(JSON.stringify(ST.inscritos));
      marcarAlteradoSeDiferente();
      toast('Lista publicada.', 'ok');
      setLoading(false);
      atualizarBadges();
    } catch (e) {
      setLoading(false);
      toast('Erro: ' + e.message, 'err');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRESENÇAS TAB
  // ═══════════════════════════════════════════════════════════════════════════
  function renderPresencas() {
    const presMap = new Map();
    if (ST.presencas && Array.isArray(ST.presencas.marcacoes)) {
      for (const m of ST.presencas.marcacoes) presMap.set(m.idInscricao, m);
    }
    const tot = ST.inscritos.length;
    let pres = 0;
    for (const i of ST.inscritos) {
      const m = presMap.get(i.id);
      if (m && m.presente) pres++;
    }
    const aus = tot - pres;
    const pct = tot > 0 ? Math.round((pres / tot) * 100) : 0;
    $('pres-n-pres').textContent = pres;
    $('pres-n-tot').textContent = tot;
    $('pres-n-aus').textContent = aus;
    $('pres-pct').textContent = pct + '%';

    // Aplicar busca
    let lista = ST.inscritos;
    const busca = (ST.presencasBusca || '').trim();
    if (busca) {
      const q = normalizar(busca);
      lista = ST.inscritos.filter(i =>
        normalizar(i.nome || '').includes(q) ||
        normalizar(i.cargo || '').includes(q) ||
        normalizar(i.entidade || '').includes(q));
    }

    const linhas = lista.map(i => {
      const m = presMap.get(i.id);
      const presente = m && m.presente;
      return `<tr class="hover">
        <td>${escapeHtml(i.nome)}</td>
        <td><span class="small">${escapeHtml(i.cargo || '—')} ${i.entidade ? '· ' + escapeHtml(i.entidade) : ''}</span></td>
        <td>${presente ? '<span class="pill verde">Presente</span>' : '<span class="pill cinza">—</span>'}</td>
        <td><span class="small mono">${m && m.horaEntrada ? fmtHora(m.horaEntrada) : ''}</span></td>
      </tr>`;
    }).join('');
    $('pres-tabela').innerHTML = `<div style="max-height:480px;overflow:auto;border:1px solid var(--linha);border-radius:6px">
      <table>
        <thead><tr><th>Nome</th><th>Cargo / Entidade</th><th>Estado</th><th>Hora</th></tr></thead>
        <tbody>${linhas || '<tr><td colspan="4" style="text-align:center;color:var(--texto-mute);padding:20px">Sem inscritos</td></tr>'}</tbody>
      </table></div>`;
  }

  async function presencasRecarregar() {
    setLoading(true, 'A recarregar presenças…');
    try {
      const { sha, payload } = await ghLer('data/presencas.json');
      ST.presencasSha = sha;
      ST.presencas = payload;
      renderPresencas();
      atualizarBadges();
      toast('Presenças actualizadas.', 'ok');
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
    setLoading(false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMISSÃO TAB
  // ═══════════════════════════════════════════════════════════════════════════
  function getPresencasMap() {
    const m = new Map();
    if (ST.presencas && Array.isArray(ST.presencas.marcacoes)) {
      for (const x of ST.presencas.marcacoes) m.set(x.idInscricao, x);
    }
    return m;
  }
  function getCertsMap() {
    const m = new Map();
    for (const c of ST.certificados) m.set(c.idInscricao, c);
    return m;
  }
  async function gerarLinkCert(inscrito, numero, dataEvento, dataEmissao) {
    const e = ST.evento;
    const secret = getSecret();
    if (!secret) throw new Error('SECRET ausente. Preenche na tab Setup (não é guardado online).');
    const canonical = [
      inscrito.nome, inscrito.cargo, numero,
      dataEvento, dataEmissao, e.cargaHoraria,
      e.titulo, e.local, secret
    ].join('|');
    const hash = (await sha256Hex(canonical)).substring(0, 12).toLowerCase();
    const enc = encodeURIComponent;
    let link = CONFIG.baseUrlCerts + '?n=' + enc(inscrito.nome) +
                '&c=' + enc(inscrito.cargo || '') +
                '&id=' + enc(numero);
    if (dataEvento) link += '&d=' + enc(dataEvento);
    if (dataEmissao) link += '&e=' + enc(dataEmissao);
    if (e.cargaHoraria) link += '&h=' + enc(e.cargaHoraria);
    if (e.titulo) link += '&t=' + enc(e.titulo);
    if (e.local) link += '&l=' + enc(e.local);
    link += '&v=' + hash;
    return { link, hash };
  }

  // Devolve a tag HTML <img> da assinatura do Comandante, ou string vazia se
  // a assinatura nao estiver carregada. Usada no template do email.
  function assinaturaImagemTag() {
    const e = ST.evento || {};
    if (!e.assinaturaComandantePng) return '';
    return '<img src="' + e.assinaturaComandantePng + '" alt="Assinatura" style="display:block;max-height:80px;max-width:240px;margin:6px 0 2px">';
  }
  function renderEmissao() {
    const presMap = getPresencasMap();
    const certsMap = getCertsMap();
    const presentes = ST.inscritos.filter(i => {
      const m = presMap.get(i.id);
      return m && m.presente;
    });
    const semCert = presentes.filter(i => !certsMap.has(i.id)).length;
    const comCert = presentes.length - semCert;

    const e = ST.evento;
    const temSetup = e && e.titulo && e.data;
    const temSecret = !!getSecret();
    const okSetup = temSetup && temSecret;

    $('emissao-info').className = 'alert ' + (okSetup ? 'info' : 'erro');
    $('emissao-info').innerHTML = okSetup
      ? `<strong>${presentes.length}</strong> presentes · <strong>${comCert}</strong> com certificado · <strong>${semCert}</strong> em falta. Próximo nº: <code>${(e.data ? e.data.substring(0,4) : new Date().getFullYear())}/${String(e.proxNumeroCert).padStart(4,'0')}</code>`
      : (temSetup
          ? '⚠️ SECRET ausente em sessão. Preenche na tab Setup (campo SECRET_HASH).'
          : '⚠️ Configura primeiro o evento (título, data) na tab Setup.');

    // Aplicar busca
    let listaEm = ST.inscritos;
    const buscaEm = (ST.emissaoBusca || '').trim();
    if (buscaEm) {
      const q = normalizar(buscaEm);
      listaEm = ST.inscritos.filter(i => {
        const c = certsMap.get(i.id);
        return normalizar(i.nome || '').includes(q) ||
          normalizar(i.cargo || '').includes(q) ||
          normalizar(i.entidade || '').includes(q) ||
          (c && normalizar(c.numero || '').includes(q));
      });
    }

    const linhas = listaEm.map(i => {
      const m = presMap.get(i.id);
      const presente = m && m.presente;
      const c = certsMap.get(i.id);
      let estadoCol;
      if (!presente) estadoCol = '<span class="pill cinza">Ausente</span>';
      else if (c) estadoCol = '<span class="pill verde">' + escapeHtml(c.numero) + '</span>';
      else estadoCol = '<span class="pill amarelo">Por emitir</span>';
      const linkCol = c ? `<a href="${escapeHtml(c.link)}" target="_blank" class="small mono truncate" style="max-width:300px;display:inline-block">${escapeHtml(c.link.substring(0, 60))}…</a>` : '';
      return `<tr class="hover">
        <td>${escapeHtml(i.nome)}</td>
        <td>${estadoCol}</td>
        <td>${linkCol}</td>
      </tr>`;
    }).join('');
    $('emissao-tabela').innerHTML = `<div style="max-height:420px;overflow:auto;border:1px solid var(--linha);border-radius:6px;margin-top:14px">
      <table><thead><tr><th>Nome</th><th>Certificado</th><th>Link</th></tr></thead>
      <tbody>${linhas || '<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--texto-mute)">Sem inscritos</td></tr>'}</tbody></table></div>`;
  }

  async function emissaoGerar() {
    const e = ST.evento;
    if (!e || !e.titulo || !e.data) {
      toast('Configura o evento na tab Setup.', 'err');
      return;
    }
    if (!getSecret()) {
      toast('SECRET ausente em sessão. Preenche na tab Setup (não é publicado).', 'err');
      return;
    }
    const presMap = getPresencasMap();
    const certsMap = getCertsMap();
    const aEmitir = ST.inscritos.filter(i => {
      const m = presMap.get(i.id);
      return m && m.presente && !certsMap.has(i.id);
    });
    if (aEmitir.length === 0) {
      toast('Nada a emitir — todos os presentes já têm certificado.', 'ok');
      return;
    }
    const ok = await confirmar('Emitir certificados',
      `Vai emitir ${aEmitir.length} certificados e publicar em data/certificados.json. Continuar?`);
    if (!ok) return;

    setLoading(true, `A emitir ${aEmitir.length} certificado(s)…`);
    try {
      const ano = (e.data || new Date().toISOString().substring(0,10)).substring(0,4);
      const dataEvento = dataPorExtenso(e.data);
      const dataEmissao = dataPorExtenso(new Date().toISOString().substring(0,10));
      let prox = e.proxNumeroCert || 1;

      for (const inscrito of aEmitir) {
        const numero = String(prox).padStart(4, '0') + '/' + ano;
        const { link, hash } = await gerarLinkCert(inscrito, numero, dataEvento, dataEmissao);
        ST.certificados.push({
          numero, idInscricao: inscrito.id,
          hash, link,
          dataEmissao: nowIso(),
          dataEnvioEmail: null,
          anulado: false
        });
        prox++;
      }
      e.proxNumeroCert = prox;

      // Persistir
      const certsPayload = {
        schema: 'certificados@1',
        eventoId: e.id,
        actualizadoEm: nowIso(),
        total: ST.certificados.length,
        certificados: ST.certificados
      };
      ST.certificadosSha = await ghEscreverComRetry(
        'data/certificados.json',
        () => certsPayload,
        () => ST.certificadosSha,
        `certificados: +${aEmitir.length} · ${nowIso()}`
      );
      // Atualizar evento.json com proxNumeroCert novo
      e.actualizadoEm = nowIso();
      ST.eventoSha = await ghEscreverComRetry(
        'data/evento.json',
        () => e,
        () => ST.eventoSha,
        `evento: proxNumeroCert=${e.proxNumeroCert}`
      );
      ST.evento = e;

      hidratarSetup();
      renderEmissao();
      renderEnvio();
      atualizarBadges();
      setLoading(false);
      toast(`${aEmitir.length} certificados emitidos.`, 'ok');
    } catch (err) {
      setLoading(false);
      toast('Erro: ' + err.message, 'err');
    }
  }

  async function emissaoPublicarCertsJson() {
    if (ST.certificados.length === 0) {
      toast('Sem certificados emitidos.', 'err');
      return;
    }
    const payload = {
      emitidoPor: 'Regimento de Sapadores Bombeiros de Lisboa',
      dataExportacao: nowIso(),
      certificados: ST.certificados.map(c => ({
        n: c.numero,
        d: (c.dataEmissao || '').substring(0,10),
        anulado: !!c.anulado
      })),
      total: ST.certificados.length
    };
    setLoading(true, 'A publicar certs.json no repo Certificados…');
    try {
      // sha do certs.json no repo Certificados (precisamos ler primeiro)
      const cur = await ghLer('certs.json', CONFIG.repoCerts);
      await ghEscrever('certs.json', payload, cur.sha,
        `certs.json: ${ST.certificados.length} · ${nowIso()}`,
        CONFIG.repoCerts);
      toast('certs.json publicado em ' + CONFIG.repoCerts + '.', 'ok');
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
    setLoading(false);
  }

  async function emissaoRecarregar() {
    setLoading(true, 'A recarregar…');
    try {
      const [pres, certs, evt] = await Promise.all([
        ghLer('data/presencas.json'),
        ghLer('data/certificados.json'),
        ghLer('data/evento.json')
      ]);
      ST.presencasSha = pres.sha; ST.presencas = pres.payload;
      ST.certificadosSha = certs.sha; ST.certificados = (certs.payload && certs.payload.certificados) || [];
      ST.eventoSha = evt.sha; ST.evento = evt.payload || ST.evento;
      hidratarSetup();
      renderEmissao();
      renderEnvio();
      atualizarBadges();
      toast('Recarregado.', 'ok');
    } catch (e) { toast('Erro: ' + e.message, 'err'); }
    setLoading(false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ENVIO TAB
  // ═══════════════════════════════════════════════════════════════════════════
  function renderEnvio() {
    const inscritosMap = new Map();
    for (const i of ST.inscritos) inscritosMap.set(i.id, i);

    // Banner do gate de assinatura
    const gateEl = $('envio-gate-assinatura');
    if (gateEl) {
      const e = ST.evento || {};
      if (e.assinaturaComandantePng) {
        const nomeCmt = (e.signatario || 'Comandante').trim();
        gateEl.className = 'alert ok';
        gateEl.innerHTML = '<strong>✓ Autorização activa</strong> · Assinatura de <strong>' + escapeHtml(nomeCmt) + '</strong> carregada. Envio liberado.';
      } else {
        gateEl.className = 'alert erro';
        gateEl.innerHTML = '<strong>⚠ Envio bloqueado</strong> · Assinatura do Comandante em falta. Vai à tab Setup, secção "Assinatura do certificado", e carrega o PNG antes de enviar.';
      }
    }

    // Aplicar busca
    let listaCerts = ST.certificados;
    const buscaEnv = (ST.envioBusca || '').trim();
    if (buscaEnv) {
      const q = normalizar(buscaEnv);
      listaCerts = ST.certificados.filter(c => {
        const i = inscritosMap.get(c.idInscricao) || {};
        const email = ST.inscritosAdmin[c.idInscricao] || i.email || '';
        return normalizar(i.nome || '').includes(q) ||
          normalizar(email).includes(q) ||
          normalizar(c.numero || '').includes(q);
      });
    }

    const linhas = listaCerts.map(c => {
      const i = inscritosMap.get(c.idInscricao) || { nome: '?', cargo: '', entidade: '', naoEnviar: false };
      // Email da sessão local tem prioridade (recém-importado); fallback para o JSON.
      const email = ST.inscritosAdmin[c.idInscricao] || (i.email || '').trim() || '';
      const enviado = !!c.dataEnvioEmail;
      const naoEnviar = !!i.naoEnviar;
      const podeEnviar = !!email && !enviado && !c.anulado && !naoEnviar;
      let colEmail, estadoPill;
      if (naoEnviar) {
        colEmail = `<span class="small" style="color:var(--aviso)">flag "Não enviar"</span>`;
        estadoPill = '<span class="pill amarelo">Não enviar</span>';
      } else if (!email) {
        colEmail = `<span class="small" style="color:var(--erro)">— sem email —</span>`;
        estadoPill = '<span class="pill cinza">Sem email</span>';
      } else {
        colEmail = `<span class="small">${escapeHtml(email)}</span>`;
        estadoPill = enviado
          ? '<span class="pill verde">Enviado</span>'
          : '<span class="pill amarelo">Por enviar</span>';
      }
      return `<tr class="hover">
        <td><input type="checkbox" class="env-chk" data-id="${c.idInscricao}" ${podeEnviar ? 'checked' : ''} ${podeEnviar ? '' : 'disabled'}></td>
        <td>${escapeHtml(i.nome)}</td>
        <td><span class="small mono">${escapeHtml(c.numero)}</span></td>
        <td>${colEmail}</td>
        <td>${estadoPill}</td>
      </tr>`;
    }).join('');
    $('envio-tabela').innerHTML = `<div style="max-height:420px;overflow:auto;border:1px solid var(--linha);border-radius:6px;margin-top:14px">
      <table>
        <thead><tr>
          <th style="width:32px"><input type="checkbox" id="env-chk-all" checked></th>
          <th>Nome</th><th>Nº Cert.</th><th>Email</th><th>Estado</th>
        </tr></thead>
        <tbody>${linhas || '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--texto-mute)">Sem certificados emitidos</td></tr>'}</tbody>
      </table></div>`;

    const all = $('env-chk-all');
    if (all) {
      all.addEventListener('change', () => {
        $$('.env-chk:not(:disabled)').forEach(c => c.checked = all.checked);
      });
    }
  }

  function getEnvioSeleccionados() {
    const ids = new Set();
    $$('.env-chk').forEach(c => { if (c.checked && !c.disabled) ids.add(parseInt(c.dataset.id, 10)); });
    return ST.certificados.filter(c => ids.has(c.idInscricao));
  }

  async function buildEmlContent(cert, inscrito, email) {
    const e = ST.evento;
    const dataEvento = dataPorExtenso(e.data);
    const vars = {
      Nome: inscrito.nome,
      Email: email,
      Cargo: inscrito.cargo || '',
      Entidade: inscrito.entidade || '',
      Titulo: e.titulo || '',
      DataEvento: dataEvento,
      HoraInicio: e.horaInicio || '',
      HoraFim: e.horaFim || '',
      Local: e.local || '',
      CargaHoraria: e.cargaHoraria || '',
      NumeroCertificado: cert.numero,
      Link: cert.link,
      Signatario: e.signatario || 'TCor Eng. Alexandre Rodrigues',
      SignatarioCargo: e.signatarioCargo || 'Comandante do RSBL',
      AssinaturaImagem: assinaturaImagemTag()
    };
    const subject = aplicarPlaceholders(e.emailSubject || 'Certificado · {{Nome}}', vars);
    const html = aplicarPlaceholders(e.emailBody || TEMPLATE_EMAIL_DEFAULT, vars);
    const text = htmlToText(html);

    // RFC 2047 para subject (suporta acentos)
    const subjectEnc = '=?UTF-8?B?' + utf8ToBase64(subject) + '?=';

    const boundary = '----=_boundary_' + Math.random().toString(36).substr(2, 12);
    const from = e.emailFrom ? `${e.emailFrom}` : 'secretariado@rsblisboa.pt';
    const cc = e.emailCc;
    const dateRfc = new Date().toUTCString();

    let eml = '';
    eml += `From: ${from}\r\n`;
    eml += `To: ${email}\r\n`;
    if (cc) eml += `Cc: ${cc}\r\n`;
    eml += `Subject: ${subjectEnc}\r\n`;
    eml += `Date: ${dateRfc}\r\n`;
    eml += `MIME-Version: 1.0\r\n`;
    eml += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`;
    eml += `X-Unsent: 1\r\n`;
    eml += `X-RSB-CertNumero: ${cert.numero}\r\n`;
    eml += `\r\n`;
    eml += `--${boundary}\r\n`;
    eml += `Content-Type: text/plain; charset=utf-8\r\n`;
    eml += `Content-Transfer-Encoding: base64\r\n\r\n`;
    eml += chunked(utf8ToBase64(text)) + `\r\n`;
    eml += `--${boundary}\r\n`;
    eml += `Content-Type: text/html; charset=utf-8\r\n`;
    eml += `Content-Transfer-Encoding: base64\r\n\r\n`;
    eml += chunked(utf8ToBase64(html)) + `\r\n`;
    eml += `--${boundary}--\r\n`;
    return eml;
  }
  function chunked(s) {
    return s.match(/.{1,76}/g).join('\r\n');
  }
  function htmlToText(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  }
  function fileSafe(s) {
    return (s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 60);
  }

  async function envioGerarZip() {
    const seleccionados = getEnvioSeleccionados();
    if (seleccionados.length === 0) {
      toast('Nada seleccionado.', 'err');
      return;
    }
    const inscritosMap = new Map();
    for (const i of ST.inscritos) inscritosMap.set(i.id, i);

    // Helper: email da sessão Excel OU email do JSON publico (schema@2).
    const obterEmail = (idInscricao) => {
      const ss = ST.inscritosAdmin[idInscricao];
      if (ss) return ss;
      const i = inscritosMap.get(idInscricao);
      return (i && i.email) ? i.email.trim() : '';
    };

    const semEmail = seleccionados.filter(c => !obterEmail(c.idInscricao));
    if (semEmail.length === seleccionados.length) {
      toast('Nenhum dos seleccionados tem email (nem na sessão, nem no JSON).', 'err');
      return;
    }
    if (semEmail.length > 0) {
      const ok = await confirmar('Emails em falta',
        `${semEmail.length} dos ${seleccionados.length} seleccionados não têm email. Continuar (vão ser ignorados)?`);
      if (!ok) return;
    }

    const nEnviar = seleccionados.length - semEmail.length;
    const okGate = await gateAssinatura(nEnviar);
    if (!okGate) return;

    setLoading(true, 'A construir emails…');
    try {
      const zip = new JSZip();
      let n = 0;
      for (const cert of seleccionados) {
        const email = obterEmail(cert.idInscricao);
        if (!email) continue;
        const inscrito = inscritosMap.get(cert.idInscricao);
        if (!inscrito) continue;
        const eml = await buildEmlContent(cert, inscrito, email);
        const fname = `${String(n+1).padStart(3,'0')}_${fileSafe(inscrito.nome)}_${fileSafe(cert.numero)}.eml`;
        zip.file(fname, eml);
        n++;
      }
      // Add README.txt no zip
      zip.file('LEIA-ME.txt',
`# Como enviar pelo Outlook desktop

1. Extrai este zip para uma pasta.
2. No Outlook, ir a "Drafts" (Rascunhos).
3. Selecciona TODOS os ficheiros .eml na pasta extraida e arrasta para a pasta Drafts do Outlook.
   (alternativa: File > Open > selecciona o .eml — abre cada um numa janela; menos prático)
4. Em Drafts, selecciona todos os emails (Ctrl+A) e clica "Send All Messages" (no menu File ou via Ctrl+Alt+S).

Se algum não enviar, vai estar em Drafts ainda. Reenvia individualmente.

Total: ${n} emails
`);
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `emails-certificados-${ST.evento.data || 'evento'}.zip`;
      document.body.appendChild(a); a.click(); a.remove();

      toast(`${n} .eml gerados em zip.`, 'ok');
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
    setLoading(false);
  }

  async function envioMailto() {
    const seleccionados = getEnvioSeleccionados();
    if (seleccionados.length === 0) {
      toast('Nada seleccionado.', 'err');
      return;
    }
    if (seleccionados.length > 5) {
      const ok = await confirmar('Abrir mailto:',
        `Vai abrir ${seleccionados.length} janelas de email. Tens a certeza? (Para mais que ~5 emails, usa o zip de .eml.)`);
      if (!ok) return;
    }

    const okGate = await gateAssinatura(seleccionados.length);
    if (!okGate) return;

    const inscritosMap = new Map();
    for (const i of ST.inscritos) inscritosMap.set(i.id, i);

    for (const cert of seleccionados) {
      const insc = inscritosMap.get(cert.idInscricao);
      const email = ST.inscritosAdmin[cert.idInscricao] || (insc && insc.email ? insc.email.trim() : '');
      if (!email) continue;
      const inscrito = insc;
      if (!inscrito) continue;
      const e = ST.evento;
      const sig = e.signatario || 'TCor Eng. Alexandre Rodrigues';
      const sigCargo = e.signatarioCargo || 'Comandante do RSBL';
      const vars = {
        Nome: inscrito.nome, Titulo: e.titulo, Link: cert.link,
        NumeroCertificado: cert.numero, DataEvento: dataPorExtenso(e.data),
        Local: e.local, Cargo: inscrito.cargo, Entidade: inscrito.entidade,
        CargaHoraria: e.cargaHoraria, HoraInicio: e.horaInicio, HoraFim: e.horaFim,
        Signatario: sig, SignatarioCargo: sigCargo,
        AssinaturaImagem: assinaturaImagemTag()
      };
      const subject = aplicarPlaceholders(e.emailSubject, vars);
      const body = `Exmo./a. Senhor/a ${inscrito.nome},\n\nEm nome do Regimento de Sapadores Bombeiros de Lisboa, agradecemos a sua presença na ${e.titulo}, realizada a ${dataPorExtenso(e.data)} no ${e.local}.\n\nO seu certificado de participação (nº ${cert.numero}) está disponível em:\n${cert.link}\n\nCom os melhores cumprimentos,\n${sig}\n${sigCargo}\nRegimento de Sapadores Bombeiros de Lisboa`;
      const url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.open(url, '_blank');
      // pequena pausa para evitar pop-up blocker
      await new Promise(r => setTimeout(r, 200));
    }
  }

  async function envioMarcarEnviados() {
    const seleccionados = getEnvioSeleccionados();
    if (seleccionados.length === 0) {
      toast('Nada seleccionado.', 'err');
      return;
    }
    const ok = await confirmar('Marcar como enviados',
      `Vai marcar ${seleccionados.length} certificados como enviados em data/certificados.json. Esta operação só altera o registo (não envia nada). Continuar?`);
    if (!ok) return;

    const ids = new Set(seleccionados.map(c => c.idInscricao));
    const agora = nowIso();
    for (const c of ST.certificados) {
      if (ids.has(c.idInscricao)) c.dataEnvioEmail = agora;
    }
    const payload = {
      schema: 'certificados@1',
      eventoId: ST.evento.id,
      actualizadoEm: agora,
      total: ST.certificados.length,
      certificados: ST.certificados
    };
    setLoading(true, 'A actualizar certificados.json…');
    try {
      ST.certificadosSha = await ghEscreverComRetry(
        'data/certificados.json',
        () => payload,
        () => ST.certificadosSha,
        `certificados: marcar ${seleccionados.length} enviados`
      );
      renderEnvio();
      atualizarBadges();
      toast(`${seleccionados.length} marcados como enviados.`, 'ok');
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
    setLoading(false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPS SCRIPT BRIDGE (envio automatizado opcional)
  // ═══════════════════════════════════════════════════════════════════════════
  async function bridgeCall(action, payload) {
    const url = (ST.evento && ST.evento.bridgeUrl) || '';
    const secret = getBridgeSecret();
    if (!url) throw new Error('Bridge URL ausente. Preenche na tab Setup.');
    if (!secret) throw new Error('Bridge secret ausente. Preenche na tab Setup (sessão).');

    const body = Object.assign({ action: action, secret: secret }, payload || {});
    // text/plain para evitar CORS preflight (Apps Script não suporta OPTIONS).
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    if (!res.ok) throw new Error('Bridge HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Bridge erro desconhecido');
    return j;
  }

  async function bridgeTestar() {
    const stat = $('bridge-status');
    stat.textContent = 'A testar…';
    stat.style.color = 'var(--texto-mute)';
    try {
      // Persistir antes de testar (secret e url têm de estar em sessão/state)
      lerSetup();
      const r = await bridgeCall('ping');
      stat.style.color = 'var(--verde)';
      stat.textContent = `✓ OK · v${r.version} · ${r.user} · quota: ${r.dailyQuota}`;
      toast('Bridge OK · ' + r.user, 'ok');
    } catch (e) {
      stat.style.color = 'var(--erro)';
      stat.textContent = '✗ ' + e.message;
      toast('Falha bridge: ' + e.message, 'err');
    }
  }

  async function envioViaBridge() {
    const seleccionados = getEnvioSeleccionados();
    if (seleccionados.length === 0) { toast('Nada seleccionado.', 'err'); return; }

    const inscritosMap = new Map();
    for (const i of ST.inscritos) inscritosMap.set(i.id, i);

    const emails = [];
    let semEmail = 0;
    for (const cert of seleccionados) {
      const insc = inscritosMap.get(cert.idInscricao);
      const email = ST.inscritosAdmin[cert.idInscricao] || (insc && insc.email ? insc.email.trim() : '');
      if (!email) { semEmail++; continue; }
      const inscrito = insc;
      if (!inscrito) continue;
      const e = ST.evento;
      const vars = {
        Nome: inscrito.nome, Email: email,
        Cargo: inscrito.cargo || '', Entidade: inscrito.entidade || '',
        Titulo: e.titulo || '', DataEvento: dataPorExtenso(e.data),
        HoraInicio: e.horaInicio || '', HoraFim: e.horaFim || '',
        Local: e.local || '', CargaHoraria: e.cargaHoraria || '',
        NumeroCertificado: cert.numero, Link: cert.link,
        Signatario: e.signatario || 'TCor Eng. Alexandre Rodrigues',
        SignatarioCargo: e.signatarioCargo || 'Comandante do RSBL',
        AssinaturaImagem: assinaturaImagemTag()
      };
      emails.push({
        idInscricao: cert.idInscricao,
        to: email,
        cc: e.emailCc || undefined,
        subject: aplicarPlaceholders(e.emailSubject || 'Certificado · {{Nome}}', vars),
        html: aplicarPlaceholders(e.emailBody || TEMPLATE_EMAIL_DEFAULT, vars)
      });
    }

    if (emails.length === 0) {
      toast('Nenhum dos seleccionados tem email em sessão.', 'err');
      return;
    }
    if (semEmail > 0) {
      const ok = await confirmar('Emails em falta',
        `${semEmail} dos seleccionados não têm email em sessão (vão ser ignorados). Continuar com ${emails.length} emails?`);
      if (!ok) return;
    }

    const okGate = await gateAssinatura(emails.length);
    if (!okGate) return;

    setLoading(true, `A enviar ${emails.length} email(s) via bridge…`);
    try {
      const r = await bridgeCall('send-batch', {
        emails: emails.map(m => ({ to: m.to, cc: m.cc, subject: m.subject, html: m.html })),
        fromName: ST.evento.signatario || 'RSB Lisboa',
        fromEmail: ST.evento.bridgeFrom || ''
      });

      // Marca enviados (apenas os que tiveram OK no relatório)
      const okSet = new Set();
      if (Array.isArray(r.results)) {
        for (let i = 0; i < r.results.length; i++) {
          if (r.results[i].ok) okSet.add(emails[i].idInscricao);
        }
      } else if (r.ok) {
        // sem relatório detalhado — assumir todos enviados
        for (const m of emails) okSet.add(m.idInscricao);
      }
      const agora = nowIso();
      for (const c of ST.certificados) {
        if (okSet.has(c.idInscricao)) c.dataEnvioEmail = agora;
      }
      // Persistir certificados.json
      const payload = {
        schema: 'certificados@1',
        eventoId: ST.evento.id,
        actualizadoEm: agora,
        total: ST.certificados.length,
        certificados: ST.certificados
      };
      ST.certificadosSha = await ghEscreverComRetry(
        'data/certificados.json',
        () => payload,
        () => ST.certificadosSha,
        `certificados: enviados via bridge (${r.sent}/${r.total}) · ${agora}`
      );

      renderEnvio();
      atualizarBadges();
      setLoading(false);
      const msg = `Enviados: ${r.sent} · Falhados: ${r.failed} · Quota restante: ${r.quotaRemaining || '?'}`;
      toast(msg, r.failed === 0 ? 'ok' : 'err');
    } catch (e) {
      setLoading(false);
      toast('Erro bridge: ' + e.message, 'err');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SNAPSHOT (backup local de todo o estado)
  // ═══════════════════════════════════════════════════════════════════════════
  async function snapshot() {
    setLoading(true, 'A construir snapshot…');
    try {
      const zip = new JSZip();
      // Estado actual em memória (após mutações que possam não estar publicadas)
      const eventoSemSecret = Object.assign({}, ST.evento || {});
      delete eventoSemSecret.secret;
      zip.file('evento.json', JSON.stringify(eventoSemSecret, null, 2));
      zip.file('inscritos.json', JSON.stringify({
        schema: 'inscritos@2',
        evento: ST.evento ? {
          id: ST.evento.id, titulo: ST.evento.titulo, data: ST.evento.data,
          local: ST.evento.local, horaInicio: ST.evento.horaInicio,
          horaFim: ST.evento.horaFim, cargaHoraria: ST.evento.cargaHoraria
        } : null,
        exportadoEm: nowIso(),
        total: ST.inscritos.length,
        inscritos: ST.inscritos
      }, null, 2));
      zip.file('presencas.json', JSON.stringify(ST.presencas || {}, null, 2));
      zip.file('certificados.json', JSON.stringify({
        schema: 'certificados@1',
        eventoId: ST.evento ? ST.evento.id : null,
        actualizadoEm: nowIso(),
        total: ST.certificados.length,
        certificados: ST.certificados
      }, null, 2));
      // Inscritos com email — só localmente
      zip.file('inscritos-com-email.PRIVADO.json', JSON.stringify(
        ST.inscritos.map(i => ({
          id: i.id, nome: i.nome, cargo: i.cargo, entidade: i.entidade,
          categoria: i.categoria, estado: i.estado,
          email: ST.inscritosAdmin[i.id] || (i.email || '')
        })), null, 2));

      zip.file('LEIA-ME.txt',
`Snapshot RSB Eventos · ${nowIso()}

Conteúdo:
  evento.json                       — metadata do evento (sem SECRET)
  inscritos.json                    — lista pública (sem emails)
  presencas.json                    — estado de presenças
  certificados.json                 — certificados emitidos
  inscritos-com-email.PRIVADO.json  — lista COM emails (não publicar!)

Uso:
  - Backup pré-evento: pasta segura
  - Pós-evento: arquivo do evento (o repo Git já é histórico, isto é
    cápsula consolidada num único zip).

Para restauro completo: extrair os JSON e fazer commit no repo Presencas,
substituindo o conteúdo da pasta data/. (Não precisa de restauro do .PRIVADO.)
`);

      const blob = await zip.generateAsync({ type: 'blob' });
      const dataStr = (ST.evento && ST.evento.data) ? ST.evento.data : new Date().toISOString().substring(0,10);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `snapshot-${dataStr}-${Date.now()}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      toast('Snapshot guardado.', 'ok');
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
    setLoading(false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BADGES + TABS
  // ═══════════════════════════════════════════════════════════════════════════
  function atualizarBadges() {
    $('badge-inscritos').textContent = ST.inscritos.length;

    const presMap = getPresencasMap();
    let pres = 0;
    for (const i of ST.inscritos) {
      const m = presMap.get(i.id);
      if (m && m.presente) pres++;
    }
    $('badge-presencas').textContent = pres;

    $('badge-emissao').textContent = ST.certificados.length;

    const porEnviar = ST.certificados.filter(c => !c.dataEnvioEmail && !c.anulado).length;
    $('badge-envio').textContent = porEnviar;
  }

  function activarTab(name) {
    ST.activeTab = name;
    $$('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('section.tab-panel').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'dashboard') renderDashboard();
    if (name === 'inscritos') renderInscritos();
    if (name === 'presencas') renderPresencas();
    if (name === 'emissao') renderEmissao();
    if (name === 'envio') renderEnvio();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════
  function renderDashboard() {
    if (!$('tab-dashboard')) return;
    const tot = ST.inscritos.length;
    let pres = 0;
    const presencasMarcacoes = (ST.presencas && Array.isArray(ST.presencas.marcacoes)) ? ST.presencas.marcacoes : [];
    for (const m of presencasMarcacoes) if (m.presente) pres++;
    const entr = (ST.entregas || []).length;
    const apr = (ST.apreciacao || []).length;
    const certs = (ST.certificados || []).filter(c => !c.anulado).length;
    const comEmail = ST.inscritos.filter(i => i.email).length;
    const comToken = ST.inscritos.filter(i => i.token).length;
    const autorizam = ST.inscritos.filter(i => i.autorizaContacto).length;

    $('dash-titulo-evento').textContent = (ST.evento && ST.evento.titulo) || 'Evento sem título';
    const dataLocal = [(ST.evento && ST.evento.data) || '', (ST.evento && ST.evento.local) || ''].filter(Boolean).join(' · ');
    $('dash-subtitulo').textContent = dataLocal || 'A carregar dados…';

    $('dash-stats').innerHTML = `
      <div class="stat-card pres"><div class="n">${pres}</div><div class="l">Presentes</div></div>
      <div class="stat-card"><div class="n">${tot}</div><div class="l">Inscritos</div></div>
      <div class="stat-card aviso"><div class="n">${tot - pres}</div><div class="l">Por marcar</div></div>
      <div class="stat-card"><div class="n">${entr}</div><div class="l">Livretos entregues</div></div>
      <div class="stat-card"><div class="n">${apr}</div><div class="l">Respostas Apreciação</div></div>
      <div class="stat-card"><div class="n">${certs}</div><div class="l">Certificados emitidos</div></div>
    `;

    $('dash-emails-stats').innerHTML = `
      <div>📧 <strong>${comEmail}</strong>/${tot} inscritos com email (<strong>${tot > 0 ? Math.round(100*comEmail/tot) : 0}%</strong>)</div>
      <div>🔑 <strong>${comToken}</strong>/${tot} com token gerado</div>
      <div>✓ <strong>${autorizam}</strong> autorizam contacto para iniciativas RSB</div>
    `;

    // Live feed: últimas 15 actividades (presenças + entregas + apreciação), ordenadas desc.
    const feed = [];
    for (const m of presencasMarcacoes) {
      if (m.presente && m.horaEntrada) {
        const i = ST.inscritos.find(x => x.id === m.idInscricao);
        if (i) feed.push({ ts: m.horaEntrada, tipo: 'pres', nome: i.nome, info: m.marcadoPor || '' });
      }
    }
    for (const e of (ST.entregas || [])) {
      const i = ST.inscritos.find(x => x.id === e.idInscricao);
      if (i) feed.push({ ts: e.entregueEm, tipo: 'entr', nome: i.nome, info: e.entreguePor || '' });
    }
    for (const r of (ST.apreciacao || [])) {
      const i = ST.inscritos.find(x => x.id === r.idInscricao);
      if (i) feed.push({ ts: r.submetidoEm, tipo: 'apr', nome: i.nome, info: r.email || '' });
    }
    feed.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

    if (feed.length === 0) {
      $('dash-feed').innerHTML = '<div style="padding:24px 16px;text-align:center;color:var(--texto-mute);font-size:13px">Sem actividade ainda. O feed actualiza assim que houver primeiras marcações.</div>';
    } else {
      const iconeTipo = { pres: '✓', entr: '🪪', apr: '📋' };
      const corTipo = { pres: 'var(--verde)', entr: 'var(--rsb-vermelho)', apr: 'var(--info)' };
      const labelTipo = { pres: 'Presente', entr: 'Livreto entregue', apr: 'Apreciação' };
      $('dash-feed').innerHTML = feed.slice(0, 15).map(f => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--linha)">
          <div style="width:28px;height:28px;border-radius:50%;background:${corTipo[f.tipo]};color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0">${iconeTipo[f.tipo]}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.nome)}</div>
            <div style="font-size:11.5px;color:var(--texto-mute)">${labelTipo[f.tipo]}${f.info ? ' · ' + escapeHtml(f.info) : ''}</div>
          </div>
          <div style="font-size:11px;color:var(--texto-mute);font-family:'SF Mono',Consolas,monospace;flex-shrink:0">${escapeHtml((f.ts || '').slice(11, 16))}</div>
        </div>
      `).join('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENTOS
  // ═══════════════════════════════════════════════════════════════════════════
  function bindEventos() {
    $$('nav.tabs button').forEach(b => b.addEventListener('click', () => activarTab(b.dataset.tab)));

    $('who-text').addEventListener('click', async () => {
      const ok = await confirmar('Sair', 'Vai apagar o token desta sessão. Continuar?');
      if (!ok) return;
      sessionStorage.clear();
      location.reload();
    });

    $('btn-login').addEventListener('click', tentarLogin);
    $('in-pin').addEventListener('keydown', e => { if (e.key === 'Enter') tentarLogin(); });

    $('btn-setup-save').addEventListener('click', setupGuardar);
    $('btn-setup-reload').addEventListener('click', setupRecarregar);
    $('btn-revogar-tablets').addEventListener('click', revogarTablets);

    // File drop
    const fd = $('filedrop');
    const fi = $('filein');
    fd.addEventListener('dragover', e => { e.preventDefault(); fd.classList.add('drag'); });
    fd.addEventListener('dragleave', () => fd.classList.remove('drag'));
    fd.addEventListener('drop', e => {
      e.preventDefault(); fd.classList.remove('drag');
      if (e.dataTransfer.files[0]) processarExcel(e.dataTransfer.files[0]);
    });
    fi.addEventListener('change', () => { if (fi.files[0]) processarExcel(fi.files[0]); });

    // Pesquisa rápida em todas as abas que tem listas
    const buscas = [
      { id: 'inscritos-busca', key: 'inscritosBusca', rerender: renderInscritos },
      { id: 'presencas-busca', key: 'presencasBusca', rerender: renderPresencas },
      { id: 'emissao-busca', key: 'emissaoBusca', rerender: renderEmissao },
      { id: 'envio-busca', key: 'envioBusca', rerender: renderEnvio }
    ];
    for (const b of buscas) {
      const inp = $(b.id);
      if (inp) inp.addEventListener('input', () => {
        ST[b.key] = inp.value;
        b.rerender();
      });
    }

    // Dashboard · botão recarregar
    const dashReload = $('dash-reload');
    if (dashReload) {
      dashReload.addEventListener('click', async () => {
        dashReload.disabled = true;
        dashReload.textContent = '↻ A recarregar…';
        try {
          await iniciar();
          toast('Dashboard actualizado.', 'ok');
        } catch (e) {
          toast('Erro: ' + e.message, 'err');
        } finally {
          dashReload.disabled = false;
          dashReload.textContent = '↻ Recarregar dados';
        }
      });
    }

    $('btn-inscritos-publish').addEventListener('click', inscritosPublicar);
    $('btn-inscritos-reload').addEventListener('click', async () => {
      setLoading(true, 'A recarregar inscritos…');
      try {
        const { sha, payload } = await ghLer('data/inscritos.json');
        ST.inscritosSha = sha;
        ST.inscritos = (payload && payload.inscritos) || [];
        ST.inscritosUltimoPublicado = JSON.parse(JSON.stringify(ST.inscritos));
        renderInscritos(); renderPresencas(); renderEmissao(); renderEnvio();
        atualizarBadges();
        marcarAlteradoSeDiferente();
        toast('Recarregado.', 'ok');
      } catch (e) { toast('Erro: ' + e.message, 'err'); }
      setLoading(false);
    });

    // ── Inscritos: add + edit + ciclo de estado (delegação) ──
    $('btn-inscritos-add').addEventListener('click', abrirAddModal);
    $('inscritos-preview').addEventListener('click', e => {
      const btnEdit = e.target.closest('.acao-edit');
      const pillEstadoEl = e.target.closest('.estado-pill-click');
      if (btnEdit) {
        abrirEditModal(btnEdit.dataset.id);
        return;
      }
      if (pillEstadoEl) {
        e.stopPropagation();
        ciclarEstado(pillEstadoEl.dataset.id);
        return;
      }
      // Click em qualquer outra zona da linha → editar
      const row = e.target.closest('tr.hover');
      if (row && row.dataset.rowId) abrirEditModal(row.dataset.rowId);
    });

    // Modal handlers
    $('edit-save').addEventListener('click', salvarEdit);
    $('edit-cancel').addEventListener('click', fecharEditModal);
    const fecharX = $('edit-fechar-x');
    if (fecharX) fecharX.addEventListener('click', fecharEditModal);
    $('edit-delete').addEventListener('click', apagarInscrito);
    $('modal-edit-inscrito').addEventListener('click', e => {
      if (e.target.id === 'modal-edit-inscrito') fecharEditModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('modal-edit-inscrito').classList.contains('hide')) {
        fecharEditModal();
      }
    });

    $('btn-presencas-reload').addEventListener('click', presencasRecarregar);

    $('btn-emissao-gerar').addEventListener('click', emissaoGerar);
    $('btn-emissao-publish').addEventListener('click', emissaoPublicarCertsJson);
    $('btn-emissao-reload').addEventListener('click', emissaoRecarregar);

    $('btn-envio-zip').addEventListener('click', envioGerarZip);
    $('btn-envio-mailto').addEventListener('click', envioMailto);
    $('btn-envio-marcar-enviados').addEventListener('click', envioMarcarEnviados);
    $('btn-envio-reload').addEventListener('click', emissaoRecarregar);
    $('btn-envio-bridge').addEventListener('click', envioViaBridge);

    $('btn-bridge-test').addEventListener('click', bridgeTestar);
    $('btn-snapshot').addEventListener('click', snapshot);

    // Upload da assinatura do Comandante
    $('btn-sig-upload').addEventListener('click', () => $('evt-sig-imagem-file').click());
    $('evt-sig-imagem-file').addEventListener('change', onAssinaturaUpload);
    $('btn-sig-remover').addEventListener('click', onAssinaturaRemover);

    // Assinar agora (canvas — caneta, rato, dedo)
    $('btn-sig-assinar').addEventListener('click', sigOpenModal);
    $('btn-assinatura-limpar').addEventListener('click', sigClearCanvas);
    $('btn-assinatura-cancelar').addEventListener('click', () => $('modal-assinatura').classList.add('hide'));
    $('btn-assinatura-salvar').addEventListener('click', sigSaveCanvas);
  }

  // ── SIGNATURE PAD ─────────────────────────────────────────────────────
  let _sigCtx = null;
  let _sigDrawing = false;
  let _sigDirty = false;

  function sigOpenModal() {
    $('modal-assinatura').classList.remove('hide');
    const canvas = $('assinatura-canvas');
    const wrap = $('assinatura-wrap');
    // Set canvas resolution to match display * device pixel ratio
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = wrap.clientWidth;
    const cssH = 240;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    _sigCtx = canvas.getContext('2d');
    _sigCtx.scale(dpr, dpr);
    _sigCtx.strokeStyle = '#111';
    _sigCtx.lineWidth = 2.2;
    _sigCtx.lineCap = 'round';
    _sigCtx.lineJoin = 'round';
    _sigDirty = false;
    $('assinatura-placeholder').style.display = 'flex';
    // Bind once
    if (!canvas._sigBound) {
      canvas.addEventListener('mousedown', sigStart);
      canvas.addEventListener('mousemove', sigDraw);
      window.addEventListener('mouseup', sigEnd);
      canvas.addEventListener('mouseleave', sigEnd);
      canvas.addEventListener('touchstart', sigStart, { passive: false });
      canvas.addEventListener('touchmove', sigDraw, { passive: false });
      canvas.addEventListener('touchend', sigEnd);
      canvas.addEventListener('touchcancel', sigEnd);
      canvas._sigBound = true;
    }
  }
  function sigGetPos(e) {
    const canvas = $('assinatura-canvas');
    const rect = canvas.getBoundingClientRect();
    const t = e.touches && e.touches[0];
    const x = (t ? t.clientX : e.clientX) - rect.left;
    const y = (t ? t.clientY : e.clientY) - rect.top;
    return { x, y };
  }
  function sigStart(e) {
    e.preventDefault();
    if (!_sigCtx) return;
    _sigDrawing = true;
    const p = sigGetPos(e);
    _sigCtx.beginPath();
    _sigCtx.moveTo(p.x, p.y);
    _sigDirty = true;
    $('assinatura-placeholder').style.display = 'none';
  }
  function sigDraw(e) {
    if (!_sigDrawing || !_sigCtx) return;
    e.preventDefault();
    const p = sigGetPos(e);
    _sigCtx.lineTo(p.x, p.y);
    _sigCtx.stroke();
  }
  function sigEnd() {
    if (_sigDrawing) {
      _sigDrawing = false;
      if (_sigCtx) _sigCtx.closePath();
    }
  }
  function sigClearCanvas() {
    if (!_sigCtx) return;
    const canvas = $('assinatura-canvas');
    _sigCtx.clearRect(0, 0, canvas.width, canvas.height);
    _sigDirty = false;
    $('assinatura-placeholder').style.display = 'flex';
  }
  async function sigSaveCanvas() {
    if (!_sigDirty) { toast('Assina primeiro antes de guardar.', 'err'); return; }
    const canvas = $('assinatura-canvas');
    const dataUrl = canvas.toDataURL('image/png');
    if (!ST.evento) ST.evento = eventoDefault();
    ST.evento.assinaturaComandantePng = dataUrl;
    ST.evento.assinaturaCarregadaEm = nowIso();
    renderAssinaturaPreview(dataUrl);
    $('modal-assinatura').classList.add('hide');
    toast('A publicar PNG no repo Certificados…', 'ok');
    try {
      const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/i, '');
      let sha = null;
      try {
        const cur = await ghLer('assets/assinatura-comandante.png', CONFIG.repoCerts);
        sha = cur.sha;
      } catch (_) { /* 404 = primeiro upload */ }
      await ghEscreverBinario(
        'assets/assinatura-comandante.png',
        base64,
        sha,
        'asset: assinatura do comandante desenhada via canvas no admin',
        CONFIG.repoCerts
      );
      toast('Assinatura sincronizada. Clica "Guardar configuração" para persistir.', 'ok');
    } catch (err) {
      console.error(err);
      toast('PNG guardado localmente mas falhou publicar: ' + err.message, 'err');
    }
  }

  function renderAssinaturaPreview(dataUrl) {
    const img = $('evt-sig-imagem-img');
    const vazio = $('evt-sig-imagem-vazio');
    const btnRem = $('btn-sig-remover');
    const btnUp = $('btn-sig-upload');
    if (dataUrl) {
      img.src = dataUrl;
      img.style.display = 'block';
      vazio.style.display = 'none';
      btnRem.style.display = 'inline-block';
      btnUp.textContent = 'Substituir PNG';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      vazio.style.display = 'block';
      btnRem.style.display = 'none';
      btnUp.textContent = 'Carregar PNG';
    }
  }

  function onAssinaturaUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      toast('PNG maior que 500 KB — reduzir antes de carregar.', 'err');
      e.target.value = '';
      return;
    }
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      toast('Apenas PNG ou JPEG são suportados.', 'err');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      if (!ST.evento) ST.evento = eventoDefault();
      ST.evento.assinaturaComandantePng = reader.result;
      ST.evento.assinaturaCarregadaEm = nowIso();
      renderAssinaturaPreview(reader.result);
      toast('A publicar PNG no repo Certificados…', 'ok');
      // Publicar como ficheiro binário em Certificados/assets/ para o index.html
      // do certificado conseguir renderizar a imagem. Sem este passo a SPA ficaria
      // só com a imagem no evento.json (para os emails) mas não nos certificados.
      try {
        const base64 = String(reader.result).replace(/^data:image\/[a-z]+;base64,/i, '');
        let sha = null;
        try {
          const cur = await ghLer('assets/assinatura-comandante.png', CONFIG.repoCerts);
          sha = cur.sha;
        } catch (_) { /* 404 = primeiro upload, sha fica null */ }
        await ghEscreverBinario(
          'assets/assinatura-comandante.png',
          base64,
          sha,
          'asset: assinatura do comandante carregada via Setup',
          CONFIG.repoCerts
        );
        toast('Assinatura sincronizada (evento + repo Certificados). Clica "Guardar configuração" para persistir.', 'ok');
      } catch (err) {
        console.error(err);
        toast('PNG guardado localmente mas falhou publicar no repo Certificados: ' + err.message, 'err');
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function onAssinaturaRemover() {
    const ok = await confirmar('Remover assinatura',
      'Vais ficar sem autorização para enviar certificados até carregar nova assinatura. Continuar?');
    if (!ok) return;
    if (ST.evento) {
      ST.evento.assinaturaComandantePng = '';
      ST.evento.assinaturaCarregadaEm = '';
    }
    renderAssinaturaPreview('');
    // Remover também do repo Certificados
    try {
      const cur = await ghLer('assets/assinatura-comandante.png', CONFIG.repoCerts);
      if (cur.sha) {
        await ghApagar(
          'assets/assinatura-comandante.png',
          cur.sha,
          'asset: remover assinatura via Setup',
          CONFIG.repoCerts
        );
      }
    } catch (err) {
      console.warn('Falha a remover PNG do repo Certificados:', err);
    }
    toast('Assinatura removida (evento + repo Certificados). Clica "Guardar configuração" para persistir.', 'ok');
  }

  // Gate de envio: bloqueia se nao houver assinatura carregada no evento.json
  // Devolve true se OK para prosseguir, false se bloqueado.
  async function gateAssinatura(nDestinatarios) {
    const e = ST.evento;
    if (!e || !e.assinaturaComandantePng) {
      toast('Assinatura do Comandante em falta. Carregar no Setup antes de enviar.', 'err');
      // Navegar para tab Setup automaticamente
      const tabSetup = document.querySelector('[data-tab="setup"]');
      if (tabSetup) tabSetup.click();
      return false;
    }
    const nomeCmt = (e.signatario || 'TCor Eng. Alexandre Rodrigues').trim();
    const ok = await confirmar('Confirmação de envio',
      `Enviar ${nDestinatarios} certificado(s) em nome de ${nomeCmt}? Esta acção dispara emails reais.`);
    return !!ok;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  bindEventos();
  if (precisaLogin()) {
    $('modal-login').classList.remove('hide');
    setTimeout(() => $('in-pin').focus(), 100);
  } else {
    $('modal-login').classList.add('hide');
    iniciar();
  }

  // Service worker para instalação como PWA + cache do shell
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
