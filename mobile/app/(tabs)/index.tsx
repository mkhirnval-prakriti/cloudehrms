import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { useColors } from '@/hooks/useColors';
import { apiRequest } from '@/lib/api';
import { useState } from 'react';

type AttendanceRecord = {
  id: number;
  work_date: string;
  punch_in_at: string | null;
  punch_out_at: string | null;
  status: string;
  punch_method: string | null;
};

function formatTime(iso: string | null): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('hi-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function getStatusInfo(record: AttendanceRecord | null) {
  if (!record) return { label: 'Absent', color: '#ef4444', bg: '#fee2e2', icon: 'close-circle' as const };
  if (record.punch_out_at) return { label: 'Present', color: '#22c55e', bg: '#dcfce7', icon: 'checkmark-circle' as const };
  if (record.punch_in_at) return { label: 'Punched In', color: '#f59e0b', bg: '#fef3c7', icon: 'time' as const };
  return { label: 'Absent', color: '#ef4444', bg: '#fee2e2', icon: 'close-circle' as const };
}

export default function HomeScreen() {
  const { user } = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 8) + '01';

  const { data: todayData, refetch: refetchToday } = useQuery({
    queryKey: ['/api/attendance/today', today],
    queryFn: () =>
      apiRequest<{ records: AttendanceRecord[] }>(
        `/attendance/history?from=${today}&to=${today}`,
      ),
  });

  const { data: monthData, refetch: refetchMonth } = useQuery({
    queryKey: ['/api/attendance/month', monthStart],
    queryFn: () =>
      apiRequest<{ records: AttendanceRecord[] }>(
        `/attendance/history?from=${monthStart}&to=${today}&limit=5`,
      ),
  });

  const todayRecord = todayData?.records?.[0] ?? null;
  const recentRecords = monthData?.records?.slice(0, 5) ?? [];
  const presentCount = monthData?.records?.filter(r => r.punch_in_at).length ?? 0;

  const statusInfo = getStatusInfo(todayRecord);
  const firstName = user?.full_name?.split(' ')[0] ?? 'Employee';

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchToday(), refetchMonth()]);
    setRefreshing(false);
  }

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 16 }]}>
        <View>
          <Text style={styles.greeting}>नमस्ते, {firstName} 🌿</Text>
          <Text style={styles.dateText}>{formatDate(new Date())}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusInfo.bg }]}>
          <Ionicons name={statusInfo.icon} size={14} color={statusInfo.color} />
          <Text style={[styles.statusBadgeText, { color: statusInfo.color }]}>{statusInfo.label}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 24 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Today's Attendance Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>आज की Attendance</Text>
          <View style={styles.punchRow}>
            <View style={styles.punchItem}>
              <View style={[styles.punchIconWrap, { backgroundColor: '#e8f5ee' }]}>
                <Ionicons name="log-in-outline" size={20} color="#1f5e3b" />
              </View>
              <Text style={styles.punchLabel}>Punch In</Text>
              <Text style={styles.punchTime}>{formatTime(todayRecord?.punch_in_at ?? null)}</Text>
            </View>
            <View style={styles.punchDivider} />
            <View style={styles.punchItem}>
              <View style={[styles.punchIconWrap, { backgroundColor: '#fef3c7' }]}>
                <Ionicons name="log-out-outline" size={20} color="#f59e0b" />
              </View>
              <Text style={styles.punchLabel}>Punch Out</Text>
              <Text style={styles.punchTime}>{formatTime(todayRecord?.punch_out_at ?? null)}</Text>
            </View>
          </View>
        </View>

        {/* Quick Actions */}
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.quickRow}>
          <TouchableOpacity
            style={[styles.quickBtn, { backgroundColor: '#1f5e3b' }]}
            onPress={() => router.push('/(tabs)/punch')}
            activeOpacity={0.85}
          >
            <Ionicons name="finger-print" size={28} color="#ffffff" />
            <Text style={[styles.quickBtnText, { color: '#ffffff' }]}>
              {todayRecord?.punch_in_at && !todayRecord?.punch_out_at ? 'Punch Out' : 'Punch In'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickBtn, { backgroundColor: '#ffffff', borderWidth: 1.5, borderColor: '#e0e7e3' }]}
            onPress={() => router.push('/(tabs)/leave')}
            activeOpacity={0.85}
          >
            <Ionicons name="calendar-outline" size={28} color="#1f5e3b" />
            <Text style={[styles.quickBtnText, { color: '#1f5e3b' }]}>Apply Leave</Text>
          </TouchableOpacity>
        </View>

        {/* Monthly Stats */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>इस महीने</Text>
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={[styles.statNum, { color: '#1f5e3b' }]}>{presentCount}</Text>
              <Text style={styles.statLabel}>Present</Text>
            </View>
            <View style={[styles.statDivider]} />
            <View style={styles.statItem}>
              <Text style={[styles.statNum, { color: '#f59e0b' }]}>{new Date().getDate() - presentCount > 0 ? new Date().getDate() - presentCount : 0}</Text>
              <Text style={styles.statLabel}>Absent</Text>
            </View>
            <View style={[styles.statDivider]} />
            <View style={styles.statItem}>
              <Text style={[styles.statNum, { color: '#6b9080' }]}>{new Date().getDate()}</Text>
              <Text style={styles.statLabel}>Working Days</Text>
            </View>
          </View>
        </View>

        {/* Recent Attendance */}
        {recentRecords.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Recent Attendance</Text>
            {recentRecords.map(rec => {
              const si = getStatusInfo(rec);
              return (
                <View key={rec.id} style={[styles.recRow]}>
                  <View style={[styles.recDot, { backgroundColor: si.color }]} />
                  <View style={styles.recInfo}>
                    <Text style={styles.recDate}>{rec.work_date}</Text>
                    <Text style={styles.recTimes}>
                      {formatTime(rec.punch_in_at)} – {formatTime(rec.punch_out_at)}
                    </Text>
                  </View>
                  <View style={[styles.recBadge, { backgroundColor: si.bg }]}>
                    <Text style={[styles.recBadgeText, { color: si.color }]}>{si.label}</Text>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    backgroundColor: '#1f5e3b',
    paddingHorizontal: 20, paddingBottom: 20,
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    borderBottomLeftRadius: 28, borderBottomRightRadius: 28,
  },
  greeting: { fontSize: 20, fontWeight: '700', color: '#ffffff', fontFamily: 'Inter_700Bold' },
  dateText: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 3, fontFamily: 'Inter_400Regular' },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, marginTop: 4,
  },
  statusBadgeText: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  content: { padding: 16, gap: 0 },
  card: {
    backgroundColor: '#ffffff', borderRadius: 16,
    padding: 18, marginBottom: 16,
    shadowColor: '#1b2b21', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.07, shadowRadius: 10, elevation: 3,
    borderWidth: 1, borderColor: '#f0f4f1',
  },
  cardTitle: { fontSize: 13, fontWeight: '600', color: '#6b9080', marginBottom: 14, fontFamily: 'Inter_600SemiBold' },
  punchRow: { flexDirection: 'row', alignItems: 'center' },
  punchItem: { flex: 1, alignItems: 'center', gap: 8 },
  punchIconWrap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  punchDivider: { width: 1, height: 50, backgroundColor: '#e0e7e3', marginHorizontal: 12 },
  punchLabel: { fontSize: 12, color: '#9cb8a8', fontFamily: 'Inter_400Regular' },
  punchTime: { fontSize: 18, fontWeight: '700', color: '#1b2b21', fontFamily: 'Inter_700Bold' },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#1b2b21', marginBottom: 10, marginTop: 4, fontFamily: 'Inter_600SemiBold' },
  quickRow: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  quickBtn: {
    flex: 1, borderRadius: 16, paddingVertical: 18,
    alignItems: 'center', gap: 8,
    shadowColor: '#1f5e3b', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 10, elevation: 4,
  },
  quickBtnText: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  statsRow: { flexDirection: 'row', alignItems: 'center' },
  statItem: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, height: 36, backgroundColor: '#e0e7e3' },
  statNum: { fontSize: 28, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  statLabel: { fontSize: 11, color: '#9cb8a8', marginTop: 2, fontFamily: 'Inter_400Regular' },
  recRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#ffffff', borderRadius: 12, padding: 14,
    marginBottom: 8, borderWidth: 1, borderColor: '#f0f4f1',
  },
  recDot: { width: 8, height: 8, borderRadius: 4 },
  recInfo: { flex: 1 },
  recDate: { fontSize: 13, fontWeight: '600', color: '#1b2b21', fontFamily: 'Inter_600SemiBold' },
  recTimes: { fontSize: 12, color: '#6b9080', marginTop: 2, fontFamily: 'Inter_400Regular' },
  recBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  recBadgeText: { fontSize: 11, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
});
