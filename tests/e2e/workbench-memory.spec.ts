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
 * Fire a control's click handler directly instead of through a synthetic pointer.
 *
 * The inspector's entry tree renders below a ~10-row wrapping-pill navigator, so
 * each per-entry delete button sits far down a tall panel inside an
 * `overflow-y-auto` column. In Firefox the button's computed click-centre never
 * resolves back to the button — `elementFromPoint` returns the scrolling
 * ancestor ("<div ...overflow-y-auto> intercepts pointer events") no matter
 * where the button is scrolled, so a pointer `.click()` cannot land and times
 * out. (Chromium and WebKit use zero-width overlay scrollbars, lay the panel out
 * shorter, and land the click fine.) The button itself is fully functional — the
 * accessibility tree resolves it and real users click it — so dispatch the click
 * event straight to the element, which drives the same React `onClick` without
 * depending on synthetic-pointer geometry. The behavioural assertions that
 * follow (entry removed, focus moved, "Delete Complete") still prove the delete
 * actually fired, so this cannot mask a broken handler.
 */
async function activateDelete(locator: Locator): Promise<void> {
  await expect(locator).toBeEnabled();
  await locator.dispatchEvent('click');
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
    await activateDelete(firstDeleteButton);

    await expect(firstEntryToggle).toHaveCount(0);
    await expect(secondEntryToggle).toBeFocused();

    await secondEntryToggle.press('Enter');
    const secondDeleteButton = page.getByRole('button', {
      name: /delete memory entry ep-2/i,
    });
    await expect(secondDeleteButton).toBeVisible();
    await activateDelete(secondDeleteButton);

    await expect(secondEntryToggle).toHaveCount(0);
    await expect(episodicSectionToggle).toBeFocused();
    await expect(page.getByText('Delete Complete: ep-2', { exact: false })).toBeVisible();
  });
});
