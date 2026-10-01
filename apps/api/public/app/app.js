// NexTwelve browser forms: sign in with Google, open a saved form, edit writable cells, save.
// Plain ES modules, no build step. All text goes through textContent; nothing is injected as HTML.

const $ = (id) => document.getElementById(id);
const state = {
  token: null,
  apps: [],
  appId: null,
  forms: [],
  reports: [],
  formName: null,
  reportName: null,
  report: null,      // the last report run
  opened: null,      // { form, page, grid }
  edits: new Map(),  // "i,j" -> raw text typed by the user
  conflicts: new Map(), // "i,j" -> current value from the server
  selected: null,    // [i, j]
  demo: null,        // { expires_at, persona, personas } for a demo session
};

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatValue = (v) => (v === null || v === undefined ? '' : Number.isInteger(v) ? whole.format(v) : cents.format(v));
const key = (i, j) => `${i},${j}`;
/** Encode one path segment (form, dataset and format names may contain spaces or &). */
const seg = encodeURIComponent;

function store(name, value) {
  try {
    if (value === null) sessionStorage.removeItem(name);
    else sessionStorage.setItem(name, value);
  } catch { /* storage unavailable: keep the session in memory only */ }
}
function recall(name) {
  try { return sessionStorage.getItem(name); } catch { return null; }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
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
  if (res.status === 401 && path !== '/v1/auth/session') {
    if (state.demo) demoEnded();
    else signOut('Your session ended. Sign in again.');
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
async function showSignIn(message = '') {
  $('workspace').hidden = true;
  $('sign-in').hidden = false;
  $('sign-in-error').textContent = message;
  const config = await fetch('/v1/config').then((r) => r.json()).catch(() => ({}));
  if (!config.google_client_id) {
    $('sign-in-error').textContent = 'Google sign-in is not configured (GOOGLE_CLIENT_IDS).';
    return;
  }
  const ready = () => typeof google !== 'undefined' && google.accounts?.id;
  for (let n = 0; !ready() && n < 50; n++) await new Promise((r) => setTimeout(r, 100));
  if (!ready()) {
    $('sign-in-error').textContent = 'Could not load Google sign-in.';
    return;
  }
  google.accounts.id.initialize({ client_id: config.google_client_id, callback: onCredential });
  $('google-button').replaceChildren();
  google.accounts.id.renderButton($('google-button'), { theme: 'outline', size: 'large', text: 'signin_with' });
}

async function onCredential(response) {
  try {
    const session = await api('POST', '/v1/auth/session', { id_token: response.credential });
    state.token = session.session_token;
    store('nx.session', state.token);
    await start();
  } catch (err) {
    $('sign-in-error').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// The public demo: a private copy, people to view it as, start over, leave
// ---------------------------------------------------------------------------
// A demo session is kept in localStorage, so the visitor's copy is still there if they come back
// (until it expires); a real session stays in sessionStorage.
function rememberDemo(token) {
  try {
    if (token) localStorage.setItem('nx.demo', token);
    else localStorage.removeItem('nx.demo');
  } catch { /* storage unavailable */ }
}
function recallDemo() {
  try { return localStorage.getItem('nx.demo'); } catch { return null; }
}

function showDemoBar(demo) {
  state.demo = demo;
  $('demo-bar').hidden = !demo;
  if (!demo) return;
  const hours = Math.max(0, Math.round((new Date(demo.expires_at).getTime() - Date.now()) / 3600e3));
  $('demo-left').textContent = `yours for ${hours} more hour${hours === 1 ? '' : 's'}`;
  $('demo-persona').replaceChildren(...demo.personas.map((p) => el('option', { value: p.key, selected: p.key === demo.persona }, p.label)));
  $('demo-persona-note').textContent = demo.personas.find((p) => p.key === demo.persona)?.description ?? '';
}

async function switchPersona(key) {
  if (dirty() && !confirm('Discard your unsaved changes?')) { $('demo-persona').value = state.demo.persona; return; }
  try {
    const r = await api('POST', '/v1/demo/persona', { persona: key });
    state.token = r.session_token;
    rememberDemo(state.token);
    state.edits.clear();
    await start();
  } catch (err) {
    alert(err.message);
  }
}

async function demoRestart() {
  if (!confirm('Start over with a fresh copy? Your changes in this copy are deleted.')) return;
  try {
    const res = await fetch('/v1/demo/session', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` }, body: '{}' });
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data);
    state.token = data.session_token;
    rememberDemo(state.token);
    state.edits.clear();
    await start();
  } catch (err) {
    alert(err.message);
  }
}

async function demoExit() {
  if (!confirm('Leave the demo? Your copy is deleted.')) return;
  await api('DELETE', '/v1/demo/session').catch(() => undefined);
  rememberDemo(null);
  state.token = null;
  location.href = '/';
}

function demoEnded() {
  rememberDemo(null);
  state.token = null;
  state.demo = null;
  $('demo-bar').hidden = true;
  $('workspace').hidden = true;
  $('sign-in').hidden = false;
  $('sign-in-error').textContent = 'Your demo copy has ended. Start a new one from the home page.';
}

// ---------------------------------------------------------------------------
// View on phone: a QR code for read-only access, approved here with the number the phone shows
// ---------------------------------------------------------------------------
const phone = { linkId: null, status: null, deadline: 0, timer: null };

function phoneSay(text, kind = '') {
  $('phone-status').textContent = text;
  $('phone-status').className = `status ${kind}`;
}

async function phoneOpen() {
  $('phone-dialog').showModal();
  await Promise.all([phoneNewCode(), phoneList()]);
}

async function phoneNewCode() {
  clearTimeout(phone.timer);
  phone.linkId = null;
  $('phone-approve').hidden = true;
  $('phone-new').hidden = true;
  $('phone-qr-box').hidden = false;
  $('phone-qr').removeAttribute('src');
  phoneSay('');
  try {
    const link = await api('POST', '/v1/devices/links', {});
    phone.linkId = link.link_id;
    phone.status = 'pending';
    phone.deadline = Date.now() + link.expires_in * 1000;
    // An image, not markup: the SVG cannot run anything.
    $('phone-qr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(link.qr_svg)}`;
    phoneTick();
  } catch (err) {
    $('phone-qr-box').hidden = true;
    phoneSay(err.message, 'bad');
    $('phone-new').hidden = false;
  }
}

async function phoneTick() {
  clearTimeout(phone.timer);
  if (!$('phone-dialog').open || !phone.linkId) return;
  const left = Math.max(0, Math.ceil((phone.deadline - Date.now()) / 1000));
  try {
    const st = await api('GET', `/v1/devices/links/${phone.linkId}`);
    phone.status = st.status;
    if (st.status === 'pending') {
      $('phone-qr-note').textContent = `The code works once and expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
    } else if (st.status === 'claimed') {
      $('phone-qr-box').hidden = true;
      if ($('phone-approve').hidden) {
        $('phone-device').textContent = st.device_label ?? 'A phone';
        $('phone-approve').hidden = false;
        $('phone-match').value = '';
        $('phone-match').focus();
      }
    } else if (st.status === 'approved' || st.status === 'active') {
      $('phone-approve').hidden = true;
      $('phone-qr-box').hidden = true;
      phoneSay(st.status === 'active' ? 'Connected. The phone has read-only access.' : 'Approved. The phone is connecting…', 'ok');
      $('phone-new').hidden = false;
      if (st.status === 'active') { phone.linkId = null; await phoneList(); return; }
    } else {
      $('phone-approve').hidden = true;
      $('phone-qr-box').hidden = true;
      phoneSay(st.status === 'denied' ? 'Not connected.' : 'The code expired.', 'bad');
      $('phone-new').hidden = false;
      phone.linkId = null;
      return;
    }
  } catch (err) {
    phoneSay(err.message, 'bad');
  }
  phone.timer = setTimeout(phoneTick, 1500);
}

async function phoneApprove(e) {
  e.preventDefault();
  if (!phone.linkId) return;
  try {
    await api('POST', `/v1/devices/links/${phone.linkId}/approve`, { match: $('phone-match').value.trim() });
    $('phone-approve').hidden = true;
    phoneSay('Approved. The phone is connecting…', 'ok');
    phoneTick();
  } catch (err) {
    phoneSay(err.message, 'bad');
    if (err.status === 409) { $('phone-approve').hidden = true; $('phone-new').hidden = false; phone.linkId = null; }
    else $('phone-match').select();
  }
}

async function phoneDeny() {
  if (phone.linkId) await api('POST', `/v1/devices/links/${phone.linkId}/deny`, {}).catch(() => undefined);
  phone.linkId = null;
  $('phone-approve').hidden = true;
  phoneSay('Not connected.');
  $('phone-new').hidden = false;
}

/** Closing the dialog withdraws a code nobody has finished using. */
function phoneClosed() {
  clearTimeout(phone.timer);
  if (phone.linkId && ['pending', 'claimed'].includes(phone.status)) {
    api('POST', `/v1/devices/links/${phone.linkId}/deny`, {}).catch(() => undefined);
  }
  phone.linkId = null;
}

async function phoneList() {
  try {
    const { devices } = await api('GET', '/v1/devices');
    const until = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('phone-list').replaceChildren(...devices.map((d) => el('li', {},
      el('span', {}, d.device_label ?? 'Phone', ' ', el('span', { class: 'muted' }, `until ${until(d.session_expires_at)}`)),
      el('button', { class: 'ghost', type: 'button', onclick: async () => {
        await api('DELETE', `/v1/devices/${d.link_id}`).catch((err) => phoneSay(err.message, 'bad'));
        await phoneList();
      } }, 'Disconnect'))));
    $('phone-list-box').hidden = devices.length === 0;
  } catch { /* the list is a convenience */ }
}

function signOut(message = '') {
  if (state.demo) { demoExit(); return; }
  state.token = null;
  store('nx.session', null);
  $('sign-out').hidden = true;
  $('phone-open').hidden = true;
  $('user-email').textContent = '';
  document.querySelector('.app-picker').hidden = true;
  showSignIn(message);
}

// ---------------------------------------------------------------------------
// Applications and forms
// ---------------------------------------------------------------------------
async function start() {
  const me = await api('GET', '/v1/me');
  $('user-email').textContent = me.demo ? (me.display_name ?? me.email) : me.email;
  showDemoBar(me.demo);
  $('sign-out').hidden = false;
  $('phone-open').hidden = !!me.read_only;
  $('sign-in').hidden = true;
  $('workspace').hidden = false;

  state.apps = (await api('GET', '/v1/apps')).apps;
  const select = $('app-select');
  select.replaceChildren(...state.apps.map((a) => el('option', { value: a.app_id }, a.name)));
  document.querySelector('.app-picker').hidden = state.apps.length === 0;
  if (state.apps.length === 0) {
    $('empty').textContent = 'You have no applications yet. Ask an administrator for a role.';
    return;
  }
  let remembered = null;
  try { remembered = localStorage.getItem('nx.app'); } catch { /* ignore */ }
  state.appId = state.apps.some((a) => a.app_id === remembered) ? remembered : state.apps[0].app_id;
  select.value = state.appId;
  await loadForms();
}

async function loadForms() {
  state.forms = (await api('GET', `/v1/apps/${state.appId}/forms`)).forms;
  const byFolder = new Map();
  for (const f of state.forms) {
    const folder = f.folder ?? 'Forms';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(f);
  }
  const list = $('form-list');
  list.replaceChildren();
  for (const [folder, forms] of byFolder) {
    list.append(el('h3', {}, folder));
    for (const f of forms) {
      list.append(
        el('a', {
          href: '#',
          dataset: { form: f.name },
          onclick: (e) => { e.preventDefault(); openForm(f.name); },
        }, f.name, f.read_only ? el('span', { class: 'lock' }, '(read-only)') : null),
      );
    }
  }
  state.reports = (await api('GET', `/v1/apps/${state.appId}/reports`)).reports;
  const reportFolders = new Map();
  for (const r of state.reports) {
    const folder = r.folder ?? 'Reports';
    if (!reportFolders.has(folder)) reportFolders.set(folder, []);
    reportFolders.get(folder).push(r);
  }
  for (const [folder, reports] of reportFolders) {
    list.append(el('h3', {}, folder));
    for (const r of reports) {
      list.append(el('a', { href: '#', dataset: { report: r.name }, onclick: (e) => { e.preventDefault(); openReport(r.name); } },
        r.name, el('span', { class: 'lock' }, '(report)')));
    }
  }
  const role = state.apps.find((a) => a.app_id === state.appId)?.role;
  if (['power_user', 'app_admin', 'service_admin'].includes(role)) {
    list.append(el('h3', {}, 'Data'));
    list.append(el('a', { href: '#', dataset: { view: 'import' }, onclick: (e) => { e.preventDefault(); showImport(); } }, 'Import a file'));
    list.append(el('a', { href: '#', dataset: { view: 'datasets' }, onclick: (e) => { e.preventDefault(); showDatasets(); } }, 'Datasets'));
    list.append(el('a', { href: '#', dataset: { view: 'defs' }, onclick: (e) => { e.preventDefault(); showDefinitions(); } }, 'Form and report definitions'));
  }
  if (['app_admin', 'service_admin'].includes(role)) {
    list.append(el('h3', {}, 'Administration'));
    list.append(el('a', { href: '#', dataset: { view: 'backups' }, onclick: (e) => { e.preventDefault(); showBackups(); } }, 'Backups and restore'));
  }
  showView('empty');
  $('empty').textContent = state.forms.length ? 'Pick a form on the left.' : 'This application has no forms yet.';
}

function showView(name) {
  for (const id of ['empty', 'form-view', 'report-view', 'import-view', 'datasets-view', 'backups-view', 'defs-view']) $(id).hidden = id !== name;
  for (const a of document.querySelectorAll('#form-list a')) {
    if (a.dataset.view === name.replace('-view', '')) a.setAttribute('aria-current', 'page');
    else if (a.dataset.view) a.removeAttribute('aria-current');
    if (name !== 'form-view' && a.dataset.form) a.removeAttribute('aria-current');
    if (name !== 'report-view' && a.dataset.report) a.removeAttribute('aria-current');
  }
}

// ---------------------------------------------------------------------------
// Imports and datasets (power users and admins)
// ---------------------------------------------------------------------------
async function uploadFile(file, purpose) {
  const res = await fetch(`/v1/apps/${state.appId}/files?name=${encodeURIComponent(file.name)}&purpose=${purpose}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${state.token}`, 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function table(node, headers, rows) {
  node.replaceChildren(
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => (c instanceof Node ? c : el('td', {}, c ?? '')))))),
  );
}

async function showImport() {
  if (dirty() && !confirm('Discard your unsaved changes?')) return;
  showView('import-view');
  for (const a of document.querySelectorAll('#form-list a[data-form]')) a.removeAttribute('aria-current');
  try {
    const formats = (await api('GET', `/v1/apps/${state.appId}/import-formats`)).formats;
    $('imp-format').replaceChildren(...formats.map((f) => el('option', { value: f.name }, `${f.name} (${f.mapping_rules} rules)`)));
    await loadRuns();
  } catch (err) {
    $('imp-status').textContent = err.message;
  }
}

async function loadRuns() {
  const runs = (await api('GET', `/v1/apps/${state.appId}/imports`)).runs;
  table($('imp-runs'), ['When', 'Format', 'Source', 'Mode', 'Status', 'Lines', 'Rejected', 'Cells', 'By'],
    runs.slice(0, 20).map((r) => [new Date(r.created_at).toLocaleString(), r.format, r.file ?? (r.source_dataset ? `dataset ${r.source_dataset.dataset}` : ''),
      r.dry_run ? `${r.mode} (check)` : r.mode, r.status, el('td', { class: 'num' }, r.lines_read),
      el('td', { class: r.lines_rejected ? 'num bad' : 'num' }, r.lines_rejected), el('td', { class: 'num' }, r.cells), r.created_by]));
}

async function runImport(dryRun) {
  const file = $('imp-file').files[0];
  if (!file) { $('imp-status').textContent = 'Choose a file first.'; return; }
  $('imp-status').textContent = dryRun ? 'Checking…' : 'Loading…';
  $('imp-status').className = 'status';
  try {
    const stored = await uploadFile(file, 'import');
    const r = await api('POST', `/v1/apps/${state.appId}/import-formats/${seg($('imp-format').value)}/run`, {
      file_id: stored.file_id, mode: $('imp-mode').value, dry_run: dryRun, load_valid_lines: $('imp-partial').checked,
    });
    $('imp-result').hidden = false;
    $('imp-counts').replaceChildren(...[['Lines', r.lines_read], ['Mapped', r.lines_mapped], ['Skipped', r.lines_skipped], ['Rejected', r.lines_rejected], ['Cells changed', r.cells]]
      .map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
    $('imp-errors-wrap').hidden = r.errors.length === 0;
    table($('imp-errors'), ['Line', 'Problem', 'Source row'],
      r.errors.map((e) => [el('td', { class: 'num' }, e.line), el('td', { class: 'bad' }, e.error), Object.values(e.source).join(' · ')]));
    const label = {
      failed: 'Rejected lines found; nothing was loaded.',
      validated: 'Every line maps. Ready to load.',
      loaded: r.cells ? `Loaded: ${r.cells} cells changed.` : 'Loaded: no cells changed (the data already matches).',
    }[r.status];
    $('imp-status').textContent = label;
    $('imp-status').className = `status ${r.status === 'failed' ? 'bad' : 'ok'}`;
    await loadRuns();
  } catch (err) {
    $('imp-status').textContent = err.message;
    $('imp-status').className = 'status bad';
  }
}

async function showDatasets(select) {
  if (dirty() && !confirm('Discard your unsaved changes?')) return;
  showView('datasets-view');
  for (const a of document.querySelectorAll('#form-list a[data-form]')) a.removeAttribute('aria-current');
  const list = (await api('GET', `/v1/apps/${state.appId}/datasets`)).datasets;
  $('ds-select').replaceChildren(...list.map((d) => el('option', { value: d.name }, `${d.name} (v${d.current_version})`)));
  if (select) $('ds-select').value = select;
  await loadDatasetSheet(true);
}

async function loadDatasetSheet(resetSheets) {
  const name = $('ds-select').value;
  if (!name) { $('ds-rows').replaceChildren(); return; }
  if (resetSheets) {
    const d = await api('GET', `/v1/apps/${state.appId}/datasets/${seg(name)}`);
    $('ds-sheet').replaceChildren(...d.sheets.map((s) => el('option', { value: s.name }, `${s.name} (${s.rows} rows)`)));
    $('ds-name').value = name;
  }
  const res = await api('GET', `/v1/apps/${state.appId}/datasets/${seg(name)}/rows?sheet=${seg($('ds-sheet').value)}&limit=500`);
  table($('ds-rows'), ['Row', ...res.columns], res.rows.map((r) => [el('td', { class: 'num' }, r.row_no), ...res.columns.map((c) => {
    const v = r.data[c];
    return el('td', { class: typeof v === 'number' ? 'num' : null }, typeof v === 'number' ? formatValue(v) : v);
  })]));
  $('ds-status').textContent = `Version ${res.version} · ${res.total} rows${res.total > 500 ? ' (first 500 shown)' : ''}`;
}

async function publishDataset() {
  const file = $('ds-file').files[0];
  const name = $('ds-name').value.trim();
  if (!file || !name) { $('ds-status').textContent = 'Choose a file and a dataset name.'; return; }
  try {
    const stored = await uploadFile(file, 'dataset');
    const r = await api('PUT', `/v1/apps/${state.appId}/datasets/${seg(name)}`, { file_id: stored.file_id });
    await showDatasets(r.name);
    $('ds-status').textContent = `Published ${r.name} version ${r.version}.`;
    $('ds-status').className = 'status ok';
  } catch (err) {
    $('ds-status').textContent = err.message;
    $('ds-status').className = 'status bad';
  }
}

// ---------------------------------------------------------------------------
// Backups and restore (application admins)
// ---------------------------------------------------------------------------
// Each preview request is numbered; an answer that is not the latest, or is for another snapshot
// or application, is ignored, so Restore can only run what the screen last previewed.
const backups = { dims: [], members: {}, snapshot: null, pitPreviewed: null, snapPreviewed: null, pitTxn: null, snapTxn: null, pitSeq: 0, snapSeq: 0 };

const plural = (n, word) => `${whole.format(n)} ${word}${n === 1 ? '' : 's'}`;
const when = (iso) => new Date(iso).toLocaleString();
const size = (bytes) => (bytes == null ? '' : bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const dimOfType = (type) => backups.dims.find((d) => d.type === type);

function say(id, text, kind = '') {
  $(id).textContent = text;
  $(id).className = `status ${kind}`;
}
function counts(node, pairs) {
  node.hidden = false;
  node.replaceChildren(...pairs.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, whole.format(v)))));
}
function fill(node, items) {
  const before = node.value;
  node.replaceChildren(...items.map(([value, label]) => el('option', { value }, label)));
  if (items.some(([v]) => v === before)) node.value = before;
}
async function deployedMembers(dim) {
  if (!backups.members[dim]) {
    backups.members[dim] = (await api('GET', `/v1/apps/${state.appId}/dimensions/${seg(dim)}/members`)).members.filter((m) => m.deployed);
  }
  return backups.members[dim];
}
const leafNames = async (type) => (await deployedMembers(dimOfType(type).name)).filter((m) => m.is_leaf).map((m) => m.name);

async function showBackups() {
  if (dirty() && !confirm('Discard your unsaved changes?')) return;
  showView('backups-view');
  for (const a of document.querySelectorAll('#form-list a[data-form]')) a.removeAttribute('aria-current');
  backups.members = {};
  $('snap-restore').hidden = true;
  try {
    const d = await api('GET', `/v1/apps/${state.appId}/dimensions`);
    backups.dims = d.dimensions;
    fill($('pit-cube'), d.cubes.map((c) => [c.name, c.name]));
    await fillPitChoices();
    if (!$('pit-at').value) {
      const anHourAgo = new Date(Date.now() - 3600e3 - new Date().getTimezoneOffset() * 60e3);
      $('pit-at').value = anHourAgo.toISOString().slice(0, 19);
    }
    await loadChanges();
    pitChanged();
    await loadSnapshots();
    await loadMetaChoices(backups.snapshots);
  } catch (err) {
    say('pit-status', err.message, 'bad');
  }
}

async function fillPitChoices() {
  fill($('pit-scenario'), (await leafNames('scenario')).map((n) => [n, n]));
  const versions = await leafNames('version');
  fill($('pit-version'), versions.map((n) => [n, n]));
  fill($('pit-target'), [['', 'the same version'], ...versions.map((n) => [n, n]), ['__new', 'a new version…']]);
  const entity = dimOfType('entity');
  $('pit-filter-label').textContent = `Only for ${entity.name}`;
  fill($('pit-filter'), [['', 'all'], ...(await deployedMembers(entity.name)).map((m) => [m.name, m.name])]);
}

async function loadChanges() {
  const txns = (await api('GET', `/v1/apps/${state.appId}/txns?limit=200`)).txns;
  fill($('pit-txn'), txns.map((t) => [String(t.txn_id),
    `#${t.txn_id} · ${when(t.created_at)} · ${t.user ?? 'system'} · ${t.source.replace('_', ' ')} · ${plural(t.cell_count, 'cell')}`]));
}

function pitChanged() {
  backups.pitSeq++;
  backups.pitPreviewed = null;
  $('pit-at-wrap').hidden = $('pit-mode').value !== 'at';
  $('pit-txn-wrap').hidden = $('pit-mode').value !== 'before';
  $('pit-new-wrap').hidden = $('pit-target').value !== '__new';
  $('pit-run').disabled = true;
  say('pit-status', 'Preview to see what would change.');
}

function pitBody(dryRun) {
  const body = { cube: $('pit-cube').value, scenario: $('pit-scenario').value, version: $('pit-version').value, dry_run: dryRun };
  if ($('pit-filter').value) body.filters = { [dimOfType('entity').name]: [$('pit-filter').value] };
  if ($('pit-mode').value === 'at') {
    if (!$('pit-at').value) throw new Error('Choose a date and time.');
    body.at = new Date($('pit-at').value).toISOString();
  } else {
    if (!$('pit-txn').value) throw new Error('There are no changes to go back before.');
    body.before_txn = Number($('pit-txn').value);
  }
  const target = $('pit-target').value;
  if (target === '__new') {
    const name = $('pit-new').value.trim();
    if (!name) throw new Error('Name the new version.');
    body.into_version = name;
    body.create_version = true;
  } else if (target) {
    body.into_version = target;
  }
  return body;
}

function showPitResult(r) {
  counts($('pit-counts'), [['Cells to set', r.cells_set], ['Cells to clear', r.cells_cleared], ['Skipped', r.skipped]]);
  $('pit-skipped-wrap').hidden = r.skipped_sample.length === 0;
  if (r.skipped_sample.length) {
    const dims = Object.keys(r.skipped_sample[0]);
    table($('pit-skipped'), dims, r.skipped_sample.map((c) => dims.map((d) => c[d])));
  }
}

async function pitPreview() {
  const seq = ++backups.pitSeq;
  const appId = state.appId;
  try {
    const body = pitBody(true);
    say('pit-status', 'Checking…');
    $('pit-undo').hidden = true;
    $('pit-run').disabled = true;
    const r = await api('POST', `/v1/apps/${appId}/restore`, body);
    if (seq !== backups.pitSeq || appId !== state.appId) return;
    showPitResult(r);
    const total = r.cells_set + r.cells_cleared;
    if (total > r.max_cells) {
      say('pit-status', `${plural(total, 'cell')} would change; restore at most ${whole.format(r.max_cells)} at a time by narrowing the slice.`, 'bad');
      return;
    }
    backups.pitPreviewed = JSON.stringify({ app: appId, ...body, dry_run: false });
    $('pit-run').disabled = total === 0;
    const point = r.as_of.txn_id ? `after change #${r.as_of.txn_id} (${when(r.as_of.at)})` : 'before the first change';
    say('pit-status', total ? `As it was ${point}: ${plural(total, 'cell')} would change in ${r.target_version}.` : `Nothing would change: ${r.target_version} already matches.`, total ? '' : 'ok');
  } catch (err) {
    if (seq === backups.pitSeq) say('pit-status', err.message, 'bad');
  }
}

async function pitRun() {
  let body;
  try { body = pitBody(false); } catch (err) { say('pit-status', err.message, 'bad'); return; }
  if (JSON.stringify({ app: state.appId, ...body }) !== backups.pitPreviewed) { pitChanged(); return; }
  const where = body.into_version ? ` into ${body.into_version}` : '';
  if (!confirm(`Restore ${body.scenario} / ${body.version}${where}? You can undo it afterwards.`)) return;
  $('pit-run').disabled = true;
  say('pit-status', 'Restoring…');
  try {
    const r = await api('POST', `/v1/apps/${state.appId}/restore`, body);
    showPitResult(r);
    backups.pitTxn = r.txn_id;
    $('pit-undo').hidden = !r.txn_id;
    say('pit-status', r.txn_id
      ? `Restored ${plural(r.cell_count, 'cell')} as change #${r.txn_id}${r.version_created ? `, in the new version ${r.target_version}` : ''}.`
      : 'Nothing changed.', 'ok');
    if (r.version_created) {
      backups.members = {};
      await fillPitChoices();
      $('pit-target').value = r.target_version;
      $('pit-new-wrap').hidden = true;
    }
    await loadChanges();
  } catch (err) {
    say('pit-status', err.message, 'bad');
  }
}

async function undoRestore(txnId, statusId, buttonId) {
  if (!confirm(`Undo change #${txnId}?`)) return;
  const run = (force) => api('POST', `/v1/apps/${state.appId}/txns/${txnId}/undo`, { force });
  try {
    let r;
    try {
      r = await run(false);
    } catch (err) {
      if (err.status !== 409 || !confirm('Some of these cells changed again after the restore. Undo anyway and overwrite those changes?')) throw err;
      r = await run(true);
    }
    $(buttonId).hidden = true;
    say(statusId, `Undone as change #${r.txn_id} (${plural(r.cell_count, 'cell')}).`, 'ok');
    await loadChanges();
  } catch (err) {
    say(statusId, err.message, 'bad');
  }
}

async function loadSnapshots() {
  const list = (await api('GET', `/v1/apps/${state.appId}/snapshots`)).snapshots;
  backups.snapshots = list;
  const covers = (s) => [s.scope.scenarios?.join(', '), s.scope.versions?.join(', ')].filter(Boolean).join(' · ') || 'everything';
  table($('snap-list'), ['Taken', 'Kind', 'Covers', 'Cells', 'Size', 'Status', 'By', 'Note', ''], list.map((s) => [
    when(s.created_at),
    s.kind.replace('_', '-'),
    covers(s),
    el('td', { class: 'num' }, s.fact_count === null ? '' : whole.format(s.fact_count)),
    el('td', { class: 'num' }, size(s.byte_size)),
    el('td', { class: s.status === 'failed' ? 'bad' : null, title: s.error ?? null }, s.status),
    s.created_by ?? 'scheduled',
    s.comment ?? '',
    el('td', { class: 'actions' }, s.status === 'complete'
      ? [el('button', { onclick: () => openSnapRestore(s) }, 'Restore…'), el('button', { class: 'ghost', onclick: () => downloadManifest(s) }, 'Manifest')]
      : null),
  ]));
  if (list.length === 0) $('snap-list').querySelector('tbody').append(el('tr', {}, el('td', { colspan: '9', class: 'muted' }, 'No snapshots yet.')));
}

async function takeSnapshot() {
  $('snap-take').disabled = true;
  say('snap-status', 'Taking a snapshot…');
  try {
    const s = await api('POST', `/v1/apps/${state.appId}/snapshots`, { comment: $('snap-comment').value.trim() || undefined });
    $('snap-comment').value = '';
    say('snap-status', `Snapshot taken: ${plural(s.fact_count, 'cell')}, ${size(s.byte_size)}.`, 'ok');
    await loadSnapshots();
  } catch (err) {
    say('snap-status', err.message, 'bad');
  } finally {
    $('snap-take').disabled = false;
  }
}

async function openSnapRestore(s) {
  backups.snapshot = s;
  backups.snapSeq++;
  backups.snapPreviewed = null;
  $('snap-restore').hidden = false;
  $('snap-restore-title').textContent = `Restore the snapshot of ${when(s.created_at)}`;
  const versions = await leafNames('version');
  const inSnapshot = s.scope.versions ?? versions;
  fill($('snap-versions'), [['', s.scope.versions ? `all in the snapshot (${s.scope.versions.join(', ')})` : 'all versions'], ...inSnapshot.map((v) => [v, v])]);
  fill($('snap-into'), [['', 'the same version'], ...versions.map((v) => [v, v])]);
  $('snap-versions').value = '';
  $('snap-into').value = '';
  $('snap-target').value = 'in_place';
  $('snap-name').value = '';
  $('snap-access').checked = false;
  snapChanged();
  $('snap-restore').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function snapChanged() {
  backups.snapSeq++;
  backups.snapPreviewed = null;
  const inPlace = $('snap-target').value === 'in_place';
  for (const n of document.querySelectorAll('#snap-restore .in-place')) n.hidden = !inPlace;
  for (const n of document.querySelectorAll('#snap-restore .new-app')) n.hidden = inPlace;
  $('snap-into').disabled = !$('snap-versions').value;
  if (!$('snap-versions').value) $('snap-into').value = '';
  $('snap-preview').hidden = !inPlace;
  $('snap-run').disabled = inPlace;
  $('snap-run').textContent = inPlace ? 'Restore' : 'Create application';
  $('snap-counts').hidden = true;
  $('snap-skipped').hidden = true;
  $('snap-undo').hidden = true;
  say('snap-restore-status', inPlace ? 'Preview to see what would change.' : 'Copies the snapshot into a new application next to this one.');
}

function snapBody(dryRun) {
  if ($('snap-target').value === 'new_app') {
    return { target: 'new_app', name: $('snap-name').value.trim() || undefined, access: $('snap-access').checked ? 'copy' : 'none' };
  }
  const body = { target: 'in_place', dry_run: dryRun };
  if ($('snap-versions').value) body.versions = [$('snap-versions').value];
  if ($('snap-into').value && $('snap-into').value !== $('snap-versions').value) body.into_version = $('snap-into').value;
  return body;
}

function showSnapResult(r) {
  counts($('snap-counts'), [['Cells to set', r.cells_set], ['Cells to clear', r.cells_cleared], ['Unchanged', r.unchanged], ['Skipped', r.skipped]]);
  $('snap-skipped').hidden = !r.skipped_reasons?.length;
  $('snap-skipped').textContent = (r.skipped_reasons ?? []).map((x) => `Skipped ${plural(x.count, 'cell')}: ${x.reason}.`).join(' ');
}

async function snapPreview() {
  const seq = ++backups.snapSeq;
  const appId = state.appId;
  const snapshotId = backups.snapshot.snapshot_id;
  try {
    const body = snapBody(true);
    say('snap-restore-status', 'Checking…');
    $('snap-run').disabled = true;
    const r = await api('POST', `/v1/apps/${appId}/snapshots/${snapshotId}/restore`, body);
    if (seq !== backups.snapSeq || appId !== state.appId || snapshotId !== backups.snapshot?.snapshot_id) return;
    showSnapResult(r);
    const total = r.cells_set + r.cells_cleared;
    if (total > r.max_cells) {
      say('snap-restore-status', `${plural(total, 'cell')} would change; restore at most ${whole.format(r.max_cells)} at a time by choosing a version, or restore into a new application.`, 'bad');
      return;
    }
    backups.snapPreviewed = JSON.stringify({ app: appId, snapshot: snapshotId, ...body, dry_run: false });
    $('snap-run').disabled = total === 0;
    say('snap-restore-status', total ? `${plural(total, 'cell')} would change.` : 'Nothing would change: the data already matches the snapshot.', total ? '' : 'ok');
  } catch (err) {
    if (seq === backups.snapSeq) say('snap-restore-status', err.message, 'bad');
  }
}

async function snapRun() {
  const body = snapBody(false);
  const newApp = body.target === 'new_app';
  const snap = backups.snapshot;
  if (!newApp && JSON.stringify({ app: state.appId, snapshot: snap.snapshot_id, ...body }) !== backups.snapPreviewed) { snapChanged(); return; }
  const taken = when(snap.created_at);
  if (!confirm(newApp
    ? `Create a new application from the snapshot of ${taken}?${body.access === 'copy' ? ' Its roles and member access will be granted again, including any removed since.' : ''}`
    : `Restore the snapshot of ${taken} over this application? A pre-restore snapshot is taken first, and you can undo the restore.`)) return;
  $('snap-run').disabled = true;
  say('snap-restore-status', newApp ? 'Creating the application…' : 'Restoring…');
  try {
    const r = await api('POST', `/v1/apps/${state.appId}/snapshots/${snap.snapshot_id}/restore`, body);
    if (newApp) {
      const missing = [...r.missing_users, ...r.missing_groups];
      const granted = r.roles_granted.length ? ` Granted: ${r.roles_granted.map((g) => `${g.email} (${g.role.replace('_', ' ')})`).join(', ')}.` : '';
      state.apps = (await api('GET', '/v1/apps')).apps;
      $('app-select').replaceChildren(...state.apps.map((a) => el('option', { value: a.app_id }, a.name)));
      $('app-select').value = state.appId;
      say('snap-restore-status', `Created ${r.name} with ${plural(r.cells, 'cell')}. Switch to it in the application list.${granted}${missing.length ? ` Not found, so not granted: ${missing.join(', ')}.` : ''}`, 'ok');
    } else {
      showSnapResult(r);
      backups.snapTxn = r.txn_id;
      $('snap-undo').hidden = !r.txn_id;
      say('snap-restore-status', r.txn_id ? `Restored ${plural(r.cell_count, 'cell')} as change #${r.txn_id}, after a pre-restore snapshot.` : 'Nothing changed.', 'ok');
      await loadSnapshots();
      await loadChanges();
    }
  } catch (err) {
    say('snap-restore-status', err.message, 'bad');
    $('snap-run').disabled = false;
  }
}

async function downloadManifest(s) {
  const res = await fetch(`/v1/apps/${state.appId}/snapshots/${s.snapshot_id}/files/manifest.json`, { headers: { authorization: `Bearer ${state.token}` } });
  if (!res.ok) { say('snap-status', (await res.json()).message, 'bad'); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: `${s.app_name}-${s.snapshot_id.slice(0, 8)}-manifest.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Downloads (the API needs the bearer token, so fetch, then hand the browser a blob)
// ---------------------------------------------------------------------------
function fileNameFrom(res, fallback) {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  return /filename="([^"]+)"/i.exec(cd)?.[1] ?? fallback;
}
async function download(method, path, body, fallback) {
  const headers = { authorization: `Bearer ${state.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: fileNameFrom(res, fallback) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Reports (read-only; anyone with a role)
// ---------------------------------------------------------------------------
let reportSeq = 0;
async function openReport(name, page = {}) {
  if (dirty() && !confirm('Discard your unsaved changes?')) return;
  const seq = ++reportSeq;
  say('report-status', 'Running…');
  try {
    const r = await api('POST', `/v1/apps/${state.appId}/reports/${seg(name)}/run`, { page });
    if (seq !== reportSeq) return;
    state.reportName = name;
    state.report = r;
    state.opened = null;
    state.edits.clear();
    state.conflicts.clear();
    showView('report-view');
    for (const a of document.querySelectorAll('#form-list a[data-report]')) {
      if (a.dataset.report === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    renderReport();
    say('report-status', '');
  } catch (err) {
    if (seq === reportSeq) {
      showView('report-view');
      say('report-status', err.message, 'bad');
    }
  }
}

const reportPage = () => Object.fromEntries(Object.entries(state.report?.page ?? {}).map(([d, p]) => [d, p.selected]));

function renderReport() {
  const r = state.report;
  $('report-title').textContent = r.report.title;
  $('report-desc').textContent = r.report.description ?? '';
  const bar = $('report-page');
  bar.replaceChildren();
  for (const [dim, p] of Object.entries(r.page)) {
    const select = el('select', { onchange: (e) => openReport(state.reportName, { ...reportPage(), [dim]: e.target.value }) },
      p.options.map((o) => el('option', { value: o, selected: o === p.selected }, o)));
    bar.append(el('label', {}, dim, select));
  }
  for (const [dim, member] of Object.entries(r.pov)) {
    if (r.page[dim]) continue;
    bar.append(el('label', {}, dim, el('span', { class: 'fixed' }, member)));
  }
  const scale = { 1000: 'In thousands. ', 1000000: 'In millions. ' }[r.display.scale] ?? '';
  const hidden = [r.suppressed.rows ? plural(r.suppressed.rows, 'empty row') : null, r.suppressed.columns ? plural(r.suppressed.columns, 'empty column') : null].filter(Boolean);
  $('report-note').textContent = `${scale}${hidden.length ? `${hidden.join(' and ')} hidden.` : ''}`;
  const fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: r.display.decimals, maximumFractionDigits: r.display.decimals });
  const label = (m) => (r.display.labels === 'alias' ? (m.alias ?? m.name) : r.display.labels === 'both' && m.alias ? `${m.name} - ${m.alias}` : m.name);
  const rows = r.rows.tuples;
  const cols = r.columns.tuples;
  const view = (list) => list.map((t) => t.map((m) => ({ ...m, alias: label(m) })));
  const rowsV = view(rows);
  const colsV = view(cols);
  const head = headerRows(r.rows.dimensions, r.columns.dimensions, colsV, r.rows.dimensions[r.rows.dimensions.length - 1]);
  const body = rowsV.map((t, i) => el('tr', { class: t.every((m) => m.leaf) ? null : 'parent' }, rowHeaders(rowsV, i),
    r.values[i].map((v, j) => el('td', { class: ['locked', colsV[j].some((m) => !m.leaf) ? 'parent-col' : null].filter(Boolean).join(' ') },
      el('span', { class: 'v' }, v === null ? '' : fmt.format(v))))));
  if (!rows.length) body.push(el('tr', {}, el('td', { class: 'muted', colspan: String(r.rows.dimensions.length + Math.max(cols.length, 1)) }, 'No data for this selection.')));
  $('report-grid').replaceChildren(el('thead', {}, head), el('tbody', {}, body));
}

async function reportDownload(format) {
  if (!state.reportName) return;
  say('report-status', 'Preparing the file…');
  try {
    await download('POST', `/v1/apps/${state.appId}/reports/${seg(state.reportName)}/run?format=${format}`, { page: reportPage() }, `${state.reportName}.${format}`);
    say('report-status', '');
  } catch (err) {
    say('report-status', err.message, 'bad');
  }
}

// ---------------------------------------------------------------------------
// Form and report definitions: export, import, version history (power users and admins)
// ---------------------------------------------------------------------------
const defs = { checked: null, seq: 0 };

async function showDefinitions() {
  if (dirty() && !confirm('Discard your unsaved changes?')) return;
  showView('defs-view');
  defsChanged();
  const options = [...state.forms.map((f) => [`forms\u0000${f.name}`, `Form: ${f.name}`]), ...state.reports.map((r) => [`reports\u0000${r.name}`, `Report: ${r.name}`])];
  fill($('defs-hist-name'), [['', 'choose…'], ...options]);
  $('defs-hist').replaceChildren();
}

function defsChanged() {
  defs.seq++;
  defs.checked = null;
  $('defs-import').disabled = true;
  $('defs-result').hidden = true;
  say('defs-status', $('defs-file').files.length ? 'Check the file to see what it would change.' : '');
}

async function sendDefinitions(dryRun) {
  const files = [...$('defs-file').files];
  if (!files.length) throw new Error('Choose a workbook, a zip, or the CSV files first.');
  const form = new FormData();
  files.forEach((f, n) => form.append(`file${n}`, f, f.name));
  const res = await fetch(`/v1/apps/${state.appId}/definitions/import${dryRun ? '?dry_run=true' : ''}`, {
    method: 'POST', headers: { authorization: `Bearer ${state.token}` }, body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(res.status === 422 && data.details?.errors)) throw new ApiError(res.status, data);
  return res.ok ? data : data.details;
}

function showDefsResult(r) {
  $('defs-result').hidden = false;
  counts($('defs-counts'), [['New', r.created.length], ['Changed', r.updated.length], ['Unchanged', r.unchanged.length], ['Deleted', r.deleted.length], ['Problems', r.errors.length]]);
  const type = (t) => (t === 'form' ? 'Form' : 'Report');
  const changes = [
    ...r.created.map((x) => [type(x.type), x.name, 'new']),
    ...r.updated.map((x) => [type(x.type), x.name, `changed (becomes version ${x.version})`]),
    ...r.deleted.map((x) => [type(x.type), x.name, 'deleted']),
  ];
  $('defs-changes-wrap').hidden = changes.length === 0;
  table($('defs-changes'), ['Type', 'Name', 'What happens'], changes);
  $('defs-errors-wrap').hidden = r.errors.length === 0;
  table($('defs-errors'), ['Sheet', 'Row', 'Column', 'Problem'],
    r.errors.map((e) => [e.sheet, el('td', { class: 'num' }, e.row ?? ''), e.column ?? '', el('td', { class: 'bad' }, e.definition && !e.message.includes(e.definition) ? `${e.definition}: ${e.message}` : e.message)]));
}

async function defsCheck() {
  const seq = ++defs.seq;
  const appId = state.appId;
  say('defs-status', 'Checking…');
  $('defs-import').disabled = true;
  try {
    const r = await sendDefinitions(true);
    if (seq !== defs.seq || appId !== state.appId) return;
    showDefsResult(r);
    const total = r.created.length + r.updated.length + r.deleted.length;
    if (r.errors.length) { say('defs-status', `${plural(r.errors.length, 'problem')} to fix; nothing would be imported.`, 'bad'); return; }
    defs.checked = { appId, files: [...$('defs-file').files].map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|') };
    $('defs-import').disabled = total === 0;
    say('defs-status', total ? `${plural(total, 'definition')} would change.` : 'Nothing would change: the file matches what is saved.', total ? '' : 'ok');
  } catch (err) {
    if (seq === defs.seq) say('defs-status', err.message, 'bad');
  }
}

async function defsImport() {
  const files = [...$('defs-file').files].map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|');
  if (!defs.checked || defs.checked.appId !== state.appId || defs.checked.files !== files) { defsChanged(); return; }
  if (!confirm('Import these definitions? Every changed form and report keeps its earlier versions in its history.')) return;
  $('defs-import').disabled = true;
  say('defs-status', 'Importing…');
  try {
    const r = await sendDefinitions(false);
    showDefsResult(r);
    if (r.errors.length) { say('defs-status', 'The file changed meanwhile and now has problems; nothing was imported.', 'bad'); return; }
    say('defs-status', `Imported: ${plural(r.created.length, 'new definition')}, ${plural(r.updated.length, 'changed definition')}, ${plural(r.deleted.length, 'deletion')}.`, 'ok');
    defs.checked = null;
    const view = 'defs-view';
    await loadForms();
    showView(view);
  } catch (err) {
    say('defs-status', err.message, 'bad');
  }
}

async function defsExport(format) {
  say('defs-export-status', 'Preparing the file…');
  try {
    await download('GET', `/v1/apps/${state.appId}/definitions/export?format=${format}`, undefined, `definitions.${format === 'csv' ? 'zip' : 'xlsx'}`);
    say('defs-export-status', '');
  } catch (err) {
    say('defs-export-status', err.message, 'bad');
  }
}

function historyTarget() {
  const other = $('defs-hist-other').value.trim();
  if (other) return [$('defs-hist-type').value, other];
  const v = $('defs-hist-name').value;
  if (!v) return null;
  return v.split('\u0000');
}

async function defsHistory() {
  const target = historyTarget();
  if (!target) { say('defs-hist-status', 'Choose a definition or type a name.', 'bad'); return; }
  const [kind, name] = target;
  say('defs-hist-status', 'Loading…');
  try {
    const { history } = await api('GET', `/v1/apps/${state.appId}/${kind}/${seg(name)}/history`);
    table($('defs-hist'), ['Version', 'Saved', 'By', 'Cube', 'Layout', ''], history.map((v) => [
      el('td', { class: 'num' }, v.version),
      when(v.changed_at),
      v.changed_by ?? '',
      v.cube ?? '',
      v.deleted ? el('td', { class: 'muted' }, 'deleted') : layoutSummary(v.definition),
      el('td', { class: 'actions' }, v.current ? el('span', { class: 'muted' }, 'current')
        : v.deleted ? null : el('button', { onclick: () => defsRestoreVersion(kind, name, v) }, 'Make current')),
    ]));
    say('defs-hist-status', '');
  } catch (err) {
    $('defs-hist').replaceChildren();
    say('defs-hist-status', err.message, 'bad');
  }
}

function layoutSummary(def) {
  const axis = (a) => (Array.isArray(a) ? a : a ? [a] : []).map((s) => s.dimension).join(' × ');
  return `Rows: ${axis(def.rows)} · Columns: ${axis(def.columns)}`;
}

async function defsRestoreVersion(kind, name, v) {
  if (!confirm(`Make version ${v.version} of ${name} current again? It is saved as a new version; nothing is lost.`)) return;
  try {
    const r = await api('POST', `/v1/apps/${state.appId}/${kind}/${seg(name)}/history/restore`, { artifact_id: v.artifact_id, version: v.version });
    say('defs-hist-status', `${r.name} is now version ${r.version}.`, 'ok');
    await loadForms();
    showView('defs-view');
    await defsHistory();
  } catch (err) {
    say('defs-hist-status', err.message, 'bad');
  }
}

// ---------------------------------------------------------------------------
// Metadata restore (application admins), on the Backups screen
// ---------------------------------------------------------------------------
const meta = { previewed: null, seq: 0 };

async function loadMetaChoices(snapshots) {
  try {
    const h = await api('GET', `/v1/apps/${state.appId}/metadata/history`);
    $('meta-history').textContent = `Point-in-time metadata history starts ${when(h.history_from)}.`;
    fill($('meta-deploy'), [['', 'choose a deploy…'], ...h.deploys.map((d) => [d.deployed_at, `deploy #${d.metadata_rev} · ${when(d.deployed_at)} · ${d.deployed_by ?? 'system'}`])]);
  } catch (err) {
    $('meta-history').textContent = err.message;
  }
  fill($('meta-snap'), snapshots.filter((s) => s.status === 'complete').map((s) => [s.snapshot_id, `${when(s.created_at)} · ${s.kind.replace('_', '-')}${s.comment ? ` · ${s.comment}` : ''}`]));
  fill($('meta-dims'), [['', 'all dimensions'], ...backups.dims.map((d) => [d.name, d.name])]);
  if (!$('meta-at').value) $('meta-at').value = $('pit-at').value;
  metaChanged();
}

function metaChanged() {
  meta.seq++;
  meta.previewed = null;
  const fromSnap = $('meta-source').value === 'snapshot';
  $('meta-at-wrap').hidden = fromSnap;
  $('meta-deploy-wrap').hidden = fromSnap;
  $('meta-snap-wrap').hidden = !fromSnap;
  $('meta-remove-new').disabled = !$('meta-defs').checked;
  $('meta-dims').disabled = !$('meta-members').checked;
  $('meta-run').disabled = true;
  $('meta-result').hidden = true;
  say('meta-status', 'Preview to see what would change.');
}

function metaBody(dryRun) {
  const body = {
    members: $('meta-members').checked,
    definitions: $('meta-defs').checked,
    remove_new_definitions: $('meta-defs').checked && $('meta-remove-new').checked,
    data: $('meta-data').checked,
    dry_run: dryRun,
  };
  if (!body.members && !body.definitions && !body.data) throw new Error('Choose members, forms and reports, or data.');
  if ($('meta-dims').value && body.members) body.dimensions = [$('meta-dims').value];
  if ($('meta-source').value === 'snapshot') {
    if (!$('meta-snap').value) throw new Error('There is no complete snapshot to restore from.');
    body.snapshot_id = $('meta-snap').value;
  } else if ($('meta-deploy').value) {
    // Just before the chosen deploy: one microsecond earlier.
    const t = $('meta-deploy').value;
    const us = Number(t.slice(20, 26));
    const base = new Date(`${t.slice(0, 19)}Z`).getTime();
    const before = us > 0 ? `${t.slice(0, 20)}${String(us - 1).padStart(6, '0')}Z` : `${new Date(base - 1000).toISOString().slice(0, 19)}.999999Z`;
    body.at = before;
  } else {
    if (!$('meta-at').value) throw new Error('Choose a date and time.');
    body.at = new Date($('meta-at').value).toISOString();
  }
  return body;
}

function showMetaResult(r) {
  const out = $('meta-result');
  out.hidden = false;
  out.replaceChildren();
  const list = (title, items) => (items.length ? el('div', {}, el('h3', {}, title), el('ul', {}, items.map((x) => el('li', {}, x)))) : null);
  if (r.members) {
    const unchanged = [];
    for (const d of r.members.dimensions) {
      const items = [
        ...d.recreated.map((n) => `${n} comes back`),
        ...d.changed.map((c) => `${c.name}${c.was ? ` (now ${c.was})` : ''}: ${c.fields.join(', ').replaceAll('_', ' ')} restored`),
        ...d.removed.map((n) => `${n} is removed`),
        ...d.kept.map((k) => `${k.name} stays (added since; ${k.cells ? plural(k.cells, 'cell') : 'used by a plan window'})`),
        ...d.conflicts,
      ];
      if (d.pending_discarded) items.push(`${plural(d.pending_discarded, 'saved change')} not yet deployed will be undone`);
      if (d.note) items.push(d.note);
      if (items.length) out.append(list(d.dimension, items));
      else unchanged.push(d.dimension);
    }
    if (unchanged.length) out.append(el('p', { class: 'muted' }, `No member changes in ${unchanged.join(', ')}.`));
    for (const n of r.members.notes) out.append(el('p', { class: 'muted' }, n));
  }
  if (r.definitions) {
    const t = (x) => `${x.type === 'form' ? 'Form' : 'Report'} ${x.name}`;
    const items = [
      ...r.definitions.created.map((x) => `${t(x)} comes back`),
      ...r.definitions.updated.map((x) => `${t(x)} goes back to its earlier version`),
      ...r.definitions.removed.map((x) => `${t(x)} is removed (created since)`),
      ...r.definitions.kept_new.map((x) => `${t(x)} stays (created since)`),
      ...r.definitions.invalid.map((x) => `${x.type === 'form' ? 'Form' : 'Report'} ${x.name}: ${x.message}`),
      ...r.definitions.notes,
    ];
    out.append(list('Forms and reports', items.length ? items : ['no change']) ?? '');
  }
  if (r.data) {
    out.append(list('Data', [
      `${plural(r.data.cells_set, 'cell')} set, ${plural(r.data.cells_cleared, 'cell')} cleared`,
      r.data.parents_cleared ? `${plural(r.data.parents_cleared, 'cell')} cleared on members that become parents again` : null,
      r.data.kept ? `${plural(r.data.kept, 'cell')} on members added since stay as they are` : null,
      r.data.skipped ? `${plural(r.data.skipped, 'cell')} skipped` : null,
    ].filter(Boolean)) ?? '');
  }
}

async function metaPreview() {
  const seq = ++meta.seq;
  const appId = state.appId;
  try {
    const body = metaBody(true);
    say('meta-status', 'Checking…');
    $('meta-run').disabled = true;
    const r = await api('POST', `/v1/apps/${appId}/metadata/restore`, body);
    if (seq !== meta.seq || appId !== state.appId) return;
    showMetaResult(r);
    if (r.data?.over_limit) {
      say('meta-status', `The data part would change more than ${whole.format(r.data.max_cells)} cells; restore metadata alone, then the data a slice at a time.`, 'bad');
      return;
    }
    meta.previewed = JSON.stringify({ app: appId, ...body, dry_run: false });
    $('meta-run').disabled = r.changes === 0;
    say('meta-status', r.changes ? 'Review the changes, then restore.' : 'Nothing would change.', r.changes ? '' : 'ok');
  } catch (err) {
    if (seq === meta.seq) say('meta-status', err.message, 'bad');
  }
}

async function metaRun() {
  let body;
  try { body = metaBody(false); } catch (err) { say('meta-status', err.message, 'bad'); return; }
  if (JSON.stringify({ app: state.appId, ...body }) !== meta.previewed) { metaChanged(); return; }
  const from = body.snapshot_id ? `the snapshot of ${$('meta-snap').selectedOptions[0]?.textContent ?? ''}` : when(body.at);
  if (!confirm(`Put metadata back to ${from}? A pre-restore snapshot is taken first.`)) return;
  $('meta-run').disabled = true;
  say('meta-status', 'Restoring…');
  try {
    const r = await api('POST', `/v1/apps/${state.appId}/metadata/restore`, body);
    showMetaResult(r);
    say('meta-status', r.changes ? `Restored${r.members?.deployed ? ` and deployed (revision ${r.members.metadata_rev})` : ''}. A pre-restore snapshot was taken first.` : 'Nothing changed.', 'ok');
    backups.members = {};
    await loadSnapshots();
    await loadChanges();
    const view = 'backups-view';
    await loadForms();
    showView(view);
  } catch (err) {
    say('meta-status', err.message, 'bad');
  }
}

async function openForm(name, page = {}) {
  if (dirty() && !confirm('Discard your unsaved changes?')) return;
  setStatus('Loading…');
  try {
    state.opened = await api('POST', `/v1/apps/${state.appId}/forms/${seg(name)}/open`, { page });
    state.formName = name;
    state.reportName = null;
    state.edits.clear();
    state.conflicts.clear();
    state.selected = null;
    showView('form-view');
    for (const a of document.querySelectorAll('#form-list a')) {
      if (a.dataset.form === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    render();
    setStatus('');
  } catch (err) {
    setStatus(err.message, 'bad');
  }
}

function currentPage() {
  return Object.fromEntries(Object.entries(state.opened.page).map(([dim, p]) => [dim, p.selected]));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const { form, page, grid } = state.opened;
  $('form-title').textContent = form.name;
  $('form-desc').textContent = form.description ?? '';
  $('form-badge').hidden = !form.read_only;
  $('form-instructions').hidden = !form.instructions;
  $('form-instructions').textContent = form.instructions ?? '';
  $('conflicts').hidden = true;
  // Read-only forms are reports: no editing controls.
  for (const id of ['save', 'discard']) $(id).hidden = form.read_only;
  document.querySelector('.hint').hidden = form.read_only;

  const pageBar = $('page');
  pageBar.replaceChildren();
  for (const [dim, p] of Object.entries(page)) {
    const select = el('select', { onchange: (e) => openForm(state.formName, { ...currentPage(), [dim]: e.target.value }) },
      p.options.map((o) => el('option', { value: o, selected: o === p.selected }, o)));
    pageBar.append(el('label', {}, dim, select));
  }
  for (const [dim, member] of Object.entries(grid.pov)) {
    if (page[dim]) continue;
    pageBar.append(el('label', {}, dim, el('span', { class: 'fixed' }, member)));
  }
  renderGrid();
  updateButtons();
}

/** An axis as tuples (one member per dimension); grids from before multi-dimension axes have members only. */
const tuplesOf = (axis) => axis.tuples ?? axis.members.map((m) => [m]);
const dimsOf = (axis) => axis.dimensions ?? [axis.dimension];
const labelOf = (m) => m.alias ?? m.name;
/** Whether tuple n repeats the outer members of tuple n-1 through position q (so its label is left blank). */
const sameOuter = (list, n, q) => n > 0 && list[n - 1].slice(0, q + 1).every((m, z) => m.name === list[n][z].name);

/** Column header rows: one per column dimension, outer members spanning their run of columns. */
function headerRows(rowDims, colDims, cols, corner) {
  return colDims.map((_, level) => {
    const cells = [];
    if (level === colDims.length - 1) {
      rowDims.forEach((d, q) => cells.push(el('th', { scope: 'col', class: 'corner' }, q === rowDims.length - 1 ? corner : d)));
    } else {
      cells.push(el('th', { scope: 'col', class: 'corner', colspan: String(rowDims.length) }, ''));
    }
    for (let j = 0; j < cols.length;) {
      let span = 1;
      if (level < colDims.length - 1) while (j + span < cols.length && sameOuter(cols, j + span, level)) span++;
      const m = cols[j][level];
      const parent = cols[j].some((x) => !x.leaf);
      cells.push(el('th', { scope: 'col', colspan: span > 1 ? String(span) : null, class: parent && level === colDims.length - 1 ? 'parent-col' : null, title: m.name }, labelOf(m)));
      j += span;
    }
    return el('tr', {}, cells);
  });
}

/** Row header cells: one per row dimension; an outer member spans its run of rows. */
function rowHeaders(rows, i) {
  const t = rows[i];
  const cells = [];
  t.forEach((m, q) => {
    const last = q === t.length - 1;
    if (!last && sameOuter(rows, i, q)) return; // covered by the cell above
    let span = 1;
    if (!last) while (i + span < rows.length && sameOuter(rows, i + span, q)) span++;
    cells.push(el('th', {
      scope: last ? 'row' : 'rowgroup', rowspan: span > 1 ? String(span) : null,
      style: last ? `padding-left:${12 + m.level * 16}px` : null, title: m.name, class: last ? null : 'outer',
    }, labelOf(m)));
  });
  return cells;
}

function renderGrid() {
  const { grid } = state.opened;
  const rows = tuplesOf(grid.rows);
  const cols = tuplesOf(grid.columns);
  const rowDims = dimsOf(grid.rows);
  const colDims = dimsOf(grid.columns);
  const colParent = cols.map((t) => t.some((m) => !m.leaf));
  const head = headerRows(rowDims, colDims, cols, `${rowDims[rowDims.length - 1]} \\ ${colDims[colDims.length - 1]}`);
  const body = rows.map((t, i) => {
    const cells = cols.map((ct, j) => {
      const k = key(i, j);
      const classes = [colParent[j] ? 'parent-col' : null, state.edits.has(k) && isChanged(i, j) ? 'dirty' : null, state.conflicts.has(k) ? 'conflict' : null];
      if (grid.writable[i][j]) {
        const input = el('input', {
          type: 'text', inputmode: 'decimal', autocomplete: 'off',
          'aria-label': `${t.map((m) => m.name).join(' / ')}, ${ct.map((m) => m.name).join(' / ')}`,
          dataset: { i, j },
          value: state.edits.has(k) ? state.edits.get(k) : formatValue(grid.values[i][j]),
          title: state.conflicts.has(k) ? `Current value: ${formatValue(state.conflicts.get(k))}` : null,
        });
        return el('td', { class: classes.filter(Boolean).join(' ') }, input);
      }
      return el('td', { class: ['locked', ...classes].filter(Boolean).join(' '), dataset: { i, j }, tabindex: '-1' },
        el('span', { class: 'v' }, formatValue(grid.values[i][j])));
    });
    return el('tr', { class: t.every((m) => m.leaf) ? null : 'parent' }, rowHeaders(rows, i), cells);
  });
  $('grid').replaceChildren(el('thead', {}, head), el('tbody', {}, body));
}

function parseInput(raw) {
  const text = String(raw).trim().replace(/,/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}
function isChanged(i, j) {
  const raw = state.edits.get(key(i, j));
  if (raw === undefined) return false;
  const v = parseInput(raw);
  const orig = state.opened.grid.values[i][j];
  if (Number.isNaN(v)) return true;
  return v === null || orig === null ? v !== orig : Math.abs(v - orig) > 5e-7;
}
function dirty() {
  for (const k of state.edits.keys()) {
    const [i, j] = k.split(',').map(Number);
    if (isChanged(i, j)) return true;
  }
  return false;
}
function updateButtons() {
  const d = dirty();
  $('save').disabled = !d;
  $('discard').disabled = !d;
  $('history').disabled = !state.selected;
}

// ---------------------------------------------------------------------------
// Editing: typing, keyboard movement, paste blocks
// ---------------------------------------------------------------------------
function inputAt(i, j) {
  return document.querySelector(`#grid input[data-i="${i}"][data-j="${j}"]`);
}
function cellAt(i, j) {
  return inputAt(i, j) ?? document.querySelector(`#grid td[data-i="${i}"][data-j="${j}"]`);
}
function move(i, j, di, dj) {
  const nRows = tuplesOf(state.opened.grid.rows).length;
  const nCols = tuplesOf(state.opened.grid.columns).length;
  for (let r = i + di, c = j + dj; r >= 0 && c >= 0 && r < nRows && c < nCols; r += di, c += dj) {
    const target = cellAt(r, c);
    if (target) { target.focus(); return; }
  }
}
function select(i, j) {
  document.querySelector('#grid td.selected')?.classList.remove('selected');
  state.selected = [i, j];
  const node = cellAt(i, j);
  (node?.tagName === 'TD' ? node : node?.parentElement)?.classList.add('selected');
  updateButtons();
}

$('grid').addEventListener('focusin', (e) => {
  const t = e.target;
  if (t.dataset.i === undefined) return;
  select(Number(t.dataset.i), Number(t.dataset.j));
  if (t.tagName === 'INPUT') t.select();
});
$('grid').addEventListener('click', (e) => {
  const td = e.target.closest('td[data-i]');
  if (td) select(Number(td.dataset.i), Number(td.dataset.j));
});
$('grid').addEventListener('input', (e) => {
  const t = e.target;
  if (t.tagName !== 'INPUT') return;
  const i = Number(t.dataset.i), j = Number(t.dataset.j);
  state.edits.set(key(i, j), t.value);
  t.parentElement.classList.toggle('dirty', isChanged(i, j));
  updateButtons();
});
$('grid').addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.dataset.i === undefined) return;
  const i = Number(t.dataset.i), j = Number(t.dataset.j);
  const atStart = t.tagName !== 'INPUT' || t.selectionStart === 0;
  const atEnd = t.tagName !== 'INPUT' || t.selectionEnd === t.value.length;
  if (e.key === 'Enter') { e.preventDefault(); move(i, j, e.shiftKey ? -1 : 1, 0); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(i, j, 1, 0); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(i, j, -1, 0); }
  else if (e.key === 'ArrowRight' && atEnd) { e.preventDefault(); move(i, j, 0, 1); }
  else if (e.key === 'ArrowLeft' && atStart) { e.preventDefault(); move(i, j, 0, -1); }
  else if (e.key === 'Escape' && t.tagName === 'INPUT') {
    state.edits.delete(key(i, j));
    t.value = formatValue(state.opened.grid.values[i][j]);
    t.parentElement.classList.remove('dirty');
    updateButtons();
  }
});
$('grid').addEventListener('paste', (e) => {
  const t = e.target;
  if (t.tagName !== 'INPUT') return;
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!/[\t\n]/.test(text.trim())) return; // a single value pastes normally
  e.preventDefault();
  const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((r) => r.split('\t'));
  const i0 = Number(t.dataset.i), j0 = Number(t.dataset.j);
  let filled = 0;
  rows.forEach((row, di) => row.forEach((value, dj) => {
    const input = inputAt(i0 + di, j0 + dj);
    if (!input) return;
    input.value = value.trim();
    state.edits.set(key(i0 + di, j0 + dj), input.value);
    input.parentElement.classList.toggle('dirty', isChanged(i0 + di, j0 + dj));
    filled++;
  }));
  setStatus(`Pasted ${filled} cell${filled === 1 ? '' : 's'}.`);
  updateButtons();
});

// ---------------------------------------------------------------------------
// Save, conflicts, history
// ---------------------------------------------------------------------------
async function save(override = false) {
  const { grid } = state.opened;
  const values = grid.values.map((row, i) => row.map((v, j) => {
    if (!grid.writable[i][j] || !state.edits.has(key(i, j))) return v;
    return state.edits.get(key(i, j));
  }));
  const bad = [];
  values.forEach((row, i) => row.forEach((v, j) => {
    if (typeof v === 'string' && Number.isNaN(parseInput(v))) bad.push(key(i, j));
  }));
  if (bad.length) {
    setStatus(`${bad.length} cell${bad.length === 1 ? ' is' : 's are'} not a number.`, 'bad');
    return;
  }
  setStatus('Saving…');
  $('save').disabled = true;
  try {
    const res = await api('POST', `/v1/apps/${state.appId}/grid/submit`, {
      grid_session_id: grid.grid_session_id,
      values: values.map((row) => row.map((v) => (typeof v === 'string' ? parseInput(v) : v))),
      override,
      client: { surface: 'web', form: state.formName },
    });
    state.edits.clear();
    await openForm(state.formName, currentPage());
    setStatus(res.cell_count ? `Saved ${res.cell_count} cell${res.cell_count === 1 ? '' : 's'}.` : 'Nothing to save.', 'ok');
  } catch (err) {
    if (err.status === 409 && err.body?.details?.conflicts) {
      state.conflicts.clear();
      for (const c of err.body.details.conflicts) state.conflicts.set(key(c.row_index, c.column_index), c.current_value);
      renderGrid();
      $('conflicts').hidden = false;
      setStatus(`${state.conflicts.size} cell${state.conflicts.size === 1 ? '' : 's'} changed under you; nothing was saved.`, 'bad');
    } else {
      setStatus(err.message, 'bad');
    }
    updateButtons();
  }
}

async function showHistory() {
  if (!state.selected) return;
  const [i, j] = state.selected;
  const { grid } = state.opened;
  const rt = tuplesOf(grid.rows)[i];
  const ct = tuplesOf(grid.columns)[j];
  const cell = { ...grid.pov };
  dimsOf(grid.rows).forEach((d, q) => { cell[d] = rt[q].name; });
  dimsOf(grid.columns).forEach((d, q) => { cell[d] = ct[q].name; });
  const row = rt.map((m) => m.name).join(' / ');
  const col = ct.map((m) => m.name).join(' / ');
  $('history-panel').hidden = false;
  $('history-cell').textContent = `${row} · ${col}`;
  $('history-list').replaceChildren(el('li', { class: 'muted' }, 'Loading…'));
  try {
    const res = await api('POST', `/v1/apps/${state.appId}/history`, { cube: grid.cube, cell, limit: 100 });
    const items = res.changes.map((c) => el('li', {},
      el('div', { class: 'change' }, `${formatValue(c.old_value) || '(empty)'} → ${formatValue(c.new_value) || '(empty)'}`),
      res.aggregate
        ? el('div', { class: 'meta' }, Object.entries(c.cell).filter(([d, m]) => cell[d] !== m).map(([d, m]) => `${d}: ${m}`).join(' · '))
        : null,
      el('div', { class: 'meta' }, `${c.user ?? 'system'} · ${new Date(c.changed_at).toLocaleString()} · ${c.source.replace('_', ' ')}${c.surface ? ` (${c.surface})` : ''}`),
      c.comment ? el('div', { class: 'meta' }, c.comment) : null));
    $('history-list').replaceChildren(...(items.length ? items : [el('li', { class: 'muted' }, 'No changes recorded.')]));
  } catch (err) {
    $('history-list').replaceChildren(el('li', { class: 'error' }, err.message));
  }
}

$('save').addEventListener('click', () => save(false));
$('overwrite').addEventListener('click', () => save(true));
$('take-theirs').addEventListener('click', () => { state.edits.clear(); openForm(state.formName, currentPage()); });
$('discard').addEventListener('click', () => { state.edits.clear(); state.conflicts.clear(); render(); setStatus('Changes discarded.'); });
$('refresh').addEventListener('click', () => openForm(state.formName, currentPage()));
$('history').addEventListener('click', showHistory);
$('history-close').addEventListener('click', () => { $('history-panel').hidden = true; });
$('sign-out').addEventListener('click', () => signOut());
$('phone-open').addEventListener('click', phoneOpen);
$('phone-close').addEventListener('click', () => $('phone-dialog').close());
$('phone-dialog').addEventListener('close', phoneClosed);
$('phone-approve').addEventListener('submit', phoneApprove);
$('phone-deny').addEventListener('click', phoneDeny);
$('phone-new').addEventListener('click', phoneNewCode);
$('imp-validate').addEventListener('click', () => runImport(true));
$('imp-load').addEventListener('click', () => runImport(false));
$('ds-select').addEventListener('change', () => loadDatasetSheet(true));
$('ds-sheet').addEventListener('change', () => loadDatasetSheet(false));
$('ds-publish').addEventListener('click', publishDataset);
for (const id of ['pit-cube', 'pit-scenario', 'pit-version', 'pit-filter', 'pit-mode', 'pit-at', 'pit-txn', 'pit-target']) $(id).addEventListener('change', pitChanged);
$('pit-new').addEventListener('input', pitChanged);
$('pit-preview').addEventListener('click', pitPreview);
$('pit-run').addEventListener('click', pitRun);
$('pit-undo').addEventListener('click', () => undoRestore(backups.pitTxn, 'pit-status', 'pit-undo'));
$('snap-take').addEventListener('click', takeSnapshot);
for (const id of ['snap-target', 'snap-versions', 'snap-into']) $(id).addEventListener('change', snapChanged);
$('snap-access').addEventListener('change', () => { backups.snapPreviewed = null; });
$('snap-preview').addEventListener('click', snapPreview);
$('snap-run').addEventListener('click', snapRun);
$('snap-undo').addEventListener('click', () => undoRestore(backups.snapTxn, 'snap-restore-status', 'snap-undo'));
$('snap-close').addEventListener('click', () => { $('snap-restore').hidden = true; });
$('report-refresh').addEventListener('click', () => state.reportName && openReport(state.reportName, reportPage()));
$('report-xlsx').addEventListener('click', () => reportDownload('xlsx'));
$('report-csv').addEventListener('click', () => reportDownload('csv'));
$('defs-xlsx').addEventListener('click', () => defsExport('xlsx'));
$('defs-csv').addEventListener('click', () => defsExport('csv'));
$('defs-file').addEventListener('change', defsChanged);
$('defs-check').addEventListener('click', defsCheck);
$('defs-import').addEventListener('click', defsImport);
$('defs-hist-load').addEventListener('click', defsHistory);
for (const id of ['meta-source', 'meta-at', 'meta-deploy', 'meta-snap', 'meta-dims', 'meta-members', 'meta-defs', 'meta-remove-new', 'meta-data']) $(id).addEventListener('change', metaChanged);
$('meta-at').addEventListener('input', () => { $('meta-deploy').value = ''; });
$('meta-preview').addEventListener('click', metaPreview);
$('meta-run').addEventListener('click', metaRun);
$('demo-persona').addEventListener('change', (e) => switchPersona(e.target.value));
$('demo-restart').addEventListener('click', demoRestart);
$('demo-exit').addEventListener('click', demoExit);
$('app-select').addEventListener('change', async (e) => {
  state.appId = e.target.value;
  try { localStorage.setItem('nx.app', state.appId); } catch { /* ignore */ }
  await loadForms();
});
window.addEventListener('beforeunload', (e) => { if (state.opened && dirty()) e.preventDefault(); });

// ---------------------------------------------------------------------------
state.token = recall('nx.session') ?? recallDemo();
if (state.token) start().catch(() => (recallDemo() === state.token ? demoEnded() : signOut()));
else showSignIn();
