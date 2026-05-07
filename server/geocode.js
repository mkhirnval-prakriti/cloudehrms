/**
 * @param {number|null|undefined} lat
 * @param {number|null|undefined} lng
 * @param {{ timeoutMs?: number }} [opts]
 */
async function reverseGeocode(lat, lng, opts = {}) {
  if (lat == null || lng == null) return null;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 6000;
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(
    lat
  )}&lon=${encodeURIComponent(lng)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "HRMS-Portal/2.0 (attendance)",
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { reverseGeocode };
