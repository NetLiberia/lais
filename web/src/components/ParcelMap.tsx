import { useEffect, useMemo, useState } from 'react';
import { GeoJSON, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { api, human } from '../api';

export interface Overlay {
  id: string;
  data: Feature | FeatureCollection | Geometry;
  color: string;
  label?: string;
  dashed?: boolean;
}

interface Props {
  overlays?: Overlay[];
  /** Fit the view to these overlays on first render. */
  fitOverlays?: boolean;
  showParcels?: boolean;
  showCounties?: boolean;
  onParcelClick?: (upi: string) => void;
  height?: number | string;
  highlightUpi?: string | null;
}

const LIBERIA_PILOT_CENTER: [number, number] = [6.302, -10.797];

const CATEGORY_COLORS: Record<string, string> = {
  private: '#2f6f4f',
  customary: '#9a6a12',
  government: '#2b5c9e',
  public: '#6b4fa0',
};

export function categoryColor(category: string) {
  return CATEGORY_COLORS[category] ?? '#555';
}

function PublicParcels({ onParcelClick, highlightUpi }: Pick<Props, 'onParcelClick' | 'highlightUpi'>) {
  const map = useMap();
  const [data, setData] = useState<FeatureCollection | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',');
    api<FeatureCollection & { truncated?: boolean; message?: string }>(`/public/parcels?bbox=${bbox}`)
      .then((fc) => {
        setData(fc);
        setMessage(fc.message ?? (fc.truncated ? 'Showing the first 2000 parcels; zoom in for more' : null));
      })
      .catch(() => setMessage('Parcel layer unavailable'));
  };

  useMapEvents({ moveend: load });
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const key = useMemo(() => `${JSON.stringify(data?.features.map((f) => f.properties?.upi))}|${highlightUpi}`, [data, highlightUpi]);

  return (
    <>
      {message && <div className="map-message">{message}</div>}
      {data && (
        <GeoJSON
          key={key}
          data={data}
          style={(f) => ({
            color: f?.properties?.upi === highlightUpi ? '#d1342f' : categoryColor(f?.properties?.land_category),
            weight: f?.properties?.upi === highlightUpi ? 3 : 1.5,
            fillOpacity: f?.properties?.record_status === 'under dispute' ? 0.45 : 0.18,
            dashArray: f?.properties?.record_status === 'under dispute' ? '4 3' : undefined,
          })}
          onEachFeature={(f, layer) => {
            const p = f.properties ?? {};
            // Popups only ever show the public field list returned by the public endpoint.
            layer.bindTooltip(
              `<strong>${p.upi}</strong><br/>${human(p.land_category)} · ${p.land_use ?? '—'}<br/>${p.record_status}`,
              { sticky: true },
            );
            if (onParcelClick) layer.on('click', () => onParcelClick(p.upi));
          }}
        />
      )}
    </>
  );
}

function Counties() {
  const [data, setData] = useState<FeatureCollection | null>(null);
  useEffect(() => {
    api<FeatureCollection>('/public/counties').then(setData).catch(() => undefined);
  }, []);
  if (!data) return null;
  return (
    <GeoJSON
      data={data}
      interactive={false}
      style={{ color: '#333', weight: 2, dashArray: '8 6', fill: false }}
    />
  );
}

function FitTo({ overlays }: { overlays: Overlay[] }) {
  const map = useMap();
  useEffect(() => {
    const group = L.featureGroup(overlays.map((o) => L.geoJSON(o.data as any)));
    const bounds = group.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(1.5), { maxZoom: 18 });
  }, [map, overlays]);
  return null;
}

export function ParcelMap({ overlays = [], fitOverlays = true, showParcels = true, showCounties = true, onParcelClick, height = 420, highlightUpi }: Props) {
  return (
    <div className="map-wrap" style={{ height }}>
      <MapContainer center={LIBERIA_PILOT_CENTER} zoom={16} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
        {showCounties && <Counties />}
        {showParcels && <PublicParcels onParcelClick={onParcelClick} highlightUpi={highlightUpi} />}
        {overlays.map((o) => (
          <GeoJSON
            key={`${o.id}-${JSON.stringify(o.data).length}`}
            data={o.data as any}
            style={{ color: o.color, weight: 3, fillOpacity: 0.3, dashArray: o.dashed ? '6 4' : undefined }}
            onEachFeature={(_f, layer) => o.label && layer.bindTooltip(o.label, { sticky: true })}
          />
        ))}
        {fitOverlays && overlays.length > 0 && <FitTo overlays={overlays} />}
      </MapContainer>
      <div className="map-legend">
        {Object.entries(CATEGORY_COLORS).map(([k, c]) => (
          <span key={k}><i style={{ background: c }} />{k}</span>
        ))}
        <span><i className="dashed" />under dispute</span>
        {overlays.map((o) => o.label && <span key={o.id}><i style={{ background: o.color }} />{o.label}</span>)}
      </div>
    </div>
  );
}
