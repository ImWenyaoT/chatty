"use client";

import { AppShell } from "@astryxdesign/core/AppShell";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import {
  ChatBubbleLeftRightIcon,
  CircleStackIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";

export type ChattyView = "chat" | "catalog";

type ChattyShellProps = {
  view: ChattyView;
  summary: string;
  sidebarExtra?: React.ReactNode;
  children: React.ReactNode;
};

export function ChattyShell({
  view,
  summary,
  sidebarExtra,
  children,
}: ChattyShellProps) {
  return (
    <AppShell
      contentPadding={0}
      height="fill"
      variant="elevated"
      sideNav={
        <SideNav
          collapsible
          resizable={{ defaultWidth: 280, minWidth: 220, maxWidth: 360 }}
          header={
            <SideNavHeading
              heading="Chatty"
              icon={
                <NavIcon icon={<Icon icon={SparklesIcon} size="sm" />} />
              }
              headingHref="/"
            />
          }
          footer={
            <SideNavSection title="状态" isHeaderHidden>
              <VStack gap={2} paddingInline={3} paddingBlock={2}>
                <Text type="supporting" color="secondary">
                  {summary}
                </Text>
                {sidebarExtra}
              </VStack>
            </SideNavSection>
          }
        >
          <SideNavSection title="导航" isHeaderHidden>
            <SideNavItem
              label="对话"
              href="/"
              isSelected={view === "chat"}
              icon={ChatBubbleLeftRightIcon}
            />
            <SideNavItem
              label="商品目录"
              href="/catalog"
              isSelected={view === "catalog"}
              icon={CircleStackIcon}
            />
          </SideNavSection>
          <Divider />
          <SideNavSection title="说明">
            <VStack gap={1} paddingInline={3} paddingBlock={1}>
              <Text type="supporting" color="secondary">
                价格与库存来自 SQLite；推荐须经 Evidence 校验。
              </Text>
            </VStack>
          </SideNavSection>
        </SideNav>
      }
    >
      {children}
    </AppShell>
  );
}
