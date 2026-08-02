const { test, expect } = require('@playwright/test');

function accountState(overrides = {}) {
  return {
    account: { email: 'connector@example.com' },
    profileComplete: true,
    merchantConnected: false,
    merchantConsent: { consented: false },
    profile: {
      primaryParentName: 'Indian Owner',
      primaryParentPhone: '+919876543210',
      merchantAuthSubjectType: 'account_holder',
      merchantAuthPhone: '+919876543210',
      dependents: [{
        id: 44,
        name: 'UK Family',
        phone: '+447700900123',
        relationshipToUser: 'Mother',
      }],
    },
    paymentMethods: [],
    ...overrides,
  };
}

test('Connectors chooses the merchant phone and opens Zepto OTP in a modal', async ({ page }) => {
  let profilePayload = null;
  await page.addInitScript(() => {
    localStorage.setItem('tokko-flow-version', 'scroll-v3');
    localStorage.setItem('tokko-view', JSON.stringify('dashboard'));
    localStorage.setItem('tokko-dashboard-page', JSON.stringify('connectors'));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (path === '/api/me') return json(accountState());
    if (path === '/api/onboarding/profile' && request.method() === 'PUT') {
      profilePayload = request.postDataJSON();
      return json(accountState());
    }
    if (path === '/api/onboarding/merchant-consent') {
      return json(accountState({ merchantConsent: { consented: true } }));
    }
    if (path === '/api/merchant/zepto/connect/start') {
      return json({ pendingId: 'pending-otp', phone: '+919876543210' }, 201);
    }
    return json({ error: `Unhandled mocked route: ${path}` }, 404);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Zepto' }).click();

  const dialog = page.getByRole('dialog', { name: 'Which number should Zepto use?' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('UK Family', { exact: true }).click();
  await expect(dialog.getByText('Merchant phone not supported')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Send OTP' })).toBeDisabled();

  await dialog.getByText('Indian Owner', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Send OTP' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your verification code' })).toBeVisible();
  expect(profilePayload.merchantAuthPhone).toBe('+919876543210');
  expect(profilePayload.merchantAuthSubjectType).toBe('account_holder');
});

test('Family details can be saved with no dependents', async ({ page }) => {
  let profilePayload = null;
  const state = accountState({
    profile: {
      primaryParentName: 'Solo Owner',
      primaryParentPhone: '+919876543210',
      merchantAuthSubjectType: 'account_holder',
      merchantAuthPhone: '+919876543210',
      dependents: [],
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('tokko-flow-version', 'scroll-v3');
    localStorage.setItem('tokko-view', JSON.stringify('dashboard'));
    localStorage.setItem('tokko-dashboard-page', JSON.stringify('family'));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (path === '/api/me') return json(state);
    if (path === '/api/onboarding/profile' && request.method() === 'PUT') {
      profilePayload = request.postDataJSON();
      return json(state);
    }
    if (path === '/api/orders') return json({ orders: [] });
    if (path === '/api/checkout/activity') return json({ checkoutFlows: [] });
    if (path === '/api/payments/mandates') return json({ mandates: [] });
    return json({});
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Add a dependent (optional)' })).toBeVisible();
  await page.getByRole('button', { name: 'Save family and continue' }).click();
  await expect(page.getByRole('heading', { name: /Good morning, Solo/ })).toBeVisible();
  expect(profilePayload.dependents).toEqual([]);
});

test('Personal shopper uses the full dashboard workspace', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tokko-flow-version', 'scroll-v3');
    localStorage.setItem('tokko-view', JSON.stringify('dashboard'));
    localStorage.setItem('tokko-dashboard-page', JSON.stringify('assistant'));
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (path === '/api/me') return json(accountState());
    if (path === '/api/merchant/zepto/addresses') return json({ addresses: [] });
    return json({});
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Personal shopper' })).toBeVisible();
  await expect(page.locator('.dashboard-page')).toHaveClass(/assistant-mode/);
  await expect(page.locator('.shopper-message-avatar')).toHaveCount(0);
  const heights = await page.evaluate(() => ({
    viewport: window.innerHeight,
    shopper: document.querySelector('.shopper-shell').getBoundingClientRect().height,
  }));
  expect(Math.abs(heights.viewport - heights.shopper)).toBeLessThanOrEqual(1);
});
