/** vite build 的输出目录。api 在同一进程里托管它，因此由这个包自己给出位置。 */
export const DIST_DIR = new URL("dist/", import.meta.url);
