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

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

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

  return (
    <View
      {...props}
      style={[
        styles.sidebar,
        compact && styles.sidebarCompact,
        { backgroundColor: colors.panel, borderColor: colors.border },
      ]}>
      <View style={[styles.brandBlock, compact && styles.compactHidden, { borderColor: colors.border }]}>
        <View style={[styles.brandMark, { backgroundColor: colors.accent }]}>
          <ThemedText style={{ color: colors.accentText }} type="smallBold">B</ThemedText>
        </View>
        <ThemedText type="smallBold" style={styles.brandText}>Brio</ThemedText>
      </View>

      <View style={[styles.navGroup, compact && styles.navGroupCompact]}>
        {children}
      </View>

      <View style={[styles.footer, compact && styles.compactHidden, { borderColor: colors.border }]}>
        <ThemedText type="code" themeColor="textTertiary">v1</ThemedText>
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
      <ThemedText type="small" themeColor={isFocused ? 'text' : 'textSecondary'} style={styles.navLabel}>
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
    paddingLeft: 104,
  },
  slotCompact: {
    paddingTop: 66,
  },
  sidebar: {
    bottom: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    gap: Spacing.four,
    left: 0,
    minHeight: '100%',
    paddingTop: Spacing.three,
    // Web-only value; react-native's stock position union stops CI typechecks.
    position: 'fixed' as never,
    top: 0,
    width: 104,
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
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    paddingBottom: Spacing.three,
    paddingHorizontal: Spacing.two,
  },
  brandMark: {
    alignItems: 'center',
    borderRadius: 12,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  brandText: {
    lineHeight: 20,
  },
  navGroup: {
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
  },
  navGroupCompact: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: 0,
  },
  navButton: {
    alignItems: 'center',
    borderRadius: 10,
    borderLeftWidth: 1,
    gap: Spacing.one,
    justifyContent: 'center',
    minHeight: 58,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    position: 'relative',
  },
  navLabel: {
    fontSize: 12,
  },
  activeRail: {
    bottom: 6,
    left: -1,
    position: 'absolute',
    top: 6,
    width: 1,
  },
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    marginTop: 'auto',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.three,
  },
  compactHidden: {
    display: 'none',
  },
});
