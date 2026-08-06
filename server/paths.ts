/**
 * 仓库根的位置。
 *
 * `.env` 和 `.env.local` 是仓库级配置，不属于任何一个包，所以这里仍然需要上溯。
 * 种子数据与前端产物则不同，它们各自属于一个包，由那个包自己导出位置。
 */
export const REPO_ROOT = new URL("../", import.meta.url);
