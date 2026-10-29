import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readApiEnv } from "./users";
import { completeOnboardingIfRequired } from "./onboarding";

// Real browser, gateway, auth and SQL. Faults drop committed responses and
// rate-limit a replay to prove history navigation cannot duplicate a write.
test("owner configures intake, Legal clarifies and shares an exact answer once", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(150000);
  const supabase = readApiEnv("SUPABASE_URL")!;
  const key = readApiEnv("SUPABASE_SECRET_KEY")!;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const org = randomUUID();
  const people: { id: string; email: string; password: string; page: Page }[] =
    [];
  const errors: string[] = [];
  async function admin(path: string, method: string, body?: unknown) {
    const response = await fetch(supabase + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(
        `Test fixture ${method} ${path}: ${response.status} ${await response.text()}`,
      );
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  try {
    for (const name of ["Owner", "Requester", "Lawyer"]) {
      const email = `intake-browser-${randomUUID()}@test.local`;
      const password = `IntakeTest-${randomUUID()}!`;
      const user = await admin("/auth/v1/admin/users", "POST", {
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: `Intake ${name}` },
      });
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          /maximum update depth|too many re-renders|getSnapshot.*cached|ResizeObserver loop/i.test(
            message.text(),
          )
        )
          errors.push(message.text());
      });
      if (process.env.REACT_STRESS === "1") {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      }
      people.push({ id: user.id, email, password, page });
      await page.goto("/login");
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await completeOnboardingIfRequired(page);
    }
    await admin("/rest/v1/organizations", "POST", {
      id: org,
      name: "Intake browser team",
      created_by: people[0].id,
    });
    await admin(
      "/rest/v1/org_members",
      "POST",
      people.map((p, i) => ({
        org_id: org,
        user_id: p.id,
        role: i === 0 ? "owner" : "member",
      })),
    );
    for (const p of people)
      await p.page
        .context()
        .addInitScript(
          ({ id, org }) =>
            localStorage.setItem(`mike.activeWorkspace.${id}`, org),
          { id: p.id, org },
        );
    const [owner, requester, lawyer] = people.map((p) => p.page);
    const emailPattern = (email: string) =>
      new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    await owner.goto("/intake");
    // Intake is on by default; requests wait until an owner picks the team.
    await expect(
      owner.getByRole("button", { name: "New request" }),
    ).toBeDisabled();
    await owner
      .getByRole("button", { name: "Intake settings", exact: true })
      .click();
    // The Legal team starts as everyone; keep only the lawyer.
    for (const person of people.slice(0, 2))
      await owner
        .getByRole("checkbox", { name: emailPattern(person.email) })
        .uncheck();
    await expect(
      owner.getByRole("checkbox", { name: emailPattern(people[2].email) }),
    ).toBeChecked();
    await owner.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      owner.getByRole("button", { name: "New request" }),
    ).toBeEnabled();
    await requester.goto("/assistant");
    await requester
      .getByRole("button", { name: "Intake", exact: true })
      .click();
    await expect(
      requester.getByRole("button", { name: "New request" }),
    ).toBeEnabled();
    await requester.getByRole("button", { name: "New request" }).focus();
    await requester.keyboard.press("Enter");
    const requestType = requester.getByRole("group", { name: "Request type" });
    await expect(requestType).toBeVisible();
    await requestType.getByRole("button", { name: "NDA request" }).click();
    await requester
      .getByLabel("Subject", { exact: true })
      .fill("Synthetic supplier NDA");
    await requester
      .getByLabel("What do you need help with?")
      .fill("Please check the supplier's confidentiality terms.");
    await requester.getByLabel("Target date (optional)").fill("2026-11-10");
    await requester.getByLabel("Timezone").fill("Europe/Stockholm");
    await requester.goBack();
    await expect(requester).toHaveURL(/\/assistant/);
    await requester.goForward();
    await expect(requester.getByLabel("Subject", { exact: true })).toHaveValue(
      "Synthetic supplier NDA",
    );
    await expect(
      requestType.getByRole("button", { name: "NDA request" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(requester.getByLabel("Target date (optional)")).toHaveValue(
      "2026-11-10",
    );
    await expect(requester.getByLabel("Timezone")).toHaveValue(
      "Europe/Stockholm",
    );
    const submissions: unknown[] = [];
    await requester.route("**/api/intake/*/requests", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 2)
        return route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Try again later." }),
        });
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (submissions.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await requester.getByRole("button", { name: "Submit request" }).click();
    await expect(
      requester.getByRole("button", { name: "Check again" }),
    ).toBeEnabled();
    await requester.goBack();
    await requester.goForward();
    await expect(
      requester.getByLabel("Subject", { exact: true }),
    ).toBeDisabled();
    await requester.getByRole("button", { name: "Check again" }).click();
    await expect(requester).toHaveURL(/\/intake\/[0-9a-f-]+\?org=/);
    expect(submissions).toHaveLength(3);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[2]).toEqual(submissions[0]);

    const detailURL = requester.url();
    const storedRequests = await admin(
      `/rest/v1/intake_requests?org_id=eq.${org}&select=id`,
      "GET",
    );
    expect(storedRequests).toHaveLength(1);

    await expect(
      requester.getByText(
        "Please check the supplier's confidentiality terms.",
        { exact: true },
      ),
    ).toBeVisible();
    await lawyer.goto("/intake");
    await lawyer
      .getByRole("button", { name: "Legal queue", exact: true })
      .click();
    await lawyer.getByRole("link", { name: "Synthetic supplier NDA" }).click();
    await lawyer.getByLabel("Assigned lawyer", { exact: true }).click();
    await lawyer
      .getByRole("menuitem", { name: "Intake Lawyer", exact: true })
      .click();
    await lawyer.getByRole("button", { name: "Save assignment" }).click();
    await expect(
      lawyer.getByRole("button", { name: "Ask for information" }),
    ).toBeVisible();
    await lawyer
      .getByLabel("Message to the requester")
      .fill("What is the supplier's name?");
    await lawyer.goBack();
    await lawyer.goForward();
    await expect(lawyer.getByLabel("Message to the requester")).toHaveValue(
      "What is the supplier's name?",
    );
    await lawyer.getByRole("button", { name: "Ask for information" }).click();
    await expect(
      lawyer.getByText("What is the supplier's name?", { exact: true }),
    ).toBeVisible();
    await requester.reload();
    await requester
      .getByLabel("Message to Legal")
      .fill("Synthetic Supplier Ltd");
    await requester.getByRole("button", { name: "Send reply" }).click();
    await expect(
      requester.getByText("Synthetic Supplier Ltd", { exact: true }),
    ).toBeVisible();
    await lawyer.reload();
    const answer =
      "Reviewed answer.\nPlease use the agreed confidentiality period.\n" +
      "LongReference".repeat(30);
    await lawyer.getByLabel("Message to the requester").fill("Old draft");
    await lawyer.getByRole("button", { name: "Preview answer" }).click();
    await lawyer.getByLabel("Message to the requester").fill(answer);
    await expect(
      lawyer.getByRole("button", { name: "Share answer and resolve" }),
    ).toHaveCount(0);
    await lawyer.getByRole("button", { name: "Preview answer" }).click();
    await expect(
      lawyer
        .getByRole("region", { name: "Answer preview" })
        .getByText(answer, { exact: true }),
    ).toBeVisible();
    let dropped = false;
    const commands: unknown[] = [];
    await lawyer.route("**/api/intake/*/requests/*/answer", async (route) => {
      commands.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (!dropped) {
        expect(response.ok()).toBe(true);
        dropped = true;
        await route.abort("failed");
      } else await route.fulfill({ response });
    });
    await lawyer
      .getByRole("button", { name: "Share answer and resolve" })
      .click();
    await expect(
      lawyer.getByRole("definition").getByText("Resolved", { exact: true }),
    ).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    await requester.reload();
    await expect(
      requester
        .getByRole("region", { name: "Conversation" })
        .getByText(answer, { exact: true }),
    ).toHaveCount(1);
    await expect(
      requester.getByRole("button", { name: "Cancel request" }),
    ).toHaveCount(0);
    await requester.setViewportSize({ width: 375, height: 812 });
    for (const dark of [false, true]) {
      // Exercise the same root class and color-scheme used by applyDarkMode.
      await requester.evaluate((enabled) => {
        document.documentElement.classList.toggle("dark", enabled);
        document.documentElement.style.colorScheme = enabled ? "dark" : "light";
      }, dark);
      expect(
        await requester.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const scan = await new AxeBuilder({ page: requester }).analyze();
      expect(scan.violations.filter((v) => v.impact === "critical")).toEqual(
        [],
      );
      await requester.screenshot({
        path: test.info().outputPath(`intake-${dark ? "dark" : "light"}.png`),
        fullPage: true,
      });
      const answerText = requester
        .getByRole("region", { name: "Conversation" })
        .getByText(answer, { exact: true });
      await answerText.scrollIntoViewIfNeeded();
      expect(
        await answerText.evaluate(
          (node) => node.scrollWidth <= node.clientWidth,
        ),
      ).toBe(true);
      await requester.screenshot({
        path: test
          .info()
          .outputPath(`intake-answer-${dark ? "dark" : "light"}.png`),
      });
    }
    await owner.goto(detailURL);
    await expect(owner.getByRole("alert")).toBeVisible();
    await expect(
      owner.getByText("Please check the supplier's confidentiality terms.", {
        exact: true,
      }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await admin(`/rest/v1/organizations?id=eq.${org}`, "DELETE");
    for (const p of people) {
      await p.page.context().close();
      await admin(`/auth/v1/admin/users/${p.id}`, "DELETE");
    }
  }
});
