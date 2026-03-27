import { expect, test } from '@playwright/test';
import { startE2EServer, type StartedE2EServer } from '../harness/test-server.js';

let server: StartedE2EServer;

test.beforeAll(async () => {
  server = await startE2EServer({ sessions: ['main'], defaultSession: 'main' });
});

test.afterAll(async () => {
  await server.stop();
});

test('toolbar layout: unified rows with balanced button distribution', async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);

  // Default is terminal mode — wait for terminal to be visible
  await expect(page.getByTestId('terminal-host')).toBeVisible();

  const mainRows = await page.locator('.toolbar-main').all();
  expect(mainRows.length).toBe(2);

  // Row 1: Esc, Ctrl, Alt, Cmd, /, @, Hm, ↑, Ed (9 buttons)
  const row1Buttons = await mainRows[0].locator('button').all();
  const row1Labels = await Promise.all(row1Buttons.map(b => b.textContent()));
  console.log('Row 1 buttons:', row1Labels);
  expect(row1Buttons.length).toBe(9);
  expect(row1Labels).toEqual(['Esc', 'Ctrl', 'Alt', 'Cmd', '/', '@', 'Hm', '↑', 'Ed']);

  // Row 2: ^C, ^B, ^R, Sft, Tab, Enter, ▼, ←, ↓, → (10 buttons)
  const row2Buttons = await mainRows[1].locator('button').all();
  const row2Labels = await Promise.all(row2Buttons.map(b => b.textContent()));
  console.log('Row 2 buttons:', row2Labels);
  expect(row2Buttons.length).toBe(10);
  expect(row2Labels).toEqual(['^C', '^B', '^R', 'Sft', 'Tab', 'Enter', '▼', '←', '↓', '→']);

  // ^C should be in row 2, not row 1
  expect(row1Labels).not.toContain('^C');
  expect(row2Labels).toContain('^C');

  // All modifiers should be in the main visible rows
  const allLabels = [...row1Labels, ...row2Labels];
  for (const mod of ['Ctrl', 'Alt', 'Cmd', 'Sft']) {
    expect(allLabels).toContain(mod);
  }

  // All direct children should be buttons (no wrapper divs)
  for (const row of mainRows) {
    const children = await row.locator(':scope > *').all();
    const tags = await Promise.all(children.map(c => c.evaluate(el => el.tagName)));
    expect(tags.every(tag => tag === 'BUTTON')).toBe(true);
  }

  // Buttons should fill the width
  const toolbarBox = await page.locator('.toolbar').boundingBox();
  for (const row of mainRows) {
    const buttons = await row.locator('button').all();
    const firstBtn = await buttons[0].boundingBox();
    const lastBtn = await buttons[buttons.length - 1].boundingBox();
    const rowWidth = (lastBtn!.x + lastBtn!.width) - firstBtn!.x;
    const toolbarContentWidth = toolbarBox!.width - 14;
    console.log(`Row width: ${rowWidth.toFixed(0)}, toolbar content: ${toolbarContentWidth.toFixed(0)}`);
    expect(rowWidth).toBeGreaterThan(toolbarContentWidth * 0.95);
  }

  // Check button sizes meet touch target guidelines (>= 40px)
  for (const btn of [...row1Buttons, ...row2Buttons]) {
    const box = await btn.boundingBox();
    console.log(`Button "${await btn.textContent()}": h=${box!.height.toFixed(0)} w=${box!.width.toFixed(0)}`);
    expect(box!.height).toBeGreaterThanOrEqual(40);
  }
});

test('expand button toggles visual indicator', async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId('terminal-host')).toBeVisible();

  const expandBtn = page.locator('.toolbar-expand-btn').first();

  // Initially collapsed — shows ▼
  await expect(expandBtn).toHaveText('▼');

  // Click to expand — shows ▲
  await expandBtn.click();
  await expect(expandBtn).toHaveText('▲');

  // Click again to collapse — back to ▼
  await expandBtn.click();
  await expect(expandBtn).toHaveText('▼');
});

test('F-keys grid uses 6-column layout in portrait', async ({ page }) => {
  // Set portrait viewport
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId('terminal-host')).toBeVisible();

  // Expand toolbar to reveal F-keys
  const expandBtn = page.locator('.toolbar-expand-btn').first();
  await expandBtn.click();

  // Click "F-Keys ▼" to expand F-keys row
  const fkeysBtn = page.locator('.toolbar-expand-btn').nth(1);
  await fkeysBtn.click();

  // Wait for F-keys grid to be visible
  const fkeysGrid = page.locator('.toolbar-row-deep-fkeys');
  await expect(fkeysGrid).toBeVisible();

  // Verify 12 F-key buttons exist
  const fkeyButtons = await fkeysGrid.locator('button').all();
  expect(fkeyButtons.length).toBe(12);

  // In portrait (6 columns), F1 and F7 should be on different rows
  const f1Box = await fkeyButtons[0].boundingBox();
  const f6Box = await fkeyButtons[5].boundingBox();
  const f7Box = await fkeyButtons[6].boundingBox();

  // F1 and F6 should be on the same row (allow sub-pixel rounding in CI)
  expect(Math.abs(f1Box!.y - f6Box!.y)).toBeLessThan(20);

  // F7 should be on a different row than F1 (use small threshold for CI font differences)
  expect(f7Box!.y).toBeGreaterThan(f1Box!.y + 5);
});

test('snippets: no Snip button when no snippets configured', async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId('terminal-host')).toBeVisible();

  // Expand toolbar
  const expandBtn = page.locator('.toolbar-expand-btn').first();
  await expandBtn.click();

  // Should not have a "Snip ▼" button in the toolbar
  await expect(page.locator('.toolbar button', { hasText: 'Snip' })).not.toBeVisible();
});

test('snippets: Snip button appears and expands when snippets exist', async ({ page }) => {
  // Inject snippets into localStorage before navigating
  const snippets = [
    { id: 'test-1', label: 'ls', command: 'ls -la', autoEnter: true },
    { id: 'test-2', label: 'git st', command: 'git status', autoEnter: false }
  ];

  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId('terminal-host')).toBeVisible();

  // Set localStorage and reload to pick up snippets
  await page.evaluate((s) => localStorage.setItem('remux-snippets', JSON.stringify(s)), snippets);
  await page.reload();
  await expect(page.getByTestId('terminal-host')).toBeVisible();

  // Expand toolbar
  const expandBtn = page.locator('.toolbar-expand-btn').first();
  await expandBtn.click();

  // Should see "Snip ▼" button
  const snipBtn = page.locator('button', { hasText: 'Snip ▼' });
  await expect(snipBtn).toBeVisible();

  // Click to expand snippets
  await snipBtn.click();

  // Should see snippet buttons
  const snippetRow = page.locator('.toolbar-row-snippets');
  await expect(snippetRow).toBeVisible();

  const snippetButtons = await snippetRow.locator('button').all();
  expect(snippetButtons.length).toBe(2);

  const labels = await Promise.all(snippetButtons.map(b => b.textContent()));
  expect(labels).toEqual(['ls', 'git st']);
});
