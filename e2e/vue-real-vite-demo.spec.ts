import { test, expect } from '@playwright/test';

test.describe('Vue 3 + Real Vite demo', () => {
  test('installs Vue + Vite, starts the server, and renders a Vue app', async ({ page }) => {
    test.setTimeout(300000);
    await page.goto('/examples/vue-real-vite-demo.html');
    await page.setViewportSize({ width: 1400, height: 900 });

    // Init
    await expect(page.locator('#status-text')).toHaveText('Ready', { timeout: 15000 });

    // Install Vue + Vite (this downloads vite@7 + @vitejs/plugin-vue + vue from npm)
    await page.click('#install-btn');
    await expect(page.locator('#status-text')).toHaveText('Installed', { timeout: 240000 });

    // Start server
    await page.click('#start-btn');
    await expect(page.locator('#status-text')).toHaveText('Server running', { timeout: 60000 });

    // Preview iframe visible and serving the Vue app
    await expect(page.locator('#preview-frame')).toBeVisible();
    const frame = page.frameLocator('#preview-frame');

    // The Vue app mounts and renders its heading + count
    await expect(frame.locator('h1')).toContainText('Vue 3 + Real Vite in the browser', { timeout: 30000 });
    await expect(frame.locator('button')).toContainText('Count: 0');

    // Interactivity works (Vue reactivity through real Vite-served ESM)
    await frame.locator('button').click();
    await expect(frame.locator('button')).toContainText('Count: 1');
  });

  test('editing App.vue and saving updates the preview', async ({ page }) => {
    test.setTimeout(300000);
    await page.goto('/examples/vue-real-vite-demo.html');
    await page.setViewportSize({ width: 1400, height: 900 });

    await expect(page.locator('#status-text')).toHaveText('Ready', { timeout: 15000 });
    await page.click('#install-btn');
    await expect(page.locator('#status-text')).toHaveText('Installed', { timeout: 240000 });
    await page.click('#start-btn');
    await expect(page.locator('#status-text')).toHaveText('Server running', { timeout: 60000 });

    const frame = page.frameLocator('#preview-frame');
    await expect(frame.locator('h1')).toContainText('Vue 3 + Real Vite in the browser', { timeout: 30000 });

    // Edit the component text and save → preview updates
    const editor = page.locator('#editor');
    const content = await editor.inputValue();
    await editor.fill(content.replace('Vue 3 + Real Vite in the browser', 'Edited from the demo!'));
    await page.click('#save-btn');

    await expect(frame.locator('h1')).toContainText('Edited from the demo!', { timeout: 30000 });
  });
});
