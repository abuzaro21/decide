// Judge journey through the real UI. Every assertion about the verdict is cross-checked against the backend
// decision record for the same proposal, so the UI cannot show an outcome the engine did not produce.
import { test, expect, type Page } from '@playwright/test';

const verdict = (page: Page) => page.locator('.verdict-word');
async function backendOutcome(page: Page) {
  const pid = await page.evaluate(async () => {
    const a = await (await fetch('/api/audit')).json();
    return [...a.events].reverse().find((e: any) => e.event.proposalId)?.event.proposalId;
  });
  const v = await page.evaluate(async (id) => (await fetch(`/api/proposals/${id}`)).json(), pid);
  return v.status === 'CLOSED_EXECUTED' ? 'EXECUTE' : v.decision.outcome;
}
async function expectTruthful(page: Page, outcome: string) {
  await expect(verdict(page)).toHaveText(outcome);
  expect(await backendOutcome(page)).toBe(outcome);
}

test('Confidence Trap: DEFER → DEFER → ESCALATE → approve → EXECUTE → executed once; audit verifies and replays', async ({ page }) => {
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await expect(page.getByText('Agent says 99% sure.')).toBeVisible();
  await expect(page.getByText(/no gate reads it/).first()).toBeVisible();
  await expect(page.getByText('What would change this decision?')).toBeVisible();

  await page.getByRole('button', { name: /fresh, healthy telemetry/ }).click();
  await expectTruthful(page, 'DEFER');
  await page.getByRole('button', { name: /rollback drill passes/ }).click();
  await expectTruthful(page, 'ESCALATE');
  await expect(page.getByText(/Sit as Release owner/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve this snapshot' }).click();
  await expectTruthful(page, 'EXECUTE');
  await page.getByRole('button', { name: /^Execute/ }).click();
  await expect(page.getByText('Executed exactly once.', { exact: false })).toBeVisible();
  await expect(page.locator('.receipt')).toContainText('DEPLOYED');

  await page.getByRole('tab', { name: /Audit trail/ }).click();
  await expect(page.getByText(/Chain verified/)).toBeVisible();
  await page.getByRole('button', { name: 'Replay current decision' }).click();
  await expect(page.getByText(/Replayed decision .*: identical ✓/)).toBeVisible();
});

test('swapping the artifact after approval kills the approval', async ({ page }) => {
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await page.getByRole('button', { name: /fresh, healthy telemetry/ }).click();
  await page.getByRole('button', { name: /rollback drill passes/ }).click();
  await page.getByRole('button', { name: 'Approve this snapshot' }).click();
  await expectTruthful(page, 'EXECUTE');
  await page.getByRole('button', { name: /swaps in a different artifact/ }).click();
  await expectTruthful(page, 'DEFER');
  await expect(page.getByText(/revision 2/)).toBeVisible();
});

test('vendor BEC: adjudicate, callback denied → REFUSE; no execute control is offered', async ({ page }) => {
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await page.getByRole('button', { name: 'Changed bank details' }).click();
  await expectTruthful(page, 'ESCALATE');
  await expect(page.getByText(/genuine · claude-haiku-5-5/)).toBeVisible();
  await page.getByRole('button', { name: /Keep the vendor-master account/ }).click();
  await expectTruthful(page, 'DEFER');
  await page.getByRole('button', { name: /never changed their bank account/ }).click();
  await expectTruthful(page, 'REFUSE');
  await expect(page.getByRole('button', { name: /^Execute/ })).toHaveCount(0);
});

test('injected approval in ticket text → ASK; verification for this exact address → EXECUTE', async ({ page }) => {
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await page.getByRole('button', { name: 'Injected approval' }).click();
  await expectTruthful(page, 'ASK');
  await page.getByRole('button', { name: /completes identity verification/ }).click();
  await expectTruthful(page, 'EXECUTE');
});

test('known failure: both monitors blind — engine allows it and the page says so', async ({ page }) => {
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await page.getByRole('button', { name: 'Known failure' }).click();
  await expectTruthful(page, 'ESCALATE');
  await expect(page.getByText(/invisible to every monitor/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve this snapshot' }).click();
  await page.getByRole('button', { name: /^Execute/ }).click();
  await expect(page.getByText(/DECIDE executed: its evidence was fresh/)).toBeVisible();
});

test('G5-01 a replay result is shown only for the decision it replayed', async ({ page }) => {
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await page.getByRole('tab', { name: /Audit trail/ }).click();
  await page.getByRole('button', { name: 'Replay current decision' }).click();
  await expect(page.getByText(/Replayed decision .*: identical ✓/)).toBeVisible();
  await page.getByRole('button', { name: /fresh, healthy telemetry/ }).click();
  await expectTruthful(page, 'DEFER');
  await expect(page.getByText(/Replayed decision .*: identical ✓/)).toHaveCount(0);
});

test('G5-03 known-failure panel never contradicts the current evidence', async ({ page }) => {
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await page.getByRole('button', { name: 'Known failure' }).click();
  await expect(page.getByText(/approval is the only thing left/)).toBeVisible();
  await page.getByRole('button', { name: /Both monitors report 3.2% errors/ }).click();
  await expectTruthful(page, 'DEFER');
  await expect(page.getByText(/evidence has changed since then/)).toBeVisible();
  await expect(page.getByText(/approval is the only thing left/)).toHaveCount(0);
});

test('@mobile renders without horizontal scroll and shows the verdict', async ({ page }) => {
  await page.goto('/');
  await expect(verdict(page)).toHaveText('DEFER');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('first load: a late session response cannot split the page across two sessions', async ({ page }) => {
  // Reproduces the live-network race: boot requests and the scenario load each start a session; if the older
  // session's Set-Cookie lands after the scenario was created, later requests read a session that does not own it.
  let release!: () => void;
  const scenarioCreated = new Promise<void>((r) => { release = r; });
  let posts = 0;
  await page.route('**/api/session', async (route) => {
    const hold = route.request().method() === 'POST' && posts++ === 0;
    const response = await route.fetch();
    if (hold) await Promise.race([scenarioCreated, new Promise((r) => setTimeout(r, 3000))]);
    await route.fulfill({ response });
  });
  await page.route('**/api/scenarios/*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
    if (route.request().method() === 'POST') release();
  });
  await page.goto('/');
  await expectTruthful(page, 'DEFER');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
