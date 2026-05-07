import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Alert } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { useColors } from '@/hooks/useColors';

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  ATTENDANCE_MANAGER: 'Attendance Manager',
  HR_MANAGER: 'HR Manager',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
};

function MenuItem({
  icon,
  label,
  sub,
  onPress,
  danger,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  sub?: string;
  onPress?: () => void;
  danger?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress} activeOpacity={0.75} disabled={!onPress}>
      <View style={[styles.menuIcon, danger && { backgroundColor: '#fee2e2' }]}>
        <Ionicons name={icon} size={18} color={danger ? '#ef4444' : '#1f5e3b'} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.menuLabel, danger && { color: '#ef4444' }]}>{label}</Text>
        {!!sub && <Text style={styles.menuSub}>{sub}</Text>}
      </View>
      {onPress && !danger && (
        <Ionicons name="chevron-forward" size={16} color="#9cb8a8" />
      )}
    </TouchableOpacity>
  );
}

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  async function handleLogout() {
    if (Platform.OS === 'web') {
      await logout();
      router.replace('/login');
      return;
    }
    Alert.alert(
      'Logout',
      'क्या आप logout करना चाहते हैं?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            await logout();
            router.replace('/login');
          },
        },
      ],
    );
  }

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;
  const initials = user?.full_name
    ?.split(' ')
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() ?? 'U';

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header / Avatar section */}
      <View style={[styles.header, { paddingTop: topPad + 20 }]}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{user?.full_name ?? 'Employee'}</Text>
        <Text style={styles.loginId}>{user?.login_id}</Text>
        <View style={styles.roleBadge}>
          <Text style={styles.roleText}>{ROLE_LABELS[user?.role ?? ''] ?? user?.role}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Account Info */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.section}>
          <MenuItem
            icon="mail-outline"
            label="Email"
            sub={user?.email || '—'}
          />
          <View style={styles.divider} />
          <MenuItem
            icon="business-outline"
            label="Branch"
            sub={user?.branch_id ? `Branch ID: ${user.branch_id}` : 'Assigned नहीं'}
          />
          <View style={styles.divider} />
          <MenuItem
            icon="time-outline"
            label="Shift"
            sub={
              user?.shift_start && user?.shift_end
                ? `${user.shift_start} – ${user.shift_end}`
                : 'Default shift'
            }
          />
        </View>

        {/* App Info */}
        <Text style={styles.sectionLabel}>App</Text>
        <View style={styles.section}>
          <MenuItem
            icon="leaf-outline"
            label="Prakriti Herbs HRMS"
            sub="Mobile App v1.0.0"
          />
          <View style={styles.divider} />
          <MenuItem
            icon="wifi-outline"
            label="WiFi Verification"
            sub="IP-based office network detection"
          />
          <View style={styles.divider} />
          <MenuItem
            icon="finger-print-outline"
            label="Biometric Attendance"
            sub="Fingerprint / Face ID support"
          />
        </View>

        {/* Logout */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.section}>
          <MenuItem
            icon="log-out-outline"
            label="Logout"
            danger
            onPress={handleLogout}
          />
        </View>

        <Text style={styles.footer}>
          Prakriti Herbs HRMS Mobile{'\n'}
          WiFi SSID • GPS • Biometric — Secure Attendance
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    backgroundColor: '#1f5e3b',
    alignItems: 'center', paddingBottom: 32,
    borderBottomLeftRadius: 32, borderBottomRightRadius: 32,
    gap: 6,
  },
  avatar: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  avatarText: { fontSize: 28, fontWeight: '700', color: '#ffffff', fontFamily: 'Inter_700Bold' },
  name: { fontSize: 20, fontWeight: '700', color: '#ffffff', fontFamily: 'Inter_700Bold' },
  loginId: { fontSize: 13, color: 'rgba(255,255,255,0.7)', fontFamily: 'Inter_400Regular' },
  roleBadge: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20, marginTop: 4,
  },
  roleText: { fontSize: 12, fontWeight: '600', color: '#ffffff', fontFamily: 'Inter_600SemiBold' },
  content: { padding: 16 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: '#9cb8a8', marginTop: 20, marginBottom: 8, marginLeft: 4, fontFamily: 'Inter_600SemiBold' },
  section: {
    backgroundColor: '#ffffff', borderRadius: 16,
    borderWidth: 1, borderColor: '#e0e7e3',
    overflow: 'hidden',
    shadowColor: '#1b2b21', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 6, elevation: 2,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14 },
  menuIcon: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: '#e8f5ee', alignItems: 'center', justifyContent: 'center',
  },
  menuLabel: { fontSize: 14, fontWeight: '600', color: '#1b2b21', fontFamily: 'Inter_600SemiBold' },
  menuSub: { fontSize: 12, color: '#9cb8a8', marginTop: 2, fontFamily: 'Inter_400Regular' },
  divider: { height: 1, backgroundColor: '#f0f4f1', marginLeft: 68 },
  footer: {
    textAlign: 'center', color: '#9cb8a8',
    fontSize: 11, marginTop: 28,
    fontFamily: 'Inter_400Regular', lineHeight: 18,
  },
});
