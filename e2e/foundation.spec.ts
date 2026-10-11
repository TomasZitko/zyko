import { expect, test, type Page } from "@playwright/test";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const uid = Date.now();

async function signup(page: Page, name: string, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

const canvas = (page: Page) => page.frameLocator('iframe[title="Page canvas"]');
const saved = (page: Page) => expect(page.getByTestId("save-state")).toHaveText("All changes saved");

test("milestone 1: full connected foundation through the UI", async ({ page, browser }) => {
  // 1. Register
  await signup(page, "Alice", `alice-${uid}@example.com`);

  // 2. Organization + project
  await page.getByLabel("Organization name").fill("Alice Studio");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("Corner Bakery");
  await page.getByLabel("What does the business do?").fill("Sourdough and pastries in Brno");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/app\/p\/[0-9a-f-]+$/);
  const projectId = page.url().split("/").pop()!;

  // 3. Project information
  await page.getByLabel("Target audience").fill("Neighbours and office workers");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  // 4. AI conversation with persisted project context
  await page.getByRole("link", { name: "Assistant" }).click();
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.getByLabel("Message").fill("What is this project about?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".msg.assistant").last()).toContainText("Sourdough and pastries in Brno");
  await page.reload();
  await expect(page.locator(".msg.user").first()).toContainText("What is this project about?");

  // 5. Asset upload
  await page.getByRole("link", { name: "Assets" }).click();
  await page.getByLabel("Upload files").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("logo.png")).toBeVisible();

  // 6-8. Structured page + registered fixture component renders in the editor canvas
  await page.getByRole("link", { name: "Editor" }).click();
  await expect(canvas(page).locator("h1")).toHaveText("Welcome");
  await expect(page.getByRole("treeitem").filter({ hasText: "Heading — Welcome" }).first()).toBeVisible();

  // 9-10. Edit properties (panel + inline), insert an image, persist
  await page.getByRole("button", { name: "Heading — Welcome" }).click();
  const textInput = page.getByRole("complementary", { name: "Properties" }).getByLabel("Text");
  await textInput.fill("Fresh bread daily");
  await expect(canvas(page).locator("h1")).toHaveText("Fresh bread daily");
  await saved(page);
  await page.getByRole("button", { name: /^Text — / }).click();
  await canvas(page).locator("p.fx-p").dblclick();
  await canvas(page).locator("p.fx-p").press("ControlOrMeta+a");
  await canvas(page).locator("p.fx-p").pressSequentially("Open every morning");
  await canvas(page).locator("p.fx-p").press("Enter");
  await saved(page);
  await page.getByRole("button", { name: /^Section/ }).click();
  await page.getByLabel("Component type").selectOption({ label: "Image (fixture)" });
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await page.getByRole("complementary", { name: "Properties" }).getByLabel("Image").selectOption({ label: "logo.png" });
  await expect(canvas(page).locator("img.fx-img")).toBeVisible();
  await saved(page);
  await page.reload();
  await expect(canvas(page).locator("h1")).toHaveText("Fresh bread daily");
  await expect(canvas(page).locator("p.fx-p")).toHaveText("Open every morning");
  await expect(canvas(page).locator("img.fx-img")).toBeVisible();

  // Undo / redo
  await page.getByRole("button", { name: "Heading — Fresh bread daily" }).click();
  await textInput.fill("Temporary");
  await saved(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(canvas(page).locator("h1")).toHaveText("Fresh bread daily");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(canvas(page).locator("h1")).toHaveText("Temporary");
  await page.getByRole("button", { name: "Undo" }).click();
  await saved(page);

  // 11. AI tool safely updates structured content
  const pages = await (await page.request.get(`/api/projects/${projectId}/pages`)).json();
  const home = (await (await page.request.get(`/api/pages/${pages.pages[0].id}`)).json()).page;
  const headingId = home.document.root[1].slots.default[0].id;
  await page.getByRole("link", { name: "Assistant" }).click();
  await page.getByLabel("Message").fill(`/tool apply_page_changes ${JSON.stringify({ pageId: home.id, baseVersion: home.version, ops: [{ op: "update_props", nodeId: headingId, props: { text: "Written by the assistant" } }] })}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".msg .tool").last()).toContainText("succeeded");
  await page.getByRole("link", { name: "Editor" }).click();
  await expect(canvas(page).locator("h1")).toHaveText("Written by the assistant");

  // 12. Revert via version history
  await page.getByText("Version history").click();
  const userRev = page.locator("li").filter({ hasText: `v${home.version} ` }).first();
  await userRev.getByRole("button", { name: "Restore" }).click();
  await expect(canvas(page).locator("h1")).toHaveText("Fresh bread daily");

  // 13. Preview
  await page.getByRole("link", { name: "Publish" }).click();
  await page.getByRole("button", { name: "Build preview" }).click();
  const previewHref = await page.getByTestId("preview-url").getAttribute("href");
  const preview = await browser.newPage();
  await preview.goto(previewHref!);
  await expect(preview.locator("h1")).toHaveText("Fresh bread daily");
  await preview.close();

  // 14-15. Publish via the assistant's approval flow, then visit the live address
  await page.getByRole("link", { name: "Assistant" }).click();
  await page.getByLabel("Message").fill("/tool publish_site {}");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("link", { name: "Publish" }).click();
  const live = page.getByTestId("live-url");
  await expect(live).toBeVisible({ timeout: 15_000 });
  const liveUrl = (await live.getAttribute("href"))!;
  expect(liveUrl).toMatch(/^http:\/\/corner-bakery-[a-z0-9-]+\.sites\.localhost:4100\/$/);
  const site = await browser.newPage();
  await site.goto(liveUrl);
  await expect(site.locator("h1")).toHaveText("Fresh bread daily");
  await expect(site.locator("img.fx-img")).toBeVisible();
  await expect(site).toHaveTitle("Home");
  await site.close();

  // 16. Back to dashboard, continue editing
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByText("Published")).toBeVisible();
  await page.getByText("Corner Bakery").click();
  await page.getByRole("link", { name: "Editor" }).click();
  await page.getByRole("button", { name: "Heading — Fresh bread daily" }).click();
  await textInput.fill("Next draft");
  await saved(page);

  // 17. Another user cannot access the project
  const ctx2 = await browser.newContext();
  const mallory = await ctx2.newPage();
  await signup(mallory, "Mallory", `mallory-${uid}@example.com`);
  await mallory.goto(`/app/p/${projectId}`);
  await expect(mallory.getByRole("alert")).toContainText("Project not found");
  const r = await mallory.request.get(`/api/projects/${projectId}`);
  expect(r.status()).toBe(404);
  await ctx2.close();
});
