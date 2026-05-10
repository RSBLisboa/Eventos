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

    // Hash SHA-256 hex do PIN. PIN actual gerado em Mai/2026: 309057.
    // Para mudar, gerar novo hash com snippet em DEPLOY.md > Passo 4.
    pinHash: '8b9423d1ff0c597462594af22b8f9aca3ae427e307c4c954a6a7e214e0a56394',

    // Polling do estado de presenças (só na tab activa).
    presencasPollMs: 30000
  };

  const TEMPLATE_EMAIL_DEFAULT = `<!DOCTYPE html><html><body style="font-family:Segoe UI,Calibri,sans-serif;color:#1a1a1a;line-height:1.6;max-width:600px;margin:auto;padding:24px">
<p style="background:#E30613;color:#fff;padding:12px 16px;margin:0 0 24px;font-weight:bold;letter-spacing:.04em;text-transform:uppercase">Regimento de Sapadores Bombeiros de Lisboa</p>
<p>Caro(a) <strong>{{Nome}}</strong>,</p>
<p>Em anexo encontra-se o seu certificado de participação na <strong>{{Titulo}}</strong>, realizada em <strong>{{DataEvento}}</strong> no <strong>{{Local}}</strong>.</p>
<p>Pode aceder ao certificado no link único abaixo:</p>
<p style="text-align:center;margin:24px 0"><a href="{{Link}}" style="background:#E30613;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Abrir certificado</a></p>
<p style="font-size:13px;color:#888">Número: {{NumeroCertificado}}</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:12px;color:#888">Cumprimentos,<br>Secretariado · Regimento de Sapadores Bombeiros de Lisboa</p>
</body></html>`;

  // ═══════════════════════════════════════════════════════════════════════════
  // ESTADO
  // ═══════════════════════════════════════════════════════════════════════════
  const ST = {
    evento: null,
    eventoSha: null,
    inscritos: [],          // sem email (público)
    inscritosSha: null,
    inscritosAdmin: {},     // map id → email (privado, sessionStorage)
    presencas: null,        // raw payload
    presencasSha: null,
    certificados: [],       // [{numero, idInscricao, hash, dataEmissao, dataEnvioEmail, anulado, link}]
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
    const pin = $('in-pin').value.trim();
    const token = $('in-token').value.trim();
    const erro = $('login-erro');
    erro.classList.add('hide');

    if (!pin || !token) {
      erro.textContent = 'Preenche PIN e token.';
      erro.classList.remove('hide');
      return;
    }
    const hash = await sha256Hex(pin);
    if (hash !== CONFIG.pinHash) {
      erro.textContent = 'PIN incorrecto.';
      erro.classList.remove('hide');
      return;
    }
    sessionStorage.setItem('gh_token', token);
    try {
      await ghValidarToken();
    } catch (e) {
      sessionStorage.removeItem('gh_token');
      erro.textContent = e.message;
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
      // Carregar em paralelo
      const [evt, ins, pres, certs] = await Promise.all([
        ghLer('data/evento.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/inscritos.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/presencas.json').catch(() => ({ sha: null, payload: null })),
        ghLer('data/certificados.json').catch(() => ({ sha: null, payload: null }))
      ]);

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

      ST.presencasSha = pres.sha;
      ST.presencas = pres.payload;

      ST.certificadosSha = certs.sha;
      ST.certificados = (certs.payload && certs.payload.certificados) || [];

      // Render
      hidratarSetup();
      renderInscritos();
      renderPresencas();
      renderEmissao();
      renderEnvio();
      atualizarBadges();

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
    $('evt-email-from').value = e.emailFrom || '';
    $('evt-email-cc').value = e.emailCc || '';
    $('evt-email-subject').value = e.emailSubject || '';
    $('evt-email-body').value = e.emailBody || TEMPLATE_EMAIL_DEFAULT;
    $('evt-secret').value = getSecret();
    $('evt-bridge-url').value = e.bridgeUrl || '';
    $('evt-bridge-secret').value = getBridgeSecret();
    $('evt-bridge-from').value = e.bridgeFrom || '';
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
  async function setupGuardar() {
    const e = lerSetup();
    if (!e.titulo || !e.data) {
      toast('Título e data são obrigatórios.', 'err');
      return;
    }
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

          if (!email) semEmailCount++;
          if (naoEnviar) naoEnviarCount++;

          inscritos.push({ id: inscritoId, nome, cargo, entidade, categoria, estado, naoEnviar });
          if (email && !naoEnviar) emails[inscritoId] = email;
        }

        if (inscritos.length === 0) {
          toast('Nenhum inscrito encontrado.', 'err');
          return;
        }

        // Stage no estado
        ST.inscritos = inscritos.sort((a, b) => normalizar(a.nome).localeCompare(normalizar(b.nome)));
        ST.inscritosAdmin = emails;
        ssGravarEmails();

        renderInscritos();
        renderEmissao();
        renderEnvio();
        atualizarBadges();
        const detalhes = [];
        if (multiEmail) detalhes.push(`${multiEmail} com múltiplos emails (juntados com vírgula)`);
        if (semEmailCount) detalhes.push(`${semEmailCount} sem email`);
        if (naoEnviarCount) detalhes.push(`${naoEnviarCount} flagged "Não enviar Mail" (excluídos do envio)`);
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

    // Preview do Excel (em sessão)
    if (ST.inscritos.length > 0) {
      const semEmail = ST.inscritos.filter(i => !ST.inscritosAdmin[i.id]).length;
      previewEl.classList.remove('hide');
      previewEl.innerHTML = `
        <div class="alert ${semEmail > 0 ? 'warn' : 'ok'}">
          <strong>${ST.inscritos.length}</strong> inscritos em sessão
          ${semEmail > 0 ? ` · <strong>${semEmail}</strong> sem email (não receberão certificado)` : ''}
        </div>` + tabelaInscritos(ST.inscritos, true);
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
        const em = ST.inscritosAdmin[i.id];
        colEmail = em
          ? `<td class="truncate"><span class="small mono">${escapeHtml(em)}</span></td>`
          : `<td><span class="small" style="color:var(--erro)">— sem email —</span></td>`;
      }
      return `<tr class="hover">
        <td>${escapeHtml(i.nome)}</td>
        <td><span class="small">${escapeHtml(i.cargo || '—')}</span></td>
        <td><span class="small">${escapeHtml(i.entidade || '—')}</span></td>
        ${colEmail}
        <td>${pillEstado(i.estado)}</td>
      </tr>`;
    }).join('');
    return `<div style="max-height:420px;overflow:auto;border:1px solid var(--linha);border-radius:6px">
      <table>
        <thead><tr>
          <th>Nome</th><th>Cargo</th><th>Entidade</th>
          ${comEmail ? '<th>Email (sessão)</th>' : ''}
          <th>Estado</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>`;
  }
  function pillEstado(s) {
    const v = (s || '').toLowerCase();
    if (v.indexOf('confirm') >= 0) return '<span class="pill verde">Confirmada</span>';
    if (v.indexOf('espera') >= 0) return '<span class="pill amarelo">Espera</span>';
    if (v.indexOf('cancel') >= 0 || v.indexOf('recusa') >= 0) return '<span class="pill vermelho">' + escapeHtml(s) + '</span>';
    return '<span class="pill cinza">' + escapeHtml(s || 'Pendente') + '</span>';
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
    const ok = await confirmar('Publicar inscritos',
      `Vai escrever ${ST.inscritos.length} inscritos em data/inscritos.json (sem emails). Continuar?`);
    if (!ok) return;

    const payload = {
      schema: 'inscritos@1',
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

    const linhas = ST.inscritos.map(i => {
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

    const linhas = ST.inscritos.map(i => {
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
        const numero = ano + '/' + String(prox).padStart(4, '0');
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

    const linhas = ST.certificados.map(c => {
      const i = inscritosMap.get(c.idInscricao) || { nome: '?', cargo: '', entidade: '', naoEnviar: false };
      const email = ST.inscritosAdmin[c.idInscricao] || '';
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

  function buildEmlContent(cert, inscrito, email) {
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
      Link: cert.link
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

    const semEmail = seleccionados.filter(c => !ST.inscritosAdmin[c.idInscricao]);
    if (semEmail.length === seleccionados.length) {
      toast('Nenhum dos seleccionados tem email em sessão.', 'err');
      return;
    }
    if (semEmail.length > 0) {
      const ok = await confirmar('Emails em falta',
        `${semEmail.length} dos ${seleccionados.length} seleccionados não têm email em sessão. Continuar (vão ser ignorados)?`);
      if (!ok) return;
    }

    setLoading(true, 'A construir emails…');
    try {
      const zip = new JSZip();
      let n = 0;
      for (const cert of seleccionados) {
        const email = ST.inscritosAdmin[cert.idInscricao];
        if (!email) continue;
        const inscrito = inscritosMap.get(cert.idInscricao);
        if (!inscrito) continue;
        const eml = buildEmlContent(cert, inscrito, email);
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
    const inscritosMap = new Map();
    for (const i of ST.inscritos) inscritosMap.set(i.id, i);

    for (const cert of seleccionados) {
      const email = ST.inscritosAdmin[cert.idInscricao];
      if (!email) continue;
      const inscrito = inscritosMap.get(cert.idInscricao);
      if (!inscrito) continue;
      const e = ST.evento;
      const vars = {
        Nome: inscrito.nome, Titulo: e.titulo, Link: cert.link,
        NumeroCertificado: cert.numero, DataEvento: dataPorExtenso(e.data),
        Local: e.local, Cargo: inscrito.cargo, Entidade: inscrito.entidade,
        CargaHoraria: e.cargaHoraria, HoraInicio: e.horaInicio, HoraFim: e.horaFim
      };
      const subject = aplicarPlaceholders(e.emailSubject, vars);
      const body = `Caro(a) ${inscrito.nome},\n\nO certificado de participação na ${e.titulo} está disponível em:\n\n${cert.link}\n\nNº: ${cert.numero}\n\nCumprimentos,\nSecretariado RSB Lisboa`;
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
      const email = ST.inscritosAdmin[cert.idInscricao];
      if (!email) { semEmail++; continue; }
      const inscrito = inscritosMap.get(cert.idInscricao);
      if (!inscrito) continue;
      const e = ST.evento;
      const vars = {
        Nome: inscrito.nome, Email: email,
        Cargo: inscrito.cargo || '', Entidade: inscrito.entidade || '',
        Titulo: e.titulo || '', DataEvento: dataPorExtenso(e.data),
        HoraInicio: e.horaInicio || '', HoraFim: e.horaFim || '',
        Local: e.local || '', CargaHoraria: e.cargaHoraria || '',
        NumeroCertificado: cert.numero, Link: cert.link
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
    } else {
      const ok = await confirmar('Enviar via bridge',
        `Vai enviar ${emails.length} emails reais via Gmail (bridge Apps Script). Continuar?`);
      if (!ok) return;
    }

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
        schema: 'inscritos@1',
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
          email: ST.inscritosAdmin[i.id] || ''
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
    if (name === 'presencas') renderPresencas();
    if (name === 'emissao') renderEmissao();
    if (name === 'envio') renderEnvio();
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
    $('in-pin').addEventListener('keydown', e => { if (e.key === 'Enter') $('in-token').focus(); });
    $('in-token').addEventListener('keydown', e => { if (e.key === 'Enter') tentarLogin(); });

    $('btn-setup-save').addEventListener('click', setupGuardar);
    $('btn-setup-reload').addEventListener('click', setupRecarregar);

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

    $('btn-inscritos-publish').addEventListener('click', inscritosPublicar);
    $('btn-inscritos-reload').addEventListener('click', async () => {
      setLoading(true, 'A recarregar inscritos…');
      try {
        const { sha, payload } = await ghLer('data/inscritos.json');
        ST.inscritosSha = sha;
        ST.inscritos = (payload && payload.inscritos) || [];
        renderInscritos(); renderPresencas(); renderEmissao(); renderEnvio();
        atualizarBadges();
        toast('Recarregado.', 'ok');
      } catch (e) { toast('Erro: ' + e.message, 'err'); }
      setLoading(false);
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
