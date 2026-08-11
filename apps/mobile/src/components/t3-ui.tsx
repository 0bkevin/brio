import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native';

import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';

export function AppText({ style, ...props }: TextProps) {
  const colors = useT3Theme();
  return (
    <Text
      {...props}
      style={[styles.text, { color: colors.foreground }, style]}
    />
  );
}

export function AppTextInput({ style, ...props }: TextInputProps) {
  const colors = useT3Theme();
  return (
    <TextInput
      {...props}
      placeholderTextColor={colors.placeholder}
      style={[
        styles.input,
        { backgroundColor: colors.input, borderColor: colors.inputBorder, color: colors.foreground },
        style,
      ]}
    />
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle | ViewStyle[] }) {
  const colors = useT3Theme();
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }, style]}>
      {children}
    </View>
  );
}

export function Section({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  const colors = useT3Theme();
  return (
    <View style={styles.section}>
      {title ? <AppText style={[styles.sectionTitle, { color: colors.muted }]}>{title}</AppText> : null}
      <Card style={styles.sectionCard}>{children}</Card>
    </View>
  );
}

export function Row({
  accessory,
  detail,
  icon,
  label,
  onPress,
}: {
  accessory?: ReactNode;
  detail?: string;
  icon?: ReactNode;
  label: string;
  onPress?: () => void;
}) {
  const colors = useT3Theme();
  const content = (
    <View style={styles.row}>
      {icon}
      <View style={styles.rowCopy}>
        <AppText style={styles.rowLabel}>{label}</AppText>
        {detail ? (
          <AppText numberOfLines={2} style={[styles.rowDetail, { color: colors.muted }]}>
            {detail}
          </AppText>
        ) : null}
      </View>
      {accessory ?? (onPress ? <AppText style={{ color: colors.tertiary }}>›</AppText> : null)}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function Divider() {
  const colors = useT3Theme();
  return <View style={[styles.divider, { backgroundColor: colors.separator }]} />;
}

export function Button({
  children,
  disabled,
  loading,
  tone = 'primary',
  style,
  ...props
}: PressableProps & {
  children: ReactNode;
  loading?: boolean;
  tone?: 'primary' | 'secondary' | 'danger' | 'plain';
}) {
  const colors = useT3Theme();
  const backgroundColor =
    tone === 'primary'
      ? colors.primary
      : tone === 'danger'
        ? colors.dangerSurface
        : tone === 'plain'
          ? 'transparent'
          : colors.subtleStrong;
  const foreground =
    tone === 'primary'
      ? colors.primaryForeground
      : tone === 'danger'
        ? colors.danger
        : colors.foreground;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      {...props}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 },
        style as ViewStyle,
      ]}>
      {loading ? <ActivityIndicator color={foreground} size="small" /> : null}
      <AppText style={[styles.buttonLabel, { color: foreground }]}>{children}</AppText>
    </Pressable>
  );
}

export function StatusDot({ status }: { status: 'online' | 'offline' | 'busy' | 'error' }) {
  const colors = useT3Theme();
  const backgroundColor =
    status === 'online'
      ? colors.success
      : status === 'busy'
        ? colors.warning
        : status === 'error'
          ? colors.danger
          : colors.tertiary;
  return <View style={[styles.statusDot, { backgroundColor }]} />;
}

export function EmptyState({
  action,
  detail,
  loading,
  title,
}: {
  action?: ReactNode;
  detail: string;
  loading?: boolean;
  title: string;
}) {
  const colors = useT3Theme();
  return (
    <View style={styles.empty}>
      {loading ? <ActivityIndicator /> : <View style={[styles.emptyMark, { backgroundColor: colors.subtle }]} />}
      <AppText style={styles.emptyTitle}>{title}</AppText>
      <AppText style={[styles.emptyDetail, { color: colors.muted }]}>{detail}</AppText>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  text: {
    fontFamily: T3Typography.regular,
    fontSize: 16,
    lineHeight: 23,
  },
  input: {
    borderRadius: T3Radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: T3Typography.regular,
    fontSize: 16,
    lineHeight: 23,
    minHeight: 54,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  card: {
    borderRadius: T3Radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  section: { gap: T3Spacing.sm },
  sectionCard: { paddingHorizontal: T3Spacing.lg },
  sectionTitle: {
    fontFamily: T3Typography.medium,
    fontSize: 13,
    lineHeight: 17,
    paddingHorizontal: T3Spacing.xs,
    textTransform: 'uppercase',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: T3Spacing.md,
    minHeight: 58,
    paddingVertical: T3Spacing.sm,
  },
  rowCopy: { flex: 1 },
  rowLabel: { fontFamily: T3Typography.medium },
  rowDetail: { fontSize: 13, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 0 },
  button: {
    alignItems: 'center',
    borderRadius: T3Radius.medium,
    flexDirection: 'row',
    gap: T3Spacing.sm,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: T3Spacing.lg,
    paddingVertical: 10,
  },
  buttonLabel: { fontFamily: T3Typography.bold, fontSize: 14, lineHeight: 19 },
  statusDot: { borderRadius: 5, height: 9, width: 9 },
  empty: {
    alignItems: 'center',
    flex: 1,
    gap: T3Spacing.sm,
    justifyContent: 'center',
    padding: T3Spacing.huge,
  },
  emptyMark: { borderRadius: 16, height: 48, marginBottom: T3Spacing.xs, width: 48 },
  emptyTitle: { fontFamily: T3Typography.bold, fontSize: 18, lineHeight: 23, textAlign: 'center' },
  emptyDetail: { fontSize: 14, lineHeight: 19, maxWidth: 360, textAlign: 'center' },
});
