import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, ScrollView, Platform, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { useColors } from '@/hooks/useColors';

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
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

type NetworkTypeLabel = 'WiFi' | 'Cellular' | 'Offline' | 'Unknown';

function getNetworkLabel(state: Network.NetworkState | null): NetworkTypeLabel {
  if (!state?.isConnected) return 'Offline';
  switch (state.type) {
    case Network.NetworkStateType.WIFI: return 'WiFi';
    case Network.NetworkStateType.CELLULAR: return 'Cellular';
    default: return 'Unknown';
  }
}

export default function PunchScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();

  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [locStatus, setLocStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [locError, setLocError] = useState('');
  const [withinRadius, setWithinRadius] = useState<boolean | null>(null);
  const [distanceM, setDistanceM] = useState<number | null>(null);

  const [networkState, setNetworkState] = useState<Network.NetworkState | null>(null);
  const [deviceIp, setDeviceIp] = useState('');
  const [networkLoading, setNetworkLoading] = useState(false);

  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioTypeLabel, setBioTypeLabel] = useState('');

  const [punching, setPunching] = useState(false);
  const [punchError, setPunchError] = useState('');
  const [punchSuccess, setPunchSuccess] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const today = new Date().toISOString().split('T')[0];
  const { data: todayData, refetch: refetchToday } = useQuery({
    queryKey: ['/api/attendance/today-punch', today],
    queryFn: () =>
      apiRequest<{ records: AttendanceRecord[] }>(
        `/attendance/history?from=${today}&to=${today}`,
      ),
  });

  const todayRecord = todayData?.records?.[0] ?? null;
  const isPunchedIn = !!todayRecord?.punch_in_at && !todayRecord?.punch_out_at;
  const punchType: 'in' | 'out' = isPunchedIn ? 'out' : 'in';
  const canPunchOut = isPunchedIn;
  const alreadyDone = !!todayRecord?.punch_in_at && !!todayRecord?.punch_out_at;

  useEffect(() => {
    checkBiometric();
    fetchLocation();
    fetchNetwork();
  }, []);

  async function checkBiometric() {
    if (Platform.OS === 'web') return;
    try {
      const has = await LocalAuthentication.hasHardwareAsync();
      if (!has) return;
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) return;
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
      setBioAvailable(types.length > 0);
      if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
        setBioTypeLabel('Face ID');
      } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
        setBioTypeLabel('Fingerprint');
      } else {
        setBioTypeLabel('Biometric');
      }
    } catch { /* ignore */ }
  }

  const fetchLocation = useCallback(async () => {
    setLocStatus('loading');
    setLocError('');
    console.log('[PUNCH] GPS: requesting permission…');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      console.log('[PUNCH] GPS permission:', status);
      if (status !== 'granted') {
        setLocStatus('error');
        setLocError('Location permission नहीं मिली। Settings में Allow करें।');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      console.log('[PUNCH] GPS coords:', loc.coords.latitude, loc.coords.longitude, '±', loc.coords.accuracy, 'm');
      setLocation(loc);
      setLocStatus('ready');
      try {
        const check = await apiRequest<{ ok: boolean; within: boolean; distance_m: number }>(
          `/attendance/geo-check?lat=${loc.coords.latitude}&lng=${loc.coords.longitude}`,
        );
        console.log('[PUNCH] Geo-check result:', check);
        setWithinRadius(check.within);
        setDistanceM(check.distance_m);
      } catch (e) {
        console.log('[PUNCH] Geo-check skipped (non-critical):', (e as Error).message);
      }
    } catch (e) {
      console.log('[PUNCH] GPS error:', (e as Error).message);
      setLocStatus('error');
      setLocError('Location नहीं मिला। दोबारा try करें।');
    }
  }, []);

  const fetchNetwork = useCallback(async () => {
    setNetworkLoading(true);
    console.log('[PUNCH] Network: detecting…');
    try {
      const state = await Network.getNetworkStateAsync();
      console.log('[PUNCH] Network state:', state.type, '| connected:', state.isConnected);
      setNetworkState(state);
      if (Platform.OS !== 'web' && state.type === Network.NetworkStateType.WIFI) {
        const ip = await Network.getIpAddressAsync();
        console.log('[PUNCH] WiFi IP:', ip);
        setDeviceIp(ip ?? '');
      } else {
        console.log('[PUNCH] Not on WiFi — skipping IP fetch');
        setDeviceIp('');
      }
    } catch (e) {
      console.log('[PUNCH] Network error:', (e as Error).message);
    }
    setNetworkLoading(false);
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([refetchToday(), fetchLocation(), fetchNetwork()]);
    setPunchError('');
    setPunchSuccess('');
    setRefreshing(false);
  }

  async function handlePunch() {
    if (alreadyDone) return;
    setPunchError('');
    setPunchSuccess('');

    // Biometric auth (optional — fingerprint / Face ID)
    if (bioAvailable && Platform.OS !== 'web') {
      try {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: punchType === 'in' ? 'Punch In verify करें' : 'Punch Out verify करें',
          fallbackLabel: 'PIN use करें',
          cancelLabel: 'Cancel',
          disableDeviceFallback: false,
        });
        if (!result.success && result.error === 'user_cancel') return;
      } catch { /* proceed without biometric */ }
    }

    setPunching(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const isWifi = networkState?.type === Network.NetworkStateType.WIFI;
      const hasGps = locStatus === 'ready' && location !== null;

      const body: Record<string, unknown> = {
        type: punchType,
        source: 'mobile',
        wifi_connected: isWifi,
        attendanceMethod: hasGps ? 'gps' : (isWifi ? 'office' : 'gps'),
      };

      if (hasGps) {
        body.lat = location!.coords.latitude;
        body.lng = location!.coords.longitude;
      }

      if (isWifi) {
        if (deviceIp) body.wifi_ip = deviceIp;
        if (!hasGps) body.useBranchCenter = true;
      }

      console.log('[PUNCH] Sending punch body:', JSON.stringify(body, null, 2));

      await apiRequest('/attendance/punch', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPunchSuccess(
        punchType === 'in'
          ? '✓ Punch In हो गया!'
          : '✓ Punch Out हो गया!',
      );
      await refetchToday();
      qc.invalidateQueries({ queryKey: ['/api/attendance/today'] });
    } catch (e) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPunchError((e as Error).message ?? 'Punch failed। दोबारा try करें।');
    }
    setPunching(false);
  }

  const networkLabel = getNetworkLabel(networkState);
  const isWifi = networkState?.type === Network.NetworkStateType.WIFI;
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 14 }]}>
        <Text style={styles.headerTitle}>Attendance Punch</Text>
        <Text style={styles.headerSub}>{today}</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 32 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {/* Today's Status */}
        {todayRecord && (
          <View style={styles.statusCard}>
            <View style={styles.statusRow}>
              <View style={styles.statusItem}>
                <Text style={styles.statusLabel}>Punch In</Text>
                <Text style={[styles.statusTime, { color: '#1f5e3b' }]}>
                  {formatTime(todayRecord.punch_in_at)}
                </Text>
              </View>
              <Ionicons name="arrow-forward" size={16} color="#9cb8a8" />
              <View style={styles.statusItem}>
                <Text style={styles.statusLabel}>Punch Out</Text>
                <Text style={[styles.statusTime, { color: '#f59e0b' }]}>
                  {formatTime(todayRecord.punch_out_at)}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Location Card */}
        <View style={styles.infoCard}>
          <View style={styles.infoCardHeader}>
            <View style={[styles.infoIcon, { backgroundColor: locStatus === 'ready' ? '#e8f5ee' : '#fee2e2' }]}>
              <Ionicons
                name="location"
                size={18}
                color={locStatus === 'ready' ? '#1f5e3b' : '#ef4444'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.infoTitle}>GPS Location</Text>
              {locStatus === 'loading' && <Text style={styles.infoSub}>Detecting…</Text>}
              {locStatus === 'ready' && location && (
                <Text style={styles.infoSub}>
                  {location.coords.latitude.toFixed(5)}, {location.coords.longitude.toFixed(5)}
                </Text>
              )}
              {locStatus === 'error' && <Text style={[styles.infoSub, { color: '#ef4444' }]}>{locError}</Text>}
              {locStatus === 'idle' && <Text style={styles.infoSub}>Tap refresh to detect</Text>}
            </View>
            {locStatus === 'loading' ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <TouchableOpacity onPress={fetchLocation} style={styles.refreshBtn}>
                <Ionicons name="refresh" size={16} color={colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {withinRadius !== null && locStatus === 'ready' && (
            <View style={[
              styles.infoBadge,
              { backgroundColor: withinRadius ? '#dcfce7' : '#fee2e2' },
            ]}>
              <Ionicons
                name={withinRadius ? 'checkmark-circle' : 'warning'}
                size={13}
                color={withinRadius ? '#22c55e' : '#ef4444'}
              />
              <Text style={[styles.infoBadgeText, { color: withinRadius ? '#16a34a' : '#ef4444' }]}>
                {withinRadius
                  ? `Office के अंदर हैं (${distanceM}m)`
                  : `Office से बाहर हैं (${distanceM}m दूर)`}
              </Text>
            </View>
          )}
        </View>

        {/* WiFi / Network Card — Key feature: IP-based WiFi verification */}
        <View style={styles.infoCard}>
          <View style={styles.infoCardHeader}>
            <View style={[
              styles.infoIcon,
              { backgroundColor: isWifi ? '#e8f5ee' : '#fef3c7' },
            ]}>
              <Ionicons
                name={isWifi ? 'wifi' : networkLabel === 'Cellular' ? 'cellular' : 'wifi-outline'}
                size={18}
                color={isWifi ? '#1f5e3b' : '#f59e0b'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.infoTitle}>
                Network · <Text style={{ color: isWifi ? '#1f5e3b' : '#f59e0b' }}>{networkLabel}</Text>
              </Text>
              {networkLoading ? (
                <Text style={styles.infoSub}>Checking…</Text>
              ) : isWifi && deviceIp ? (
                <Text style={styles.infoSub}>IP: {deviceIp}</Text>
              ) : !isWifi ? (
                <Text style={styles.infoSub}>WiFi पर नहीं हैं — GPS से punch होगा</Text>
              ) : (
                <Text style={styles.infoSub}>WiFi connected</Text>
              )}
            </View>
            {networkLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <TouchableOpacity onPress={fetchNetwork} style={styles.refreshBtn}>
                <Ionicons name="refresh" size={16} color={colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {isWifi && deviceIp && (
            <View style={[styles.infoBadge, { backgroundColor: '#e8f5ee' }]}>
              <Ionicons name="shield-checkmark" size={13} color="#1f5e3b" />
              <Text style={[styles.infoBadgeText, { color: '#1f5e3b' }]}>
                Device IP ({deviceIp}) server पर verify होगा
              </Text>
            </View>
          )}
          {!isWifi && (
            <View style={[styles.infoBadge, { backgroundColor: '#fef3c7' }]}>
              <Ionicons name="information-circle" size={13} color="#92400e" />
              <Text style={[styles.infoBadgeText, { color: '#92400e' }]}>
                WiFi SSID browser/app दोनों में available है — IP से verify होता है
              </Text>
            </View>
          )}
        </View>

        {/* Biometric Card */}
        {bioAvailable && Platform.OS !== 'web' && (
          <View style={[styles.infoCard, { backgroundColor: '#e8f5ee' }]}>
            <View style={styles.infoCardHeader}>
              <View style={[styles.infoIcon, { backgroundColor: '#1f5e3b' }]}>
                <MaterialCommunityIcons name="fingerprint" size={18} color="#ffffff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.infoTitle}>{bioTypeLabel} Available</Text>
                <Text style={styles.infoSub}>Punch करते समय verify होगा</Text>
              </View>
              <Ionicons name="checkmark-circle" size={20} color="#1f5e3b" />
            </View>
          </View>
        )}

        {/* Feedback messages */}
        {!!punchSuccess && (
          <View style={[styles.feedbackBox, { backgroundColor: '#dcfce7' }]}>
            <Ionicons name="checkmark-circle" size={20} color="#16a34a" />
            <Text style={[styles.feedbackText, { color: '#15803d' }]}>{punchSuccess}</Text>
          </View>
        )}
        {!!punchError && (
          <View style={[styles.feedbackBox, { backgroundColor: '#fee2e2' }]}>
            <Ionicons name="alert-circle" size={20} color="#ef4444" />
            <Text style={[styles.feedbackText, { color: '#dc2626' }]}>{punchError}</Text>
          </View>
        )}

        {/* Main Punch Button */}
        {alreadyDone ? (
          <View style={[styles.punchBtn, { backgroundColor: '#f0f4f1', borderWidth: 2, borderColor: '#e0e7e3' }]}>
            <Ionicons name="checkmark-done" size={32} color="#9cb8a8" />
            <Text style={[styles.punchBtnText, { color: '#9cb8a8' }]}>आज का attendance हो गया!</Text>
            <Text style={[styles.punchBtnSub, { color: '#9cb8a8' }]}>In: {formatTime(todayRecord?.punch_in_at ?? null)} · Out: {formatTime(todayRecord?.punch_out_at ?? null)}</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[
              styles.punchBtn,
              punching && styles.punchBtnLoading,
              punchType === 'out' && styles.punchBtnOut,
            ]}
            onPress={handlePunch}
            disabled={punching}
            activeOpacity={0.85}
            testID="punch-button"
          >
            {punching ? (
              <ActivityIndicator color="#ffffff" size="large" />
            ) : (
              <>
                <Ionicons
                  name={punchType === 'in' ? 'log-in' : 'log-out'}
                  size={36}
                  color="#ffffff"
                />
                <Text style={styles.punchBtnText}>
                  {punchType === 'in' ? 'Punch In करें' : 'Punch Out करें'}
                </Text>
                {bioAvailable && Platform.OS !== 'web' && (
                  <Text style={styles.punchBtnSub}>{bioTypeLabel} से verify होगा</Text>
                )}
              </>
            )}
          </TouchableOpacity>
        )}

        <Text style={styles.hint}>
          ℹ️ WiFi पर होने पर device IP ({deviceIp || '—'}) से office network verify होगा।{'\n'}
          GPS + WiFi दोनों मिलकर secure attendance ensure करते हैं।
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    backgroundColor: '#1f5e3b',
    paddingHorizontal: 20, paddingBottom: 20,
    borderBottomLeftRadius: 28, borderBottomRightRadius: 28,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#ffffff', fontFamily: 'Inter_700Bold' },
  headerSub: { fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 3, fontFamily: 'Inter_400Regular' },
  content: { padding: 16, gap: 0 },
  statusCard: {
    backgroundColor: '#ffffff', borderRadius: 16, padding: 16,
    marginBottom: 14, borderWidth: 1, borderColor: '#e0e7e3',
    shadowColor: '#1b2b21', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 6, elevation: 2,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  statusItem: { alignItems: 'center', gap: 4 },
  statusLabel: { fontSize: 11, color: '#9cb8a8', fontFamily: 'Inter_400Regular' },
  statusTime: { fontSize: 20, fontWeight: '700', fontFamily: 'Inter_700Bold' },
  infoCard: {
    backgroundColor: '#ffffff', borderRadius: 16, padding: 14,
    marginBottom: 12, borderWidth: 1, borderColor: '#e0e7e3',
    shadowColor: '#1b2b21', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 6, elevation: 2,
  },
  infoCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  infoIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  infoTitle: { fontSize: 13, fontWeight: '600', color: '#1b2b21', fontFamily: 'Inter_600SemiBold' },
  infoSub: { fontSize: 12, color: '#6b9080', marginTop: 2, fontFamily: 'Inter_400Regular' },
  refreshBtn: { padding: 6 },
  infoBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 10, paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 8,
  },
  infoBadgeText: { fontSize: 11, fontFamily: 'Inter_500Medium', flex: 1 },
  feedbackBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    borderRadius: 12, padding: 14, marginBottom: 14,
  },
  feedbackText: { fontSize: 14, fontFamily: 'Inter_500Medium', flex: 1, lineHeight: 20 },
  punchBtn: {
    backgroundColor: '#1f5e3b', borderRadius: 20,
    paddingVertical: 24, alignItems: 'center',
    gap: 8, marginBottom: 16,
    shadowColor: '#1f5e3b', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3, shadowRadius: 16, elevation: 8,
  },
  punchBtnOut: { backgroundColor: '#f59e0b', shadowColor: '#f59e0b' },
  punchBtnLoading: { opacity: 0.75 },
  punchBtnText: { fontSize: 18, fontWeight: '700', color: '#ffffff', fontFamily: 'Inter_700Bold' },
  punchBtnSub: { fontSize: 12, color: 'rgba(255,255,255,0.75)', fontFamily: 'Inter_400Regular' },
  hint: {
    textAlign: 'center', color: '#9cb8a8', fontSize: 11,
    fontFamily: 'Inter_400Regular', lineHeight: 17, paddingHorizontal: 8,
  },
});
