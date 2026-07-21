import { expect, test } from '@playwright/test'

test('root opens the Agent content workbench', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/workbench$/)
  await expect(
    page.getByRole('heading', { name: 'Agent 内容工作台' }),
  ).toBeVisible()
})

test('browser completes research, human approval, and sandbox export', async ({
  page,
}) => {
  await page.goto('/workbench')
  await page.getByRole('button', { name: '运行 Agent' }).click()

  await expect(
    page.getByRole('heading', {
      name: '高精地图产业研究简报',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '高精地图内容包', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('等待人工批准').first()).toBeVisible()

  await page.getByRole('button', { name: '批准内容包' }).click()
  await expect(page.getByText('已批准')).toBeVisible()

  await page.getByRole('button', { name: '请求沙箱导出' }).click()
  await expect(page.getByText('已导出', { exact: true })).toBeVisible()
  await expect(page.getByText(/delivery receipt/)).toBeVisible()
  await expect(page.getByText(/delivery:/)).toBeVisible()
})
