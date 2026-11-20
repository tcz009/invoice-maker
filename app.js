'use strict';

/* =====================================================================
   Invoice Maker — independent contractor invoices (GBP)
   Single-page app: editor + live A4 preview, stored in localStorage.
   ===================================================================== */

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

const STORE_KEY = 'contractor-invoice.v1';
const CURRENCIES = ['GBP', 'EUR', 'USD'];
const MIN_LINES = 5;

const CERT_TEXT =
  'I certify that the above is a true and accurate statement of services rendered, ' +
  'and that I am responsible for my own tax withholding and reporting as an independent contractor.';
const SUBMIT_TEXT = 'Please send your invoice to accounts@example.com.';

/* Defaults for a brand-new install. Leave these blank for a reusable template,
   or fill them in with your own details (they only seed the first invoice). */
const SEED = {
  contractor: {
    name: '',
    business: '',
    email: '',
    phone: '',
    address: '',
    utr: '',
  },
  payment: {
    bank: '',
    holder: '',
    accountNumber: '',
    sortCode: '',
  },
  signature: '',
};

/* ---------------------------------------------------------------- */
/* tiny helpers                                                      */
/* ---------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const pad2 = (n) => String(n).padStart(2, '0');
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(value) {
  return esc(value).replace(/\n/g, '<br>');
}

function num(value) {
  if (value === '' || value == null) return 0;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/* ---------------------------------------------------------------- */
/* dates                                                             */
/* ---------------------------------------------------------------- */

function isoOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayISO() {
  return isoOf(new Date());
}
function parseISO(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDaysISO(value, days) {
  const d = parseISO(value) || new Date();
  d.setDate(d.getDate() + days);
  return isoOf(d);
}
function endOfMonthISO(value) {
  const d = parseISO(value) || new Date();
  return isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

const longDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
function fmtDate(value) {
  const d = parseISO(value);
  return d ? longDate.format(d) : '—';
}

/* Default billing period for new invoices.
   'previous-month' → 1st to last day of the month before the invoice date.
   'mid-month'      → 15th of the previous month to the 14th of this one. */
const DEFAULT_PERIOD = 'previous-month';

function defaultPeriod(issueDate) {
  const d = parseISO(issueDate) || new Date();
  let y = d.getFullYear();
  let m = d.getMonth() + 1;

  if (DEFAULT_PERIOD === 'mid-month') {
    if (d.getDate() < 15) {
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
    }
    const to = `${y}-${pad2(m)}-14`;
    let fm = m - 1;
    let fy = y;
    if (fm === 0) { fm = 12; fy -= 1; }
    return { from: `${fy}-${pad2(fm)}-15`, to };
  }

  if (m === 1) { m = 12; y -= 1; } else { m -= 1; }
  return { from: `${y}-${pad2(m)}-01`, to: isoOf(new Date(y, m, 0)) };
}

function periodLabel(period) {
  if (!period || !period.from || !period.to) return '';
  return `${fmtDate(period.from)} – ${fmtDate(period.to)}`;
}

/* ---------------------------------------------------------------- */
/* money                                                             */
/* ---------------------------------------------------------------- */

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND']);

function money(cents, currency) {
  const cur = currency || (state.inv && state.inv.currency) || 'GBP';
  const zero = ZERO_DECIMAL.has(cur);
  let text;
  try {
    text = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: cur,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: zero ? 0 : 2,
      maximumFractionDigits: zero ? 0 : 2,
    }).format(Math.abs(cents) / 100);
  } catch {
    text = `${cur} ${(Math.abs(cents) / 100).toFixed(2)}`;
  }
  return cents < 0 ? `(${text})` : text;
}

function fmtQty(value) {
  if (value === '' || value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return esc(String(value));
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n);
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const state = { store: null, settings: null, inv: null };

function newItem(dateText) {
  return { id: uid(), date: dateText || '', description: '', qty: '1', rate: '' };
}

function baseInvoice(settings) {
  const today = todayISO();
  const period = defaultPeriod(today);
  return {
    id: uid(),
    status: 'draft',
    number: '',
    issueDate: today,
    dueDate: endOfMonthISO(today),
    currency: (settings && settings.currency) || 'GBP',
    contractor: { ...SEED.contractor },
    payment: { ...SEED.payment },
    period,
    items: [newItem(periodLabel(period))],
    signature: SEED.signature,
    signatureDate: today,
    certification: CERT_TEXT,
    submission: SUBMIT_TEXT,
    updatedAt: Date.now(),
  };
}

function normalizeInvoice(raw) {
  const base = baseInvoice(state.settings);
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base, ...src };
  out.id = src.id || base.id;
  out.contractor = { ...base.contractor, ...(src.contractor || {}) };
  out.payment = { ...base.payment, ...(src.payment || {}) };
  out.period = { ...base.period, ...(src.period || {}) };
  const items = Array.isArray(src.items) && src.items.length ? src.items : base.items;
  out.items = items.map((it) => ({ ...newItem(), ...it, id: (it && it.id) || uid() }));
  if (!CURRENCIES.includes(out.currency)) out.currency = 'GBP';
  return out;
}

function loadStore() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    raw = null;
  }

  if (!raw || !Array.isArray(raw.invoices) || raw.invoices.length === 0) {
    const seeded = {
      version: 1,
      counter: 1,
      settings: { currency: 'GBP', accent: '#1f3864' },
      currentId: null,
      invoices: [],
    };
    const inv = baseInvoice(seeded.settings);
    inv.number = `${new Date().getFullYear()}-${String(seeded.counter).padStart(3, '0')}`;
    seeded.counter += 1;
    seeded.invoices.push(inv);
    seeded.currentId = inv.id;
    return seeded;
  }

  return {
    version: 1,
    counter: Number.isFinite(raw.counter) && raw.counter > 0 ? raw.counter : 1,
    settings: { currency: 'GBP', accent: '#1f3864', ...(raw.settings || {}) },
    currentId: raw.currentId || null,
    invoices: raw.invoices.map((item) => normalizeInvoice(item)),
  };
}

function nextNumber() {
  return `${new Date().getFullYear()}-${String(state.store.counter).padStart(3, '0')}`;
}

/* ---------------------------------------------------------------- */
/* totals                                                            */
/* ---------------------------------------------------------------- */

function lineCents(item) {
  return Math.round(num(item.qty) * num(item.rate) * 100);
}

function totalsOf(invoice) {
  const lines = invoice.items.map(lineCents);
  const subtotal = lines.reduce((a, b) => a + b, 0);
  return { lines, subtotal, total: subtotal };
}

function statusOf(invoice) {
  if (invoice.status === 'paid') return 'paid';
  if (invoice.status === 'sent' && invoice.dueDate && invoice.dueDate < todayISO() && totalsOf(invoice).total > 0) {
    return 'overdue';
  }
  return invoice.status || 'draft';
}

function statusLabel(invoice) {
  return { draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue' }[statusOf(invoice)] || 'Draft';
}

/* ---------------------------------------------------------------- */
/* persistence                                                       */
/* ---------------------------------------------------------------- */

let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (state.inv) state.inv.updatedAt = Date.now();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
  } catch {
    toast('Could not save — browser storage is full or blocked.');
  }
}

/* ---------------------------------------------------------------- */
/* rendering — invoice paper                                         */
/* ---------------------------------------------------------------- */

function detRow(label, value) {
  return `<div class="det-row">
    <span class="det-label">${esc(label)}</span>
    <span class="det-value">${value ? nl2br(value) : '&nbsp;'}</span>
  </div>`;
}

function linkify(text) {
  return esc(text || '').replace(
    /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi,
    (match) => `<a href="mailto:${match}">${match}</a>`,
  );
}

function renderPaper() {
  const inv = state.inv;
  const t = totalsOf(inv);
  const filler = Math.max(0, MIN_LINES - inv.items.length);

  $('.paper', document).innerHTML = `
    <div class="paper-inner">
      <h1 class="doc-title">Independent Contractor Invoice</h1>

      <section class="block">
        <div class="band">Contractor &amp; Invoice Details</div>
        <div class="details">
          <div class="det-col">
            ${detRow('Contractor Name', inv.contractor.name)}
            ${detRow('Business Name (if applicable)', inv.contractor.business)}
            ${detRow('Email', inv.contractor.email)}
            ${detRow('Phone', inv.contractor.phone)}
            ${detRow('Address', inv.contractor.address)}
          </div>
          <div class="det-col">
            ${detRow('Invoice Number', inv.number)}
            ${detRow('Invoice Date', inv.issueDate ? fmtDate(inv.issueDate) : '')}
            ${detRow('UTR Number', inv.contractor.utr)}
            ${detRow('Due Date', inv.dueDate ? fmtDate(inv.dueDate) : '')}
          </div>
        </div>
      </section>

      <section class="block">
        <div class="band">Services Provided</div>
        <table class="services">
          <colgroup>
            <col class="c-date" /><col class="c-desc" /><col class="c-qty" /><col class="c-rate" /><col class="c-amt" />
          </colgroup>
          <thead>
            <tr>
              <th>Date</th><th>Description of Work</th><th>Hours / Qty</th><th>Rate</th><th>Amount</th>
            </tr>
          </thead>
          <tbody>
            ${inv.items
              .map(
                (item) => `<tr>
                  <td>${item.date ? nl2br(item.date) : '&nbsp;'}</td>
                  <td>${item.description ? nl2br(item.description) : '&nbsp;'}</td>
                  <td class="num">${fmtQty(item.qty)}</td>
                  <td class="num">${item.rate === '' ? '' : money(Math.round(num(item.rate) * 100))}</td>
                  <td class="num">${item.rate === '' ? '' : money(lineCents(item))}</td>
                </tr>`,
              )
              .join('')}
            ${Array.from({ length: filler }, () => '<tr class="empty"><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>').join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="label" colspan="4">Subtotal</td>
              <td class="num">${money(t.subtotal)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <div class="total-bar">
        <span>TOTAL AMOUNT DUE</span>
        <span>${money(t.total)}</span>
      </div>

      <section class="block">
        <div class="band">Payment Details</div>
        <div class="pay">
          ${detRow('Bank Name', inv.payment.bank)}
          ${detRow('Account Holder Name', inv.payment.holder)}
          ${detRow('Account Number', inv.payment.accountNumber)}
          ${detRow('Sort Code', inv.payment.sortCode)}
        </div>
      </section>

      <p class="certification">${nl2br(inv.certification)}</p>
      <p class="submission">${linkify(inv.submission)}</p>

      <div class="sign">
        <div class="sign-field">
          <span class="sign-label">Signature</span>
          <span class="sign-box">${inv.signature ? esc(inv.signature) : '&nbsp;'}</span>
        </div>
        <div class="sign-field">
          <span class="sign-label">Date</span>
          <span class="sign-box">${inv.signatureDate ? fmtDate(inv.signatureDate) : '&nbsp;'}</span>
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- */
/* rendering — editor                                                */
/* ---------------------------------------------------------------- */

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let target = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!target[keys[i]] || typeof target[keys[i]] !== 'object') target[keys[i]] = {};
    target = target[keys[i]];
  }
  target[keys[keys.length - 1]] = value;
}

function renderItems() {
  const inv = state.inv;
  $('#items').innerHTML = inv.items
    .map(
      (item, index) => `<div class="item" data-id="${item.id}">
        <div class="item-top">
          <input type="text" class="item-date" data-field="date" value="${esc(item.date)}"
                 placeholder="15 October 2026 – 14 November 2026" aria-label="Date, line ${index + 1}" />
          <button type="button" class="icon-btn" data-act="del" title="Remove line" aria-label="Remove line ${index + 1}">✕</button>
        </div>
        <input type="text" class="item-desc" data-field="description" value="${esc(item.description)}"
               placeholder="Description of work" aria-label="Description, line ${index + 1}" />
        <div class="item-grid">
          <label><span>Hours / Qty</span><input type="text" inputmode="decimal" data-field="qty" value="${esc(item.qty)}" aria-label="Hours or quantity, line ${index + 1}" /></label>
          <label><span>Rate</span><input type="text" inputmode="decimal" data-field="rate" value="${esc(item.rate)}" placeholder="0.00" aria-label="Rate, line ${index + 1}" /></label>
          <div class="item-amount"><span>Amount</span><b>${item.rate === '' ? '—' : money(lineCents(item))}</b></div>
        </div>
      </div>`,
    )
    .join('');
}

function renderSummary() {
  const t = totalsOf(state.inv);
  $('#editorTotal').innerHTML = `
    <div class="sum-row"><span>Subtotal</span><b>${money(t.subtotal)}</b></div>
    <div class="sum-row sum-total"><span>Total amount due</span><b>${money(t.total)}</b></div>`;
}

function updateChrome() {
  $('#libCount').textContent = String(state.store.invoices.length);
  $('#brandSub').textContent = `${state.inv.number || 'Untitled'} · ${state.inv.currency}`;
  document.title = `${state.inv.number || 'Invoice'} — Invoice Maker`;
}

function fillEditor() {
  $$('[data-path]').forEach((el) => {
    const value = getPath(state.inv, el.dataset.path);
    el.value = value == null ? '' : value;
  });
  $('#f-accent').value = state.settings.accent;
  renderItems();
  renderPaper();
  renderSummary();
  syncDuePreset();
  updateChrome();
}

function refresh() {
  renderPaper();
  renderSummary();
  updateChrome();
  scheduleSave();
}

/* ---------------------------------------------------------------- */
/* due-date rules                                                    */
/* ---------------------------------------------------------------- */

function dueFromPreset(preset, issueDate) {
  switch (preset) {
    case 'receipt': return issueDate;
    case 'net14': return addDaysISO(issueDate, 14);
    case 'net30': return addDaysISO(issueDate, 30);
    case 'eom':
    default: return endOfMonthISO(issueDate);
  }
}

function syncDuePreset() {
  const inv = state.inv;
  const match = ['eom', 'receipt', 'net14', 'net30'].find((p) => dueFromPreset(p, inv.issueDate) === inv.dueDate);
  $('#f-duepreset').value = match || 'custom';
}

/* ---------------------------------------------------------------- */
/* invoice switching / creation                                      */
/* ---------------------------------------------------------------- */

function newInvoice() {
  const prev = state.inv;
  const inv = baseInvoice(state.settings);
  if (prev) {
    inv.contractor = { ...prev.contractor };
    inv.payment = { ...prev.payment };
    inv.signature = prev.signature;
    inv.certification = prev.certification || CERT_TEXT;
    inv.submission = prev.submission || SUBMIT_TEXT;
    inv.currency = prev.currency || 'GBP';
  }
  inv.number = nextNumber();
  state.store.counter += 1;
  state.store.invoices.unshift(inv);
  state.store.currentId = inv.id;
  state.inv = inv;
  return inv;
}

function importStatement(data) {
  const amount = Number(data && data.total);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  // Fill the invoice on screen if it is still blank; otherwise start the next one.
  const isBlank =
    totalsOf(state.inv).total === 0 &&
    !state.inv.items.some((item) => item.description !== '' || num(item.rate) !== 0);
  const inv = isBlank ? state.inv : newInvoice();
  const today = todayISO();
  inv.issueDate = today;
  inv.dueDate = endOfMonthISO(today);
  inv.signatureDate = today;
  if (data.from && data.to) inv.period = { from: data.from, to: data.to };

  inv.items = [{
    id: uid(),
    date: periodLabel(inv.period),
    description: 'Event Crew / Crew Chief services',
    qty: '1',
    rate: amount.toFixed(2),
  }];

  fillEditor();
  refresh();
  saveNow();
  toast(`Imported ${money(Math.round(amount * 100))} — add any deduction, then Download ▸ PDF.`);
  return true;
}

window.importStatement = importStatement;

function switchTo(id) {
  const inv = state.store.invoices.find((i) => i.id === id);
  if (!inv) return;
  state.inv = inv;
  state.store.currentId = id;
  fillEditor();
  refresh();
  saveNow();
}

function createAndOpen() {
  newInvoice();
  fillEditor();
  refresh();
  saveNow();
}

function duplicateInvoice(id) {
  const source = state.store.invoices.find((i) => i.id === id);
  if (!source) return;

  const copy = normalizeInvoice(JSON.parse(JSON.stringify(source)));
  copy.id = uid();
  copy.number = nextNumber();
  state.store.counter += 1;
  copy.status = 'draft';
  copy.issueDate = todayISO();
  copy.dueDate = endOfMonthISO(copy.issueDate);
  copy.signatureDate = copy.issueDate;
  copy.period = defaultPeriod(copy.issueDate);
  copy.updatedAt = Date.now();
  const label = periodLabel(copy.period);
  copy.items.forEach((item) => {
    item.id = uid();
    if (item.date) item.date = label;
  });

  state.store.invoices.unshift(copy);
  state.store.currentId = copy.id;
  state.inv = copy;
  fillEditor();
  refresh();
  saveNow();
  toast(`Duplicated as ${copy.number}.`);
}

function deleteInvoice(id) {
  const inv = state.store.invoices.find((i) => i.id === id);
  if (!inv) return;
  if (!window.confirm(`Delete invoice ${inv.number || 'Untitled'}? This cannot be undone.`)) return;

  state.store.invoices = state.store.invoices.filter((i) => i.id !== id);

  if (state.store.invoices.length === 0) {
    createAndOpen();
  } else if (state.inv.id === id) {
    switchTo(state.store.invoices[0].id);
  } else {
    saveNow();
  }
  renderLibrary();
  updateChrome();
}

/* ---------------------------------------------------------------- */
/* library                                                           */
/* ---------------------------------------------------------------- */

function renderLibrary() {
  const list = state.store.invoices.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (list.length === 0) {
    $('#libList').innerHTML = '<p class="lib-empty">No invoices yet.</p>';
    return;
  }
  $('#libList').innerHTML = list
    .map((inv) => {
      const current = inv.id === state.inv.id;
      return `<div class="lib-row${current ? ' is-current' : ''}" data-id="${inv.id}">
        <div class="lib-main">
          <span class="lib-num">${esc(inv.number || 'Untitled')}</span>
          <span class="lib-meta">${fmtDate(inv.issueDate)} · ${statusLabel(inv)}</span>
        </div>
        <div class="lib-amt">${money(totalsOf(inv).total, inv.currency)}</div>
        <div class="lib-actions">
          <button type="button" data-act="open">Open</button>
          <button type="button" data-act="dup">Duplicate</button>
          <button type="button" data-act="del">Delete</button>
        </div>
      </div>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- */
/* toast                                                             */
/* ---------------------------------------------------------------- */

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------------------------------------------------------------- */
/* download                                                          */
/* ---------------------------------------------------------------- */

function nativeHandlers() {
  return window.webkit && window.webkit.messageHandlers ? window.webkit.messageHandlers : null;
}

function isNativeApp() {
  const handlers = nativeHandlers();
  return !!(handlers && handlers.saveFile);
}

function kindForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'text/csv') return 'csv';
  if (mime.indexOf('spreadsheetml') !== -1) return 'xlsx';
  return 'json';
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveTextFile(filename, text, mime) {
  const handlers = nativeHandlers();
  if (handlers && handlers.saveFile) {
    handlers.saveFile.postMessage({ filename, text, kind: kindForMime(mime) });
    return;
  }
  triggerDownload(new Blob([text], { type: mime }), filename);
}

function saveBase64File(filename, base64, mime) {
  const handlers = nativeHandlers();
  if (handlers && handlers.saveFile) {
    handlers.saveFile.postMessage({ filename, base64, kind: kindForMime(mime) });
    return;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  triggerDownload(new Blob([bytes], { type: mime }), filename);
}

function fileBase() {
  return (state.inv.number || 'invoice').replace(/[^a-z0-9._-]+/gi, '-');
}

function buildCSV(invoice) {
  const quote = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const t = totalsOf(invoice);
  const rows = [];

  rows.push(['Invoice', invoice.number].map(quote).join(','));
  rows.push(['Invoice date', invoice.issueDate].map(quote).join(','));
  rows.push(['Due date', invoice.dueDate].map(quote).join(','));
  rows.push(['Contractor', invoice.contractor.name].map(quote).join(','));
  rows.push(['Business', invoice.contractor.business].map(quote).join(','));
  rows.push(['Email', invoice.contractor.email].map(quote).join(','));
  rows.push(['Currency', invoice.currency].map(quote).join(','));
  rows.push('');
  rows.push(['Date', 'Description', 'Hours / Qty', 'Rate', 'Amount'].map(quote).join(','));

  invoice.items.forEach((item) => {
    rows.push([
      item.date,
      item.description,
      String(num(item.qty)),
      num(item.rate).toFixed(2),
      (lineCents(item) / 100).toFixed(2),
    ].map(quote).join(','));
  });

  rows.push('');
  rows.push(['Subtotal', '', '', '', (t.subtotal / 100).toFixed(2)].map(quote).join(','));
  rows.push(['Total amount due', '', '', '', (t.total / 100).toFixed(2)].map(quote).join(','));
  return rows.join('\r\n');
}

function exportJSON() {
  saveNow();
  saveTextFile(
    `${fileBase()}.json`,
    JSON.stringify({ app: 'contractor-invoice-maker', version: 1, exportedAt: new Date().toISOString(), invoice: state.inv }, null, 2),
    'application/json',
  );
  toast('JSON backup saved.');
}

function exportCSV() {
  saveNow();
  saveTextFile(`${fileBase()}.csv`, '\ufeff' + buildCSV(state.inv), 'text/csv');
  toast('CSV spreadsheet saved.');
}

async function renderInvoiceCanvas(scale) {
  const source = $('#paper');
  const wrap = document.createElement('div');
  wrap.className = 'paper';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.cssText = 'position:fixed;left:-10000px;top:0;margin:0;zoom:1;box-shadow:none;';
  wrap.innerHTML = source.innerHTML;
  document.body.appendChild(wrap);

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const width = 793;
  const height = Math.max(1122, Math.ceil(wrap.getBoundingClientRect().height));
  try {
    return await window.html2canvas(wrap, {
      scale,
      width,
      height,
      windowWidth: 1440,
      windowHeight: 1440,
      backgroundColor: '#ffffff',
      logging: false,
    });
  } finally {
    wrap.remove();
  }
}

async function exportPNG() {
  if (!window.html2canvas) {
    toast('Image export needs the bundled renderer.');
    return;
  }
  saveNow();
  toast('Rendering image…');
  try {
    const canvas = await renderInvoiceCanvas(2);
    saveBase64File(`${fileBase()}.png`, canvas.toDataURL('image/png').split(',')[1], 'image/png');
    toast('PNG image saved.');
  } catch (error) {
    console.error(error);
    toast('Could not render the image.');
  }
}

function exportXLSX() {
  saveNow();
  try {
    const bytes = window.InvoiceXLSX.build(state.inv);
    saveBase64File(
      `${fileBase()}.xlsx`,
      bytesToBase64(bytes),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    toast('Excel workbook saved.');
  } catch (error) {
    console.error(error);
    toast('Could not build the spreadsheet.');
  }
}

function exportPDF() {
  const handlers = nativeHandlers();
  if (handlers && handlers.savePDF) {
    saveNow();
    handlers.savePDF.postMessage({ filename: `${fileBase()}.pdf` });
    return;
  }
  toast('Choose “Save as PDF” in the print dialog.');
  saveNow();
  window.print();
}

/* ---------------------------------------------------------------- */
/* wiring                                                            */
/* ---------------------------------------------------------------- */

function applyAccent() {
  document.documentElement.style.setProperty('--accent', state.settings.accent || '#1f3864');
}

function buildCurrencyOptions() {
  const names = (() => {
    try {
      return new Intl.DisplayNames(['en-GB'], { type: 'currency' });
    } catch {
      return null;
    }
  })();
  $('#f-currency').innerHTML = CURRENCIES.map(
    (code) => `<option value="${code}">${code}${names ? ` — ${names.of(code)}` : ''}</option>`,
  ).join('');
}

function wire() {
  /* generic fields */
  $$('[data-path]').forEach((el) => {
    el.addEventListener('input', onFieldChange);
    el.addEventListener('change', onFieldChange);
  });

  /* line items */
  const itemsEl = $('#items');

  itemsEl.addEventListener('input', (event) => {
    const row = event.target.closest('.item');
    const field = event.target.dataset.field;
    if (!row || !field) return;
    const item = state.inv.items.find((i) => i.id === row.dataset.id);
    if (!item) return;

    item[field] = event.target.value;
    const amount = row.querySelector('.item-amount b');
    if (amount) amount.textContent = item.rate === '' ? '—' : money(lineCents(item));
    refresh();
  });

  itemsEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act="del"]');
    if (!button) return;
    const row = button.closest('.item');
    const index = state.inv.items.findIndex((i) => i.id === row.dataset.id);
    if (index < 0) return;

    if (state.inv.items.length === 1) {
      state.inv.items = [newItem(periodLabel(state.inv.period))];
    } else {
      state.inv.items.splice(index, 1);
    }
    renderItems();
    refresh();
  });

  $('#btnAddItem').addEventListener('click', () => {
    state.inv.items.push(newItem(periodLabel(state.inv.period)));
    renderItems();
    refresh();
    const rows = $$('.item', itemsEl);
    const last = rows[rows.length - 1];
    if (last) last.querySelector('.item-desc').focus();
  });

  $('#btnApplyPeriod').addEventListener('click', () => {
    const label = periodLabel(state.inv.period);
    if (!label) {
      toast('Set a period first.');
      return;
    }
    state.inv.items.forEach((item) => {
      item.date = label;
    });
    renderItems();
    refresh();
    toast(`Period applied to ${state.inv.items.length} line${state.inv.items.length === 1 ? '' : 's'}.`);
  });

  /* due date rule */
  $('#f-duepreset').addEventListener('change', (event) => {
    const preset = event.target.value;
    if (preset === 'custom') return;
    state.inv.dueDate = dueFromPreset(preset, state.inv.issueDate);
    $('#f-due').value = state.inv.dueDate;
    refresh();
  });

  /* accent */
  $('#f-accent').addEventListener('input', (event) => {
    state.settings.accent = event.target.value;
    applyAccent();
    scheduleSave();
  });

  $('#swatches').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-color]');
    if (!button) return;
    state.settings.accent = button.dataset.color;
    $('#f-accent').value = button.dataset.color;
    applyAccent();
    scheduleSave();
  });

  /* top bar */
  $('#btnNew').addEventListener('click', () => {
    createAndOpen();
    toast('New invoice started.');
  });

  $('#btnPrint').addEventListener('click', () => {
    saveNow();
    window.print();
  });

  /* download menu */
  const downloadBtn = $('#btnDownload');
  const downloadMenu = $('#downloadMenu');

  const closeDownloadMenu = () => {
    downloadMenu.hidden = true;
    downloadBtn.setAttribute('aria-expanded', 'false');
  };

  downloadBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = downloadMenu.hidden;
    downloadMenu.hidden = !opening;
    downloadBtn.setAttribute('aria-expanded', String(opening));
    if (opening) downloadMenu.querySelector('button').focus();
  });

  downloadMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-download]');
    if (!item) return;
    closeDownloadMenu();
    const kind = item.dataset.download;
    if (kind === 'pdf') exportPDF();
    else if (kind === 'png') exportPNG();
    else if (kind === 'xlsx') exportXLSX();
    else if (kind === 'csv') exportCSV();
    else if (kind === 'json') exportJSON();
  });

  document.addEventListener('click', (event) => {
    if (!downloadMenu.hidden && !event.target.closest('.download')) closeDownloadMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !downloadMenu.hidden) closeDownloadMenu();
  });

  $('#btnImport').addEventListener('click', () => $('#importFile').click());

  const statementBtn = $('#btnImportStatement');
  if (statementBtn) {
    statementBtn.addEventListener('click', () => {
      const handlers = nativeHandlers();
      if (handlers && handlers.importStatement) handlers.importStatement.postMessage(null);
    });
  }

  $('#importFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const raw = data && data.invoice ? data.invoice : data;
      const inv = normalizeInvoice(raw);
      inv.id = uid();
      inv.number = inv.number || nextNumber();
      state.store.invoices.unshift(inv);
      state.store.currentId = inv.id;
      state.inv = inv;
      fillEditor();
      refresh();
      saveNow();
      toast('Invoice imported.');
    } catch {
      toast('That file is not a valid invoice JSON.');
    }
    event.target.value = '';
  });

  /* library */
  const dialog = $('#libDlg');
  $('#btnLibrary').addEventListener('click', () => {
    renderLibrary();
    dialog.showModal();
  });
  $('#btnCloseLib').addEventListener('click', () => dialog.close());
  $('#btnLibNew').addEventListener('click', () => {
    dialog.close();
    createAndOpen();
  });
  $('#libList').addEventListener('click', (event) => {
    const action = event.target.closest('button[data-act]');
    const row = event.target.closest('.lib-row');
    if (!action || !row) return;
    const id = row.dataset.id;

    if (action.dataset.act === 'open') {
      switchTo(id);
      dialog.close();
    } else if (action.dataset.act === 'dup') {
      duplicateInvoice(id);
      dialog.close();
    } else if (action.dataset.act === 'del') {
      deleteInvoice(id);
    }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  /* keyboard */
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
      toast('Saved.');
    }
  });
}

/* ---------------------------------------------------------------- */
/* field changes                                                     */
/* ---------------------------------------------------------------- */

function onFieldChange(event) {
  const el = event.target;
  const path = el.dataset.path;
  if (!path) return;

  const previousPeriod = periodLabel(state.inv.period);
  setPath(state.inv, path, el.value);

  if (path === 'issueDate') {
    const preset = $('#f-duepreset').value;
    if (preset !== 'custom') {
      state.inv.dueDate = dueFromPreset(preset, el.value);
      $('#f-due').value = state.inv.dueDate;
    }
  }

  if (path === 'dueDate') syncDuePreset();

  if (path === 'currency') renderItems();

  if (path.startsWith('period.')) {
    const nextPeriod = periodLabel(state.inv.period);
    state.inv.items.forEach((item) => {
      if (!item.date || item.date === previousPeriod) item.date = nextPeriod;
    });
    renderItems();
  }

  refresh();
}

/* ---------------------------------------------------------------- */
/* boot                                                              */
/* ---------------------------------------------------------------- */

function boot() {
  if (new URLSearchParams(window.location.search).has('print')) {
    document.body.classList.add('print-mode');
  }
  if (isNativeApp()) document.body.classList.add('native');

  state.store = loadStore();
  state.settings = state.store.settings;

  const wanted = state.store.invoices.find((i) => i.id === state.store.currentId);
  state.inv = wanted || state.store.invoices[0];
  state.store.currentId = state.inv.id;

  applyAccent();
  buildCurrencyOptions();
  wire();
  fillEditor();
  refresh();
  saveNow();
}

boot();
