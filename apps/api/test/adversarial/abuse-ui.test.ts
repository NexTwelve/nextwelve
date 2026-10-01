import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness } from './abuse-helpers.js';

/**
 * The "Backups and restore" screen in headless Chromium, with the API served in-process.
 * Playwright lives outside the repo; the suite is skipped when it is not installed.
 */
// Playwright is not a dependency of the repo: point NX_PLAYWRIGHT at an install (or add it), else this suite is skipped.
const PW = process.env.NX_PLAYWRIGHT ?? 'playwright';
const CHROME = process.env.NX_CHROME; // a Chromium binary; default: Playwright's own
let playwright: any = null;
try {
  playwright = await import(PW);
} catch {
  playwright = null;
}
// Code passed to page functions runs in the browser; these stand in for the DOM types there.
declare const document: any;
declare const window: any;
const PUBLIC = join(import.meta.dirname, '../../public');
const ORIGIN = 'http://nx.test';
const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;

describe.skipIf(!playwright)('adversarial: backups screen in a browser', () => {
  let h: AbuseHarness;
  let admin: Api;
  let appId: string;
  let base: string;
  let snapA: any;
  let snapB: any;
  let browser: any;

  async function edit(v: number) {
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[2][0] = v;
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }

  /** A page signed in as the admin, with /v1 routed to the in-process API and static files from public/. */
  async function openPage(delay?: (path: string, body: string) => number) {
    const ctx = await browser.newContext();
    await ctx.route('https://accounts.google.com/**', (r: any) => r.abort());
    await ctx.route(`${ORIGIN}/**`, async (route: any) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname.startsWith('/v1/')) {
        const body = req.postData() ?? undefined;
        const wait = delay?.(url.pathname, body ?? '') ?? 0;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        const res = await h.app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), body });
        return route.fulfill({ status: res.status, headers: Object.fromEntries((res.headers as any).entries()), body: Buffer.from(await res.arrayBuffer()) });
      }
      const file = url.pathname.endsWith('/') ? `${url.pathname.slice(1)}index.html` : url.pathname.slice(1);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PUBLIC, file)) });
    });
    await ctx.addInitScript(([t, a]: string[]) => { sessionStorage.setItem('nx.session', t!); localStorage.setItem('nx.app', a!); }, [admin.token, appId]);
    const page = await ctx.newPage();
    const restores: { snapshot: string; body: any }[] = [];
    page.on('request', (r: any) => {
      const m = /\/snapshots\/([0-9a-f-]{36})\/restore$/.exec(new URL(r.url()).pathname);
      if (m && r.method() === 'POST') restores.push({ snapshot: m[1]!, body: JSON.parse(r.postData() ?? '{}') });
    });
    page.on('dialog', (d: any) => d.accept());
    await page.goto(`${ORIGIN}/app/`);
    await page.click('#form-list a[data-view="backups"]');
    await page.waitForSelector('#snap-list tbody tr');
    return { ctx, page, restores };
  }

  beforeAll(async () => {
    h = await createAbuseHarness();
    await provisionTenant(h.db, 'UI Co', null, 'admin@ui.test');
    admin = await signIn(h as any, 'admin@ui.test');
    appId = await seedPlanApp(admin, `Plan ${XSS}`);
    base = `/v1/apps/${appId}`;
    // Hostile text everywhere the screen shows names: a member, a version, snapshot comments.
    expectOk(await admin.put(`${base}/dimensions/Entity/members`, { members: [{ name: `North ${XSS}`, parent: 'Total Company' }] }));
    expectOk(await admin.put(`${base}/dimensions/Version/members`, { members: [{ name: `V ${XSS}` }] }));
    expectOk(await admin.post(`${base}/deploy`));
    await edit(100);
    snapA = expectOk(await admin.post(`${base}/snapshots`, { comment: `A ${XSS}` }), 201);
    await edit(200);
    snapB = expectOk(await admin.post(`${base}/snapshots`, { comment: `B ${XSS}` }), 201);
    await edit(300);
    browser = await playwright.chromium.launch(CHROME ? { executablePath: CHROME } : {});
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('shows names, comments and errors as text, never as HTML', async () => {
    const { ctx, page } = await openPage();
    try {
      await page.waitForFunction(() => document.querySelectorAll('#snap-list tbody tr').length >= 2);
      expect(await page.textContent('#snap-list')).toContain(`A ${XSS}`);
      expect(await page.$$eval('#pit-filter option', (o: any[]) => o.map((x) => x.textContent))).toContain(`North ${XSS}`);
      // A preview whose status line echoes a hostile new version name back.
      await page.selectOption('#pit-target', '__new');
      await page.fill('#pit-new', `New ${XSS}`);
      await page.click('#pit-preview');
      await page.waitForFunction(() => /\d cells? would change|Nothing would change/.test(document.querySelector('#pit-status')!.textContent!));
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as any).__xss ?? 0)).toBe(0);
      expect(await page.$$('img:not(#phone-qr)')).toHaveLength(0); // the QR image in the (closed) phone dialog is part of the page
    } finally {
      await ctx.close();
    }
  });

  it('restores only the snapshot that was previewed, even when a slow preview answers late', async () => {
    // The preview of snapshot A is slow (large snapshots take seconds); the admin moves on to snapshot B meanwhile.
    const { ctx, page, restores } = await openPage((path, body) => (path.includes(snapA.snapshot_id) && body.includes('"dry_run":true') ? 1500 : 0));
    try {
      const row = (comment: string) => page.locator('#snap-list tbody tr', { hasText: comment });
      await row(`A ${XSS}`).locator('button', { hasText: 'Restore' }).click();
      await page.click('#snap-preview');
      await page.waitForTimeout(100);
      await row(`B ${XSS}`).locator('button', { hasText: 'Restore' }).click(); // B is open; nothing about B was previewed
      await page.waitForTimeout(2500); // the slow answer about A arrives while B is open
      const runEnabled = !(await page.isDisabled('#snap-run'));
      if (runEnabled) {
        await page.click('#snap-run');
        await page.waitForFunction(() => /Restored|Nothing changed|failed/i.test(document.querySelector('#snap-restore-status')!.textContent!), null, { timeout: 5000 });
      }
      const ran = restores.filter((r) => r.body.dry_run === false).map((r) => (r.snapshot === snapA.snapshot_id ? 'A' : r.snapshot === snapB.snapshot_id ? 'B' : r.snapshot));
      // Whatever ran must be what was previewed: A, or nothing.
      expect(ran.filter((x) => x !== 'A')).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 20_000);

  it('asks before every restore, and Run stays disabled until a matching preview', async () => {
    const { ctx, page } = await openPage();
    try {
      expect(await page.isDisabled('#pit-run')).toBe(true);
      await page.click('#pit-preview');
      await page.waitForFunction(() => /\d cells? would change|Nothing would change/.test(document.querySelector('#pit-status')!.textContent!));
      await page.selectOption('#pit-version', 'Final'); // change after the preview
      expect(await page.isDisabled('#pit-run')).toBe(true);
      const row = page.locator('#snap-list tbody tr').first();
      await row.locator('button', { hasText: 'Restore' }).click();
      expect(await page.isDisabled('#snap-run')).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
