import { AuthView } from '@clerk/expo/native';
import { StyleSheet, View } from 'react-native';

export function CloudAuthView() {
  return (
    <View style={styles.container}>
      <AuthView isDismissible={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 520,
    width: '100%',
  },
});
