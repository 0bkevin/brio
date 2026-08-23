import { SignIn } from '@clerk/expo/web';
import { View } from 'react-native';

export function CloudAuthView() {
  return (
    <View>
      <SignIn routing="hash" />
    </View>
  );
}
