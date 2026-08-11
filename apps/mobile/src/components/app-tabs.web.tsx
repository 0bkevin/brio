import {
  Tabs,
  TabList,
  TabTrigger,
  TabSlot,
  type TabListProps,
  type TabTriggerSlotProps,
} from 'expo-router/ui';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { SectionLabel, StatusBadge, ThemeSwitcher } from './dashboard';
import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useConnectionStore } from '@/state/connection-store';

export default function AppTabs() {
  const colors = useTheme();

  return (
    <Tabs>
      <TabSlot
        style={[
          styles.slot,
          styles.slotWide,
          { backgroundColor: colors.background },
        ]}
      />
      <TabList asChild>
        <SidebarNav>
          <TabTrigger name="chat" href="/" asChild>
            <SidebarButton icon="message" label="Chat" />
          </TabTrigger>
          <TabTrigger name="manage" href="/explore" asChild>
            <SidebarButton icon="gearshape" label="Manage" />
          </TabTrigger>
        </SidebarNav>
      </TabList>
    </Tabs>
  );
}

function SidebarNav({ children, compact, ...props }: TabListProps & { compact?: boolean }) {
  const colors = useTheme();
  const connection = useConnectionStore((state) => state.connection);

  return (
    <View
      {...props}
      style={[
        styles.sidebar,
        compact && styles.sidebarCompact,
        { backgroundColor: colors.panel, borderColor: colors.border },
      ]}>
      <View style={[styles.brandBlock, compact && styles.compactHidden, { borderColor: colors.border }]}>
        <ThemedText type="brand" style={styles.brandText}>
          Brio
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Hermes Agent
        </ThemedText>
      </View>

      <View style={[styles.navGroup, compact && styles.navGroupCompact]}>
        <SectionLabel>Navigation</SectionLabel>
        {children}
      </View>

      <View style={[styles.navGroup, compact && styles.compactHidden]}>
        <SectionLabel>Status</SectionLabel>
        <StatusBadge tone={connection ? 'success' : 'warning'}>
          {connection ? connection.status : 'disconnected'}
        </StatusBadge>
        <ThemedText numberOfLines={2} type="small" themeColor="textTertiary">
          {connection?.url ?? 'No companion connected'}
        </ThemedText>
      </View>

      <View style={[styles.themeGroup, compact && styles.compactHidden]}>
        <SectionLabel>Theme</SectionLabel>
        <ThemeSwitcher />
      </View>

      <View style={[styles.footer, compact && styles.compactHidden, { borderColor: colors.border }]}>
        <ThemedText type="code" themeColor="textTertiary">
          v1.0.0
        </ThemedText>
        <ThemedText type="eyebrow">Nous</ThemedText>
      </View>
    </View>
  );
}

function SidebarButton({
  icon,
  isFocused,
  label,
  ...props
}: TabTriggerSlotProps & { icon: SymbolViewProps['name']; label: string }) {
  const colors = useTheme();

  return (
    <Pressable
      {...props}
      style={({ pressed }) => [
        styles.navButton,
        {
          backgroundColor: isFocused ? colors.backgroundSelected : 'transparent',
          borderColor: isFocused ? colors.accent : 'transparent',
          opacity: pressed ? 0.75 : 1,
        },
      ]}>
      <SymbolView name={icon} size={16} tintColor={isFocused ? colors.text : colors.textSecondary} />
      <ThemedText type="eyebrow" themeColor={isFocused ? 'text' : 'textSecondary'} style={styles.navLabel}>
        {label}
      </ThemedText>
      {isFocused ? <View style={[styles.activeRail, { backgroundColor: colors.accent }]} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: {
    height: '100%',
    minHeight: 0,
  },
  slotWide: {
    paddingLeft: 260,
  },
  slotCompact: {
    paddingTop: 66,
  },
  sidebar: {
    bottom: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    gap: Spacing.three,
    left: 0,
    minHeight: '100%',
    paddingTop: Spacing.three,
    position: 'fixed',
    top: 0,
    width: 260,
    zIndex: 10,
  },
  sidebarCompact: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRightWidth: 0,
    bottom: undefined,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 0,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    right: 0,
    top: 0,
    width: '100%',
  },
  brandBlock: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    paddingBottom: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  brandText: {
    lineHeight: 20,
  },
  navGroup: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  navGroupCompact: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: 0,
  },
  navButton: {
    alignItems: 'center',
    borderLeftWidth: 1,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 42,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    position: 'relative',
  },
  navLabel: {
    flex: 1,
  },
  activeRail: {
    bottom: 6,
    left: -1,
    position: 'absolute',
    top: 6,
    width: 1,
  },
  themeGroup: {
    flex: 1,
    gap: Spacing.two,
    minHeight: 0,
    paddingHorizontal: Spacing.three,
  },
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 'auto',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  compactHidden: {
    display: 'none',
  },
});
