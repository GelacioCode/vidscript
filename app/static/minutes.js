/* VidScript: Minutes of Meeting.
 *
 * Uses the person's own Claude/ChatGPT subscription through copy/paste:
 *   1. build a ready-made MOM prompt that includes the transcript,
 *   2. they run it at claude.ai or chatgpt.com,
 *   3. they paste the reply back; it becomes an editable, formatted document.
 * Nothing here talks to the VidScript server; the draft lives in localStorage.
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const KEY = 'vidscript.minutes';
  const PROMPT_OPENING = 'You are an experienced executive assistant. Write formal Minutes of Meeting';
  const SITES = {
    claude: { name: 'Claude', url: 'https://claude.ai/new' },
    chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  };
  const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'hr'];

  const el = {
    setup: $('#m-setup'), editor: $('#m-editor'),
    title: $('#m-title'), date: $('#m-date'), attendees: $('#m-attendees'),
    transcript: $('#m-transcript'), count: $('#m-count'),
    promptStatus: $('#m-prompt-status'), paste: $('#m-paste'), pasteStatus: $('#m-paste-status'),
    backToDoc: $('#m-back-to-doc'), doc: $('#m-doc'), saved: $('#m-saved'),
  };

  // ---------- helpers ----------
  function setStatus(node, msg, kind) {
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.textContent = '';
    if (typeof msg === 'string') node.textContent = msg;
    else if (msg) node.append(...msg);
  }

  function flash(btn, ok, okLabel, failLabel) {
    const label = btn.querySelector('span') || btn;
    const original = label.dataset.label || label.textContent;
    label.dataset.label = original;
    label.textContent = ok ? okLabel : failLabel;
    if (ok) btn.classList.add('copied');
    setTimeout(() => { label.textContent = original; btn.classList.remove('copied'); }, 1800);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }

  function hasDoc() { return el.doc.textContent.trim().length > 0; }

  function mode(m) {
    el.setup.hidden = m !== 'setup';
    el.editor.hidden = m !== 'editor';
    el.backToDoc.hidden = !(m === 'setup' && hasDoc());
  }

  // ---------- draft autosave ----------
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  }

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const draft = {
        title: el.title.value, date: el.date.value, attendees: el.attendees.value,
        transcript: el.transcript.value, doc: el.doc.innerHTML.trim(), savedAt: Date.now(),
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(draft));
        el.saved.textContent = 'Draft saved in this browser';
      } catch {
        el.saved.textContent = "Couldn't save the draft in this browser. Copy your minutes before leaving.";
      }
    }, 400);
  }

  function updateCount() {
    const t = el.transcript.value.trim();
    const words = t ? t.split(/\s+/).length : 0;
    let msg = words ? `${words.toLocaleString()} words` : '';
    if (t.length > 100000) msg += ' · Long transcript: Claude will attach it as a file automatically; ChatGPT may ask you to shorten it.';
    el.count.textContent = msg;
  }

  // ---------- step 2: the prompt ----------
  function fmtDate(v) {
    if (!v) return '';
    const d = new Date(v + 'T00:00:00Z');
    return isNaN(d) ? v : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function buildPrompt() {
    const title = el.title.value.trim();
    const date = fmtDate(el.date.value);
    const attendees = el.attendees.value.trim();
    return `${PROMPT_OPENING} (MOM) in English from the meeting transcript below.

About the transcript:
- It was produced by automatic speech recognition. It has no speaker names and may contain misheard words; interpret obvious recognition mistakes sensibly.
- It may be in English, Filipino/Tagalog, or Taglish. Always write the minutes in clear, professional English, translating as needed.

Rules:
- Never invent names, numbers, dates, or decisions. If something is not stated in the transcript or in the meeting details below, write "Not stated".
- Assign an action item to a person only when the transcript makes the owner clear.
- Be concise: capture decisions, commitments, and key facts, not small talk.

Reply with ONLY the minutes in Markdown: no introduction, no closing remarks, no code block. Use exactly this structure:

# Minutes of Meeting: <meeting title>

**Date:** <date, or Not stated>
**Attendees:** <names, or Not stated>
**Prepared by:**

## Summary
<2 to 4 sentences on the purpose and main outcomes>

## Discussion
### <Topic>
- <key point>

(one ### subsection per topic, in the order discussed)

## Decisions
- <decision> (or "- None recorded")

## Action Items
| # | Action | Owner | Due date |
|---|--------|-------|----------|
| 1 | <task> | <name or Not stated> | <date or Not stated> |

## Open Issues
- <unresolved question> (or "- None")

## Next Meeting
<date, time and agenda if mentioned, otherwise Not stated>

Meeting details from the organizer:
- Title: ${title || 'Not provided (infer a short, descriptive title from the discussion)'}
- Date: ${date || 'Not provided'}
- Known attendees: ${attendees || 'Not provided'}

<transcript>
${el.transcript.value.trim()}
</transcript>`;
  }

  document.querySelectorAll('[data-prompt]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!el.transcript.value.trim()) {
      setStatus(el.promptStatus, 'Add a transcript first (step 1).', 'bad');
      el.transcript.focus();
      return;
    }
    const ok = await copyText(buildPrompt());
    if (!ok) {
      setStatus(el.promptStatus, "Couldn't copy to the clipboard. Check that the page has clipboard permission and try again.", 'bad');
      return;
    }
    const site = SITES[btn.dataset.prompt];
    if (!site) {
      setStatus(el.promptStatus, 'Prompt copied. Paste it into a new chat in Claude or ChatGPT and send it.', 'ok');
      return;
    }
    window.open(site.url, '_blank', 'noopener');
    const link = Object.assign(document.createElement('a'), { href: site.url, target: '_blank', rel: 'noopener', textContent: `open ${site.name}` });
    setStatus(el.promptStatus, [
      `Prompt copied. In the ${site.name} tab, paste it (Ctrl+V) and send. When the reply is done, copy it and come back for step 3. (Tab didn't open? `,
      link, ')',
    ], 'ok');
  }));

  // ---------- step 3: paste the reply ----------
  function sanitize(html) {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: [] });
  }

  function cleanMarkdown(md) {
    let s = md.replace(/\r\n?/g, '\n').trim();
    const fence = s.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
    if (fence) s = fence[1].trim();
    // Drop a short preamble such as "Here are the minutes:" before the first heading.
    const h = s.search(/^#{1,3}\s/m);
    if (h > 0 && h < 400) s = s.slice(h);
    return s;
  }

  function tidy(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    t.content.querySelectorAll('p, li, h1, h2, h3, h4').forEach((n) => {
      if (!n.textContent.trim() && !n.querySelector('table')) n.remove();
    });
    return t.innerHTML.trim();
  }

  const STRUCTURE = /<(h[1-6]|ul|ol|li|table)\b/i;

  function importReply(html, text) {
    if (text && text.trim().startsWith(PROMPT_OPENING)) {
      setStatus(el.pasteStatus, "That's the prompt, not the reply. Copy the AI's answer first, then paste it here.", 'bad');
      return true; // handled (with a message)
    }
    let out = '';
    if (html && STRUCTURE.test(html)) out = sanitize(html);
    else if (text && text.trim()) out = sanitize(marked.parse(cleanMarkdown(text), { gfm: true, breaks: true }));
    out = tidy(out);
    if (!out) return false;
    el.doc.innerHTML = out;
    setStatus(el.pasteStatus, '');
    mode('editor');
    save();
    window.scrollTo({ top: 0 });
    return true;
  }

  el.paste.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertFromPaste') e.preventDefault();
  });
  el.paste.addEventListener('drop', (e) => e.preventDefault());
  el.paste.addEventListener('paste', (e) => {
    e.preventDefault();
    const cd = e.clipboardData;
    if (!importReply(cd.getData('text/html'), cd.getData('text/plain'))) {
      setStatus(el.pasteStatus, 'That paste was empty. Copy the reply from Claude or ChatGPT, then paste again.', 'bad');
    }
  });

  $('#m-paste-btn').addEventListener('click', async () => {
    try {
      let html = '', text = '';
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        }
      } else {
        text = await navigator.clipboard.readText();
      }
      if (!importReply(html, text)) {
        setStatus(el.pasteStatus, 'Your clipboard looks empty. Copy the reply from Claude or ChatGPT first.', 'bad');
      }
    } catch {
      setStatus(el.pasteStatus, 'Your browser blocked clipboard access. Click the box above and press Ctrl+V (⌘V on Mac) instead.', 'bad');
      el.paste.focus();
    }
  });

  el.backToDoc.addEventListener('click', () => mode('editor'));

  // ---------- editor ----------
  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
    btn.addEventListener('click', () => {
      const [cmd, arg] = btn.dataset.cmd.split(':');
      el.doc.focus();
      document.execCommand(cmd, false, arg ? `<${arg}>` : null);
      save();
    });
  });

  function actionTable() {
    const heading = [...el.doc.querySelectorAll('h1, h2, h3')].find((h) => /action/i.test(h.textContent));
    for (let n = heading && heading.nextElementSibling; n && !/^H[1-3]$/.test(n.tagName); n = n.nextElementSibling) {
      if (n.tagName === 'TABLE') return n;
      const inner = n.querySelector('table');
      if (inner) return inner;
    }
    return heading ? null : el.doc.querySelector('table');
  }

  function newActionTable() {
    const t = document.createElement('table');
    t.innerHTML = '<thead><tr><th>#</th><th>Action</th><th>Owner</th><th>Due date</th></tr></thead><tbody></tbody>';
    let heading = [...el.doc.querySelectorAll('h1, h2, h3')].find((h) => /action/i.test(h.textContent));
    if (!heading) {
      heading = document.createElement('h2');
      heading.textContent = 'Action Items';
      el.doc.appendChild(heading);
    }
    heading.after(t);
    return t;
  }

  $('#m-add-row').addEventListener('mousedown', (e) => e.preventDefault());
  $('#m-add-row').addEventListener('click', () => {
    const table = actionTable() || newActionTable();
    const body = table.tBodies[0] || table.createTBody();
    const cols = (table.rows[0] && table.rows[0].cells.length) || 4;
    const row = body.insertRow();
    for (let i = 0; i < cols; i++) row.insertCell().innerHTML = '<br>';
    const firstHeader = table.rows[0] && table.rows[0].cells[0].textContent.trim();
    if (firstHeader === '#') row.cells[0].textContent = String(body.rows.length);
    // Put the caret in the Action cell.
    const target = row.cells[firstHeader === '#' && cols > 1 ? 1 : 0];
    el.doc.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    save();
  });

  el.doc.addEventListener('input', save);
  // Keep pasted content inside the document clean, too.
  el.doc.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    const html = cd.getData('text/html');
    if (!html) return; // plain text pastes are fine as-is
    e.preventDefault();
    document.execCommand('insertHTML', false, sanitize(html));
  });

  // ---------- copy (formatted) ----------
  const EXPORT_STYLES = {
    h1: 'font-size:18pt;margin:0 0 10pt;',
    h2: 'font-size:14pt;margin:16pt 0 6pt;',
    h3: 'font-size:12pt;margin:10pt 0 4pt;',
    h4: 'font-size:11pt;margin:8pt 0 4pt;',
    p: 'margin:0 0 8pt;',
    ul: 'margin:0 0 8pt;', ol: 'margin:0 0 8pt;',
    table: 'border-collapse:collapse;width:100%;margin:4pt 0 10pt;',
    th: 'border:1px solid #999;padding:4pt 6pt;text-align:left;vertical-align:top;background:#f2f2f2;font-weight:bold;',
    td: 'border:1px solid #999;padding:4pt 6pt;text-align:left;vertical-align:top;',
  };

  function exportHtml() {
    const clone = el.doc.cloneNode(true);
    clone.querySelectorAll('*').forEach((n) => {
      const style = EXPORT_STYLES[n.tagName.toLowerCase()];
      if (style) n.setAttribute('style', style);
      if (n.tagName === 'TABLE') n.setAttribute('border', '1'); // helps Word keep the grid
    });
    return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4;color:#000;">${clone.innerHTML}</div>`;
  }

  function exportText() {
    return el.doc.innerText.replace(/\n{3,}/g, '\n\n').trim();
  }

  $('#m-copy').addEventListener('click', async () => {
    const btn = $('#m-copy');
    const html = exportHtml();
    const text = exportText();
    let ok = false;
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
        ok = true;
      }
    } catch {}
    if (!ok) {
      const onCopy = (e) => {
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      };
      document.addEventListener('copy', onCopy);
      try { ok = document.execCommand('copy'); } catch {}
      document.removeEventListener('copy', onCopy);
    }
    flash(btn, ok, 'Copied!', 'Copy failed: select the text and press Ctrl+C');
  });

  $('#m-redo-steps').addEventListener('click', () => {
    mode('setup');
    el.paste.scrollIntoView({ block: 'center' });
  });

  $('#m-reset').addEventListener('click', () => {
    if (!confirm('Start over? This clears the minutes draft and its transcript from this browser.')) return;
    el.title.value = el.date.value = el.attendees.value = el.transcript.value = '';
    el.doc.innerHTML = '';
    setStatus(el.promptStatus, '');
    setStatus(el.pasteStatus, '');
    el.saved.textContent = '';
    try { localStorage.removeItem(KEY); } catch {}
    updateCount();
    mode('setup');
  });

  // ---------- step 1: inputs + hand-off from the Transcript tab ----------
  [el.title, el.date, el.attendees, el.transcript].forEach((n) => n.addEventListener('input', save));
  el.transcript.addEventListener('input', updateCount);

  function guessDate(s) {
    const m = (s || '').match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b/);
    if (!m) return '';
    if (/^\d{4}-/.test(m[1])) return m[1];
    const d = new Date(m[1].replace('.', ''));
    if (isNaN(d)) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  window.addEventListener('vidscript:minutes', (e) => {
    const { transcript = '', title = '' } = e.detail || {};
    const same = el.transcript.value.trim() === transcript.trim();
    if (same && hasDoc()) { mode('editor'); return; }
    if (hasDoc() && !confirm('Replace your current minutes draft with this transcript?')) return;
    el.transcript.value = transcript;
    el.title.value = title;
    el.date.value = guessDate(title);
    el.attendees.value = '';
    el.doc.innerHTML = '';
    setStatus(el.promptStatus, '');
    setStatus(el.pasteStatus, '');
    updateCount();
    mode('setup');
    save();
  });

  // ---------- restore ----------
  const draft = loadDraft();
  if (draft) {
    el.title.value = draft.title || '';
    el.date.value = draft.date || '';
    el.attendees.value = draft.attendees || '';
    el.transcript.value = draft.transcript || '';
    el.doc.innerHTML = draft.doc ? sanitize(draft.doc) : '';
    if (draft.doc) el.saved.textContent = 'Draft restored from this browser';
  }
  updateCount();
  mode(hasDoc() ? 'editor' : 'setup');
})();
