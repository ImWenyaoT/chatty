/**
 * 仓库布局的唯一定义。
 *
 * 每个文件各自数 `../` 上溯到仓库根，会让层级深度不同的文件写出不同的字面量，
 * 移动文件时不会报错、只会静默指向别处，所以这里集中一次。
 */

export const REPO_ROOT = new URL("../../", import.meta.url);

/** SQLite 的初始化种子，不是运行时业务查询接口。 */
export const DATA_DIR = new URL("data/", REPO_ROOT);

export const FRONTEND_DIST = new URL("frontend/dist/", REPO_ROOT);
