const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('**/api/me', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Authentication required' }),
  }));
});

test('landing scenes scroll and snap smoothly in both directions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Care feels lighter here.' })).toBeVisible();

  const flow = page.locator('.tokko-landing-flow');
  const dimensions = await flow.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThanOrEqual(dimensions.clientHeight * 2);

  await flow.evaluate((element) => element.scrollBy({ top: element.clientHeight, behavior: 'smooth' }));
  await expect(page.locator('.tokko-hero-screen')).toHaveAttribute('aria-hidden', 'false');
  await expect.poll(() => flow.evaluate((element) => element.scrollTop)).toBeGreaterThan(dimensions.clientHeight * 0.8);

  await flow.evaluate((element) => element.scrollBy({ top: -element.clientHeight, behavior: 'smooth' }));
  await expect(page.locator('.tokko-entry-screen')).toHaveAttribute('aria-hidden', 'false');
  await expect.poll(() => flow.evaluate((element) => element.scrollTop)).toBeLessThan(dimensions.clientHeight * 0.2);
});

test('landing controls meet touch sizing and Google uses its official color mark', async ({ page }) => {
  await page.goto('/');

  const themeSize = await page.getByRole('button', { name: 'Use dark mode' }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(themeSize.width).toBeGreaterThanOrEqual(44);
  expect(themeSize.height).toBeGreaterThanOrEqual(44);

  await page.getByRole('button', { name: 'Enter Tokko' }).click();
  await page.getByRole('button', { name: 'Set up my family' }).click();
  const googleMark = page.locator('.tokko-google-mark img');
  await expect(googleMark).toHaveAttribute('src', '/assets/google-g.svg');
  await expect(googleMark).toBeVisible();
});

test('iPhone viewport uses responsive composition without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 659 });
  await page.goto('/');

  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /width=device-width/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);

  await page.getByRole('button', { name: 'Enter Tokko' }).click();
  const pathWidth = await page.locator('.tokko-agent-path').evaluate((element) => element.getBoundingClientRect().width);
  expect(pathWidth).toBeLessThanOrEqual(353);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);

  await page.getByRole('button', { name: 'Set up my family' }).click();
  const authColumns = await page.locator('.tf-auth-screen > main').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(authColumns.trim().split(/\s+/)).toHaveLength(1);
  const authCard = await page.locator('.tf-auth-card').boundingBox();
  expect(authCard.width).toBeGreaterThan(340);
  expect(authCard.x).toBeGreaterThanOrEqual(16);
  const emailFontSize = await page.getByLabel('Email').evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(emailFontSize).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
});
