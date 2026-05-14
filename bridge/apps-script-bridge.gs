/**
 * RSB Eventos · Apps Script bridge
 *
 * Endpoints suportados (action no body POST):
 *   - ping           : healthcheck, devolve versão + quota + email do owner
 *   - send           : envia um email único (admin Eventos → tab Envio)
 *   - send-batch     : envia N emails em batch (admin Eventos → tab Envio)
 *   - apreciacao     : recebe resposta do apreciacao.html (página pública),
 *                      valida token, persiste em RSBLisboa/Presencas/data/apreciacao.json
 *
 * USO:
 *   1. Vai a https://script.google.com → New project.
 *   2. Cola este ficheiro inteiro em Code.gs (substitui o conteúdo default).
 *   3. Configura Script Properties em Project Settings:
 *        SHARED_SECRET    — string aleatória longa, usada por send/send-batch (admin)
 *        CERT_SECRET      — string IGUAL à de Certificados/config.js, usada por apreciacao
 *        GITHUB_PAT       — fine-grained PAT com Contents:write em RSBLisboa/Presencas
 *        GITHUB_OWNER     — RSBLisboa
 *        GITHUB_REPO      — Presencas
 *        GITHUB_BRANCH    — main
 *   4. (Opcional) Edita ALLOWED_FROM abaixo se quiseres usar "send-as".
 *   5. Deploy:
 *        Deploy > New deployment > tipo "Web app"
 *        Description: "RSB Eventos bridge"
 *        Execute as: Me (a tua conta Gmail)
 *        Who has access: Anyone   ← necessário para o admin browser e apreciacao.html
 *      → Copia o "Web app URL" (termina em /exec).
 *   6. Cola o URL em:
 *      - Eventos admin, tab Setup, secção "Bridge Apps Script" (+ SHARED_SECRET)
 *      - Certificados/config.js, campo BRIDGE_URL (commit + push)
 *
 * QUOTAS Gmail (envio):
 *   - 100 destinatários/dia em conta gmail.com normal
 *   - 1500/dia em Google Workspace (cm-lisboa.pt etc.)
 *
 * QUOTAS GitHub API:
 *   - 5000 pedidos/hora por PAT — confortável para o caso de uso.
 *
 * SEGURANÇA:
 *   - Anyone-access do web app é uma URL "secret" (não indexada).
 *   - send/send-batch requerem SHARED_SECRET no body (admin only).
 *   - apreciacao valida token derivado de CERT_SECRET (cada respondente tem token único).
 *   - PAT do GitHub vive em Script Properties, nunca no client.
 *
 * REVOGAÇÃO:
 *   - Após o evento: Deploy > Manage deployments > arquivar.
 *   - PAT GitHub: settings/personal-access-tokens > revogar.
 */

// Opcional: lista de "from" permitidos para "send-as".
// Adicionar endereços já verificados em Gmail Settings > Accounts > Send mail as.
const ALLOWED_FROM = [
  // 'rsb.esbl@cm-lisboa.pt',
];

// ════════════════════════════════════════════════════════════════════════════
// Endpoints HTTP
// ════════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    const raw = e && e.postData ? e.postData.contents : '';
    if (!raw) return jsonResp({ ok: false, error: 'Empty body' });
    const payload = JSON.parse(raw);

    switch (payload.action) {
      case 'ping':
        if (!checkSharedSecret(payload.secret)) return jsonResp({ ok: false, error: 'Bad secret' });
        return jsonResp({
          ok: true,
          version: '1.1',
          user: Session.getActiveUser().getEmail() || '(unknown)',
          dailyQuota: MailApp.getRemainingDailyQuota()
        });

      case 'send':
        if (!checkSharedSecret(payload.secret)) return jsonResp({ ok: false, error: 'Bad secret' });
        return jsonResp(handleSend(payload));

      case 'send-batch':
        if (!checkSharedSecret(payload.secret)) return jsonResp({ ok: false, error: 'Bad secret' });
        return jsonResp(handleSendBatch(payload));

      case 'apreciacao':
        // Não usa SHARED_SECRET — autoriza-se via token derivado de CERT_SECRET.
        return jsonResp(handleApreciacao(payload));

      default:
        return jsonResp({ ok: false, error: 'Unknown action: ' + payload.action });
    }
  } catch (err) {
    return jsonResp({ ok: false, error: err.toString(), stack: (err.stack || '').substring(0, 500) });
  }
}

function doGet() {
  return ContentService.createTextOutput(
    'RSB Eventos bridge — endpoint POST only.'
  ).setMimeType(ContentService.MimeType.TEXT);
}

// ════════════════════════════════════════════════════════════════════════════
// Properties helpers
// ════════════════════════════════════════════════════════════════════════════

function prop(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function checkSharedSecret(s) {
  const expected = prop('SHARED_SECRET');
  return expected && s === expected;
}

// ════════════════════════════════════════════════════════════════════════════
// Send single email
// ════════════════════════════════════════════════════════════════════════════

function handleSend(p) {
  const to = p.to;
  const subject = p.subject;
  const html = p.html;
  const cc = p.cc;
  const fromName = p.fromName || 'RSB Lisboa';
  const fromEmail = p.fromEmail;

  if (!to || !subject || !html) {
    return { ok: false, error: 'Missing fields (to/subject/html)' };
  }

  const opts = { name: fromName, htmlBody: html };
  if (cc) opts.cc = cc;
  if (fromEmail && ALLOWED_FROM.indexOf(fromEmail) >= 0) opts.from = fromEmail;

  GmailApp.sendEmail(to, subject, htmlToText(html), opts);
  return { ok: true, to: to };
}

// ════════════════════════════════════════════════════════════════════════════
// Send batch
// ════════════════════════════════════════════════════════════════════════════

function handleSendBatch(p) {
  if (!Array.isArray(p.emails)) return { ok: false, error: 'emails must be array' };
  const fromName = p.fromName || 'RSB Lisboa';
  const fromEmail = p.fromEmail;

  const results = [];
  let okCount = 0, errCount = 0;

  for (const m of p.emails) {
    if (!m.to || !m.subject || !m.html) {
      results.push({ to: m.to, ok: false, error: 'Missing fields' });
      errCount++;
      continue;
    }
    try {
      const opts = { name: fromName, htmlBody: m.html };
      if (m.cc) opts.cc = m.cc;
      if (fromEmail && ALLOWED_FROM.indexOf(fromEmail) >= 0) opts.from = fromEmail;
      GmailApp.sendEmail(m.to, m.subject, htmlToText(m.html), opts);
      results.push({ to: m.to, ok: true });
      okCount++;
    } catch (err) {
      results.push({ to: m.to, ok: false, error: err.toString() });
      errCount++;
    }
    Utilities.sleep(100);
  }

  return {
    ok: errCount === 0,
    sent: okCount,
    failed: errCount,
    total: p.emails.length,
    results: results,
    quotaRemaining: MailApp.getRemainingDailyQuota()
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Apreciação · recebe resposta do questionário de satisfação público
// ════════════════════════════════════════════════════════════════════════════

function handleApreciacao(p) {
  const id = p.id;
  const t = (p.t || '').toLowerCase();
  const respostas = p.respostas;
  const submetidoEm = p.submetidoEm || new Date().toISOString();

  if (!id || !t || !respostas) {
    return { ok: false, error: 'Campos em falta (id, t, respostas)' };
  }

  const certSecret = prop('CERT_SECRET');
  if (!certSecret) {
    return { ok: false, error: 'CERT_SECRET não configurada no bridge' };
  }

  // Recalcula token esperado e compara
  const expected = sha256Hex(id + '|' + certSecret).substring(0, 16).toLowerCase();
  if (t !== expected) {
    return { ok: false, error: 'Token inválido' };
  }

  // Persiste em GitHub (RSBLisboa/Presencas/data/apreciacao.json)
  const owner = prop('GITHUB_OWNER') || 'RSBLisboa';
  const repo = prop('GITHUB_REPO') || 'Presencas';
  const branch = prop('GITHUB_BRANCH') || 'main';
  const pat = prop('GITHUB_PAT');
  if (!pat) {
    return { ok: false, error: 'GITHUB_PAT não configurado no bridge' };
  }

  const path = 'data/apreciacao.json';
  const apiBase = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;

  // GET para ler estado actual (+ SHA)
  let current = null;
  let sha = null;
  try {
    const getResp = UrlFetchApp.fetch(apiBase + '?ref=' + branch, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + pat,
        Accept: 'application/vnd.github+json'
      },
      muteHttpExceptions: true
    });
    if (getResp.getResponseCode() === 200) {
      const j = JSON.parse(getResp.getContentText());
      sha = j.sha;
      const decoded = Utilities.newBlob(Utilities.base64Decode(j.content)).getDataAsString('UTF-8');
      current = JSON.parse(decoded);
    } else if (getResp.getResponseCode() === 404) {
      current = null; // ficheiro ainda não existe
    } else {
      return { ok: false, error: 'GitHub GET HTTP ' + getResp.getResponseCode() + ': ' + getResp.getContentText().substring(0, 200) };
    }
  } catch (err) {
    return { ok: false, error: 'GitHub GET falhou: ' + err.toString() };
  }

  // Compor o ficheiro novo
  if (!current) {
    current = {
      schema: 'apreciacao@1',
      eventoId: 1,
      actualizadoEm: submetidoEm,
      total: 0,
      respostas: []
    };
  }

  // Verifica se o id já respondeu (last-write-wins; mantém o mais recente)
  const idStr = String(id);
  const existeIdx = current.respostas.findIndex(r => String(r.idInscricao) === idStr);
  const novaResposta = {
    idInscricao: parseInt(idStr, 10) || idStr,
    submetidoEm: submetidoEm,
    respostas: respostas
  };

  if (existeIdx >= 0) {
    current.respostas[existeIdx] = novaResposta;
  } else {
    current.respostas.push(novaResposta);
  }

  current.actualizadoEm = submetidoEm;
  current.total = current.respostas.length;

  // PUT do novo conteúdo
  const novoConteudo = Utilities.base64Encode(JSON.stringify(current, null, 2), Utilities.Charset.UTF_8);
  const putBody = {
    message: 'apreciacao: resposta do inscrito ' + idStr,
    content: novoConteudo,
    branch: branch
  };
  if (sha) putBody.sha = sha;

  try {
    const putResp = UrlFetchApp.fetch(apiBase, {
      method: 'put',
      headers: {
        Authorization: 'Bearer ' + pat,
        Accept: 'application/vnd.github+json'
      },
      contentType: 'application/json',
      payload: JSON.stringify(putBody),
      muteHttpExceptions: true
    });
    const code = putResp.getResponseCode();
    if (code === 200 || code === 201) {
      return { ok: true, id: idStr, total: current.total };
    } else if (code === 409) {
      return { ok: false, error: 'Conflito de sincronização (SHA divergente). Tente novamente em alguns segundos.' };
    } else {
      return { ok: false, error: 'GitHub PUT HTTP ' + code + ': ' + putResp.getContentText().substring(0, 200) };
    }
  } catch (err) {
    return { ok: false, error: 'GitHub PUT falhou: ' + err.toString() };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Utils
// ════════════════════════════════════════════════════════════════════════════

function jsonResp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sha256Hex(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return hex;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
