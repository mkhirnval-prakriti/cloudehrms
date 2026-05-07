import { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Platform, Modal, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { useColors } from '@/hooks/useColors';

type LeaveRequest = {
  id: number;
  leave_type: string;
  from_date: string;
  to_date: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  applied_at: string;
  days?: number;
};

const LEAVE_TYPES = [
  { key: 'casual', label: 'Casual Leave', short: 'CL' },
  { key: 'sick', label: 'Sick Leave', short: 'SL' },
  { key: 'annual', label: 'Annual Leave', short: 'AL' },
  { key: 'unpaid', label: 'Unpaid Leave', short: 'UL' },
];

function statusColor(s: string) {
  if (s === 'approved') return { text: '#15803d', bg: '#dcfce7' };
  if (s === 'rejected') return { text: '#dc2626', bg: '#fee2e2' };
  return { text: '#92400e', bg: '#fef3c7' };
}

function statusLabel(s: string) {
  if (s === 'approved') return 'Approved';
  if (s === 'rejected') return 'Rejected';
  return 'Pending';
}

export default function LeaveScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  const [leaveType, setLeaveType] = useState('casual');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [reason, setReason] = useState('');

  const { data, refetch } = useQuery({
    queryKey: ['/api/leave/my'],
    queryFn: () => apiRequest<{ leaves: LeaveRequest[] }>('/leave?my=true'),
  });

  const leaves = data?.leaves ?? [];

  async function onRefresh() {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }

  function openModal() {
    const today = new Date().toISOString().split('T')[0];
    setFromDate(today);
    setToDate(today);
    setReason('');
    setLeaveType('casual');
    setFormError('');
    setFormSuccess('');
    setShowModal(true);
  }

  async function submitLeave() {
    if (!fromDate || !toDate) {
      setFormError('Dates ज़रूरी हैं।');
      return;
    }
    if (!reason.trim()) {
      setFormError('Reason लिखें।');
      return;
    }
    setFormError('');
    setSubmitting(true);
    try {
      await apiRequest('/leave/apply', {
        method: 'POST',
        body: JSON.stringify({ leave_type: leaveType, from_date: fromDate, to_date: toDate, reason: reason.trim() }),
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setFormSuccess('Leave application submit हो गई!');
      await refetch();
      qc.invalidateQueries({ queryKey: ['/api/leave'] });
      setTimeout(() => setShowModal(false), 1200);
    } catch (e) {
      setFormError((e as Error).message ?? 'Apply failed। दोबारा try करें।');
    }
    setSubmitting(false);
  }

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 14 }]}>
        <View>
          <Text style={styles.headerTitle}>Leave Management</Text>
          <Text style={styles.headerSub}>{leaves.length} applications</Text>
        </View>
        <TouchableOpacity style={styles.applyBtn} onPress={openModal} activeOpacity={0.85}>
          <Ionicons name="add" size={18} color="#ffffff" />
          <Text style={styles.applyBtnText}>Apply</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 24 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {leaves.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="calendar-outline" size={48} color="#9cb8a8" />
            <Text style={styles.emptyTitle}>कोई Leave नहीं</Text>
            <Text style={styles.emptySub}>Leave apply करने के लिए + button दबाएं</Text>
          </View>
        ) : (
          leaves.map(l => {
            const sc = statusColor(l.status);
            const lt = LEAVE_TYPES.find(x => x.key === l.leave_type);
            return (
              <View key={l.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={[styles.typeBadge, { backgroundColor: '#e8f5ee' }]}>
                    <Text style={[styles.typeShort, { color: '#1f5e3b' }]}>{lt?.short ?? 'L'}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardType}>{lt?.label ?? l.leave_type}</Text>
                    <Text style={styles.cardDates}>{l.from_date} → {l.to_date}</Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.statusText, { color: sc.text }]}>{statusLabel(l.status)}</Text>
                  </View>
                </View>
                {!!l.reason && (
                  <Text style={styles.cardReason} numberOfLines={2}>{l.reason}</Text>
                )}
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Apply Leave Modal */}
      <Modal visible={showModal} animationType="slide" transparent presentationStyle="formSheet">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { paddingBottom: bottomPad + 16 }]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Leave Apply करें</Text>
              <TouchableOpacity onPress={() => setShowModal(false)} style={styles.closeBtn}>
                <Ionicons name="close" size={22} color="#6b9080" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {!!formError && (
                <View style={[styles.feedbackBox, { backgroundColor: '#fee2e2' }]}>
                  <Ionicons name="alert-circle" size={16} color="#ef4444" />
                  <Text style={[styles.feedbackText, { color: '#dc2626' }]}>{formError}</Text>
                </View>
              )}
              {!!formSuccess && (
                <View style={[styles.feedbackBox, { backgroundColor: '#dcfce7' }]}>
                  <Ionicons name="checkmark-circle" size={16} color="#16a34a" />
                  <Text style={[styles.feedbackText, { color: '#15803d' }]}>{formSuccess}</Text>
                </View>
              )}

              <Text style={styles.fieldLabel}>Leave Type</Text>
              <View style={styles.typeRow}>
                {LEAVE_TYPES.map(t => (
                  <TouchableOpacity
                    key={t.key}
                    style={[styles.typeChip, leaveType === t.key && styles.typeChipActive]}
                    onPress={() => setLeaveType(t.key)}
                  >
                    <Text style={[styles.typeChipText, leaveType === t.key && styles.typeChipTextActive]}>
                      {t.short}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.fieldLabel}>From Date</Text>
              <TextInput
                style={styles.textInput}
                value={fromDate}
                onChangeText={setFromDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#9cb8a8"
              />

              <Text style={styles.fieldLabel}>To Date</Text>
              <TextInput
                style={styles.textInput}
                value={toDate}
                onChangeText={setToDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#9cb8a8"
              />

              <Text style={styles.fieldLabel}>Reason</Text>
              <TextInput
                style={[styles.textInput, { minHeight: 80, textAlignVertical: 'top' }]}
                value={reason}
                onChangeText={setReason}
                placeholder="Leave का कारण लिखें…"
                placeholderTextColor="#9cb8a8"
                multiline
              />

              <TouchableOpacity
                style={[styles.submitBtn, submitting && { opacity: 0.65 }]}
                onPress={submitLeave}
                disabled={submitting}
                activeOpacity={0.85}
              >
                {submitting ? (
                  <ActivityIndicator color="#ffffff" size="small" />
                ) : (
                  <>
                    <Ionicons name="send" size={16} color="#ffffff" />
                    <Text style={styles.submitBtnText}>Submit करें</Text>
                  </>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    backgroundColor: '#1f5e3b', paddingHorizontal: 20, paddingBottom: 20,
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    borderBottomLeftRadius: 28, borderBottomRightRadius: 28,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#ffffff', fontFamily: 'Inter_700Bold' },
  headerSub: { fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 3, fontFamily: 'Inter_400Regular' },
  applyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  applyBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  content: { padding: 16 },
  empty: { alignItems: 'center', paddingTop: 64, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: '#1b2b21', fontFamily: 'Inter_600SemiBold' },
  emptySub: { fontSize: 13, color: '#6b9080', fontFamily: 'Inter_400Regular' },
  card: {
    backgroundColor: '#ffffff', borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: '#e0e7e3',
    shadowColor: '#1b2b21', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 6, elevation: 2,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  typeBadge: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  typeShort: { fontWeight: '700', fontSize: 13, fontFamily: 'Inter_700Bold' },
  cardType: { fontSize: 14, fontWeight: '600', color: '#1b2b21', fontFamily: 'Inter_600SemiBold' },
  cardDates: { fontSize: 12, color: '#6b9080', marginTop: 2, fontFamily: 'Inter_400Regular' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusText: { fontSize: 11, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  cardReason: { fontSize: 12, color: '#6b9080', marginTop: 10, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  modalSheet: {
    backgroundColor: '#ffffff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 20, maxHeight: '90%',
  },
  modalHandle: { width: 36, height: 4, backgroundColor: '#e0e7e3', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1b2b21', fontFamily: 'Inter_700Bold' },
  closeBtn: { padding: 4 },
  feedbackBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, padding: 12, marginBottom: 16 },
  feedbackText: { fontSize: 13, flex: 1, fontFamily: 'Inter_400Regular' },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#1b2b21', marginBottom: 8, fontFamily: 'Inter_600SemiBold' },
  textInput: {
    backgroundColor: '#f9fafb', borderRadius: 12, borderWidth: 1.5, borderColor: '#e0e7e3',
    padding: 14, fontSize: 14, color: '#1b2b21', marginBottom: 16, fontFamily: 'Inter_400Regular',
  },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  typeChip: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    backgroundColor: '#f0f4f1', borderWidth: 1.5, borderColor: '#e0e7e3',
  },
  typeChipActive: { backgroundColor: '#1f5e3b', borderColor: '#1f5e3b' },
  typeChipText: { fontSize: 13, fontWeight: '600', color: '#6b9080', fontFamily: 'Inter_600SemiBold' },
  typeChipTextActive: { color: '#ffffff' },
  submitBtn: {
    backgroundColor: '#1f5e3b', borderRadius: 14, paddingVertical: 15, marginTop: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  submitBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 15, fontFamily: 'Inter_700Bold' },
});
