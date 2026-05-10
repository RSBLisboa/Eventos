# Eventos · Admin RSB Lisboa

App web (SPA) que substitui completamente a base de dados Access para a gestão do ciclo de vida de eventos do **Regimento de Sapadores Bombeiros de Lisboa**.

Faz tudo no browser (sem servidor próprio): edição de evento, importação de inscritos via Excel, vista de presenças em tempo real, emissão de certificados (numeração + hash SHA-256 + link), e geração de ficheiros `.eml` em zip para envio em massa via Outlook desktop.

> **Stack zero-server**: GitHub Pages (host) + GitHub REST API (persistência) + SheetJS (parse Excel) + JSZip (zip de .eml) + browser nativo (SHA-256, Crypto API, fetch). Sem Access, sem Power Automate, sem app registration no Entra ID.

---

## Como se encaixa no fluxo do evento

```
┌────────────────────────────────────────────────────────────────────────┐
│  ANTES do evento                                                        │
│  ────────────────                                                       │
│  Admin (este app)                                                       │
│   ├─ Setup  → publica  data/evento.json    (Presencas repo)             │
│   ├─ Inscritos: upload Excel → publica  data/inscritos.json (sem email) │
│   └─ emails ficam em sessionStorage do admin (privado, não persiste)    │
│                                                                         │
│  DURANTE o evento                                                       │
│  ────────────────                                                       │
│  Tablet (PWA Presenças)  ←→  data/presencas.json                        │
│                                                                         │
│  DEPOIS do evento                                                       │
│  ────────────────                                                       │
│  Admin (este app)                                                       │
│   ├─ Presenças: vê estado real-time                                     │
│   ├─ Emissão: gera nº + hash + links → data/certificados.json           │
│   ├─ Emissão: publica Certificados/certs.json (validar.html público)    │
│   └─ Envio: gera zip de .eml → arrasta para Outlook → "Send All"        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Estrutura do repositório

```
/
├── index.html               ← App principal (admin SPA)
├── manifest.webmanifest     ← PWA installable
├── sw.js                    ← Service worker (cache do shell)
├── js/
│   └── app.js               ← Toda a lógica (state, GitHub API, tabs, bridge)
├── bridge/
│   └── apps-script-bridge.gs← Código Google Apps Script (envio automatizado)
├── scripts/
│   └── Download-Libs.ps1    ← Self-host das libs CDN (opcional)
├── assets/
│   ├── rsb-brasao.png
│   └── lisboa-cml-transparent.png
└── README.md
```

Bibliotecas via CDN (sem build, sem npm):
- `xlsx@0.18.5` — parse Excel
- `jszip@3.10.1` — zip de .eml + snapshot

> Para self-hosting (resiliência caso o CDN caia), corre `scripts\Download-Libs.ps1`.

---

## Setup — primeira instalação

### 1. Criar o repositório no GitHub

Recomendado: **um repo separado para o admin** (este código), e usar o repo `Presencas` (já existente) como _data store_.

1. `https://github.com/new` → nome: `Eventos`, owner: `RSBLisboa`, **Public**, sem README/license/gitignore.
2. Copiar o conteúdo desta pasta (`APP/Github/Eventos/`) para o repo local clonado e push:
   ```bash
   git clone https://github.com/RSBLisboa/Eventos.git
   # copiar ficheiros
   git add . && git commit -m "Initial admin SPA" && git push
   ```
3. **Settings → Pages**: source = `Deploy from a branch`, branch = `main`, folder = `/ (root)`.
4. App fica em `https://rsblisboa.github.io/Eventos/`.

### 2. Confirmar repos auxiliares

Já devem existir do trabalho anterior:
- `RSBLisboa/Presencas` — data store + PWA do tablet
- `RSBLisboa/Certificados` — validar.html + index.html dos certificados

Se algum não existir, criar agora (ver `Github/Presencas/README.md` e `Github/Certificados/README.md`).

### 3. Fine-grained PAT

1. `https://github.com/settings/personal-access-tokens/new`
2. **Token name**: `RSB-Eventos-Admin-2026-05-18`
3. **Resource owner**: a tua conta/org (mesma que detém `RSBLisboa`)
4. **Expiration**: até 2 dias após o evento (curto TTL).
5. **Repository access**: *Only select repositories* → `Presencas` **e** `Certificados`.
6. **Permissions** → **Contents**: `Read and write` (todas as outras `No access`).
7. Generate, copiar **uma vez**, guardar em sítio seguro.

### 4. Mudar o PIN

`js/app.js` tem o hash do PIN no topo:
```js
pinHash: '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
```
Default = `1234` (igual à PWA de presenças, podes manter para terem o mesmo PIN).

Para mudar, na consola DevTools (F12) de qualquer página:
```js
(async pin => {
  const buf = new TextEncoder().encode(pin);
  const h = await crypto.subtle.digest('SHA-256', buf);
  console.log(Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join(''));
})('TEU-PIN-AQUI')
```
Substitui o hash em `app.js`, commit + push.

### 5. Configurar SECRET (sessionStorage, não publicado)

Na tab **Setup** (depois de fazer login no admin), preencher o campo **SECRET_HASH** com **a mesma string** que está em `Certificados/index.html`:

```js
const SECRET = "RSBLisboa-2026-CertificadoSecretKey-MudarEstaChave";
```

🔒 **Importante**: a partir desta versão, a SECRET é guardada **apenas no sessionStorage** do browser do admin — nunca é publicada no GitHub. Cada admin que entre tem de a introduzir uma vez por sessão.

> Se o teu `evento.json` foi criado por uma versão antiga e tem `secret` inline, o admin detecta na inicialização, copia para sessionStorage e mostra um aviso. Clica "Guardar configuração" no Setup para republicar a versão limpa.

⚠️ **Mudar esta SECRET nos dois sítios** (`Certificados/index.html` E na sessão admin) antes de qualquer emissão de produção, ou os certificados ficam inválidos.

### 6. (Opcional) Configurar Apps Script bridge para envio automatizado

Em vez de gerar um zip de `.eml` e arrastar para Outlook, podes deployar um pequeno script Google Apps Script que envia os emails automaticamente via Gmail/Workspace.

**Vantagens**: 1 clique para enviar todos · sem passar por Outlook · email "From" verificado (Send-as).
**Quando NÃO usar**: se preferires ter visibilidade visual em cada email antes do send (Outlook drafts).

#### Setup do bridge (uma vez)

1. Vai a `https://script.google.com` → **New project**.
2. Em `Code.gs`, substitui o conteúdo pelo de [`bridge/apps-script-bridge.gs`](bridge/apps-script-bridge.gs).
3. **Edita `SHARED_SECRET`** — uma string longa aleatória (≥ 32 chars, ex.: gerar com `openssl rand -base64 32`).
4. (Opcional) Edita `ALLOWED_FROM` se quiseres usar "Send-as" um endereço institucional configurado no Gmail.
5. **Deploy**: `Deploy → New deployment → Web app`:
   - Description: "RSB Eventos bridge"
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy → autoriza permissões → copia o **Web app URL** (termina em `/exec`).

#### Configurar no admin

Na tab **Setup**, secção "Bridge Apps Script":
- Cola o **URL** do web app (fica em `evento.json`).
- Cola o **mesmo SHARED_SECRET** (fica em sessionStorage).
- (Opcional) "From" para send-as.
- Clica **Testar bridge** → deve mostrar `✓ OK · v1.0 · teu-email · quota: 100`.

#### Usar

Tab **Envio** → selecciona certificados → clica **⚡ Enviar via bridge**. O sistema envia em batch via Gmail e marca como enviados em `data/certificados.json`.

#### Revogar (após o evento)

`script.google.com → Deploy → Manage deployments → archive`. A URL deixa de responder.

---

## Fluxo completo (passo-a-passo)

### Pré-evento (qualquer dia antes)

#### 1. Login

Abrir `https://rsblisboa.github.io/Eventos/` → introduzir PIN + token → entra.

#### 2. Tab **Setup**

- Preencher: ID do evento, data, título, local, hora início/fim, carga horária, próximo nº de cert (1 para evento novo), descrição (texto que vai no certificado), assinatura (nome + cargo do comandante).
- Email: remetente (`From:` dos `.eml`), CC opcional, assunto (com placeholders), corpo HTML (template default já preenche com o aspecto RSB).
- SECRET_HASH: colar a mesma chave que está no `index.html` dos certificados.
- **Guardar configuração** → escreve `data/evento.json` no repo Presencas.

#### 3. Tab **Inscritos**

- Upload do `Gestão de Convidados - Evento 2026-05-18.xlsx` (drag-and-drop ou clique).
- O sistema auto-detecta colunas (Nome, Email, Cargo, Entidade, Categoria, Estado_Inscrição). Mostra preview com aviso se algum não tiver email.
- **Publicar inscritos.json** → escreve no repo Presencas (sem emails — os emails ficam apenas no sessionStorage do teu browser).

> ⚠️ **Os emails têm de ser carregados a cada sessão admin**. Por design — não persistimos PII no GitHub. Se fechares o separador, na próxima sessão tens de fazer upload do Excel outra vez antes de poderes enviar emails.

### Durante o evento

A PWA de presenças (`https://rsblisboa.github.io/Presencas/`) já vai funcionar — é independente. A tab **Presenças** do admin mostra o estado em tempo real (polling 30s).

### Pós-evento

#### 4. Tab **Emissão**

- Vê a lista: presentes vs. ausentes, com cert vs. sem cert.
- **Gerar certificados em falta** → para cada inscrito presente sem cert, gera nº `AAAA/NNNN`, hash SHA-256 (igual à fórmula do site dos certificados), link, e regista em `data/certificados.json`.
- O `proxNumeroCert` no `evento.json` auto-incrementa.
- **Publicar certs.json (validar.html)** → escreve `certs.json` na raiz do repo Certificados (o `validar.html` passa a reconhecer estes números).

#### 5. Tab **Envio**

- Lista: para cada certificado, mostra estado (Sem email / Por enviar / Enviado).
- **Selecciona** os que queres enviar (por defeito todos os "Por enviar").
- Botões (3 caminhos de envio):
  - **⚡ Enviar via bridge** — envio automático via Apps Script + Gmail (recomendado se configurado). 1 clique para tudo.
  - **Gerar zip de .eml** — bundle de `.eml` (multipart/alternative texto + HTML, base64 UTF-8). Para arrastar para Outlook desktop drafts.
  - **Abrir mailto:** — abre janela de email por seleccionado (só viável para 1–5).
  - **Marcar como enviados (sem enviar)** — útil se enviaste manualmente e queres só registar.

#### 6. Importar para Outlook (apenas se usaste "Gerar zip de .eml")

1. Extrai o zip para uma pasta.
2. Abre Outlook desktop. Vai a **Drafts** (Rascunhos).
3. Selecciona TODOS os ficheiros `.eml` na pasta (Ctrl+A) e arrasta para a pasta Drafts do Outlook.
4. Cada `.eml` aparece como rascunho. Tem `X-Unsent: 1` no header — o Outlook abre como rascunho editável e tu podes confirmar visualmente o conteúdo.
5. Em Drafts, selecciona todos (Ctrl+A) → **File > Send All Messages** (ou Ctrl+Alt+S).
6. Voltar ao admin → **Marcar como enviados**.

> Se o Outlook recusar `.eml` (algumas versões corporativas bloqueiam), alternativa: abre cada `.eml` com duplo-clique → abre numa janela de mensagem → carrega Send. Para 48 emails é tedioso; melhor pedir ao IT para libertar drag-and-drop de .eml.

---

## Schemas dos JSON

### `data/evento.json`
```json
{
  "schema": "evento@1",
  "id": 1,
  "titulo": "Sessão Técnica em Substâncias Perigosas",
  "data": "2026-05-18",
  "local": "Auditório do Metropolitano de Lisboa",
  "horaInicio": "09:00",
  "horaFim": "12:00",
  "cargaHoraria": "3 horas",
  "proxNumeroCert": 49,
  "descricao": "...",
  "signatario": "TCor Eng. Alexandre Rodrigues",
  "signatarioCargo": "Comandante do RSBL",
  "emailFrom": "secretariado@rsblisboa.pt",
  "emailCc": "",
  "emailSubject": "Certificado · {{Titulo}}",
  "emailBody": "<html>…</html>",
  "bridgeUrl": "https://script.google.com/macros/s/.../exec",
  "bridgeFrom": "secretariado@cm-lisboa.pt",
  "actualizadoEm": "2026-05-18T20:30:00"
}
```

> 🔒 **Sem `secret`**: a SECRET de hashing dos certificados vive apenas em `sessionStorage` do browser do admin e nunca é publicada. Idem para `bridgeSecret`.

### `data/certificados.json`
```json
{
  "schema": "certificados@1",
  "eventoId": 1,
  "actualizadoEm": "2026-05-18T20:35:00",
  "total": 41,
  "certificados": [
    {
      "numero": "2026/0001",
      "idInscricao": 101,
      "hash": "abc123def456",
      "link": "https://rsblisboa.github.io/Certificados/?n=…&v=abc123def456",
      "dataEmissao": "2026-05-18T20:34:12",
      "dataEnvioEmail": null,
      "anulado": false
    }
  ]
}
```

> Não contém PII (sem nome / email). O `nome` reconstrói-se via `inscritos.json` + `idInscricao`. O link já está construído (incluí o nome) porque essa é a string canónica do certificado.

### `Certificados/certs.json` (existente, formato preservado)
```json
{
  "emitidoPor": "Regimento de Sapadores Bombeiros de Lisboa",
  "dataExportacao": "2026-05-18T20:35:00",
  "certificados": [{"n": "2026/0001", "d": "2026-05-18", "anulado": false}],
  "total": 41
}
```

---

## Decisões e trade-offs

| Decisão | Razão |
|---|---|
| **SPA pura, zero servidor** | Evento único / equipa pequena. Servidor seria sobre-engenharia + custo + ponto de falha. GitHub é o backend. |
| **Emails apenas em sessionStorage** | Não publicar PII em repo público. Custo: re-upload do Excel a cada sessão. Em troca: zero risco de fuga. |
| **SECRET + bridgeSecret em sessionStorage** | Mesma razão: estes valores nunca tocam o repo. Cada admin introduz uma vez por sessão. |
| **3 caminhos de envio (bridge, .eml, mailto)** | Bridge = automático (1 clique, requer setup Apps Script). .eml = manual via Outlook (zero setup). mailto = fallback individual. Compromisso entre setup-once e flexibilidade. |
| **CDN pinned versions** | `xlsx@0.18.5`, `jszip@3.10.1` — versões fixas. `Download-Libs.ps1` muda para self-hosting num clique. |
| **PIN client-side** | Apenas como barreira contra acesso casual. Quem souber abrir DevTools vê o hash. Para um evento fechado é suficiente; para uso continuado, considerar OAuth GitHub. |
| **Last-write-wins por SHA** | Admin tipicamente é single-user. Se houver dois separadores abertos, GitHub recusa o segundo PUT (HTTP 409); fazemos retry com refetch. |
| **Numeração na app, não atómica** | Em volume de 1 admin × 50 certs/dia, colisões são teoricamente possíveis mas práticamente nulas. Se for problema, lock optimista via SHA já está in place no `evento.json` (PUT falha em conflito). |
| **Bridge `text/plain` em vez de `application/json`** | Apps Script não suporta CORS preflight — `text/plain` é simple request, passa direto. O Apps Script parse JSON manualmente do body. |
| **Snapshot zip via JSZip** | Backup local off-Git em qualquer momento. Inclui `inscritos-com-email.PRIVADO.json` (versão completa) que NUNCA é publicada — fica só no zip do admin. |

---

## Limites e riscos

### Críticos

- **`secret` no JSON público**: como acima — qualquer pessoa que veja `data/evento.json` pode forjar links de certificado. Mitigações: a) mudar SECRET por evento, b) usar repo privado (custos), c) mover validação para um endpoint server-side (custos + complexidade).
- **`X-Unsent: 1` requer Outlook Classic / Outlook desktop**: o novo Outlook (Web/New) pode não respeitar este header. Verificar antes do dia D.
- **Quota GitHub**: 5000 req/h. Operações deste app são <100 req/sessão. Confortável.
- **Dependência de CDN**: jsdelivr.net ou cdnjs caem → app não carrega. Em produção: auto-hospedar `xlsx` e `jszip` em `assets/`.

### Não-críticos

- **Drag-and-drop de .eml**: pode estar bloqueado por política IT. Plano B: abrir cada .eml individualmente.
- **Latência GitHub Pages**: até ~1 min entre push e o ficheiro estar live no Pages. A app usa a API REST directamente, então lê sempre actualizado, mas a PWA do tablet pode demorar a ver o `inscritos.json` novo.
- **Nome de ficheiros .eml**: usa `nome_normalizado_numero.eml`. Pode dar conflito se houver homónimos exactos com o mesmo nº (impossível na prática).

---

## Troubleshooting

| Sintoma | Causa | Solução |
|---|---|---|
| Login falha "Token inválido" | PAT expirou / scope errado | Re-criar PAT com `Contents: write` em ambos os repos |
| Após upload Excel, "0 inscritos" | Coluna "Nome" não detectada | Confirmar que a coluna se chama `Nome` no header |
| Tab Presenças vazia | `presencas.json` ainda não escrito (ninguém fez check-in) | Esperar — o tablet escreve quando alguém marca |
| "Configura primeiro o evento" na tab Emissão | Falta título / data / SECRET no Setup | Tab Setup → preencher → Guardar |
| Hash de certificado não bate em `validar.html` | SECRET diferente entre `evento.json` e `Certificados/index.html` | Sincronizar as duas SECRETs |
| Outlook não aceita `.eml` arrastado | Política corporativa | Fallback: abrir cada um com duplo-clique |
| Email aparece com encoding partido | Body com caracteres não-UTF-8 | O .eml usa `Content-Transfer-Encoding: base64` UTF-8 — funciona em qualquer cliente moderno; se não, é bug do cliente. Reportar versão. |

---

## Comparação com a versão Access (legacy)

| Funcionalidade | Access (`APP/BD/`) | Web Admin (este) |
|---|---|---|
| Gestão de eventos | `tblEvento` + `frmEventos` | tab Setup |
| Importação Excel | `modIntegra_Excel.bas` | tab Inscritos (SheetJS no browser) |
| Presenças | `frmPresencas` (tablet) ou web PWA | web PWA + tab Presenças (read-only) |
| Numeração + hash | `modBiz_Certificados.bas` (VBA SHA-256 puro) | `app.js` (Web Crypto API) |
| Envio email | `modIntegra_Outlook.bas` (Outlook automation) | `.eml` zip → Outlook drag-and-drop |
| Validar.html | `modIntegra_GitHubPages.blnPublicarCertsViaAPI` | tab Emissão → "Publicar certs.json" |
| Audit trail | `tblAudit` | Histórico Git (cada commit é auditável) |
| RGPD anonimização | `modBiz_RGPD.bas` | a fazer (futuro) — operação pontual via cliente Git |
| Single binary install | `.accde` 32/64-bit | URL no browser |

A pasta `APP/src/`, `APP/scripts/`, `APP/BD/` continua válida — fica como caminho alternativo. Não foi removida.

---

## Próximos passos (futuro)

Já implementados em Mai/2026:
- ✅ Auto-hospedar libs (`scripts/Download-Libs.ps1`)
- ✅ Modo PWA (`manifest.webmanifest` + `sw.js`)
- ✅ Backup snapshot (botão `💾 Backup` no header, gera zip com tudo)
- ✅ Apps Script bridge para envio automatizado via Gmail (`bridge/apps-script-bridge.gs`)
- ✅ SECRET fora do JSON público (sessionStorage only)

Pendentes:
1. **Internacionalização** — extrair strings PT para `i18n/pt.json` (low-priority — projecto é PT-only).
2. **RGPD anonimização** — replicar `modBiz_RGPD` em JS: substitui campos PII em `inscritos.json` e re-publica.
3. **Test harness** — smoke-test automático que percorre setup → publicar → emitir → enviar → publicar certs (com mock do bridge).
4. **Multi-evento** — actualmente o sistema gere um evento de cada vez. Para o RSB lidar com vários eventos em paralelo, mover `data/{evento.json,inscritos.json,...}` para `events/{eventoId}/{...}`.
