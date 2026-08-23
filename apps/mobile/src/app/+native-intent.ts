export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (new URL(path).hostname === 'expo-sharing') return '/';
    return path;
  } catch {
    return path.startsWith('/') ? path : '/';
  }
}
