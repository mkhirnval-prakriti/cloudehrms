function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function minutesSinceMidnight(iso) {
  const d = new Date(iso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseHmToMinutes(hm) {
  if (!hm || typeof hm !== "string") return 9 * 60;
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h)) return 9 * 60;
  return h * 60 + (Number.isNaN(m) ? 0 : m);
}

module.exports = { haversineMeters, minutesSinceMidnight, parseHmToMinutes };
