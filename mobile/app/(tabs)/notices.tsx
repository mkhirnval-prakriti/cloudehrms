import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { useColors } from '@/hooks/useColors';
import { useState } from 'react';

type Notice = {
  id: number;
  title: string;
  body: string;
  priority: 'normal' | 'important' | 'urgent';
  created_at: string;
  read?: boolean;
};

function priorityStyle(p: string) {
  if (p === 'urgent') return { color: '#dc2626', bg: '#fee2e2', icon: 'alert-circle' as const };
  if (p === 'important') return { color: '#92400e', bg: '#fef3c7', icon: 'warning' as const };
  return { color: '#1f5e3b', bg: '#e8f5ee', icon: 'information-circle' as const };
}

export default function NoticesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ['/api/notices'],
    queryFn: () => apiRequest<{ notices: Notice[] }>('/notices?limit=50'),
  });

  const notices = data?.notices ?? [];
  const unread = notices.filter(n => !n.read).length;

  async function onRefresh() {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }

  async function markRead(id: number) {
    try {
      await apiRequest(`/notices/${id}/read`, { method: 'POST' });
      qc.invalidateQueries({ queryKey: ['/api/notices'] });
    } catch { /* non-critical */ }
  }

  function toggleExpand(id: number) {
    setExpanded(prev => (prev === id ? null : id));
    const notice = notices.find(n => n.id === id);
    if (notice && !notice.read) markRead(id);
  }

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 14 }]}>
        <View>
          <Text style={styles.headerTitle}>Notices</Text>
          <Text style={styles.headerSub}>
            {unread > 0 ? `${unread} unread` : 'सब पढ़ लिए'}
          </Text>
        </View>
        {unread > 0 && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadNum}>{unread}</Text>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 24 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {notices.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="notifications-outline" size={48} color="#9cb8a8" />
            <Text style={styles.emptyTitle}>कोई Notice नहीं</Text>
            <Text style={styles.emptySub}>HR से कोई नई notice नहीं है।</Text>
          </View>
        ) : (
          notices.map(n => {
            const ps = priorityStyle(n.priority);
            const isOpen = expanded === n.id;
            const dateStr = new Date(n.created_at).toLocaleDateString('hi-IN', {
              day: 'numeric', month: 'short', year: 'numeric',
            });
            return (
              <TouchableOpacity
                key={n.id}
                style={[styles.card, !n.read && styles.cardUnread]}
                onPress={() => toggleExpand(n.id)}
                activeOpacity={0.85}
              >
                <View style={styles.cardTop}>
                  <View style={[styles.priorityIcon, { backgroundColor: ps.bg }]}>
                    <Ionicons name={ps.icon} size={16} color={ps.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardTitle, !n.read && styles.cardTitleUnread]} numberOfLines={isOpen ? undefined : 1}>
                      {n.title}
                    </Text>
                    <Text style={styles.cardDate}>{dateStr}</Text>
                  </View>
                  {!n.read && <View style={styles.dot} />}
                  <Ionicons
                    name={isOpen ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color="#9cb8a8"
                  />
                </View>
                {isOpen && (
                  <Text style={styles.cardBody}>{n.body}</Text>
                )}
                {isOpen && (
                  <View style={[styles.priorityTag, { backgroundColor: ps.bg }]}>
                    <Text style={[styles.priorityTagText, { color: ps.color }]}>
                      {n.priority.charAt(0).toUpperCase() + n.priority.slice(1)}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
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
  unreadBadge: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#fef3c7', alignItems: 'center', justifyContent: 'center',
  },
  unreadNum: { fontSize: 14, fontWeight: '700', color: '#92400e', fontFamily: 'Inter_700Bold' },
  content: { padding: 16 },
  empty: { alignItems: 'center', paddingTop: 64, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: '#1b2b21', fontFamily: 'Inter_600SemiBold' },
  emptySub: { fontSize: 13, color: '#6b9080', fontFamily: 'Inter_400Regular' },
  card: {
    backgroundColor: '#ffffff', borderRadius: 16, padding: 16, marginBottom: 10,
    borderWidth: 1, borderColor: '#e0e7e3',
    shadowColor: '#1b2b21', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 6, elevation: 2,
  },
  cardUnread: { borderColor: '#1f5e3b', borderWidth: 1.5 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  priorityIcon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 14, fontWeight: '500', color: '#6b9080', fontFamily: 'Inter_500Medium' },
  cardTitleUnread: { fontWeight: '700', color: '#1b2b21', fontFamily: 'Inter_700Bold' },
  cardDate: { fontSize: 11, color: '#9cb8a8', marginTop: 2, fontFamily: 'Inter_400Regular' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1f5e3b' },
  cardBody: {
    fontSize: 13, color: '#6b9080', lineHeight: 20,
    marginTop: 12, fontFamily: 'Inter_400Regular',
  },
  priorityTag: {
    alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20, marginTop: 10,
  },
  priorityTagText: { fontSize: 11, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
});
