/** Demo 固定的五个用户，对应 SQLite 里的画像种子。 */
export const DEMO_USERS = [
  {
    id: "user_active",
    label: "用户 A · 活跃型",
    display_name: "用户 A",
    profile_label: "活跃型",
  },
  {
    id: "user_budget",
    label: "用户 B · 价格敏感型",
    display_name: "用户 B",
    profile_label: "价格敏感型",
  },
  {
    id: "user_vip",
    label: "用户 C · 高价值型",
    display_name: "用户 C",
    profile_label: "高价值型",
  },
  {
    id: "user_new",
    label: "用户 D · 新客型",
    display_name: "用户 D",
    profile_label: "新客型",
  },
  {
    id: "user_churn",
    label: "用户 E · 流失风险型",
    display_name: "用户 E",
    profile_label: "流失风险型",
  },
] as const;

export const DEMO_USER_IDS = new Set<string>(DEMO_USERS.map((user) => user.id));
