/** 全量商品与画像，给「看看数据」面板用。 */

import { DEMO_USERS } from "../../../../data/demo-users.ts";
import { catalog } from "../../../../lib/runtime.ts";

export function GET() {
  return Response.json({
    products: catalog.products,
    profiles: DEMO_USERS.map((user) => ({
      ...catalog.userProfile(user.id),
      display_name: user.display_name,
      profile_label: user.profile_label,
    })),
  });
}
