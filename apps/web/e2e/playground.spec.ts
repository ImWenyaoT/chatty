import { expect, test } from "@playwright/test";

test("browser reaches the real FastAPI Agent and persisted Harness trace", async ({
  page,
}) => {
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "客户消息" }).fill("你好");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByRole("log")).toContainText("浏览器链路已完成。");
  await expect(
    page.getByRole("complementary", { name: "运行详情" }),
  ).toContainText("已回复");
  await expect(
    page.getByRole("complementary", { name: "运行详情" }),
  ).toContainText("not_applicable");

  await page.goto("/dashboard");
  await expect(page.getByText("browser-smoke-model")).toBeVisible();
  await page.getByRole("tab", { name: "Model / Tool spans" }).click();
  await expect(page.getByText("Agent run completed")).toBeVisible();
});
