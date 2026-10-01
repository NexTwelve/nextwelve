// The landing page: start (or continue) a demo copy and open the planner in it.
const $$ = (sel) => [...document.querySelectorAll(sel)];
const statusEl = document.querySelector('.demo-status');
let turnstileToken = null;
let config = { enabled: false, turnstile_site_key: null };

function say(text, bad = false) {
  statusEl.textContent = text;
  statusEl.className = `note demo-status${bad ? ' bad' : ''}`;
}

function remembered() {
  try { return localStorage.getItem('nx.demo'); } catch { return null; }
}
function remember(token) {
  try {
    if (token) localStorage.setItem('nx.demo', token);
    else localStorage.removeItem('nx.demo');
  } catch { /* the demo still works for this tab */ }
}

/** A copy started earlier and not yet expired: offer to continue it. */
async function existingCopy() {
  const token = remembered();
  if (!token) return null;
  const res = await fetch('/v1/me', { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res || !res.ok) { remember(null); return null; }
  const me = await res.json();
  return me.demo ? { token, me } : null;
}

async function startDemo(fresh) {
  if (config.turnstile_site_key && !turnstileToken) {
    say('Complete the check above, then try again.', true);
    document.getElementById('demo').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  for (const b of $$('.demo-start, .demo-fresh')) b.disabled = true;
  say('Preparing your copy of Fernhollow Foods… this takes a few seconds.');
  document.getElementById('demo').scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const headers = { 'content-type': 'application/json' };
    const old = fresh ? remembered() : null;
    if (old) headers.authorization = `Bearer ${old}`;
    const res = await fetch('/v1/demo/session', { method: 'POST', headers, body: JSON.stringify({ turnstile_token: turnstileToken ?? undefined }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message ?? `the demo could not start (${res.status})`);
    remember(data.session_token);
    location.href = '/app/';
  } catch (err) {
    say(`Sorry: ${err.message}.`, true);
    for (const b of $$('.demo-start, .demo-fresh')) b.disabled = false;
    if (window.turnstile) { window.turnstile.reset(); turnstileToken = null; }
  }
}

async function init() {
  config = await fetch('/v1/demo').then((r) => r.json()).catch(() => config);
  if (!config.enabled) {
    for (const b of $$('.demo-start')) b.disabled = true;
    for (const n of $$('.demo-note')) n.textContent = 'The demo is not available right now.';
    say('The demo is not available right now.');
    return;
  }
  if (config.personas?.length) {
    const dl = document.getElementById('personas');
    dl.replaceChildren(...config.personas.flatMap((p) => {
      const dt = document.createElement('dt');
      dt.textContent = p.label;
      const dd = document.createElement('dd');
      dd.textContent = p.description;
      return [dt, dd];
    }));
  }
  const copy = await existingCopy();
  if (copy) {
    const hours = Math.max(0, Math.round((new Date(copy.me.demo.expires_at).getTime() - Date.now()) / 3600e3));
    for (const b of $$('.demo-start')) b.textContent = 'Continue your demo';
    for (const b of $$('.demo-fresh')) b.hidden = false;
    for (const n of $$('.demo-note')) n.textContent = `Your copy is kept for about ${hours} more hour${hours === 1 ? '' : 's'}.`;
  }
  for (const b of $$('.demo-start')) b.addEventListener('click', () => (copy ? (location.href = '/app/') : startDemo(false)));
  for (const b of $$('.demo-fresh')) b.addEventListener('click', () => startDemo(true));
  if (config.turnstile_site_key) {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => window.turnstile.render('#turnstile', {
      sitekey: config.turnstile_site_key,
      callback: (t) => { turnstileToken = t; },
      'expired-callback': () => { turnstileToken = null; },
    });
    document.head.append(script);
  }
}

init();
