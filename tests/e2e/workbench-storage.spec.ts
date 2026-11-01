import { expect, test } from '@playwright/test';
import { gotoWorkbench, installDefaultApiMocks, waitForWorkbenchReady } from './helpers/workbench';

// Sessions and personas persist through @framers/sql-storage-adapter's IndexedDbAdapter, which
// runs sql.js in the page. A sql.js wasm from another release than its glue code throws on load
// ("dd.O is not a function"), storage never opens, and no session can be created.
test.describe('AgentOS Workbench - Browser storage', () => {
  test('opens sql.js storage without a page error and seeds a sendable session', async ({ page, baseURL }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const storageFailures: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /bootstrap storage|IndexedDbAdapter|sql\.js/i.test(msg.text())) {
        storageFailures.push(msg.text());
      }
    });
    const wasmResponses: Array<{ url: string; status: number; type: string | undefined }> = [];
    page.on('response', (response) => {
      // The wasm binary itself, not vite's `?import&url` module that exports its URL.
      const url = new URL(response.url());
      if (url.pathname.endsWith('.wasm') && !url.searchParams.has('import')) {
        wasmResponses.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] });
      }
    });

    await installDefaultApiMocks(page);
    await gotoWorkbench(page, baseURL!);
    await waitForWorkbenchReady(page);
    await page.getByRole('tab', { name: /Compose/i }).click();

    await expect(page.getByRole('button', { name: /Send to AgentOS/i })).toBeEnabled({ timeout: 20_000 });
    expect(wasmResponses.length).toBeGreaterThan(0);
    for (const wasm of wasmResponses) {
      expect(wasm.status, wasm.url).toBe(200);
      expect(wasm.type, wasm.url).toContain('application/wasm');
    }
    expect(pageErrors).toEqual([]);
    expect(storageFailures).toEqual([]);
  });
});
