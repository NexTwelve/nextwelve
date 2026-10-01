// NexTwelve on a phone: pair by QR code, then read forms and reports. Read-only by design: the
// session this page gets can call only read routes, and the server enforces that.
// All text goes through textContent; nothing is injected as HTML.

const $ = (id) => document.getElementById(id);
const SCREENS = ['screen-start', 'screen-wait', 'screen-message', 'screen-list', 'screen-view'];
const state = { token: null, apps: [], appId: null, open: null, labels: 'name' };

function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  say('');
}
function say(text, bad = false) {
  $('status').textContent = text;
  $('status').className = `status${bad ? ' bad' : ''}`;
}
function message(title, text) {
  $('message-title').textContent = title;
  $('message-text').textContent = text;
  show('screen-message');
}

// Per tab: closing the tab forgets the session (the server can also end it at any time).
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* memory only */ } },
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && state.token) ended();
    throw new ApiError(res.status, data);
  }
  return data;
}

function ended() {
  state.token = null;
  store.set('nx.phone', null);
  $('disconnect').hidden = true;
  $('ro-badge').hidden = true;
  message('Access has ended', 'This phone is no longer connected. To look again, choose View on phone on your computer and scan a new code.');
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
async function claim(code) {
  try {
    const r = await api('POST', '/v1/devices/claim', { code });
    store.set('nx.claim', JSON.stringify({ claim: r.claim, match: r.match }));
    $('match').textContent = r.match;
    show('screen-wait');
    poll(r.claim, Date.now() + r.wait_seconds * 1000);
  } catch (err) {
    message('This code cannot be used', `${err.message}.`);
  }
}

async function poll(claimRef, deadline) {
  if (Date.now() > deadline) {
    store.set('nx.claim', null);
    message('Not approved in time', 'Show a new code on your computer and scan it again.');
    return;
  }
  try {
    const r = await api('POST', '/v1/devices/claim/poll', { claim: claimRef });
    if (r.status === 'approved') {
      store.set('nx.claim', null);
      state.token = r.session_token;
      store.set('nx.phone', state.token);
      await viewer();
      return;
    }
  } catch (err) {
    store.set('nx.claim', null);
    const why = err.body?.status === 'denied' ? 'The request was declined on the computer.' : 'The code expired or was already used.';
    message('Not connected', `${why} Show a new code on your computer and scan it again.`);
    return;
  }
  setTimeout(() => poll(claimRef, deadline), 1500);
}

// ---------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------
async function viewer() {
  const me = await api('GET', '/v1/me');
  $('ro-badge').hidden = false;
  $('disconnect').hidden = false;
  $('who').textContent = `Signed in as ${me.display_name ?? me.email}, read-only.`;
  state.apps = (await api('GET', '/v1/apps')).apps;
  if (!state.apps.length) {
    message('Nothing to show', 'You have no applications yet.');
    return;
  }
  const select = $('app-select');
  select.replaceChildren(...state.apps.map((a) => el('option', { value: a.app_id }, a.name)));
  $('app-label').hidden = state.apps.length < 2;
  state.appId = state.apps[0].app_id;
  await listItems();
}

async function listItems() {
  show('screen-list');
  const base = `/v1/apps/${state.appId}`;
  const [forms, reports] = await Promise.all([api('GET', `${base}/forms`), api('GET', `${base}/reports`)]);
  const item = (kind, d) => el('li', {}, el('button', { type: 'button', onclick: () => openItem(kind, d.name, {}) },
    el('span', {}, d.name, d.folder || d.description ? el('small', {}, d.folder ?? d.description) : null)));
  $('report-list').replaceChildren(...reports.reports.map((d) => item('report', d)));
  $('form-list').replaceChildren(...forms.forms.map((d) => item('form', d)));
  $('report-list').hidden = !reports.reports.length;
  $('form-list').hidden = !forms.forms.length;
  $('list-empty').hidden = reports.reports.length + forms.forms.length > 0;
}

async function openItem(kind, name, page) {
  say('Loading…');
  const base = `/v1/apps/${state.appId}`;
  try {
    const path = kind === 'report' ? `${base}/reports/${encodeURIComponent(name)}/run` : `${base}/forms/${encodeURIComponent(name)}/open`;
    const r = await api('POST', path, { page });
    state.open = { kind, name, page: Object.fromEntries(Object.entries(r.page ?? {}).map(([d, p]) => [d, p.selected])) };
    show('screen-view');
    window.scrollTo(0, 0);
    render(kind, name, r);
  } catch (err) {
    say(err.message, true);
  }
}

const label = (m, how) => (how === 'name' || !m.alias ? m.name : how === 'alias' ? m.alias : `${m.name} - ${m.alias}`);

function render(kind, name, r) {
  const grid = kind === 'report' ? r : r.grid;
  const how = kind === 'report' ? r.display?.labels ?? 'name' : 'name';
  const decimals = kind === 'report' ? r.display?.decimals ?? 0 : null;
  const scale = kind === 'report' ? r.display?.scale ?? 1 : 1;
  // Reports come scaled and rounded; forms show whole numbers, or cents when there are any.
  const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const cents = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fixed = new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: decimals ?? 0 });
  const fmt = { format: (v) => (decimals !== null ? fixed.format(v) : Number.isInteger(v) ? whole.format(v) : cents.format(v)) };

  $('view-title').textContent = kind === 'report' ? r.report?.title ?? name : name;
  const notes = [kind === 'report' ? 'Report' : 'Form (read-only on this phone)'];
  if (scale === 1000) notes.push('in thousands');
  if (scale === 1000000) notes.push('in millions');
  $('view-note').textContent = notes.join(', ');

  // Page choices.
  const pages = Object.entries(r.page ?? {});
  $('pages').replaceChildren(...pages.map(([dim, p]) => el('label', {}, dim,
    el('select', { onchange: (e) => openItem(kind, name, { ...state.open.page, [dim]: e.target.value }) },
      p.options.map((o) => el('option', { value: o, selected: o === p.selected }, o))))));
  const pageDims = new Set(pages.map(([d]) => d));
  $('pov').textContent = Object.entries(r.pov ?? grid.pov ?? {}).filter(([d]) => !pageDims.has(d)).map(([d, m]) => `${d}: ${m}`).join(' · ');

  // The table: one header row of column tuples, then one row per row tuple. With several
  // dimensions on rows, the outer members become group headings, so each row is labelled by its
  // innermost member and stays readable on a narrow screen.
  const cols = grid.columns.tuples;
  const rows = grid.rows.tuples;
  const head = el('tr', {}, el('th', { scope: 'col' }, grid.rows.dimensions.at(-1)),
    cols.map((t) => el('th', { scope: 'col' }, t.map((m) => label(m, how)).join(' · '))));
  const body = [];
  let group = null;
  rows.forEach((t, i) => {
    const outer = t.slice(0, -1).map((m) => label(m, how)).join(' · ');
    if (t.length > 1 && outer !== group) {
      group = outer;
      body.push(el('tr', { class: 'group' }, el('th', { scope: 'rowgroup', colspan: cols.length + 1 }, outer)));
    }
    const inner = t.at(-1);
    body.push(el('tr', { class: t.some((m) => !m.leaf) && !inner.leaf ? 'parent' : null },
      el('th', { scope: 'row', title: label(inner, how) }, label(inner, how)),
      cols.map((_, j) => {
        const v = grid.values[i]?.[j];
        return el('td', {}, v === null || v === undefined ? '' : fmt.format(v));
      })));
  });
  $('table').replaceChildren(el('thead', {}, head), el('tbody', {}, body));
  if (!rows.length || !cols.length) say('No data to show.');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('back').addEventListener('click', () => listItems().catch((err) => say(err.message, true)));
$('reload').addEventListener('click', () => state.open && openItem(state.open.kind, state.open.name, state.open.page));
$('app-select').addEventListener('change', (e) => { state.appId = e.target.value; listItems().catch((err) => say(err.message, true)); });
$('disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect this phone? You can connect again with a new code.')) return;
  await api('DELETE', '/v1/devices/current').catch(() => undefined);
  ended();
  message('Disconnected', 'This phone no longer has access. To look again, scan a new code from your computer.');
});

async function init() {
  const code = location.hash.slice(1);
  if (code) {
    // Take the one-time code out of the address bar and history before anything else.
    history.replaceState(null, '', location.pathname);
    await claim(decodeURIComponent(code));
    return;
  }
  state.token = store.get('nx.phone');
  if (state.token) {
    try { await viewer(); } catch (err) { if (err.status !== 401) say(err.message, true); }
    return;
  }
  let pending = null;
  try { pending = JSON.parse(store.get('nx.claim') ?? 'null'); } catch { /* ignore */ }
  if (pending?.claim) {
    show('screen-wait');
    $('match').textContent = pending.match ?? '··';
    poll(pending.claim, Date.now() + 120_000);
    return;
  }
  show('screen-start');
}

init();
