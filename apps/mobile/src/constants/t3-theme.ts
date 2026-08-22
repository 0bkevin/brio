import { Platform } from 'react-native';

export const T3Palette = {
  light: {
    screen: '#f2f2f7',
    sheet: 'rgba(242, 242, 247, 0.98)',
    card: '#ffffff',
    cardAlt: '#f5f5f5',
    foreground: '#262626',
    secondary: '#525252',
    muted: '#737373',
    tertiary: '#8e8e93',
    border: 'rgba(0, 0, 0, 0.08)',
    separator: 'rgba(0, 0, 0, 0.05)',
    subtle: 'rgba(0, 0, 0, 0.04)',
    subtleStrong: 'rgba(0, 0, 0, 0.08)',
    primary: '#262626',
    primaryForeground: '#ffffff',
    input: '#ffffff',
    inputBorder: 'rgba(0, 0, 0, 0.1)',
    placeholder: '#a3a3a3',
    userBubble: '#007aff',
    userBubbleForeground: '#ffffff',
    success: '#34c759',
    warning: '#ff9500',
    danger: '#dc2626',
    dangerSurface: '#fef2f2',
    code: 'rgba(0, 0, 0, 0.04)',
  },
  dark: {
    screen: '#0a0a0a',
    sheet: 'rgba(14, 14, 14, 0.98)',
    card: '#171717',
    cardAlt: '#1c1c1c',
    foreground: '#f5f5f5',
    secondary: '#a3a3a3',
    muted: '#8e8e93',
    tertiary: '#636366',
    border: 'rgba(255, 255, 255, 0.06)',
    separator: 'rgba(255, 255, 255, 0.04)',
    subtle: 'rgba(255, 255, 255, 0.04)',
    subtleStrong: 'rgba(255, 255, 255, 0.08)',
    primary: '#f5f5f5',
    primaryForeground: '#0a0a0a',
    input: '#141414',
    inputBorder: 'rgba(255, 255, 255, 0.08)',
    placeholder: '#8e8e93',
    userBubble: '#0a84ff',
    userBubbleForeground: '#ffffff',
    success: '#30d158',
    warning: '#ff9f0a',
    danger: '#fca5a5',
    dangerSurface: 'rgba(239, 68, 68, 0.14)',
    code: 'rgba(255, 255, 255, 0.06)',
  },
} as const;

export type T3Colors = (typeof T3Palette)[keyof typeof T3Palette];

export const T3Typography = {
  regular: 'DMSans_400Regular',
  medium: 'DMSans_500Medium',
  bold: 'DMSans_700Bold',
  mono: Platform.select({ ios: 'ui-monospace', android: 'monospace', default: 'monospace' }),
} as const;

export const T3Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  huge: 32,
} as const;

export const T3Radius = {
  small: 10,
  medium: 16,
  large: 24,
  pill: 999,
} as const;

export const CHAT_CONTENT_MAX_WIDTH = 960;
export const SPLIT_LAYOUT_MIN_WIDTH = 720;
