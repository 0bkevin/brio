import { useColorScheme } from 'react-native';

import { T3Palette } from '@/constants/t3-theme';

export function useT3Theme() {
  return T3Palette[useColorScheme() === 'light' ? 'light' : 'dark'];
}
