/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { colorsFromDashboardTheme, DashboardThemes } from '@/constants/theme';
import { useUIStore } from '@/state/ui-store';

export function useTheme() {
  const themeName = useUIStore((state) => state.themeName);
  const dashboardTheme = DashboardThemes[themeName] ?? DashboardThemes.default;

  return colorsFromDashboardTheme(dashboardTheme);
}

export function useDashboardTheme() {
  const themeName = useUIStore((state) => state.themeName);
  return DashboardThemes[themeName] ?? DashboardThemes.default;
}
