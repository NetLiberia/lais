import { useEffect, useMemo, useState } from 'react';
import { GeoJSON, LayersControl, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import type { Geometry } from 'geojson';
import type { GisFeatureCollection, WorkspaceLayerKey } from '../types';

/**
 * The GIS officer's parcel workspace map. Published (approved reference) parcels, working staging data,
 * submitted staging data and diagnostic layers are drawn differently, each can be switched off, and the
 * legend says which is authoritative. Coordinates are shown in WGS 84 and UTM 29N; a scale bar is shown.
 */
export const LAYER_STYLE: Record<WorkspaceLayerKey, L.PathOptions & { label: string; swatch: string }> = {
  reference: { label: 'Approved reference parcels (published register)', swatch: '#1f5fbf', color: '#1f5fbf', weight: 1.5, fillColor: '#1f5fbf', fillOpacity: 0.08 },
  working: { label: 'Working staging data (not registered)', swatch: '#c77700', color: '#c77700', weight: 2.5, dashArray: '6 5', fillColor: '#f2b84b', fillOpacity: 0.18 },
  submitted: { label: 'Submitted staging data (under review)', swatch: '#7a2fb6', color: '#7a2fb6', weight: 2, dashArray: '3 4', fillColor: '#b18be0', fillOpacity: 0.15 },
  invalid: { label: 'Invalid geometry (as received, not repaired)', swatch: '#b00020', color: '#b00020', weight: 3, dashArray: '2 4', fillColor: '#b00020', fillOpacity: 0.12 },
  overlaps: { label: 'Overlap areas with published parcels', swatch: '#d1342f', color: '#d1342f', weight: 1, fillColor: '#d1342f', fillOpacity: 0.55 },
  duplicates: { label: 'Duplicate identifiers', swatch: '#e0689b', color: '#e0689b', weight: 3, fillColor: '#e0689b', fillOpacity: 0.2 },
  boundary: { label: 'County boundary', swatch: '#555', color: '#555', weight: 2, dashArray: '10 6', fill: false },
};
const ORDER: WorkspaceLayerKey[] = ['boundary', 'reference', 'submitted', 'working', 'duplicates', 'invalid', 'overlaps'];

const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const popupFor = (key: WorkspaceLayerKey, p: Record<string, unknown>) => {
  const rows = Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== '').slice(0, 10)
    .map(([k, v]) => `<tr><th>${escape(k.replace(/_/g, ' '))}</th><td>${escape(v)}</td></tr>`).join('');
  return `<strong>${escape(LAYER_STYLE[key].label)}</strong><table class="popup-table">${rows}</table>`;
};

/** WGS 84 longitude/latitude to UTM zone 29N easting/northing (metres), for the coordinate readout. */
export function toUtm29n(lon: number, lat: number): [number, number] {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180, lam0 = (-9 * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const y = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  return [x, y];
}

function Coordinates() {
  const [pos, setPos] = useState<L.LatLng | null>(null);
  useMapEvents({ mousemove: (e) => setPos(e.latlng), mouseout: () => setPos(null) });
  if (!pos) return <div className="map-coords muted">Move the pointer over the map for coordinates</div>;
  const [x, y] = toUtm29n(pos.lng, pos.lat);
  return (
    <div className="map-coords" aria-live="off">
      WGS 84: {pos.lat.toFixed(6)}, {pos.lng.toFixed(6)} · UTM 29N: {x.toFixed(1)} E, {y.toFixed(1)} N
    </div>
  );
}

function Scale() {
  const map = useMap();
  useEffect(() => {
    const c = L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);
    return () => { c.remove(); };
  }, [map]);
  return null;
}

/** Fits the map to a geometry whenever `target` changes (search results, zoom-to-finding). */
function FitTo({ target }: { target: { geometry: Geometry; token: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    const b = L.geoJSON(target.geometry).getBounds();
    if (b.isValid()) map.flyToBounds(b.pad(0.8), { maxZoom: 18, duration: 0.6 });
  }, [map, target]);
  return null;
}

function FitInitial({ layers }: { layers: Partial<Record<WorkspaceLayerKey, GisFeatureCollection>> }) {
  const map = useMap();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    for (const key of ['working', 'submitted', 'boundary', 'reference'] as WorkspaceLayerKey[]) {
      const fc = layers[key];
      if (fc && fc.features.length) {
        const b = L.geoJSON(fc as GeoJSON.FeatureCollection).getBounds();
        if (b.isValid()) { map.fitBounds(b.pad(0.1), { maxZoom: 17 }); setDone(true); return; }
      }
    }
  }, [map, layers, done]);
  return null;
}

export function WorkspaceMap({ layers, focus, height = 560, onFeatureClick, initiallyOff = [] }: {
  layers: Partial<Record<WorkspaceLayerKey, GisFeatureCollection>>;
  focus?: { geometry: Geometry; token: number } | null;
  height?: number;
  onFeatureClick?: (layer: WorkspaceLayerKey, properties: Record<string, unknown>) => void;
  initiallyOff?: WorkspaceLayerKey[];
}) {
  const present = useMemo(() => ORDER.filter((k) => layers[k]), [layers]);
  return (
    <div className="map-wrap workspace-map" style={{ height }}>
      <MapContainer center={[6.35, -10.7]} zoom={11} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="OpenStreetMap">
            <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="No basemap (offline)">
            <TileLayer url="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
          </LayersControl.BaseLayer>
          {present.map((key) => (
            <LayersControl.Overlay key={key} checked={!initiallyOff.includes(key)} name={`${LAYER_STYLE[key].label} (${layers[key]!.features.length})`}>
              <GeoJSON
                key={`${key}-${layers[key]!.features.length}`}
                data={layers[key] as GeoJSON.FeatureCollection}
                style={() => LAYER_STYLE[key]}
                interactive={key !== 'boundary'}
                onEachFeature={(f, layer) => {
                  layer.bindPopup(popupFor(key, (f.properties ?? {}) as Record<string, unknown>));
                  if (onFeatureClick) layer.on('click', () => onFeatureClick(key, (f.properties ?? {}) as Record<string, unknown>));
                }}
              />
            </LayersControl.Overlay>
          ))}
        </LayersControl>
        <Scale />
        <Coordinates />
        <FitInitial layers={layers} />
        <FitTo target={focus ?? null} />
      </MapContainer>
      <div className="map-legend" aria-label="Map legend">
        {present.map((k) => (
          <span key={k}><i style={{ background: k === 'boundary' ? 'transparent' : LAYER_STYLE[k].swatch, border: `2px ${LAYER_STYLE[k].dashArray ? 'dashed' : 'solid'} ${LAYER_STYLE[k].swatch}` }} />{LAYER_STYLE[k].label}</span>
        ))}
      </div>
    </div>
  );
}

/** Two versions of a case overlaid: version A solid blue, version B dashed orange. */
export function VersionOverlayMap({ a, b, labelA, labelB, height = 420 }: { a: GisFeatureCollection; b: GisFeatureCollection; labelA: string; labelB: string; height?: number }) {
  const both = useMemo(() => ({ working: b, reference: a }), [a, b]);
  return (
    <div className="map-wrap workspace-map" style={{ height }}>
      <MapContainer center={[6.35, -10.7]} zoom={14} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
        <LayersControl position="topright">
          <LayersControl.Overlay checked name={labelA}>
            <GeoJSON key={`a-${a.features.length}`} data={a as GeoJSON.FeatureCollection} style={{ color: '#1f5fbf', weight: 3, fillOpacity: 0.1 }}
              onEachFeature={(f, l) => l.bindPopup(`${escape(labelA)}: feature ${Number(f.properties?.feature_index) + 1}`)} />
          </LayersControl.Overlay>
          <LayersControl.Overlay checked name={labelB}>
            <GeoJSON key={`b-${b.features.length}`} data={b as GeoJSON.FeatureCollection} style={{ color: '#c77700', weight: 2.5, dashArray: '6 5', fillOpacity: 0.1 }}
              onEachFeature={(f, l) => l.bindPopup(`${escape(labelB)}: feature ${Number(f.properties?.feature_index) + 1}`)} />
          </LayersControl.Overlay>
        </LayersControl>
        <Scale />
        <Coordinates />
        <FitInitial layers={both} />
      </MapContainer>
      <div className="map-legend">
        <span><i style={{ background: '#1f5fbf' }} />{labelA}</span>
        <span><i style={{ border: '2px dashed #c77700', background: 'transparent' }} />{labelB}</span>
      </div>
    </div>
  );
}
