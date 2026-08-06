/** 存活探针。与其余端点一起收在 `/api` 下，API 面只有一处入口。 */
export function GET() {
  return Response.json({ status: "ok" as const });
}
