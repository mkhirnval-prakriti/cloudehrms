import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';

export default function LoginScreen() {
  const { login } = useAuth();
  const insets = useSafeAreaInsets();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const webTop = Platform.OS === 'web' ? 67 : insets.top;

  async function handleLogin() {
    if (!loginId.trim() || !password.trim()) {
      setError('Login ID और Password दोनों ज़रूरी हैं।');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await login(loginId.trim(), password);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch (e) {
      setError((e as Error).message ?? 'Login failed। Admin से confirm करें।');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.root, { paddingTop: webTop }]}>
      <View style={styles.header}>
        <View style={styles.logoWrap}>
          <Ionicons name="leaf" size={40} color="#ffffff" />
        </View>
        <Text style={styles.brand}>Prakriti Herbs</Text>
        <Text style={styles.brandSub}>HRMS Mobile</Text>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={[
            styles.form,
            { paddingBottom: (Platform.OS === 'web' ? 34 : insets.bottom) + 32 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.formTitle}>नमस्ते 👋</Text>
          <Text style={styles.formSub}>अपने HRMS credentials से login करें</Text>

          {!!error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Text style={styles.label}>Employee ID / Login ID</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="person-outline" size={18} color="#9cb8a8" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={loginId}
              onChangeText={setLoginId}
              placeholder="जैसे: PH-AMR-001"
              placeholderTextColor="#9cb8a8"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              testID="login-id-input"
            />
          </View>

          <Text style={[styles.label, { marginTop: 16 }]}>Password</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={18} color="#9cb8a8" style={styles.inputIcon} />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor="#9cb8a8"
              secureTextEntry={!showPass}
              returnKeyType="done"
              onSubmitEditing={handleLogin}
              testID="password-input"
            />
            <TouchableOpacity onPress={() => setShowPass(p => !p)} style={styles.eyeBtn}>
              <Ionicons
                name={showPass ? 'eye-off-outline' : 'eye-outline'}
                size={18}
                color="#9cb8a8"
              />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}
            testID="login-button"
          >
            {loading ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <>
                <Text style={styles.btnText}>Login करें</Text>
                <Ionicons name="arrow-forward" size={18} color="#ffffff" />
              </>
            )}
          </TouchableOpacity>

          <Text style={styles.hint}>
            Login ID या password भूल गए? Admin / HR से संपर्क करें।
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f7f4' },
  header: {
    backgroundColor: '#1f5e3b',
    paddingTop: 28, paddingBottom: 44,
    alignItems: 'center',
    borderBottomLeftRadius: 36, borderBottomRightRadius: 36,
  },
  logoWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  brand: { fontSize: 26, fontWeight: '700', color: '#ffffff', fontFamily: 'Inter_700Bold' },
  brandSub: { fontSize: 13, color: 'rgba(255,255,255,0.7)', marginTop: 3, fontFamily: 'Inter_400Regular' },
  form: { padding: 24, paddingTop: 32 },
  formTitle: { fontSize: 24, fontWeight: '700', color: '#1b2b21', fontFamily: 'Inter_700Bold' },
  formSub: { fontSize: 13, color: '#6b9080', marginTop: 4, marginBottom: 28, fontFamily: 'Inter_400Regular' },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fee2e2', borderRadius: 10,
    padding: 12, marginBottom: 20,
  },
  errorText: { color: '#ef4444', fontSize: 13, flex: 1, fontFamily: 'Inter_400Regular' },
  label: { fontSize: 12, fontWeight: '600', color: '#1b2b21', marginBottom: 6, fontFamily: 'Inter_600SemiBold' },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#ffffff', borderRadius: 14,
    borderWidth: 1.5, borderColor: '#e0e7e3',
    paddingHorizontal: 14, minHeight: 52,
  },
  inputIcon: { marginRight: 10 },
  input: {
    flex: 1, fontSize: 15, color: '#1b2b21',
    fontFamily: 'Inter_400Regular', paddingVertical: 14,
  },
  eyeBtn: { padding: 6 },
  btn: {
    backgroundColor: '#1f5e3b', borderRadius: 16,
    paddingVertical: 16, marginTop: 28,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  btnDisabled: { opacity: 0.65 },
  btnText: { color: '#ffffff', fontSize: 16, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  hint: {
    textAlign: 'center', color: '#9cb8a8',
    fontSize: 12, marginTop: 28, fontFamily: 'Inter_400Regular', lineHeight: 18,
  },
});
