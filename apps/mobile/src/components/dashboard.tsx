import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { DashboardThemes, Spacing, type DashboardThemeName } from '@/constants/theme';
import { useDashboardTheme, useTheme } from '@/hooks/use-theme';
import { useUIStore } from '@/state/ui-store';

export function DashboardBackdrop() {
  const colors = useTheme();
  const dashboardTheme = useDashboardTheme();

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: colors.panel,
            opacity: 0.8,
          },
        ]}
      />
      <View
        style={[
          styles.warmOverlay,
          Platform.OS === 'web'
            ? ({
                backgroundImage: `radial-gradient(ellipse at 0% 0%, transparent 55%, ${dashboardTheme.palette.warmGlow} 100%)`,
              } as ViewStyle)
            : { backgroundColor: dashboardTheme.palette.warmGlow },
        ]}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          Platform.OS === 'web'
            ? ({
                backgroundImage:
                  'repeating-linear-gradient(0deg, rgba(255,255,255,0.035) 0, rgba(255,255,255,0.035) 1px, transparent 1px, transparent 4px)',
                opacity: 0.18 * dashboardTheme.palette.noiseOpacity,
              } as ViewStyle)
            : { opacity: 0 },
        ]}
      />
    </View>
  );
}

export function DashboardCard({
  children,
  inset = 'normal',
  style,
}: {
  children: ReactNode;
  inset?: 'normal' | 'compact';
  style?: ViewStyle;
}) {
  const colors = useTheme();
  const dashboardTheme = useDashboardTheme();

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.panel,
          borderColor: colors.border,
          borderRadius: dashboardTheme.layout.radius,
          padding: inset === 'compact' ? Spacing.two : Spacing.three,
        },
        Platform.OS === 'web'
          ? ({ boxShadow: '0 12px 24px rgba(0,0,0,0.22)' } as ViewStyle)
          : {
              elevation: 4,
              shadowColor: '#000000',
              shadowOffset: { height: 12, width: 0 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
            },
        style,
      ]}>
      {children}
    </View>
  );
}

export function StatusBadge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  const colors = useTheme();
  const toneColor =
    tone === 'success'
      ? colors.success
      : tone === 'warning'
        ? colors.warning
        : tone === 'danger'
          ? colors.danger
          : colors.textSecondary;

  return (
    <View style={[styles.badge, { borderColor: toneColor, backgroundColor: colors.backgroundSelected }]}>
      <View style={[styles.badgeDot, { backgroundColor: toneColor }]} />
      <ThemedText type="small" style={{ color: toneColor }}>
        {children}
      </ThemedText>
    </View>
  );
}

export function ThemeSwitcher() {
  const colors = useTheme();
  const currentThemeName = useUIStore((state) => state.themeName);
  const setThemeName = useUIStore((state) => state.setThemeName);

  return (
    <View style={styles.themeList}>
      {(Object.keys(DashboardThemes) as DashboardThemeName[]).map((themeName) => {
        const option = DashboardThemes[themeName];
        const active = currentThemeName === themeName;

        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={themeName}
            onPress={() => void setThemeName(themeName)}
            style={({ pressed }) => [
              styles.themeOption,
              {
                backgroundColor: active ? colors.backgroundSelected : 'transparent',
                borderColor: active ? colors.accent : colors.border,
                opacity: pressed ? 0.75 : 1,
              },
            ]}>
            <View style={styles.swatch}>
              <View style={[styles.swatchPart, { backgroundColor: option.palette.background }]} />
              <View style={[styles.swatchPart, { backgroundColor: option.palette.midground }]} />
              <View style={[styles.swatchPart, { backgroundColor: option.palette.warmGlow }]} />
            </View>
            <ThemedText
              numberOfLines={1}
              type="small"
              themeColor={active ? 'text' : 'textSecondary'}
              style={styles.themeLabel}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <ThemedText type="eyebrow" themeColor="textTertiary">
      {children}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  warmOverlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    opacity: 0.22,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
  },
  badge: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  badgeDot: {
    borderRadius: 4,
    height: 6,
    width: 6,
  },
  themeList: {
    gap: Spacing.one,
  },
  themeOption: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 34,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  swatch: {
    borderColor: 'rgba(255,255,255,0.2)',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: 14,
    overflow: 'hidden',
    width: 34,
  },
  swatchPart: {
    flex: 1,
  },
  themeLabel: {
    flex: 1,
  },
});
