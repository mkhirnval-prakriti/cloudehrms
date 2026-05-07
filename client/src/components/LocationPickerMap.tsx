import { useEffect, useRef } from 'react'
import { Circle, MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

interface Props {
  lat: number | null
  lng: number | null
  radius: number
  onMove: (lat: number, lng: number) => void
  centerTrigger?: number
}

function ClickHandler({ onMove }: { onMove: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onMove(e.latlng.lat, e.latlng.lng) })
  return null
}

function Recenterer({ lat, lng, trigger }: { lat: number; lng: number; trigger: number }) {
  const map = useMapEvents({})
  useEffect(() => {
    if (trigger > 0) map.setView([lat, lng], 16)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])
  return null
}

export function LocationPickerMap({ lat, lng, radius, onMove, centerTrigger = 0 }: Props) {
  const markerRef = useRef<L.Marker>(null)
  const hasPos = lat != null && lng != null
  const center: [number, number] = hasPos ? [lat!, lng!] : [20.5937, 78.9629]

  return (
    <MapContainer
      center={center}
      zoom={hasPos ? 15 : 5}
      style={{ height: '320px', width: '100%', borderRadius: '12px', zIndex: 0 }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickHandler onMove={onMove} />
      {hasPos && centerTrigger > 0 && (
        <Recenterer lat={lat!} lng={lng!} trigger={centerTrigger} />
      )}
      {hasPos && (
        <>
          <Marker
            position={[lat!, lng!]}
            draggable
            ref={markerRef}
            eventHandlers={{
              dragend() {
                const p = markerRef.current?.getLatLng()
                if (p) onMove(p.lat, p.lng)
              },
            }}
          />
          <Circle
            center={[lat!, lng!]}
            radius={radius}
            pathOptions={{ color: '#1f5e3b', fillColor: '#1f5e3b', fillOpacity: 0.13, weight: 2, dashArray: '6 4' }}
          />
        </>
      )}
    </MapContainer>
  )
}
