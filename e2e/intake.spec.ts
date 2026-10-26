import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readApiEnv } from "./users";
import { completeOnboardingIfRequired } from "./onboarding";

// Real browser, gateway, auth and SQL. The only intercepted response is dropped
// AFTER the real server commits, to verify retrying cannot duplicate an answer.
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
    await owner.goto(`/organizations/${org}/settings/intake`);
    await owner.getByRole("checkbox", { name: "Enable intake" }).check();
    await owner
      .getByRole("checkbox", {
        name: new RegExp(
          people[2].email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      })
      .check();
    await owner.getByRole("button", { name: "Save intake settings" }).click();
    await expect(
      owner.getByRole("button", { name: "Save intake settings" }),
    ).toBeEnabled();
    await requester.goto("/intake");
    await requester.getByRole("button", { name: "New request" }).click();
    await requester.getByLabel("Request type").selectOption("nda");
    await requester
      .getByLabel("Subject", { exact: true })
      .fill("Synthetic supplier NDA");
    await requester
      .getByLabel("What do you need help with?")
      .fill("Please check the supplier's confidentiality terms.");
    await requester.getByRole("button", { name: "Submit request" }).click();
    await expect(requester).toHaveURL(/\/intake\/[0-9a-f-]+\?org=/);
    const detailURL = requester.url();
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
    await lawyer
      .getByLabel("Assigned lawyer", { exact: true })
      .selectOption(people[2].id);
    await lawyer.getByRole("button", { name: "Save assignment" }).click();
    await expect(
      lawyer.getByRole("button", { name: "Ask for information" }),
    ).toBeVisible();
    await lawyer
      .getByLabel("Message to the requester")
      .fill("What is the supplier's name?");
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
      "Reviewed answer.\nPlease use the agreed confidentiality period.";
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
      lawyer.getByText("resolved · NDA request", { exact: true }),
    ).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    await requester.reload();
    await expect(
      requester.locator("article").getByText(answer, { exact: true }),
    ).toHaveCount(1);
    await expect(
      requester.getByRole("button", { name: "Cancel request" }),
    ).toHaveCount(0);
    await requester.setViewportSize({ width: 375, height: 812 });
    expect(
      await requester.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const scan = await new AxeBuilder({ page: requester }).analyze();
    expect(scan.violations.filter((v) => v.impact === "critical")).toEqual([]);
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
