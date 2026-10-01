import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness } from './abuse-helpers.js';

/**
 * Second pass on the Backups screen (headless Chromium, API in-process; skipped without Playwright):
 * preview sequencing across application switches, and the new "copy access" checkbox.
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
declare const document: any;
const PUBLIC = join(import.meta.dirname, '../../public');
const ORIGIN = 'http://nx.test';

describe.skipIf(!playwright)('fix: the Backups screen', () => {
  let h: AbuseHarness;
  let admin: Api;
  let appA: string;
  let appB: string;
  let browser: any;

  async function edit(appId: string, v: number) {
    const b = `/v1/apps/${appId}`;
    const g = expectOk(await admin.post(`${b}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[2][0] = v;
    expectOk(await admin.post(`${b}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }

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
    await ctx.addInitScript(([t, a]: string[]) => { sessionStorage.setItem('nx.session', t!); localStorage.setItem('nx.app', a!); }, [admin.token, appA]);
    const page = await ctx.newPage();
    const posts: { path: string; body: any }[] = [];
    page.on('request', (r: any) => {
      if (r.method() === 'POST' && /restore$/.test(new URL(r.url()).pathname)) posts.push({ path: new URL(r.url()).pathname, body: JSON.parse(r.postData() ?? '{}') });
    });
    page.on('dialog', (d: any) => d.accept());
    await page.goto(`${ORIGIN}/app/`);
    await page.click('#form-list a[data-view="backups"]');
    await page.waitForSelector('#snap-list tbody tr');
    return { ctx, page, posts };
  }

  beforeAll(async () => {
    h = await createAbuseHarness();
    await provisionTenant(h.db, 'UI Fix Co', null, 'admin@uifix.test');
    admin = await signIn(h as any, 'admin@uifix.test');
    appA = await seedPlanApp(admin, 'Alpha');
    appB = await seedPlanApp(admin, 'Beta'); // the same member names, as a restored copy would have
    for (const [app, label] of [[appA, 'alpha'], [appB, 'beta']] as const) {
      await edit(app, 100);
      expectOk(await admin.post(`/v1/apps/${app}/snapshots`, { comment: `${label}-snapshot` }), 201);
      await edit(app, 200);
    }
    browser = await playwright.chromium.launch(CHROME ? { executablePath: CHROME } : {});
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('a slow point-in-time preview of one application does not enable Restore after switching to another', async () => {
    const { ctx, page, posts } = await openPage((path, body) => (path === `/v1/apps/${appA}/restore` && body.includes('"dry_run":true') ? 1500 : 0));
    try {
      await page.selectOption('#pit-mode', 'before');
      await page.click('#pit-preview');
      await page.waitForTimeout(100);
      await page.selectOption('#app-select', appB);
      await page.waitForTimeout(2200);
      expect(await page.isDisabled('#pit-run')).toBe(true);
      expect(posts.filter((p) => p.body.dry_run === false)).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 20_000);

  it('after switching application, the Backups screen does not keep offering the previous application\'s snapshots and changes', async () => {
    const { ctx, page } = await openPage();
    try {
      await page.waitForFunction(() => /alpha-snapshot/.test(document.querySelector('#snap-list').textContent));
      await page.selectOption('#app-select', appB);
      await page.waitForTimeout(800);
      const shown = await page.evaluate(() => ({
        visible: !document.querySelector('#backups-view').hidden,
        list: document.querySelector('#snap-list').textContent,
      }));
      // Correct: the screen follows the selected application (or closes); it never mixes the two.
      const stale = shown.visible && /alpha-snapshot/.test(shown.list);
      expect({ stale, selected: await page.inputValue('#app-select') }).toEqual({ stale: false, selected: appB });
    } finally {
      await ctx.close();
    }
  }, 20_000);

  it('the "copy access" checkbox sends access: copy only when ticked, and starts unticked for every snapshot opened', async () => {
    const { ctx, page, posts } = await openPage();
    try {
      const open = async () => {
        await page.locator('#snap-list tbody tr', { hasText: 'alpha-snapshot' }).locator('button', { hasText: 'Restore' }).click();
        await page.selectOption('#snap-target', 'new_app');
      };
      await open();
      expect(await page.isChecked('#snap-access')).toBe(false);
      await page.check('#snap-access');
      await page.fill('#snap-name', 'UI Copy With Access');
      await page.click('#snap-run');
      await page.waitForFunction(() => /Created/.test(document.querySelector('#snap-restore-status').textContent), null, { timeout: 8000 });
      await open();
      expect(await page.isChecked('#snap-access')).toBe(false);
      await page.fill('#snap-name', 'UI Copy Without Access');
      await page.click('#snap-run');
      await page.waitForFunction(() => /Created/.test(document.querySelector('#snap-restore-status').textContent) && /Without/.test(document.querySelector('#snap-restore-status').textContent), null, { timeout: 8000 });
      expect(posts.filter((p) => p.body.target === 'new_app').map((p) => [p.body.name, p.body.access])).toEqual([
        ['UI Copy With Access', 'copy'],
        ['UI Copy Without Access', 'none'],
      ]);
    } finally {
      await ctx.close();
    }
  }, 25_000);
});
