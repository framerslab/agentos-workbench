import { expect, test, type Locator } from '@playwright/test';
import {
  attachConsoleErrorCollector,
  flushConsoleErrors,
  gotoWorkbench,
  installDefaultApiMocks,
  installMemoryInspectorApiMocks,
  waitForWorkbenchReady,
} from './helpers/workbench';

const consoleErrors: string[] = [];

/**
 * Click an inspector control reliably across every browser engine.
 *
 * The inspector's entry tree renders below a tall wrapping-pill navigator
 * inside an `overflow-y-auto` column, so a per-entry delete button sits near
 * the bottom of that scroll region. Playwright's built-in scroll-into-view
 * lands the button flush against the clip edge, leaving its centre point in the
 * clipped-away half. Firefox's `elementFromPoint` then resolves that point to
 * the scrolling ancestor rather than the button, and the click times out with
 * "<div ...overflow-y-auto> intercepts pointer events". Explicitly centring the
 * button first moves its hit-point firmly inside the visible clip region.
 * Chromium and WebKit use overlay scrollbars (zero width) so their layout is
 * shorter and never reproduces it — which is why only Firefox failed.
 */
async function clickCentered(locator: Locator): Promise<void> {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await locator.click();
}

test.beforeEach(async ({ page }) => {
  await installDefaultApiMocks(page);
  await installMemoryInspectorApiMocks(page);
  attachConsoleErrorCollector(page, consoleErrors);
});

test.afterEach(async () => {
  flushConsoleErrors(consoleErrors);
});

test.describe('AgentOS Workbench - Memory Inspector', () => {
  test('delete flow preserves keyboard focus within the inspector', async ({ page, baseURL }) => {
    await page.addInitScript(() => {
      window.confirm = () => true;
    });

    await gotoWorkbench(page, baseURL!);
    await waitForWorkbenchReady(page);

    await page.getByRole('tab', { name: /^Memory$/i }).click();
    await page.getByRole('tab', { name: /^Inspector$/i }).click();

    const firstEntryToggle = page.locator('#memory-entry-toggle-ep-1');
    const secondEntryToggle = page.locator('#memory-entry-toggle-ep-2');
    const episodicSectionToggle = page.locator('#memory-section-toggle-episodic');

    await expect(firstEntryToggle).toBeVisible();
    await expect(page.getByLabel('Search memory entries')).toBeVisible();

    await firstEntryToggle.focus();
    await expect(firstEntryToggle).toBeFocused();
    await firstEntryToggle.press('Enter');

    const firstDeleteButton = page.getByRole('button', {
      name: /delete memory entry ep-1/i,
    });
    await expect(firstDeleteButton).toBeVisible();
    await clickCentered(firstDeleteButton);

    await expect(firstEntryToggle).toHaveCount(0);
    await expect(secondEntryToggle).toBeFocused();

    await secondEntryToggle.press('Enter');
    const secondDeleteButton = page.getByRole('button', {
      name: /delete memory entry ep-2/i,
    });
    await expect(secondDeleteButton).toBeVisible();
    await clickCentered(secondDeleteButton);

    await expect(secondEntryToggle).toHaveCount(0);
    await expect(episodicSectionToggle).toBeFocused();
    await expect(page.getByText('Delete Complete: ep-2', { exact: false })).toBeVisible();
  });
});
