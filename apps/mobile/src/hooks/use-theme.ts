/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { useColorScheme } from 'react-native';

import { DashboardThemes } from '@/constants/theme';
import { T3Palette } from '@/constants/t3-theme';

export function useTheme() {
  const palette = T3Palette[useColorScheme() === 'light' ? 'light' : 'dark'];
  return {
    text: palette.foreground,
    background: palette.screen,
    backgroundElement: palette.subtle,
    backgroundSelected: palette.subtleStrong,
    textSecondary: palette.secondary,
    textTertiary: palette.tertiary,
    textDisabled: palette.tertiary,
    border: palette.border,
    panel: palette.card,
    panelStrong: palette.cardAlt,
    accent: palette.primary,
    accentText: palette.primaryForeground,
    glow: 'transparent',
    success: palette.success,
    warning: palette.warning,
    danger: palette.danger,
  } as const;
}

export function useDashboardTheme() {
  return {
    ...DashboardThemes.default,
    layout: { ...DashboardThemes.default.layout, radius: 24 },
    palette: { ...DashboardThemes.default.palette, warmGlow: 'transparent', noiseOpacity: 0 },
  };
}
