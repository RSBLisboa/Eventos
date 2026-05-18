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

    // Hash SHA-256 hex da password admin (RSBL18MAI2026!).
    // Unificada com Presencas SPA. Para mudar, ver tools/cifrar-pat.html.
    pinHash: '3e9acaea400236b765076b342af311910d7b19730d85d541c3276db3ec41f9b5',

    // PAT cifrado com a password admin (PBKDF2 150k + AES-GCM, base64 de salt|iv|ct).
    // Gerar com tools/cifrar-pat.html neste repo.
    patCifrado: 'DknFWCRvCUDKncniIpJuB0yem1+lklo48JTgckFwkgo7aYrVptaG1OKPLU2MKMcxDaInhfVrXZlCCp+BPYR/dI7yrrRmZRikENfOBrqB8drkqFsd+CTiMfyFJEaNCXma9kBVK8g4O7YTjowyqKsp7jFyOkxYpBuPsBdTs5kxw+bCCOlZe8kpwrk=',

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
    renderPrograma();
    renderSala();
  }

  function renderSala() {
    const e = ST.evento || {};
    const sala = e.sala || {};
    const lugares = Array.isArray(sala.lugares) ? sala.lugares : [];
    const nomeEl = $('evt-sala-nome');
    const lugaresEl = $('evt-sala-lugares');
    if (nomeEl) nomeEl.value = sala.nome || '';
    if (lugaresEl) lugaresEl.value = lugares.join(', ');
    const tipoEl = $('evt-sala-tipo-' + (sala.tipo === 'oval' ? 'oval' : 'reto'));
    if (tipoEl) tipoEl.checked = true;
    renderSalaAtribuicoes();
  }

  // Geradores de layout: produzem array [{lugar, x, y}, ...] + viewBox.
  // Recto: 8 filas × 24 colunas + fila R no topo · viewBox 1000×480.
  // Oval: arcos concêntricos em torno do palco · viewBox 1300×700.
  function separarRENumericos(lugares) {
    const reservados = [], numericos = [];
    for (const l of lugares) {
      if (String(l).toUpperCase().startsWith('R')) reservados.push(String(l));
      else numericos.push(String(l));
    }
    return { reservados, numericos };
  }
  function gerarLayoutReto(lugares) {
    const { reservados, numericos } = separarRENumericos(lugares);
    const layout = [];
    const rN = reservados.length;
    if (rN > 0) {
      const rW = 38, rGap = 14;
      const totalW = rN * rW + (rN - 1) * rGap;
      const startX = (1000 - totalW) / 2 + rW / 2;
      reservados.forEach((lab, i) => {
        layout.push({ lugar: lab, x: Math.round((startX + i * (rW + rGap)) * 10) / 10, y: 85 });
      });
    }
    const nPerRow = 24, gap = 5, w = 30;
    const totalW = nPerRow * w + (nPerRow - 1) * gap;
    const startX = (1000 - totalW) / 2 + w / 2;
    const startY = 140, rowH = 40;
    numericos.forEach((lab, idx) => {
      const r = Math.floor(idx / nPerRow);
      const c = idx % nPerRow;
      layout.push({
        lugar: lab,
        x: Math.round((startX + c * (w + gap)) * 10) / 10,
        y: startY + r * rowH
      });
    });
    return { layout, viewBox: '0 0 1000 480' };
  }
  function gerarLayoutOval(lugares) {
    const { reservados, numericos } = separarRENumericos(lugares);
    // Centro do palco e parâmetros de design harmonioso:
    //   - K_PX = passo arco constante entre lugares (mesma distância "linear" para o olho)
    //   - GAP_FILAS_PX = incremento de raio entre filas (distância vertical equivalente)
    //   - CORREDOR_RAD = gap entre blocos esquerdo/centro/direito
    const cx = 700, cy = 145;
    const K_PX = 40;
    const GAP_FILAS_PX = 46;
    const CORREDOR_RAD = 8 * Math.PI / 180;
    const layout = [];
    const round = v => Math.round(v * 10) / 10;
    function distribuirBlocos(n) {
      const e = Math.floor(n / 3);
      const d = Math.floor(n / 3);
      return [e, n - e - d, d];
    }
    // Coloca uma fila inteira (sem ou com corredores de 3 blocos), garantindo passo
    // arco constante (K_PX) entre lugares consecutivos dentro de um bloco.
    function colocarFila(labs, raio, fila, comCorredor) {
      const n = labs.length;
      if (n === 0) return;
      const Krad = K_PX / raio;
      if (!comCorredor || n < 6) {
        // Linha contígua (caso da fila R ou n pequeno)
        const spanTotal = (n - 1) * Krad;
        const ini = Math.PI / 2 - spanTotal / 2;
        for (let i = 0; i < n; i++) {
          const t = ini + i * Krad;
          layout.push({
            lugar: labs[i], fila,
            x: round(cx + raio * Math.cos(t)),
            y: round(cy + raio * Math.sin(t))
          });
        }
        return;
      }
      // Com corredores: 3 blocos (E/C/D), passo Krad dentro de cada bloco,
      // gap CORREDOR_RAD entre o último lugar de um bloco e o primeiro do seguinte.
      const [nE, nC, nD] = distribuirBlocos(n);
      // span_total = (n-3) × Krad + 2 × corredorRad
      const spanTotal = (n - 3) * Krad + 2 * CORREDOR_RAD;
      const ini = Math.PI / 2 - spanTotal / 2;
      let pos = 0;
      // Bloco esquerdo
      for (let i = 0; i < nE; i++) {
        const t = ini + i * Krad;
        layout.push({ lugar: labs[pos++], fila, x: round(cx + raio * Math.cos(t)), y: round(cy + raio * Math.sin(t)) });
      }
      // Bloco central
      const startC = ini + (nE - 1) * Krad + CORREDOR_RAD;
      for (let i = 0; i < nC; i++) {
        const t = startC + i * Krad;
        layout.push({ lugar: labs[pos++], fila, x: round(cx + raio * Math.cos(t)), y: round(cy + raio * Math.sin(t)) });
      }
      // Bloco direito
      const startD = startC + (nC - 1) * Krad + CORREDOR_RAD;
      for (let i = 0; i < nD; i++) {
        const t = startD + i * Krad;
        layout.push({ lugar: labs[pos++], fila, x: round(cx + raio * Math.cos(t)), y: round(cy + raio * Math.sin(t)) });
      }
    }
    // Fila R — arco contíguo no anel interior (sem corredor, espaço dramático ao palco)
    if (reservados.length > 0) {
      colocarFila(reservados, 180, 'R', false);
    }
    // 12 filas numéricas A-L com n crescente — leque harmonioso
    // n: 8+9+11+12+14+15+17+18+20+21+23+24 = 192
    const config = [
      { letra: 'A', n: 8 },
      { letra: 'B', n: 9 },
      { letra: 'C', n: 11 },
      { letra: 'D', n: 12 },
      { letra: 'E', n: 14 },
      { letra: 'F', n: 15 },
      { letra: 'G', n: 17 },
      { letra: 'H', n: 18 },
      { letra: 'I', n: 20 },
      { letra: 'J', n: 21 },
      { letra: 'K', n: 23 },
      { letra: 'L', n: 24 }
    ];
    let idx = 0, raioAtual = 230;
    for (const f of config) {
      if (idx >= numericos.length) break;
      const tomar = Math.min(f.n, numericos.length - idx);
      const filaLabs = numericos.slice(idx, idx + tomar);
      idx += tomar;
      colocarFila(filaLabs, raioAtual, f.letra, true);
      raioAtual += GAP_FILAS_PX;
    }
    return { layout, viewBox: '0 0 1400 920' };
  }
  function regenerarLayoutSala() {
    const e = ST.evento || {};
    if (!e.sala) e.sala = {};
    const lugares = Array.isArray(e.sala.lugares) ? e.sala.lugares : [];
    const tipo = e.sala.tipo === 'oval' ? 'oval' : 'reto';
    const { layout, viewBox } = (tipo === 'oval' ? gerarLayoutOval(lugares) : gerarLayoutReto(lugares));
    e.sala.tipo = tipo;
    e.sala.layout = layout;
    e.sala.viewBox = viewBox;
    e.sala.totalLugares = lugares.length;
    ST.evento = e;
    toast('Layout regenerado: ' + lugares.length + ' lugares (' + tipo + '). Carrega "Guardar configuração" para publicar.', 'ok');
  }

  function renderSalaAtribuicoes() {
    const el = $('sala-atribuicoes');
    if (!el) return;
    const e = ST.evento || {};
    const sala = e.sala || {};
    const lugares = Array.isArray(sala.lugares) ? sala.lugares : [];
    const inscritos = ST.inscritos || [];
    if (!lugares.length) {
      el.innerHTML = '<div class="help">Define a lista de lugares acima.</div>';
      return;
    }
    // Mapa lugar → inscrito
    const mapaPorLugar = new Map();
    const semLugar = [];
    inscritos.forEach(i => {
      if (i.lugar) mapaPorLugar.set(String(i.lugar), i);
    });
    inscritos.forEach(i => {
      if (!i.lugar && i.estado && /confirm/i.test(i.estado)) semLugar.push(i);
    });

    const opcoes = ['<option value="">— vazio —</option>']
      .concat(inscritos
        .filter(i => i.estado && /confirm/i.test(i.estado))
        .sort((a,b) => normalizar(a.nome||'').localeCompare(normalizar(b.nome||'')))
        .map(i => `<option value="${i.id}">${escapeHtml(i.nome)} (id ${i.id})</option>`)
      ).join('');

    const linhas = lugares.map(lugar => {
      const occupied = mapaPorLugar.get(String(lugar));
      return `
        <div style="display:grid;grid-template-columns:64px 1fr 32px;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--linha)">
          <span style="text-align:center">${pillLugarHtml(lugar)}</span>
          <select data-sala-lugar="${escapeHtml(lugar)}" style="padding:6px 10px;font-size:13px;border:1px solid var(--linha);border-radius:6px;font-family:inherit;background:#fff">
            ${opcoes.replace('value="' + (occupied ? occupied.id : '__none__') + '"', 'value="' + (occupied ? occupied.id : '__none__') + '" selected')}
          </select>
          <span style="color:var(--texto-mute);font-size:11.5px">${occupied ? '✓' : ''}</span>
        </div>
      `;
    }).join('');

    const stats = `
      <div class="alert ${semLugar.length ? 'warn' : 'ok'}" style="margin-bottom:10px;font-size:12.5px">
        ${mapaPorLugar.size} dos ${lugares.length} lugares atribuídos · ${semLugar.length} confirmados sem lugar
      </div>
    `;
    el.innerHTML = stats + '<div style="max-height:400px;overflow:auto;border:1px solid var(--linha);border-radius:6px;padding:8px 12px">' + linhas + '</div>';

    // Bind change handlers
    el.querySelectorAll('select[data-sala-lugar]').forEach(sel => {
      sel.addEventListener('change', () => {
        const lugar = sel.dataset.salaLugar;
        const novoId = sel.value;
        // Limpar lugar de quem já tinha esse lugar
        ST.inscritos.forEach(i => {
          if (String(i.lugar) === String(lugar)) delete i.lugar;
        });
        // Atribuir ao novo
        if (novoId) {
          const inscrito = ST.inscritos.find(x => String(x.id) === String(novoId));
          if (inscrito) inscrito.lugar = lugar;
        }
        renderSalaAtribuicoes();
        renderInscritos();
      });
    });
  }

  function lerSala() {
    const nomeEl = $('evt-sala-nome');
    const lugaresEl = $('evt-sala-lugares');
    if (!nomeEl || !lugaresEl) return null;
    const lugares = (lugaresEl.value || '')
      .split(/[,\n]/)
      .map(s => s.trim())
      .filter(Boolean);
    const tipoOval = $('evt-sala-tipo-oval');
    const tipo = (tipoOval && tipoOval.checked) ? 'oval' : 'reto';
    const e = ST.evento || {};
    const salaAnterior = e.sala || {};
    const layoutExistente = Array.isArray(salaAnterior.layout) ? salaAnterior.layout : [];
    const tipoMudou = (salaAnterior.tipo || 'reto') !== tipo;
    const lugaresMudaram = !Array.isArray(salaAnterior.lugares) || salaAnterior.lugares.join(',') !== lugares.join(',');
    let layout = layoutExistente, viewBox = salaAnterior.viewBox || '0 0 1000 480';
    if (!layoutExistente.length || tipoMudou || lugaresMudaram) {
      const gerado = (tipo === 'oval' ? gerarLayoutOval(lugares) : gerarLayoutReto(lugares));
      layout = gerado.layout;
      viewBox = gerado.viewBox;
    }
    return {
      nome: nomeEl.value.trim(),
      tipo,
      totalLugares: lugares.length,
      lugares,
      layout,
      viewBox
    };
  }

  function renderPrograma() {
    const lista = $('programa-lista');
    if (!lista) return;
    const e = ST.evento || {};
    const slots = Array.isArray(e.programa) ? e.programa : [];
    if (!slots.length) {
      lista.innerHTML = '<div class="help" style="padding:14px;border:1px dashed var(--linha);border-radius:6px;text-align:center">Sem slots. Clica "+ Adicionar slot".</div>';
      return;
    }
    const linhas = ['<div style="display:flex;flex-direction:column;gap:14px;font-size:13px">'];
    linhas.push('<div style="font-size:11px;color:var(--texto-mute);font-style:italic;line-height:1.5">Para slot com vários oradores, separar com <code>|</code> (ex: <em>Miguel Moita · Intervir.pt | José Ferreira · ERSBL</em>). Descrição é opcional.</div>');
    slots.forEach((s, i) => {
      const paineisTxt = Array.isArray(s.paineis)
        ? s.paineis.map(p => [p.numero || '', p.tema || '', p.orador || '', p.afiliacao || ''].join(' | ')).join('\n')
        : '';
      const convidadosTxt = Array.isArray(s.convidados)
        ? s.convidados.map(c => [c.nome || '', c.cargo || ''].join(' | ')).join('\n')
        : '';
      const moderacaoTxt = s.moderacao ? [s.moderacao.nome || '', s.moderacao.cargo || ''].join(' | ') : '';
      const temAvancado = !!(paineisTxt || convidadosTxt || moderacaoTxt);

      linhas.push(`
        <div style="display:grid;grid-template-columns:100px 1fr 90px;gap:8px;padding:12px;border:1px solid var(--linha);border-radius:8px;background:#fafafa">
          <div>
            <label style="font-size:10.5px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">Hora</label>
            <input type="time" id="prog-hora-${i}" value="${escapeHtml(s.hora || '')}" style="width:100%;padding:7px 10px;font-size:13px;font-family:inherit;border:1px solid var(--linha);border-radius:6px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:10.5px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">Título da temática</label>
            <input type="text" id="prog-titulo-${i}" value="${escapeHtml(s.titulo || '')}" placeholder="Ex: Painéis Temáticos" style="width:100%;padding:7px 10px;font-size:13px;font-family:inherit;border:1px solid var(--linha);border-radius:6px;margin-top:3px">
          </div>
          <div style="display:flex;align-items:flex-end">
            <button class="btn secondary" data-prog-del="${i}" style="padding:7px 12px;font-size:12px;width:100%">Remover</button>
          </div>
          <div style="grid-column:1 / span 3">
            <label style="font-size:10.5px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">Orador(es)</label>
            <input type="text" id="prog-oradores-${i}" value="${escapeHtml(s.oradores || s.orador || '')}" placeholder="Nome · Entidade  (separar oradores múltiplos com |)" style="width:100%;padding:7px 10px;font-size:13px;font-family:inherit;border:1px solid var(--linha);border-radius:6px;margin-top:3px">
          </div>
          <div style="grid-column:1 / span 3">
            <label style="font-size:10.5px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">Descrição (opcional)</label>
            <textarea id="prog-descricao-${i}" rows="2" placeholder="Resumo do slot, observações…" style="width:100%;padding:7px 10px;font-size:13px;font-family:inherit;border:1px solid var(--linha);border-radius:6px;margin-top:3px;resize:vertical">${escapeHtml(s.descricao || '')}</textarea>
          </div>
          <details ${temAvancado ? 'open' : ''} style="grid-column:1 / span 3;margin-top:4px">
            <summary style="font-size:11px;color:var(--rsb-vermelho);cursor:pointer;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;padding:4px 0">Estrutura avançada (painéis · convidados · moderação)</summary>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;padding-left:8px;border-left:2px solid var(--linha)">
              <div>
                <label style="font-size:10.5px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">Painéis (uma linha por painel)</label>
                <textarea id="prog-paineis-${i}" rows="3" placeholder="Número | Tema | Orador | Afiliação&#10;Exemplo: I | Formação e sensibilização | Miguel Moita | Intervir.pt" style="width:100%;padding:7px 10px;font-size:12.5px;font-family:'SF Mono',Consolas,monospace;border:1px solid var(--linha);border-radius:6px;margin-top:3px;resize:vertical">${escapeHtml(paineisTxt)}</textarea>
              </div>
              <div>
                <label style="font-size:10.5px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">Oradores convidados (uma linha cada)</label>
                <textarea id="prog-convidados-${i}" rows="3" placeholder="Nome | Cargo&#10;Exemplo: Richard Marques | Presidente do Serviço Regional Madeira" style="width:100%;padding:7px 10px;font-size:12.5px;font-family:'SF Mono',Consolas,monospace;border:1px solid var(--linha);border-radius:6px;margin-top:3px;resize:vertical">${escapeHtml(convidadosTxt)}</textarea>
              </div>
              <div>
                <label style="font-size:10.5px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">Moderação</label>
                <input type="text" id="prog-moderacao-${i}" value="${escapeHtml(moderacaoTxt)}" placeholder="Nome | Cargo" style="width:100%;padding:7px 10px;font-size:12.5px;font-family:'SF Mono',Consolas,monospace;border:1px solid var(--linha);border-radius:6px;margin-top:3px">
              </div>
            </div>
          </details>
        </div>
      `);
    });
    linhas.push('</div>');
    lista.innerHTML = linhas.join('');
  }

  function lerPrograma() {
    const lista = $('programa-lista');
    if (!lista) return [];
    const splitPipe = (s) => s.split('|').map(x => x.trim());
    const out = [];
    let i = 0;
    while ($('prog-hora-' + i)) {
      const hora = $('prog-hora-' + i).value.trim();
      const titulo = $('prog-titulo-' + i).value.trim();
      const oradores = $('prog-oradores-' + i) ? $('prog-oradores-' + i).value.trim() : '';
      const descricao = $('prog-descricao-' + i) ? $('prog-descricao-' + i).value.trim() : '';
      const paineisRaw = $('prog-paineis-' + i) ? $('prog-paineis-' + i).value.trim() : '';
      const convidadosRaw = $('prog-convidados-' + i) ? $('prog-convidados-' + i).value.trim() : '';
      const moderacaoRaw = $('prog-moderacao-' + i) ? $('prog-moderacao-' + i).value.trim() : '';
      if (hora || titulo) {
        const slot = { hora, titulo, oradores, descricao };
        if (paineisRaw) {
          const paineis = paineisRaw.split(/\r?\n/).map(l => {
            const [numero, tema, orador, afiliacao] = splitPipe(l);
            return { numero: numero || '', tema: tema || '', orador: orador || '', afiliacao: afiliacao || '' };
          }).filter(p => p.tema || p.orador);
          if (paineis.length) slot.paineis = paineis;
        }
        if (convidadosRaw) {
          const convidados = convidadosRaw.split(/\r?\n/).map(l => {
            const [nome, cargo] = splitPipe(l);
            return { nome: nome || '', cargo: cargo || '' };
          }).filter(c => c.nome);
          if (convidados.length) slot.convidados = convidados;
        }
        if (moderacaoRaw) {
          const [nome, cargo] = splitPipe(moderacaoRaw);
          if (nome) slot.moderacao = { nome, cargo: cargo || '' };
        }
        out.push(slot);
      }
      i++;
    }
    out.sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
    return out;
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
    e.programa = lerPrograma();
    const sala = lerSala();
    if (sala) e.sala = sala;
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
  // ARQUIVAR EVENTO + PREPARAR PRÓXIMO
  // ═══════════════════════════════════════════════════════════════════════════
  // Cria branch arquivo/<data> em Presencas + Certificados a apontar para o
  // commit actual de main. Reseta JSONs operacionais para estado limpo e
  // actualiza evento.json com novo ID/data. inscritos.json fica intacto
  // (operador importa nova lista depois no tab Inscritos).
  async function ghGetBranchSha(repo, branch) {
    const url = `https://api.github.com/repos/${CONFIG.githubOwner}/${repo}/git/ref/heads/${branch}`;
    const r = await fetch(url, { headers: ghHeaders() });
    if (!r.ok) throw new Error(`GET ref ${branch}: ${r.status}`);
    const j = await r.json();
    return j.object.sha;
  }
  async function ghCreateBranch(repo, novoBranch, fromSha) {
    const url = `https://api.github.com/repos/${CONFIG.githubOwner}/${repo}/git/refs`;
    const r = await fetch(url, {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({ ref: `refs/heads/${novoBranch}`, sha: fromSha })
    });
    if (r.status === 422) {
      // Branch já existe — sinalizar mas não bloquear (idempotente).
      return { existed: true };
    }
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Criar branch ${novoBranch} em ${repo}: ${r.status} ${t}`);
    }
    return { existed: false };
  }

  async function arquivarEvento() {
    const novoId = parseInt($('evt-prox-id').value, 10);
    const novaData = $('evt-prox-data').value;
    if (!novoId || !novaData) {
      toast('Preenche ID e data do próximo evento antes de arquivar.', 'err');
      return;
    }
    const eventoActual = ST.evento || {};
    const dataAct = eventoActual.data || nowIso().slice(0, 10);
    const branchArquivo = 'arquivo/' + dataAct + '-id' + (eventoActual.id || 0);

    const ok = await confirmar(
      'Arquivar evento ' + (eventoActual.id || '?'),
      'Vai criar branch "' + branchArquivo + '" em Presencas e Certificados (snapshot do estado actual), depois resetar presenças/entregas/certificados/apreciação e actualizar evento.json para ID=' + novoId + ', data=' + novaData + '.\n\ninscritos.json fica intacto — importas nova lista no tab Inscritos.\n\nContinuar?'
    );
    if (!ok) return;

    setLoading(true, 'A criar branches arquivo…');
    try {
      // 1. Snapshot via branch nos 2 repos.
      const [shaPres, shaCerts] = await Promise.all([
        ghGetBranchSha(CONFIG.repoData, CONFIG.branch),
        ghGetBranchSha(CONFIG.repoCerts, CONFIG.branch)
      ]);
      const [b1, b2] = await Promise.all([
        ghCreateBranch(CONFIG.repoData, branchArquivo, shaPres),
        ghCreateBranch(CONFIG.repoCerts, branchArquivo, shaCerts)
      ]);
      const arq = (b1.existed || b2.existed)
        ? ' (branches já existiam — re-usadas)'
        : '';

      setLoading(true, 'A resetar JSONs operacionais…');
      // 2. Reset dos JSONs operacionais. Cada um precisa do sha actual.
      const resets = [
        { path: 'data/presencas.json', repo: CONFIG.repoData, payload: { schema: 'presencas@1', eventoId: novoId, actualizadoEm: nowIso(), marcacoes: [] } },
        { path: 'data/entregas.json', repo: CONFIG.repoData, payload: { schema: 'entregas@1', eventoId: novoId, actualizadoEm: nowIso(), versao: 1, entregas: [] } },
        { path: 'data/apreciacao.json', repo: CONFIG.repoData, payload: { schema: 'apreciacao@1', eventoId: novoId, actualizadoEm: nowIso(), respostas: [] } },
        { path: 'data/certificados.json', repo: CONFIG.repoData, payload: { schema: 'certificados@1', eventoId: novoId, actualizadoEm: nowIso(), certificados: [] } }
      ];
      for (const r of resets) {
        try {
          const cur = await ghLer(r.path, r.repo).catch(() => ({ sha: null }));
          await ghEscrever(r.path, r.payload, cur.sha,
            'reset: novo evento id=' + novoId + ' · arquivo em ' + branchArquivo, r.repo);
        } catch (e) {
          console.warn('Reset falhou para', r.path, e.message);
        }
      }

      // 3. Actualizar evento.json com novo ID + data + programa vazio.
      setLoading(true, 'A actualizar evento.json…');
      const novoEvento = JSON.parse(JSON.stringify(eventoActual));
      novoEvento.id = novoId;
      novoEvento.data = novaData;
      novoEvento.programa = [];
      novoEvento.proxNumeroCert = 1;
      novoEvento.actualizadoEm = nowIso();
      // Mantém titulo/local/email/signatário/users — todos editáveis depois.
      const curEvt = await ghLer('data/evento.json', CONFIG.repoData);
      await ghEscrever('data/evento.json', novoEvento, curEvt.sha,
        'novo evento: id=' + novoId + ' data=' + novaData, CONFIG.repoData);

      setLoading(false);
      toast('Evento arquivado em ' + branchArquivo + arq + '. Recarrega para começar o próximo.', 'ok');
      // Forçar reload depois de 3s para mostrar o novo estado.
      setTimeout(() => location.reload(), 3000);
    } catch (err) {
      setLoading(false);
      toast('Erro a arquivar: ' + err.message, 'err');
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
    const filtroCat = ST.filtroCategoria || '';
    let lista = ST.inscritos;
    if (busca) {
      const q = normalizar(busca);
      lista = lista.filter(i => {
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
    if (filtroCat) {
      if (filtroCat === '__participante__') {
        lista = lista.filter(i => !i.categoria);
      } else {
        lista = lista.filter(i => (i.categoria || '') === filtroCat);
      }
    }
    const filtroLug = ST.filtroLugar || '';
    if (filtroLug === '__com__') lista = lista.filter(i => !!i.lugar);
    else if (filtroLug === '__sem__') lista = lista.filter(i => !i.lugar);
    else if (filtroLug === '__r__') lista = lista.filter(i => String(i.lugar || '').startsWith('R'));

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
      const conv = (eraConv === true || eraConv === 'Sim');
      const auto = (eraConv === false || eraConv === 'Não' || eraConv === 'Nao');
      const pillEra = auto
        ? '<span class="pill amarelo" title="Auto-inscrito · não estava na lista original">Auto</span>'
        : (conv ? '<span class="pill cinza" title="Estava na lista de convidados original">Conv.</span>' : '');
      const flagNaoEnviar = i.naoEnviar ? '<span class="pill amarelo" title="Flag: Não enviar mail">🚫</span>' : '';
      const pillCat = pillCategoria(i.categoria);
      const pillLugar = pillLugarHtml(i.lugar);
      return `<tr class="hover" data-row-id="${i.id}">
        <td><span class="small mono" style="color:var(--texto-mute)">${escapeHtml(String(i.id || ''))}</span></td>
        <td>${escapeHtml(i.nome)} ${flagNaoEnviar}</td>
        <td><span class="small">${escapeHtml(i.cargo || '—')}</span></td>
        <td><span class="small">${escapeHtml(i.entidade || '—')}</span></td>
        ${colEmail}
        <td>${pillLugar}</td>
        <td>${pillCat}</td>
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
          <th style="width:70px">Lugar</th>
          <th style="width:130px">Categoria</th>
          <th style="width:120px">Estado</th>
          <th style="width:70px">Origem</th>
          <th style="width:48px"></th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>`;
  }

  // Pill colorida para o lugar (mesma paleta cross-app)
  function pillLugarHtml(lugar) {
    if (!lugar) return '<span class="small" style="color:var(--texto-mute)">—</span>';
    const l = String(lugar);
    const ehR = l.toUpperCase().startsWith('R');
    const bg = ehR ? '#fef9c3' : '#f1f5f9';
    const fg = ehR ? '#854d0e' : '#1e293b';
    const bd = ehR ? '#facc15' : '#cbd5e1';
    return '<span style="display:inline-block;background:' + bg + ';color:' + fg + ';font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;border:1px solid ' + bd + '">' + escapeHtml(l) + '</span>';
  }

  // Pill colorida para a categoria (mesma paleta do p.html)
  function pillCategoria(cat) {
    if (!cat) return '<span class="small" style="color:var(--texto-mute)">—</span>';
    const cores = {
      'Organização': '#1a1a1a',
      'Orador': '#E30613',
      'Orador Convidado': '#C46C00',
      'Moderação': '#6b21a8',
      'Coautor do Livreto': '#0e7490',
      'VIP': '#a16207',
      'Imprensa': '#1565c0'
    };
    const cor = cores[cat] || '#5a5a5a';
    return `<span style="display:inline-block;background:${cor};color:#fff;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;padding:3px 8px;border-radius:999px">${escapeHtml(cat)}</span>`;
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
    $('edit-categoria').value = i.categoria || '';
    $('edit-lugar').value = i.lugar || '';
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
    $('edit-categoria').value = '';
    $('edit-lugar').value = '';
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
      categoria: $('edit-categoria').value,         // manual: sobrepõe-se à detecção automática
      lugar: $('edit-lugar').value.trim(),          // ex: "12", "R3", "40+41"
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
  // Helper unificado de filtragem (busca + categoria + lugar + entidade).
  // Usado nas tabs Presenças, Emissão e Envio para manter UX consistente com
  // o filtro avançado da tab Inscritos.
  function matchInscritoFiltros(i, filtros, extras) {
    extras = extras || {};
    const busca = (filtros.busca || '').trim();
    if (busca) {
      const q = normalizar(busca);
      const emailLocal = ST.inscritosAdmin[i.id] || '';
      const cert = extras.certNumero || '';
      const ok = normalizar(i.nome || '').includes(q)
        || normalizar(i.cargo || '').includes(q)
        || normalizar(i.entidade || '').includes(q)
        || normalizar(i.email || '').includes(q)
        || normalizar(emailLocal).includes(q)
        || normalizar(i.token || '').includes(q)
        || normalizar(i.categoria || '').includes(q)
        || normalizar(i.lugar || '').includes(q)
        || normalizar(cert).includes(q)
        || String(i.id || '').includes(q);
      if (!ok) return false;
    }
    const cat = filtros.categoria || '';
    if (cat) {
      if (cat === '__participante__') {
        if (i.categoria) return false;
      } else {
        if ((i.categoria || '') !== cat) return false;
      }
    }
    const lug = filtros.lugar || '';
    if (lug === '__com__' && !i.lugar) return false;
    if (lug === '__sem__' && i.lugar) return false;
    if (lug === '__r__' && !String(i.lugar || '').toUpperCase().startsWith('R')) return false;
    const ent = (filtros.entidade || '').trim();
    if (ent) {
      const q = normalizar(ent);
      if (!normalizar(i.entidade || '').includes(q)) return false;
    }
    return true;
  }
  function listaEntidades() {
    const s = new Set();
    for (const i of ST.inscritos) { if (i.entidade) s.add(i.entidade); }
    return Array.from(s).sort((a,b)=>a.localeCompare(b,'pt-PT'));
  }
  // Render datalist partilhado para o autocomplete de entidade (atualizado on-the-fly).
  function refrescarDatalistEntidades() {
    const dl = $('datalist-entidades');
    if (!dl) return;
    dl.innerHTML = listaEntidades().map(e => '<option value="'+escapeHtml(e)+'">').join('');
  }
  // Constrói os controlos UI dos filtros (categoria, lugar, entidade) numa toolbar.
  function renderToolbarFiltros(prefixo) {
    return `
      <select id="${prefixo}-filtro-cat" style="padding:9px 12px;font-size:13px;border:1px solid var(--linha);border-radius:8px;background:#fafafa;font-family:inherit;cursor:pointer">
        <option value="">Todas as categorias</option>
        <option value="Organização">Organização</option>
        <option value="Orador">Orador</option>
        <option value="Orador Convidado">Orador Convidado</option>
        <option value="Moderação">Moderação</option>
        <option value="Coautor do Livreto">Coautor do Livreto</option>
        <option value="VIP">VIP</option>
        <option value="Imprensa">Imprensa</option>
        <option value="__participante__">Sem categoria</option>
      </select>
      <select id="${prefixo}-filtro-lugar" style="padding:9px 12px;font-size:13px;border:1px solid var(--linha);border-radius:8px;background:#fafafa;font-family:inherit;cursor:pointer">
        <option value="">Todos os lugares</option>
        <option value="__com__">Com lugar</option>
        <option value="__sem__">Sem lugar</option>
        <option value="__r__">Só R (VIP)</option>
      </select>
      <input list="datalist-entidades" id="${prefixo}-filtro-ent" placeholder="Entidade…" autocomplete="off" style="padding:9px 12px;font-size:13px;border:1px solid var(--linha);border-radius:8px;background:#fafafa;font-family:inherit;min-width:160px">
    `;
  }

  function renderPresencas() {
    refrescarDatalistEntidades();
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

    // Filtros unificados
    const filtros = {
      busca: ST.presencasBusca || '',
      categoria: ST.presencasFiltroCat || '',
      lugar: ST.presencasFiltroLugar || '',
      entidade: ST.presencasFiltroEnt || ''
    };
    const lista = ST.inscritos.filter(i => matchInscritoFiltros(i, filtros));

    const linhas = lista.map(i => {
      const m = presMap.get(i.id);
      const presente = m && m.presente;
      const cat = i.categoria ? pillCategoria(i.categoria) : '';
      const lugar = i.lugar ? pillLugarHtml(i.lugar) : '';
      const meta = `${cat} ${lugar}`.trim();
      return `<tr class="hover">
        <td>${escapeHtml(i.nome)}</td>
        <td><span class="small">${escapeHtml(i.cargo || '—')} ${i.entidade ? '· ' + escapeHtml(i.entidade) : ''}</span></td>
        <td>${meta || '<span class="small" style="color:var(--texto-mute)">—</span>'}</td>
        <td>${presente ? '<span class="pill verde">Presente</span>' : '<span class="pill cinza">—</span>'}</td>
        <td><span class="small mono">${m && m.horaEntrada ? fmtHora(m.horaEntrada) : ''}</span></td>
      </tr>`;
    }).join('');
    $('pres-tabela').innerHTML = `<div style="max-height:480px;overflow:auto;border:1px solid var(--linha);border-radius:6px">
      <table>
        <thead><tr><th>Nome</th><th>Cargo / Entidade</th><th style="width:200px">Cat / Lugar</th><th style="width:110px">Estado</th><th style="width:80px">Hora</th></tr></thead>
        <tbody>${linhas || '<tr><td colspan="5" style="text-align:center;color:var(--texto-mute);padding:20px">Sem inscritos</td></tr>'}</tbody>
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

    // Filtros unificados
    const filtros = {
      busca: ST.emissaoBusca || '',
      categoria: ST.emissaoFiltroCat || '',
      lugar: ST.emissaoFiltroLugar || '',
      entidade: ST.emissaoFiltroEnt || ''
    };
    const listaEm = ST.inscritos.filter(i => {
      const c = certsMap.get(i.id);
      return matchInscritoFiltros(i, filtros, { certNumero: c && c.numero });
    });

    const linhas = listaEm.map(i => {
      const m = presMap.get(i.id);
      const presente = m && m.presente;
      const c = certsMap.get(i.id);
      let estadoCol;
      if (!presente) estadoCol = '<span class="pill cinza">Ausente</span>';
      else if (c) estadoCol = '<span class="pill verde">' + escapeHtml(c.numero) + '</span>';
      else estadoCol = '<span class="pill amarelo">Por emitir</span>';
      const linkCol = c ? `<a href="${escapeHtml(c.link)}" target="_blank" class="small mono truncate" style="max-width:300px;display:inline-block">${escapeHtml(c.link.substring(0, 60))}…</a>` : '';
      const cat = i.categoria ? pillCategoria(i.categoria) : '';
      const lugar = i.lugar ? pillLugarHtml(i.lugar) : '';
      const meta = `${cat} ${lugar}`.trim();
      return `<tr class="hover">
        <td>${escapeHtml(i.nome)}</td>
        <td>${meta || '<span class="small" style="color:var(--texto-mute)">—</span>'}</td>
        <td>${estadoCol}</td>
        <td>${linkCol}</td>
      </tr>`;
    }).join('');
    $('emissao-tabela').innerHTML = `<div style="max-height:420px;overflow:auto;border:1px solid var(--linha);border-radius:6px;margin-top:14px">
      <table><thead><tr><th>Nome</th><th style="width:200px">Cat / Lugar</th><th style="width:130px">Certificado</th><th>Link</th></tr></thead>
      <tbody>${linhas || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--texto-mute)">Sem inscritos</td></tr>'}</tbody></table></div>`;
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

    // Filtros unificados
    const filtros = {
      busca: ST.envioBusca || '',
      categoria: ST.envioFiltroCat || '',
      lugar: ST.envioFiltroLugar || '',
      entidade: ST.envioFiltroEnt || ''
    };
    const listaCerts = ST.certificados.filter(c => {
      const i = inscritosMap.get(c.idInscricao);
      if (!i) return false;
      return matchInscritoFiltros(i, filtros, { certNumero: c.numero });
    });

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
      const cat = i.categoria ? pillCategoria(i.categoria) : '';
      const lugar = i.lugar ? pillLugarHtml(i.lugar) : '';
      const meta = `${cat} ${lugar}`.trim();
      return `<tr class="hover">
        <td><input type="checkbox" class="env-chk" data-id="${c.idInscricao}" ${podeEnviar ? 'checked' : ''} ${podeEnviar ? '' : 'disabled'}></td>
        <td>${escapeHtml(i.nome)}</td>
        <td>${meta || '<span class="small" style="color:var(--texto-mute)">—</span>'}</td>
        <td><span class="small mono">${escapeHtml(c.numero)}</span></td>
        <td>${colEmail}</td>
        <td>${estadoPill}</td>
      </tr>`;
    }).join('');
    $('envio-tabela').innerHTML = `<div style="max-height:420px;overflow:auto;border:1px solid var(--linha);border-radius:6px;margin-top:14px">
      <table>
        <thead><tr>
          <th style="width:32px"><input type="checkbox" id="env-chk-all" checked></th>
          <th>Nome</th><th style="width:200px">Cat / Lugar</th><th>Nº Cert.</th><th>Email</th><th>Estado</th>
        </tr></thead>
        <tbody>${linhas || '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--texto-mute)">Sem certificados emitidos</td></tr>'}</tbody>
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

    const badgeSala = $('badge-sala');
    if (badgeSala) {
      const sala = (ST.evento && ST.evento.sala) || {};
      const totalLug = (sala.layout || sala.lugares || []).length;
      const atribuidos = ST.inscritos.filter(i => i.lugar).length;
      badgeSala.textContent = totalLug ? (atribuidos + '/' + totalLug) : '0';
    }
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
    if (name === 'sala' && typeof EditorSala !== 'undefined') EditorSala.activar();
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
    $('btn-arquivar-evento').addEventListener('click', arquivarEvento);
    // Re-render das atribuições quando a lista de lugares muda
    const salaLugaresEl = $('evt-sala-lugares');
    if (salaLugaresEl) {
      salaLugaresEl.addEventListener('input', () => {
        if (!ST.evento) ST.evento = {};
        ST.evento.sala = lerSala();
        renderSalaAtribuicoes();
      });
    }
    // Radio buttons do tipo da sala — actualiza tipo + regenera layout em sessão
    ['evt-sala-tipo-reto', 'evt-sala-tipo-oval'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('change', () => {
        if (!ST.evento) ST.evento = {};
        ST.evento.sala = lerSala();
        toast('Tipo de sala alterado para "' + ST.evento.sala.tipo + '". Carrega "Guardar configuração" para publicar.', 'ok');
      });
    });
    // Botão regenerar layout (força recálculo)
    const btnGerar = $('btn-gerar-layout');
    if (btnGerar) btnGerar.addEventListener('click', () => {
      if (!ST.evento) ST.evento = {};
      ST.evento.sala = lerSala();
      regenerarLayoutSala();
    });
    $('btn-prog-add').addEventListener('click', () => {
      const actual = lerPrograma();
      actual.push({ hora: '', titulo: '', oradores: '', descricao: '' });
      if (!ST.evento) ST.evento = {};
      ST.evento.programa = actual;
      renderPrograma();
    });
    $('programa-lista').addEventListener('click', e => {
      const btn = e.target.closest('button[data-prog-del]');
      if (!btn) return;
      const idx = parseInt(btn.dataset.progDel, 10);
      const actual = lerPrograma();
      actual.splice(idx, 1);
      if (!ST.evento) ST.evento = {};
      ST.evento.programa = actual;
      renderPrograma();
    });

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

    // Filtros avançados (categoria / lugar / entidade) propagados nas abas Presenças, Emissão e Envio.
    const tabsFiltros = [
      { prefixo: 'presencas', stateCat: 'presencasFiltroCat', stateLug: 'presencasFiltroLugar', stateEnt: 'presencasFiltroEnt', rerender: renderPresencas },
      { prefixo: 'emissao', stateCat: 'emissaoFiltroCat', stateLug: 'emissaoFiltroLugar', stateEnt: 'emissaoFiltroEnt', rerender: renderEmissao },
      { prefixo: 'envio', stateCat: 'envioFiltroCat', stateLug: 'envioFiltroLugar', stateEnt: 'envioFiltroEnt', rerender: renderEnvio }
    ];
    for (const tf of tabsFiltros) {
      const cont = $(tf.prefixo + '-filtros');
      if (!cont) continue;
      cont.innerHTML = renderToolbarFiltros(tf.prefixo);
      const cat = $(tf.prefixo + '-filtro-cat');
      const lug = $(tf.prefixo + '-filtro-lugar');
      const ent = $(tf.prefixo + '-filtro-ent');
      if (cat) cat.addEventListener('change', () => { ST[tf.stateCat] = cat.value; tf.rerender(); });
      if (lug) lug.addEventListener('change', () => { ST[tf.stateLug] = lug.value; tf.rerender(); });
      if (ent) ent.addEventListener('input', () => { ST[tf.stateEnt] = ent.value; tf.rerender(); });
    }
    refrescarDatalistEntidades();

    // Filtro por categoria na lista de inscritos
    const filtroCat = $('inscritos-filtro-cat');
    if (filtroCat) {
      filtroCat.addEventListener('change', () => {
        ST.filtroCategoria = filtroCat.value;
        renderInscritos();
      });
    }
    const filtroLugar = $('inscritos-filtro-lugar');
    if (filtroLugar) {
      filtroLugar.addEventListener('change', () => {
        ST.filtroLugar = filtroLugar.value;
        renderInscritos();
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
  // EDITOR DE PLANTAS — integrado na tab "Sala"
  // Reusa ghLer/ghEscreverComRetry para persistir sala (evento.json) e
  // atribuições (inscritos.json). Estado local independente do ST principal,
  // sincronizado on-demand via "Aplicar e publicar" e "Recarregar do evento".
  // ═══════════════════════════════════════════════════════════════════════════
  const EditorSala = (function() {
    const DEFAULT_CFG = {
      tipo: 'auditorio', filas: 12, lugaresPorFila: 14, corredores: 2,
      corredorLarg: 50, seat: 30, gapH: 8, gapV: 14,
      raio: 200, abertura: 165, margem: 60, palco: true, reservados: 8
    };
    const PRESETS_ED = {
      aud: { tipo: 'auditorio', filas: 12, lugaresPorFila: 14, corredores: 2, corredorLarg: 50, seat: 30, gapH: 8, gapV: 14, raio: 200, abertura: 165, margem: 60, palco: true, reservados: 8 },
      cinema: { tipo: 'retangular', filas: 10, lugaresPorFila: 16, corredores: 2, corredorLarg: 40, seat: 28, gapH: 4, gapV: 18, margem: 50, palco: true, reservados: 0 },
      teatro: { tipo: 'auditorio', filas: 18, lugaresPorFila: 20, corredores: 3, corredorLarg: 55, seat: 26, gapH: 5, gapV: 12, raio: 220, abertura: 175, margem: 70, palco: true, reservados: 12 },
      conf: { tipo: 'retangular', filas: 8, lugaresPorFila: 12, corredores: 1, corredorLarg: 80, seat: 34, gapH: 10, gapV: 22, margem: 80, palco: true, reservados: 0 }
    };
    const SLIDERS = [
      ['filas', 'Número de filas', 1, 40, 1],
      ['lugaresPorFila', 'Lugares por fila (alvo)', 4, 60, 1],
      ['corredores', 'Número de corredores', 0, 4, 1],
      ['corredorLarg', 'Largura dos corredores (px)', 20, 120, 1],
      ['seat', 'Tamanho da cadeira (px)', 18, 60, 1],
      ['gapH', 'Espaço horizontal (px)', 2, 30, 1],
      ['gapV', 'Espaço vertical (px)', 6, 60, 1],
      ['raio', 'Curvatura — raio inicial (px)', 80, 500, 5, 'auditorio'],
      ['abertura', 'Abertura angular máx. (°)', 60, 180, 1, 'auditorio'],
      ['margem', 'Margem (px)', 20, 200, 5],
      ['reservados', 'Lugares reservados (R*)', 0, 20, 1, 'auditorio']
    ];

    const ES = {
      cfg: { ...DEFAULT_CFG },
      rows: [], seats: [], aisles: [], bounds: { w: 1400, h: 900 },
      centro: null, palcoConfig: null,
      selected: new Set(),
      estados: new Map(),       // seatId → 'reservado'|'vip'|'ocupado'|'free'
      ocupacoes: new Map(),     // codigo (A1, R5) → idInscrito
      zoom: 1, pan: { x: 0, y: 0 },
      activado: false,
      iniciaisLoaded: false
    };

    function rowLab(idx) {
      let n = idx + 1, s = '';
      while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    }
    function distribuirBlocosED(n, nBlocos) {
      if (nBlocos < 1) return [n];
      const base = Math.floor(n / nBlocos);
      const resto = n - base * nBlocos;
      const blocos = new Array(nBlocos).fill(base);
      const meio = Math.floor(nBlocos / 2);
      const ordem = [];
      for (let d = 0; d <= nBlocos; d++) {
        if (meio + d < nBlocos) ordem.push(meio + d);
        if (d > 0 && meio - d >= 0) ordem.push(meio - d);
      }
      for (let i = 0; i < resto; i++) blocos[ordem[i % ordem.length]]++;
      return blocos.filter(b => b > 0);
    }

    function gerarRect(cfg) {
      const rows = [], aisles = [];
      const stepH = cfg.seat + cfg.gapH, stepV = cfg.seat + cfg.gapV;
      const blocos = distribuirBlocosED(cfg.lugaresPorFila, cfg.corredores + 1);
      const larguraLugares = blocos.reduce((a, b) => a + b * stepH, 0) - cfg.gapH;
      const larguraTotal = larguraLugares + cfg.corredores * cfg.corredorLarg;
      const startX = cfg.margem;
      const palcoH = cfg.palco ? 80 : 0;
      const startY = cfg.margem + palcoH + 40;
      for (let fi = 0; fi < cfg.filas; fi++) {
        const slots = [];
        const y = startY + fi * stepV;
        let x = startX, nr = 1;
        blocos.forEach((nBloco, bi) => {
          for (let i = 0; i < nBloco; i++) {
            slots.push({ lugar: nr++, fila: rowLab(fi), x: x + cfg.seat/2, y: y + cfg.seat/2 });
            x += stepH;
          }
          x -= cfg.gapH;
          if (bi < blocos.length - 1) {
            if (fi === 0) aisles.push({ tipo: 'reto', x: x + cfg.corredorLarg/2, y0: startY, y1: startY + cfg.filas*stepV, largura: cfg.corredorLarg });
            x += cfg.corredorLarg + cfg.gapH;
          }
        });
        rows.push({ label: rowLab(fi), slots });
      }
      return {
        rows, aisles,
        bounds: { w: startX + larguraTotal + cfg.margem, h: startY + cfg.filas * stepV + cfg.margem },
        centro: null,
        palcoConfig: cfg.palco ? { tipo: 'reto', x: startX, y: cfg.margem, w: larguraTotal, h: palcoH - 10 } : null
      };
    }

    function gerarAud(cfg) {
      const rows = [], aisles = [];
      const palcoR = 70;
      const stepV = cfg.seat + cfg.gapV;
      const stepArco = cfg.seat + cfg.gapH;
      const corredorRad = cfg.corredorLarg / Math.max(cfg.raio, 80);
      const aberturaMaxRad = cfg.abertura * Math.PI / 180;
      const filas = [];
      if (cfg.reservados > 0) {
        const raioR = Math.max(palcoR + 50, cfg.raio - 60);
        filas.push({ label: 'R', raio: raioR, n: cfg.reservados, ehR: true });
      }
      let raioAtual = cfg.raio;
      for (let fi = 0; fi < cfg.filas; fi++) {
        const nAlvo = cfg.lugaresPorFila + Math.round(fi * 0.6);
        const arcoMax = raioAtual * aberturaMaxRad;
        const nMaxArco = Math.max(2, Math.floor(arcoMax / stepArco) + 1);
        filas.push({ label: rowLab(fi), raio: raioAtual, n: Math.min(nAlvo, nMaxArco), ehR: false });
        raioAtual += stepV;
      }
      const nBlocos = cfg.corredores + 1;
      let minX = 0, maxX = 0, maxY = 0;
      filas.forEach(f => {
        const slots = [];
        const Krad = stepArco / f.raio;
        const blocos = f.ehR ? [f.n] : distribuirBlocosED(f.n, nBlocos);
        const spanLug = blocos.reduce((a,b) => a + (b-1) * Krad, 0);
        const spanCorr = (blocos.length - 1) * corredorRad;
        const spanTotal = spanLug + spanCorr;
        const ini = Math.PI/2 - spanTotal/2;
        let nr = 1, ang = ini;
        blocos.forEach((nBloco, bi) => {
          for (let i = 0; i < nBloco; i++) {
            const x = f.raio * Math.cos(ang);
            const y = f.raio * Math.sin(ang);
            slots.push({ lugar: f.ehR ? 'R' + nr : nr, fila: f.label, x, y });
            nr++;
            if (i < nBloco - 1) ang += Krad;
          }
          if (bi < blocos.length - 1) {
            ang += corredorRad + Krad;
          }
        });
        slots.forEach(s => { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y); });
        rows.push({ label: f.label, raio: f.raio, slots });
      });
      const pad = cfg.margem;
      const palcoY = pad + (cfg.palco ? palcoR + 30 : 10);
      const offX = pad + Math.abs(minX);
      const offY = palcoY + (cfg.palco ? 0 : 30);
      rows.forEach(r => r.slots.forEach(s => { s.x += offX; s.y += offY; }));
      return {
        rows, aisles,
        bounds: { w: offX + maxX + pad, h: offY + maxY + pad },
        centro: { cx: offX, cy: offY },
        palcoConfig: cfg.palco ? { tipo: 'circular', cx: offX, cy: offY, r: palcoR } : null
      };
    }

    function gerarLayoutED() {
      const cfg = ES.cfg;
      const res = cfg.tipo === 'auditorio' ? gerarAud(cfg) : gerarRect(cfg);
      let id = 0;
      const seats = [];
      res.rows.forEach(r => r.slots.forEach(s => {
        s.id = 'S' + id++;
        s.codigo = String(s.fila) + s.lugar;
        seats.push(s);
      }));
      ES.rows = res.rows; ES.aisles = res.aisles; ES.bounds = res.bounds;
      ES.centro = res.centro; ES.palcoConfig = res.palcoConfig; ES.seats = seats;
    }

    function estadoDoLugar(s) {
      // Prioridade: selected > estado explícito > ocupação por inscrito > default
      if (ES.selected.has(s.id)) return 'selected';
      const e = ES.estados.get(s.id);
      if (e) return e;
      if (ES.ocupacoes.has(s.codigo)) return 'ocupado';
      if (String(s.lugar).toString().startsWith('R')) return 'reservado';
      return 'free';
    }
    function corEstado(e) {
      switch (e) {
        case 'selected':   return { fill: '#ef4444', stroke: '#b91c1c' };
        case 'reservado':  return { fill: '#fde047', stroke: '#b45309' };
        case 'vip':        return { fill: '#c084fc', stroke: '#7c3aed' };
        case 'ocupado':    return { fill: '#60a5fa', stroke: '#1d4ed8' };
        default:           return { fill: '#cbd5e1', stroke: '#64748b' };
      }
    }

    function renderPalco() {
      if (!ES.palcoConfig) return '';
      if (ES.palcoConfig.tipo === 'circular') {
        const { cx, cy, r } = ES.palcoConfig;
        return `
          <g>
            <circle cx="${cx}" cy="${cy}" r="${r+12}" fill="#fde4ee" stroke="#be185d" stroke-width="1.5" opacity="0.6"/>
            <circle cx="${cx}" cy="${cy}" r="${r*0.62}" fill="#be185d"/>
            <text x="${cx}" y="${cy+7}" style="fill:#fff;font-size:22px;font-weight:800;text-anchor:middle">1</text>
            <text x="${cx}" y="${cy+r+30}" style="fill:#64748b;font-size:10.5px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-anchor:middle">Palco · Painel</text>
          </g>`;
      }
      const { x, y, w, h } = ES.palcoConfig;
      return `
        <g>
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#fde4ee" stroke="#be185d" stroke-width="1.5"/>
          <text x="${x+w/2}" y="${y+h/2+6}" style="fill:#be185d;font-size:16px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;text-anchor:middle">Palco</text>
        </g>`;
    }
    function renderAisles() {
      return (ES.aisles || []).filter(a => a.tipo === 'reto').map(a =>
        `<rect x="${a.x - a.largura/2}" y="${a.y0}" width="${a.largura}" height="${a.y1 - a.y0}" fill="#f1f5f9" opacity="0.7"/>`
      ).join('');
    }
    function renderArcos() {
      if (!ES.centro) return '';
      return ES.rows.map(r => {
        if (r.slots.length < 2) return '';
        const raios = r.slots.map(s => Math.hypot(s.x - ES.centro.cx, s.y - ES.centro.cy));
        const rMed = raios.reduce((a,b) => a+b, 0)/raios.length + 14;
        const ang = s => Math.atan2(s.y - ES.centro.cy, s.x - ES.centro.cx);
        const angs = r.slots.map(ang).sort((a,b) => a-b);
        const a0 = angs[0] - 0.05, a1 = angs[angs.length-1] + 0.05;
        const x1 = ES.centro.cx + rMed * Math.cos(a0);
        const y1 = ES.centro.cy + rMed * Math.sin(a0);
        const x2 = ES.centro.cx + rMed * Math.cos(a1);
        const y2 = ES.centro.cy + rMed * Math.sin(a1);
        const large = (a1 - a0) > Math.PI ? 1 : 0;
        const ehR = r.label === 'R';
        const cor = ehR ? '#fbbf24' : '#cbd5e1';
        return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${rMed.toFixed(1)} ${rMed.toFixed(1)} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${cor}" stroke-width="${ehR ? 1.5 : 1}" opacity="0.5"/>`;
      }).join('');
    }
    function renderLetras() {
      return ES.rows.map(r => {
        if (!r.slots.length) return '';
        const sorted = r.slots.slice().sort((a,b) => a.x - b.x);
        const sEsq = sorted[0], sDir = sorted[sorted.length-1];
        const ehR = r.label === 'R', off = 30;
        const bg = ehR ? '#fef3c7' : '#f1f5f9';
        const cor = ehR ? '#b45309' : '#475569';
        return [{x: sEsq.x - off, y: sEsq.y}, {x: sDir.x + off, y: sDir.y}].map(p => `
          <g>
            <circle cx="${p.x}" cy="${p.y}" r="11" fill="${bg}" stroke="${cor}" stroke-width="0.8" opacity="0.95"/>
            <text x="${p.x}" y="${p.y+4}" style="fill:${cor};font-size:11.5px;font-weight:800;text-anchor:middle">${r.label}</text>
          </g>
        `).join('');
      }).join('');
    }
    function renderSeats() {
      const s_ = ES.cfg.seat;
      return ES.seats.map(s => {
        const e = estadoDoLugar(s);
        const c = corEstado(e);
        const w = s_, h = s_ * 0.78;
        const x = s.x - w/2, y = s.y - h/2;
        const ehR = String(s.lugar).startsWith('R');
        const txt = ehR ? '★' + String(s.lugar).substring(1) : s.lugar;
        const fs = ehR ? Math.max(11, s_*0.32) : Math.max(9, s_*0.28);
        const idInsc = ES.ocupacoes.get(s.codigo);
        const insc = idInsc ? (ST.inscritos.find(i => i.id === idInsc)) : null;
        const titleTxt = s.codigo + (insc ? ' · ' + insc.nome : ' · ' + e);
        return `
          <g class="ed-seat" data-id="${s.id}" data-codigo="${s.codigo}">
            <title>${escapeHtml(titleTxt)}</title>
            <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${c.fill}" stroke="${c.stroke}" stroke-width="${e === 'selected' ? 2.5 : 1.4}" style="cursor:pointer"/>
            <text x="${s.x}" y="${s.y + fs*0.36}" text-anchor="middle" style="font-size:${fs}px;font-weight:700;pointer-events:none;fill:#1e293b">${escapeHtml(String(txt))}</text>
          </g>`;
      }).join('');
    }

    function render() {
      gerarLayoutED();
      const svg = document.getElementById('ed-svg');
      if (!svg) return;
      const { w, h } = ES.bounds;
      const vbW = w / ES.zoom, vbH = h / ES.zoom;
      const vbX = -ES.pan.x / ES.zoom, vbY = -ES.pan.y / ES.zoom;
      svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      let html = `<rect x="0" y="0" width="${w}" height="${h}" fill="#fff" stroke="#e5e5e5" stroke-width="1"/>`;
      html += renderAisles();
      html += renderPalco();
      html += renderArcos();
      html += renderLetras();
      html += renderSeats();
      svg.innerHTML = html;
      bindCliquesLugares();
      atualizarStats();
      const zEl = document.getElementById('ed-zoom-level');
      if (zEl) zEl.textContent = Math.round(ES.zoom * 100) + '%';
    }

    function bindCliquesLugares() {
      document.querySelectorAll('.ed-seat').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const id = el.dataset.id;
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            if (ES.selected.has(id)) ES.selected.delete(id);
            else ES.selected.add(id);
          } else {
            const era = ES.selected.has(id) && ES.selected.size === 1;
            ES.selected.clear();
            if (!era) ES.selected.add(id);
          }
          render();
          atualizarPainelSentar();
        });
      });
    }

    function atualizarStats() {
      const total = ES.seats.length;
      const filas = ES.rows.length;
      let livres = 0, ocupados = 0;
      ES.seats.forEach(s => {
        const e = estadoDoLugar(s);
        if (e === 'free') livres++;
        else if (e === 'ocupado') ocupados++;
      });
      const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      setEl('ed-s-total', total);
      setEl('ed-s-filas', filas);
      setEl('ed-s-livres', livres);
      setEl('ed-s-ocupados', ocupados);
      setEl('ed-sel-count', ES.selected.size);
      const det = Array.from(ES.selected).slice(0, 20).map(id => {
        const s = ES.seats.find(x => x.id === id);
        return s ? s.codigo : '';
      }).filter(Boolean).join(', ');
      const detEl = document.getElementById('ed-sel-detail');
      if (detEl) detEl.textContent = det + (ES.selected.size > 20 ? '…' : '');
    }

    function atualizarPainelSentar() {
      const painel = document.getElementById('ed-sentar-panel');
      if (!painel) return;
      // Mostra o painel sentar se exactamente UM lugar livre ou já ocupado está seleccionado
      if (ES.selected.size !== 1) { painel.style.display = 'none'; return; }
      const id = Array.from(ES.selected)[0];
      const s = ES.seats.find(x => x.id === id);
      if (!s) { painel.style.display = 'none'; return; }
      painel.style.display = '';
      const busca = (document.getElementById('ed-sentar-busca') || {}).value || '';
      const idAtual = ES.ocupacoes.get(s.codigo);
      const semLugar = ST.inscritos.filter(i => {
        if (!i.lugar) return true;
        // Permitir mostrar quem já está neste lugar para "trocar"
        return i.id === idAtual;
      });
      const q = normalizar(busca);
      const filtr = q
        ? semLugar.filter(i => normalizar(i.nome).includes(q) || normalizar(i.cargo||'').includes(q) || normalizar(i.entidade||'').includes(q))
        : semLugar;
      const lista = document.getElementById('ed-sentar-lista');
      if (!lista) return;
      lista.innerHTML = '';
      // Cabeçalho: lugar + acção remover (se já ocupado)
      const cab = document.createElement('div');
      cab.style.cssText = 'padding:8px 10px;background:#fff;border-bottom:1px solid var(--linha);font-size:11.5px;display:flex;justify-content:space-between;align-items:center';
      cab.innerHTML = `<strong>${escapeHtml(s.codigo)}</strong>` + (idAtual ? '<button class="btn secondary" style="padding:3px 8px;font-size:11px" id="ed-remover-aqui">Libertar</button>' : '');
      lista.appendChild(cab);
      const rem = document.getElementById('ed-remover-aqui');
      if (rem) rem.addEventListener('click', () => marcarOcupacao(s.codigo, null));
      if (filtr.length === 0) {
        const v = document.createElement('div');
        v.style.cssText = 'padding:10px;color:#888;text-align:center;font-size:12px';
        v.textContent = 'Sem resultados.';
        lista.appendChild(v);
        return;
      }
      filtr.slice(0, 80).forEach(i => {
        const item = document.createElement('div');
        const ehAtual = i.id === idAtual;
        item.style.cssText = 'padding:7px 10px;border-bottom:1px solid #eee;cursor:pointer;font-size:12px;' + (ehAtual ? 'background:#fef3c7' : 'background:#fff');
        item.innerHTML = `<div style="font-weight:600">${escapeHtml(i.nome)}${ehAtual ? ' ✓' : ''}</div><div style="font-size:10.5px;color:#888">${escapeHtml((i.cargo || '') + (i.entidade ? ' · ' + i.entidade : ''))}</div>`;
        item.addEventListener('mouseenter', () => item.style.background = ehAtual ? '#fde68a' : '#f1f5f9');
        item.addEventListener('mouseleave', () => item.style.background = ehAtual ? '#fef3c7' : '#fff');
        item.addEventListener('click', () => marcarOcupacao(s.codigo, i.id));
        lista.appendChild(item);
      });
    }

    function marcarOcupacao(codigo, idInscrito) {
      // Limpa qualquer ocupação anterior deste lugar
      const idAnterior = ES.ocupacoes.get(codigo);
      if (idAnterior) {
        const ant = ST.inscritos.find(i => i.id === idAnterior);
        if (ant) delete ant.lugar;
        ES.ocupacoes.delete(codigo);
      }
      // Limpa qualquer ocupação anterior deste inscrito noutro lugar
      if (idInscrito) {
        const novo = ST.inscritos.find(i => i.id === idInscrito);
        if (!novo) { toast('Inscrito não encontrado.', 'err'); return; }
        if (novo.lugar) {
          ES.ocupacoes.delete(String(novo.lugar));
        }
        novo.lugar = codigo;
        ES.ocupacoes.set(codigo, idInscrito);
      }
      ES.selected.clear();
      render();
      atualizarPainelSentar();
      toast(idInscrito ? 'Inscrito atribuído a ' + codigo + ' (não publicado).' : 'Lugar ' + codigo + ' libertado (não publicado).', 'ok');
    }

    function aplicarEstadoSel(estado) {
      if (ES.selected.size === 0) { toast('Selecciona lugares primeiro.', 'err'); return; }
      ES.selected.forEach(id => {
        if (estado === 'free') ES.estados.delete(id);
        else ES.estados.set(id, estado);
      });
      ES.selected.clear();
      render();
      toast('Estado actualizado em ' + ES.estados.size + ' lugar(es).', 'ok');
    }

    // ════ Carregamento e persistência ════
    function carregarDoEvento() {
      const e = ST.evento || {};
      const sala = e.sala || {};
      // Mapeia config a partir de evento.sala se possivel; senao usa defaults
      ES.cfg.tipo = sala.tipo === 'retangular' ? 'retangular' : 'auditorio';
      if (sala.editorCfg) {
        // Configuração nativa do editor guardada anteriormente
        ES.cfg = { ...DEFAULT_CFG, ...sala.editorCfg };
      }
      // Estados/ocupações: ler de ST.inscritos[].lugar
      ES.ocupacoes.clear();
      ES.estados.clear();
      ST.inscritos.forEach(i => {
        if (i.lugar) ES.ocupacoes.set(String(i.lugar), i.id);
      });
      atualizarUIFromCfg();
      render();
      setTimeout(fit, 50);
    }

    async function aplicarEPublicar() {
      const ok = await confirmar('Aplicar e publicar planta', 'Vai guardar a planta em evento.json e actualizar as atribuições de lugar em inscritos.json. Continuar?');
      if (!ok) return;
      setLoading(true, 'A publicar planta…');
      try {
        // 1. evento.json: actualizar sala.layout, sala.lugares, sala.tipo, sala.viewBox, sala.editorCfg
        const e = ST.evento || (ST.evento = eventoDefault());
        if (!e.sala) e.sala = {};
        e.sala.tipo = ES.cfg.tipo;
        e.sala.layout = ES.seats.map(s => ({ lugar: s.codigo, fila: s.fila, x: Math.round(s.x*10)/10, y: Math.round(s.y*10)/10 }));
        e.sala.lugares = ES.seats.map(s => s.codigo);
        e.sala.totalLugares = ES.seats.length;
        e.sala.viewBox = `0 0 ${Math.ceil(ES.bounds.w)} ${Math.ceil(ES.bounds.h)}`;
        e.sala.editorCfg = { ...ES.cfg };
        e.actualizadoEm = nowIso();
        ST.eventoSha = await ghEscreverComRetry(
          'data/evento.json', () => e, () => ST.eventoSha,
          'sala: planta actualizada via editor · ' + nowIso()
        );
        ST.evento = e;
        // 2. inscritos.json: actualizar campo lugar com as ocupacoes locais
        const inscritosAtuais = JSON.parse(JSON.stringify(ST.inscritos));
        ST.inscritosSha = await ghEscreverComRetry(
          'data/inscritos.json',
          () => ({
            schema: 'inscritos@2',
            eventoId: e.id,
            actualizadoEm: nowIso(),
            total: inscritosAtuais.length,
            inscritos: inscritosAtuais
          }),
          () => ST.inscritosSha,
          'inscritos: atribuicoes via editor de planta · ' + nowIso()
        );
        ST.inscritosUltimoPublicado = JSON.parse(JSON.stringify(inscritosAtuais));
        toast('Planta e atribuições publicadas.', 'ok');
        atualizarBadges();
        if (typeof renderSala === 'function') renderSala();
      } catch (err) {
        toast('Erro: ' + err.message, 'err');
      }
      setLoading(false);
    }

    // ════ Sliders / UI ════
    function atualizarUIFromCfg() {
      $$('button[data-ed-tipo]').forEach(b => b.classList.toggle('on', b.dataset.edTipo === ES.cfg.tipo));
      // (re)criar sliders
      const cont = document.getElementById('ed-sliders');
      if (!cont) return;
      cont.innerHTML = SLIDERS.filter(s => !s[5] || s[5] === ES.cfg.tipo).map(([prop, label, min, max, step]) => `
        <div style="margin-bottom:10px">
          <label style="display:block;font-size:11px;color:var(--texto-mute);text-transform:uppercase;letter-spacing:0.04em;font-weight:600;margin-bottom:4px">${label}</label>
          <div style="display:grid;grid-template-columns:1fr 50px;gap:6px;align-items:center">
            <input type="range" min="${min}" max="${max}" step="${step}" value="${ES.cfg[prop]}" data-ed-prop="${prop}" style="width:100%;accent-color:var(--rsb-vermelho)">
            <span style="text-align:right;font-size:12px;color:var(--texto-mute);font-variant-numeric:tabular-nums" data-ed-val="${prop}">${ES.cfg[prop]}</span>
          </div>
        </div>
      `).join('') + `
        <div style="margin-top:10px;padding:8px;background:#fff;border:1px solid var(--linha);border-radius:5px;display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="ed-cfg-palco" ${ES.cfg.palco ? 'checked' : ''}>
          <label for="ed-cfg-palco" style="margin:0;text-transform:none;letter-spacing:0;font-size:12px;font-weight:400">Mostrar palco / zona frontal</label>
        </div>
      `;
      cont.querySelectorAll('input[type=range][data-ed-prop]').forEach(el => {
        el.addEventListener('input', () => {
          const prop = el.dataset.edProp;
          ES.cfg[prop] = parseInt(el.value, 10);
          const val = cont.querySelector('[data-ed-val="' + prop + '"]');
          if (val) val.textContent = el.value;
          render();
        });
      });
      const palcoEl = document.getElementById('ed-cfg-palco');
      if (palcoEl) palcoEl.addEventListener('change', () => { ES.cfg.palco = palcoEl.checked; render(); });
    }

    function fit() {
      const wrap = document.getElementById('ed-canvas-wrap');
      const svg = document.getElementById('ed-svg');
      if (!wrap || !svg) return;
      const r = wrap.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const { w, h } = ES.bounds;
      ES.zoom = Math.min(r.width / w, r.height / h) * 0.95;
      ES.pan = { x: (r.width - w * ES.zoom) / 2, y: (r.height - h * ES.zoom) / 2 };
      const vbW = w / ES.zoom, vbH = h / ES.zoom;
      const vbX = -ES.pan.x / ES.zoom, vbY = -ES.pan.y / ES.zoom;
      svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
      const zEl = document.getElementById('ed-zoom-level');
      if (zEl) zEl.textContent = Math.round(ES.zoom * 100) + '%';
    }

    function initPanZoom() {
      const svg = document.getElementById('ed-svg');
      if (!svg) return;
      let drag = false, sp = null, sm = null;
      svg.addEventListener('mousedown', e => {
        if (e.target.closest('.ed-seat')) return;
        drag = true; svg.style.cursor = 'grabbing';
        sp = { ...ES.pan }; sm = { x: e.clientX, y: e.clientY };
      });
      window.addEventListener('mousemove', e => {
        if (!drag) return;
        ES.pan = { x: sp.x + e.clientX - sm.x, y: sp.y + e.clientY - sm.y };
        const { w, h } = ES.bounds;
        const vbW = w / ES.zoom, vbH = h / ES.zoom;
        svg.setAttribute('viewBox', `${(-ES.pan.x/ES.zoom)} ${(-ES.pan.y/ES.zoom)} ${vbW} ${vbH}`);
      });
      window.addEventListener('mouseup', () => { drag = false; svg.style.cursor = 'grab'; });
      svg.addEventListener('wheel', e => {
        if (!ES.activado) return;
        e.preventDefault();
        const delta = -Math.sign(e.deltaY) * 0.1;
        const old = ES.zoom;
        const nz = Math.max(0.2, Math.min(8, old * (1 + delta)));
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const f = nz / old;
        ES.pan.x = mx - (mx - ES.pan.x) * f;
        ES.pan.y = my - (my - ES.pan.y) * f;
        ES.zoom = nz;
        const { w, h } = ES.bounds;
        svg.setAttribute('viewBox', `${(-ES.pan.x/ES.zoom)} ${(-ES.pan.y/ES.zoom)} ${w/ES.zoom} ${h/ES.zoom}`);
        const zEl = document.getElementById('ed-zoom-level');
        if (zEl) zEl.textContent = Math.round(ES.zoom * 100) + '%';
      }, { passive: false });
    }

    function exportJSON() {
      const payload = {
        schema: 'sala-editor@1',
        geradoEm: nowIso(),
        config: ES.cfg,
        bounds: ES.bounds,
        palco: ES.palcoConfig,
        centro: ES.centro || null,
        filas: ES.rows.map(r => ({
          label: r.label,
          raio: r.raio || null,
          lugares: r.slots.map(s => ({
            codigo: s.codigo, fila: s.fila, lugar: s.lugar,
            x: Math.round(s.x*10)/10, y: Math.round(s.y*10)/10,
            estado: ES.estados.get(s.id) || (ES.ocupacoes.has(s.codigo) ? 'ocupado' : (String(s.lugar).startsWith('R') ? 'reservado' : 'free')),
            idInscrito: ES.ocupacoes.get(s.codigo) || null
          }))
        })),
        aisles: ES.aisles
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'planta-sala.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast('JSON exportado.', 'ok');
    }
    function exportSVG() {
      const svg = document.getElementById('ed-svg');
      const clone = svg.cloneNode(true);
      let str = new XMLSerializer().serializeToString(clone);
      const { w, h } = ES.bounds;
      str = str.replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`);
      str = str.replace(/viewBox="[^"]*"/, `viewBox="0 0 ${w} ${h}"`);
      const blob = new Blob([str], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'planta-sala.svg';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast('SVG exportado.', 'ok');
    }
    function exportPNG() {
      const svg = document.getElementById('ed-svg');
      const clone = svg.cloneNode(true);
      let str = new XMLSerializer().serializeToString(clone);
      const { w, h } = ES.bounds;
      str = str.replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`);
      str = str.replace(/viewBox="[^"]*"/, `viewBox="0 0 ${w} ${h}"`);
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const img = new Image();
      const blob = new Blob([str], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(b => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = 'planta-sala.png';
          a.click();
          URL.revokeObjectURL(a.href);
          URL.revokeObjectURL(url);
          toast('PNG exportado.', 'ok');
        }, 'image/png');
      };
      img.src = url;
    }
    function importJSON(file) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.config) ES.cfg = { ...DEFAULT_CFG, ...data.config };
          ES.estados.clear();
          atualizarUIFromCfg();
          render();
          if (data.filas) {
            const codMap = new Map();
            ES.seats.forEach(s => codMap.set(s.codigo, s.id));
            data.filas.forEach(f => f.lugares.forEach(l => {
              const id = codMap.get(l.codigo);
              if (id && l.estado && l.estado !== 'free' && l.estado !== 'ocupado') {
                ES.estados.set(id, l.estado);
              }
            }));
            render();
          }
          toast('JSON importado.', 'ok');
        } catch (e) {
          toast('Erro a ler JSON: ' + e.message, 'err');
        }
      };
      reader.readAsText(file);
    }

    function bindUIOnce() {
      if (ES.iniciaisLoaded) return;
      ES.iniciaisLoaded = true;
      // Tipo
      $$('button[data-ed-tipo]').forEach(b => {
        b.addEventListener('click', () => {
          ES.cfg.tipo = b.dataset.edTipo;
          atualizarUIFromCfg();
          render();
          setTimeout(fit, 30);
        });
      });
      // Presets
      const presets = [['ed-preset-aud', 'aud'], ['ed-preset-cinema', 'cinema'], ['ed-preset-teatro', 'teatro'], ['ed-preset-conf', 'conf']];
      presets.forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => {
          ES.cfg = { ...DEFAULT_CFG, ...PRESETS_ED[key] };
          ES.estados.clear(); ES.selected.clear();
          atualizarUIFromCfg(); render(); setTimeout(fit, 30);
          toast('Preset aplicado: ' + key, 'ok');
        });
      });
      // Recarregar
      const load = document.getElementById('ed-load-evento');
      if (load) load.addEventListener('click', carregarDoEvento);
      // Zoom
      const zin = document.getElementById('ed-zoom-in');
      if (zin) zin.addEventListener('click', () => { ES.zoom = Math.min(8, ES.zoom * 1.2); render(); });
      const zout = document.getElementById('ed-zoom-out');
      if (zout) zout.addEventListener('click', () => { ES.zoom = Math.max(0.2, ES.zoom / 1.2); render(); });
      const zf = document.getElementById('ed-fit');
      if (zf) zf.addEventListener('click', fit);
      // Estado da selecção
      const bf = document.getElementById('ed-sel-livre'); if (bf) bf.addEventListener('click', () => aplicarEstadoSel('free'));
      const br = document.getElementById('ed-sel-reservado'); if (br) br.addEventListener('click', () => aplicarEstadoSel('reservado'));
      const bv = document.getElementById('ed-sel-vip'); if (bv) bv.addEventListener('click', () => aplicarEstadoSel('vip'));
      const bc = document.getElementById('ed-sel-clear'); if (bc) bc.addEventListener('click', () => { ES.selected.clear(); render(); atualizarPainelSentar(); });
      // Busca sentar
      const buscaEl = document.getElementById('ed-sentar-busca');
      if (buscaEl) buscaEl.addEventListener('input', atualizarPainelSentar);
      // Export / Import
      const eJson = document.getElementById('sala-ed-export-json'); if (eJson) eJson.addEventListener('click', exportJSON);
      const eSvg = document.getElementById('sala-ed-export-svg'); if (eSvg) eSvg.addEventListener('click', exportSVG);
      const ePng = document.getElementById('sala-ed-export-png'); if (ePng) ePng.addEventListener('click', exportPNG);
      const iBtn = document.getElementById('sala-ed-importar');
      const iFile = document.getElementById('sala-ed-file');
      if (iBtn && iFile) {
        iBtn.addEventListener('click', () => iFile.click());
        iFile.addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
      }
      // Aplicar
      const aplicarBtn = document.getElementById('sala-ed-aplicar');
      if (aplicarBtn) aplicarBtn.addEventListener('click', aplicarEPublicar);
      // Pan / zoom
      initPanZoom();
    }

    function activar() {
      bindUIOnce();
      if (!ES.activado) {
        ES.activado = true;
        carregarDoEvento();
      } else {
        // Re-render para acompanhar mudanças em ST
        ES.ocupacoes.clear();
        ST.inscritos.forEach(i => { if (i.lugar) ES.ocupacoes.set(String(i.lugar), i.id); });
        render();
      }
    }

    return { activar, render, carregar: carregarDoEvento };
  })();

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
