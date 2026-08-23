/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export type DashboardTheme = {
  name: string;
  label: string;
  description: string;
  palette: {
    background: string;
    midground: string;
    foreground: string;
    warmGlow: string;
    noiseOpacity: number;
  };
  typography: {
    fontSans: string;
    fontMono: string;
    fontDisplay: string;
    baseSize: number;
    lineHeight: number;
    letterSpacing: number;
  };
  layout: {
    radius: number;
    spacingMultiplier: number;
    density: 'compact' | 'comfortable' | 'spacious';
  };
};

const systemSans =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const systemMono = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

const defaultTypography = {
  fontSans: systemSans,
  fontMono: systemMono,
  fontDisplay: systemSans,
  baseSize: 15,
  lineHeight: 1.55,
  letterSpacing: 0,
};

const defaultLayout = {
  radius: 8,
  spacingMultiplier: 1,
  density: 'comfortable' as const,
};

export const DashboardThemes = {
  default: {
    name: 'default',
    label: 'Hermes Teal',
    description: 'Classic dark teal with cream accents.',
    palette: {
      background: '#041c1c',
      midground: '#ffe6cb',
      foreground: '#ffffff',
      warmGlow: 'rgba(255, 189, 56, 0.35)',
      noiseOpacity: 1,
    },
    typography: defaultTypography,
    layout: defaultLayout,
  },
  'default-large': {
    name: 'default-large',
    label: 'Hermes Teal Large',
    description: 'Hermes Teal with larger text and roomier spacing.',
    palette: {
      background: '#041c1c',
      midground: '#ffe6cb',
      foreground: '#ffffff',
      warmGlow: 'rgba(255, 189, 56, 0.35)',
      noiseOpacity: 1,
    },
    typography: {
      ...defaultTypography,
      baseSize: 18,
      lineHeight: 1.65,
    },
    layout: {
      ...defaultLayout,
      spacingMultiplier: 1.15,
      density: 'spacious' as const,
    },
  },
  midnight: {
    name: 'midnight',
    label: 'Midnight',
    description: 'Deep blue-violet with cool accents.',
    palette: {
      background: '#0a0a1f',
      midground: '#d4c8ff',
      foreground: '#ffffff',
      warmGlow: 'rgba(167, 139, 250, 0.32)',
      noiseOpacity: 0.8,
    },
    typography: {
      ...defaultTypography,
      fontSans: `"Inter", ${systemSans}`,
      fontMono: `"JetBrains Mono", ${systemMono}`,
    },
    layout: {
      ...defaultLayout,
      radius: 12,
    },
  },
  ember: {
    name: 'ember',
    label: 'Ember',
    description: 'Warm crimson and bronze.',
    palette: {
      background: '#1a0a06',
      midground: '#ffd8b0',
      foreground: '#ffffff',
      warmGlow: 'rgba(249, 115, 22, 0.38)',
      noiseOpacity: 1,
    },
    typography: {
      ...defaultTypography,
      fontSans: `"Spectral", Georgia, "Times New Roman", serif`,
      fontMono: `"IBM Plex Mono", ${systemMono}`,
      fontDisplay: `"Spectral", Georgia, "Times New Roman", serif`,
    },
    layout: {
      ...defaultLayout,
      radius: 4,
    },
  },
  mono: {
    name: 'mono',
    label: 'Mono',
    description: 'Clean grayscale for focused sessions.',
    palette: {
      background: '#0e0e0e',
      midground: '#eaeaea',
      foreground: '#ffffff',
      warmGlow: 'rgba(255, 255, 255, 0.1)',
      noiseOpacity: 0.6,
    },
    typography: {
      ...defaultTypography,
      fontSans: `"IBM Plex Sans", ${systemSans}`,
      fontMono: `"IBM Plex Mono", ${systemMono}`,
    },
    layout: {
      ...defaultLayout,
      radius: 0,
    },
  },
  cyberpunk: {
    name: 'cyberpunk',
    label: 'Cyberpunk',
    description: 'Neon green on black.',
    palette: {
      background: '#040608',
      midground: '#9bffcf',
      foreground: '#ffffff',
      warmGlow: 'rgba(0, 255, 136, 0.22)',
      noiseOpacity: 1.2,
    },
    typography: {
      ...defaultTypography,
      fontSans: `"Share Tech Mono", "JetBrains Mono", ${systemMono}`,
      fontMono: `"Share Tech Mono", "JetBrains Mono", ${systemMono}`,
      fontDisplay: `"Share Tech Mono", "JetBrains Mono", ${systemMono}`,
    },
    layout: {
      ...defaultLayout,
      radius: 0,
    },
  },
  rose: {
    name: 'rose',
    label: 'Rose',
    description: 'Soft pink and warm ivory.',
    palette: {
      background: '#1a0f15',
      midground: '#ffd4e1',
      foreground: '#ffffff',
      warmGlow: 'rgba(249, 168, 212, 0.3)',
      noiseOpacity: 0.9,
    },
    typography: {
      ...defaultTypography,
      fontSans: `"Fraunces", Georgia, serif`,
      fontMono: `"DM Mono", ${systemMono}`,
      fontDisplay: `"Fraunces", Georgia, serif`,
    },
    layout: {
      ...defaultLayout,
      radius: 16,
    },
  },
} satisfies Record<string, DashboardTheme>;

export type DashboardThemeName = keyof typeof DashboardThemes;

export function colorsFromDashboardTheme(theme: DashboardTheme) {
  return {
    text: theme.palette.midground,
    background: theme.palette.background,
    backgroundElement: withAlpha(theme.palette.midground, 0.06),
    backgroundSelected: withAlpha(theme.palette.midground, 0.12),
    textSecondary: withAlpha(theme.palette.midground, 0.78),
    textTertiary: withAlpha(theme.palette.midground, 0.52),
    textDisabled: withAlpha(theme.palette.midground, 0.34),
    border: withAlpha(theme.palette.midground, 0.18),
    panel: withAlpha(theme.palette.midground, 0.05),
    panelStrong: withAlpha(theme.palette.midground, 0.1),
    accent: theme.palette.midground,
    accentText: theme.palette.background,
    glow: theme.palette.warmGlow,
    success: '#4ade80',
    warning: '#ffbd38',
    danger: '#fb2c36',
  } as const;
}

function withAlpha(hex: string, alpha: number) {
  const normalized = hex.replace('#', '');
  const bigint = parseInt(normalized, 16);
  const red = (bigint >> 16) & 255;
  const green = (bigint >> 8) & 255;
  const blue = bigint & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export const Colors = {
  light: colorsFromDashboardTheme(DashboardThemes.default),
  dark: colorsFromDashboardTheme(DashboardThemes.default),
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
