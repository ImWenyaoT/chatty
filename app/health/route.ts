/** 存活探针。路径保持契约里的 `/health`，所以不在 `/api` 下。 */
export function GET() {
  return Response.json({ status: "ok" as const });
}
