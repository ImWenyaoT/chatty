"use client";

import { Selector } from "@astryxdesign/core/Selector";
import type { DemoUser } from "@/lib/api-client";

export function UserPicker({
  users,
  value,
  onChange,
  disabled = false,
}: {
  users: DemoUser[];
  value: string;
  onChange: (userId: string) => void;
  disabled?: boolean;
}) {
  return (
    <Selector
      label="演示用户"
      description="切换身份会开启新会话，便于对比画像对推荐的影响。"
      options={users.map((user) => ({
        value: user.id,
        label: user.label,
      }))}
      value={value}
      onChange={(next) => {
        if (next !== null) onChange(next);
      }}
      isDisabled={disabled}
      size="sm"
      variant="secondary"
      width="100%"
    />
  );
}
