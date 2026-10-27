import { useEffect, useMemo } from 'react';
import { GeoJSON, LayersControl, MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Geometry } from 'geojson';

/**
 * Map for quality review. Working (staged) data and authoritative published data are drawn
 * differently on purpose: working geometries are dashed amber outlines labelled "not registered",
 * published reference parcels are solid blue. Layers can be switched on and off.
 */
export interface ReviewLayerItem { id: string; geometry: Geometry; popup: string; invalid?: boolean }
export interface ReviewMapProps {
  working: ReviewLayerItem[];
  references?: ReviewLayerItem[];
  overlaps?: ReviewLayerItem[];
  county?: { geometry: Geometry; label: string } | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  height?: number;
  /** Changing this number re-fits the map to all working data. */
  fitToken?: number;
}

const STYLE = {
  working: { color: '#c77700', weight: 2.5, dashArray: '6 5', fillColor: '#f2b84b', fillOpacity: 0.18 },
  invalid: { color: '#b00020', weight: 3, dashArray: '2 4', fillColor: '#b00020', fillOpacity: 0.12 },
  selected: { color: '#7a2fb6', weight: 4, dashArray: undefined, fillOpacity: 0.25 },
  reference: { color: '#1f5fbf', weight: 2, fillColor: '#1f5fbf', fillOpacity: 0.08 },
  overlap: { color: '#d1342f', weight: 1, fillColor: '#d1342f', fillOpacity: 0.55 },
  county: { color: '#555', weight: 2, dashArray: '10 6', fill: false },
};

function bounds(items: { geometry: Geometry }[]) {
  const b = L.featureGroup(items.map((i) => L.geoJSON(i.geometry))).getBounds();
  return b.isValid() ? b : null;
}

function Fit({ items, token }: { items: ReviewLayerItem[]; token: number }) {
  const map = useMap();
  useEffect(() => {
    const b = bounds(items);
    if (b) map.fitBounds(b.pad(0.4), { maxZoom: 19 });
  }, [map, token]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function ZoomTo({ item }: { item: ReviewLayerItem | undefined }) {
  const map = useMap();
  useEffect(() => {
    if (!item) return;
    const b = bounds([item]);
    if (b) map.flyToBounds(b.pad(0.6), { maxZoom: 19, duration: 0.6 });
  }, [map, item]);
  return null;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function ReviewMap({ working, references = [], overlaps = [], county, selectedId, onSelect, height = 420, fitToken = 0 }: ReviewMapProps) {
  const selected = useMemo(() => working.find((w) => w.id === selectedId), [working, selectedId]);
  const start = useMemo(() => bounds(working)?.getCenter() ?? L.latLng(6.3, -10.8), [working]);
  if (working.length === 0) return <div className="map-empty muted">No geometry to show.</div>;
  return (
    <div className="map-wrap" style={{ height }}>
      <MapContainer center={start} zoom={16} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
        <LayersControl position="topright">
          {county && (
            <LayersControl.Overlay checked name="County boundary">
              <GeoJSON data={county.geometry} style={STYLE.county} interactive={false} />
            </LayersControl.Overlay>
          )}
          {references.length > 0 && (
            <LayersControl.Overlay checked name="Published parcels (authoritative)">
              <GeoJSON key={`ref-${references.length}`} data={{ type: 'FeatureCollection', features: references.map((r) => ({ type: 'Feature', geometry: r.geometry, properties: { popup: r.popup } })) } as GeoJSON.FeatureCollection}
                style={STYLE.reference} onEachFeature={(f, layer) => layer.bindPopup(escape(String(f.properties?.popup)))} />
            </LayersControl.Overlay>
          )}
          <LayersControl.Overlay checked name="Submitted working data (not registered)">
            <GeoJSON key={`work-${working.length}-${selectedId}`}
              data={{ type: 'FeatureCollection', features: working.map((w) => ({ type: 'Feature', geometry: w.geometry, properties: { id: w.id, popup: w.popup, invalid: w.invalid } })) } as GeoJSON.FeatureCollection}
              style={(f) => (f?.properties?.id === selectedId ? STYLE.selected : f?.properties?.invalid ? STYLE.invalid : STYLE.working)}
              onEachFeature={(f, layer) => {
                layer.bindPopup(`<strong>WORKING DATA: not registered</strong><br>${escape(String(f.properties?.popup))}`);
                layer.on('click', () => onSelect?.(String(f.properties?.id)));
              }} />
          </LayersControl.Overlay>
          {overlaps.length > 0 && (
            <LayersControl.Overlay checked name="Potential overlap areas">
              <GeoJSON key={`ov-${overlaps.length}`} data={{ type: 'FeatureCollection', features: overlaps.map((o) => ({ type: 'Feature', geometry: o.geometry, properties: { popup: o.popup } })) } as GeoJSON.FeatureCollection}
                style={STYLE.overlap} onEachFeature={(f, layer) => layer.bindPopup(escape(String(f.properties?.popup)))} />
            </LayersControl.Overlay>
          )}
        </LayersControl>
        <Fit items={working} token={fitToken} />
        <ZoomTo item={selected} />
      </MapContainer>
      <div className="map-legend">
        <span><i className="sw-working" />Submitted working data (not registered)</span>
        <span><i className="sw-invalid" />Invalid record</span>
        {references.length > 0 && <span><i style={{ background: '#1f5fbf' }} />Published parcel (authoritative)</span>}
        {overlaps.length > 0 && <span><i style={{ background: '#d1342f' }} />Potential overlap area</span>}
        {county && <span><i className="dashed" />{county.label}</span>}
      </div>
    </div>
  );
}
