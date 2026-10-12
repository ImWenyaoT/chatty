import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DemoUser } from "@/lib/api-client";

export function UserPicker({
  users,
  value,
  onChange,
  disabled,
}: {
  users: DemoUser[];
  value: string;
  onChange: (userId: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-[var(--color-muted-foreground)]">
        演示用户
      </p>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label="演示用户">
          <SelectValue placeholder="选择用户" />
        </SelectTrigger>
        <SelectContent className="w-[var(--radix-select-trigger-width)] min-w-[14rem]">
          {users.map((user) => (
            <SelectItem key={user.id} value={user.id}>
              {user.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs leading-relaxed text-[var(--color-muted-foreground)]">
        切换身份会开启新会话，便于对比画像对推荐的影响。
      </p>
    </div>
  );
}
