/**
 * RSB Eventos · Apps Script bridge para envio automatizado de emails.
 *
 * USO:
 *   1. Vai a https://script.google.com → New project.
 *   2. Cola este ficheiro inteiro em Code.gs (substitui o conteúdo default).
 *   3. Edita SHARED_SECRET abaixo (escolhe uma string longa aleatória).
 *   4. (Opcional) Edita ALLOWED_FROM se quiseres fazer "send-as" um endereço
 *      verificado na tua conta Gmail (ex.: o teu @cm-lisboa.pt configurado em
 *      Gmail Settings > Accounts > Send mail as).
 *   5. Deploy:
 *        Deploy > New deployment > tipo "Web app"
 *        Description: "RSB Eventos bridge"
 *        Execute as: Me (a tua conta Gmail)
 *        Who has access: Anyone   ← necessário para o admin browser chamar sem auth
 *      → Copia o "Web app URL" (termina em /exec).
 *   6. No admin Eventos, tab Setup, secção "Bridge Apps Script":
 *        - Cola o URL
 *        - Cola o mesmo SHARED_SECRET
 *        - Clica "Testar bridge" → deve devolver versão + email da conta.
 *
 * QUOTAS Gmail (para teres em conta):
 *   - 100 destinatários/dia em conta gmail.com normal
 *   - 1500/dia em Google Workspace (cm-lisboa.pt etc.)
 *   Para os 48 inscritos do RSB cabe largamente.
 *
 * SEGURANÇA:
 *   - Anyone-access do web app é uma URL "secret" (não indexada). O SHARED_SECRET
 *     no body é a barreira de auth. NÃO usar SHARED_SECRET curto/previsível.
 *   - O endpoint só envia emails com payload válido (HTML pré-formado pelo admin).
 *   - Cada chamada deixa trail no Gmail "Sent" da tua conta — auditável.
 *
 * REVOGAÇÃO:
 *   - Após o evento: Deploy > Manage deployments > arquivar o deployment.
 *     A URL deixa de responder.
 */

const SHARED_SECRET = 'RGuG/KVYHe9xpJcaSLHVj3qOtyvo5wAmWdUqkWv5O2E=';

// Opcional: lista de "from" permitidos para "send-as". Vazio = só a conta default.
// Adicionar endereços já verificados em Gmail Settings > Accounts > Send mail as.
const ALLOWED_FROM = [
  // 'secretariado@cm-lisboa.pt',
  // 'rsblisboa@example.org',
];

// ════════════════════════════════════════════════════════════════════════════
// Endpoints HTTP
// ════════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    // Aceita Content-Type: text/plain ou application/json (admin usa text/plain
    // para evitar CORS preflight, que Apps Script não suporta).
    const raw = e && e.postData ? e.postData.contents : '';
    if (!raw) return jsonResp({ ok: false, error: 'Empty body' });
    const payload = JSON.parse(raw);

    if (payload.secret !== SHARED_SECRET) {
      return jsonResp({ ok: false, error: 'Bad secret' });
    }

    switch (payload.action) {
      case 'ping':
        return jsonResp({
          ok: true,
          version: '1.0',
          user: Session.getActiveUser().getEmail() || '(unknown)',
          dailyQuota: MailApp.getRemainingDailyQuota()
        });

      case 'send':
        return jsonResp(handleSend(payload));

      case 'send-batch':
        return jsonResp(handleSendBatch(payload));

      default:
        return jsonResp({ ok: false, error: 'Unknown action: ' + payload.action });
    }
  } catch (err) {
    return jsonResp({ ok: false, error: err.toString(), stack: (err.stack || '').substring(0, 500) });
  }
}

function doGet() {
  return ContentService.createTextOutput(
    'RSB Eventos bridge — endpoint POST only. Use the admin Eventos web app.'
  ).setMimeType(ContentService.MimeType.TEXT);
}

// ════════════════════════════════════════════════════════════════════════════
// Send single
// ════════════════════════════════════════════════════════════════════════════

function handleSend(p) {
  const to = p.to;
  const subject = p.subject;
  const html = p.html;
  const cc = p.cc;
  const fromName = p.fromName || 'RSB Lisboa';
  const fromEmail = p.fromEmail; // opcional — só usado se estiver em ALLOWED_FROM

  if (!to || !subject || !html) {
    return { ok: false, error: 'Missing fields (to/subject/html)' };
  }

  const opts = {
    name: fromName,
    htmlBody: html
  };
  if (cc) opts.cc = cc;
  if (fromEmail && ALLOWED_FROM.indexOf(fromEmail) >= 0) {
    opts.from = fromEmail;
  }

  GmailApp.sendEmail(to, subject, htmlToText(html), opts);
  return { ok: true, to: to };
}

// ════════════════════════════════════════════════════════════════════════════
// Send batch — emails: [{to, subject, html, cc?}, ...]
// Continua em caso de falha individual; devolve relatório por linha.
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
    // Pequena pausa para não bater na quota por segundo
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
// Utils
// ════════════════════════════════════════════════════════════════════════════

function jsonResp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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
