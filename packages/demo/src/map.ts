import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MetadataSnapshot } from '@web-video-streamer/lib';

export class CameraMap {
  private readonly map: L.Map;
  private readonly accuracy: L.Circle;
  private readonly marker: L.CircleMarker;
  private readonly footprint: L.Polygon;
  private readonly axis: L.Polyline;
  private readonly center: L.CircleMarker;
  private follow = true;
  private hasFix = false;
  private lastPosition?: L.LatLngTuple;

  constructor(element: HTMLElement) {
    this.map = L.map(element, { zoomControl: true, attributionControl: true }).setView([20, 0], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0b6bcb';
    this.accuracy = L.circle([0, 0], { radius: 0, color: accent, weight: 1, fillOpacity: 0.08, interactive: false });
    this.footprint = L.polygon([], { color: accent, weight: 1.5, fillOpacity: 0.25, interactive: false });
    this.axis = L.polyline([], { color: accent, weight: 1, dashArray: '4 4', interactive: false });
    this.center = L.circleMarker([0, 0], { radius: 3, color: accent, weight: 1, fillOpacity: 1, interactive: false });
    this.marker = L.circleMarker([0, 0], { radius: 6, color: '#fff', weight: 2, fillColor: accent, fillOpacity: 1 });

    // Stop following once the user pans; the recenter control turns it back on.
    this.map.on('dragstart', () => (this.follow = false));
    this.addRecenterControl();
  }

  update(snap: MetadataSnapshot): void {
    const { position, pose, fov, footprint } = snap;
    if (!position) return;
    const latLng: L.LatLngTuple = [position.latitude, position.longitude];
    this.lastPosition = latLng;

    if (!this.hasFix) {
      this.hasFix = true;
      for (const layer of [this.accuracy, this.footprint, this.axis, this.center, this.marker]) layer.addTo(this.map);
      this.map.setView(latLng, 18);
    } else if (this.follow && !this.map.getBounds().pad(-0.2).contains(latLng)) {
      this.map.panTo(latLng);
    }

    this.accuracy.setLatLng(latLng).setRadius(position.accuracy);
    this.marker.setLatLng(latLng);

    if (!footprint) {
      this.footprint.setLatLngs([]);
      this.axis.setLatLngs([]);
      this.center.setLatLng(latLng).setStyle({ opacity: 0, fillOpacity: 0 });
      this.setLabel(pose ? 'heading not north-referenced' : 'no orientation');
      return;
    }

    const c: L.LatLngTuple = [footprint.center.latitude, footprint.center.longitude];
    this.footprint.setLatLngs(footprint.outline.map((p) => [p.latitude, p.longitude] as L.LatLngTuple));
    // Dashed outline where the view runs past the range cap (sky or distant ground).
    this.footprint.setStyle({ dashArray: footprint.capped ? '6 4' : undefined });
    this.axis.setLatLngs([latLng, c]);
    this.center.setLatLng(c).setStyle({ opacity: 1, fillOpacity: 1 });
    const range = footprint.center.capped ? `≥${fmtDistance(footprint.center.distance)}` : fmtDistance(footprint.center.distance);
    this.setLabel(`${pose!.azimuth.toFixed(0)}° · EL ${pose!.elevation.toFixed(0)}° · HFOV ${fov.horizontal.toFixed(0)}° · ${range}`);
  }

  private setLabel(text: string) {
    if (this.marker.getTooltip()) this.marker.setTooltipContent(text);
    else this.marker.bindTooltip(text, { permanent: true, direction: 'bottom', offset: [0, 8], className: 'map-label' });
  }

  private addRecenterControl() {
    const Recenter = L.Control.extend({
      onAdd: () => {
        const button = L.DomUtil.create('button', 'map-recenter');
        button.type = 'button';
        button.title = 'Follow camera position';
        button.textContent = '◎';
        L.DomEvent.disableClickPropagation(button);
        button.addEventListener('click', () => {
          this.follow = true;
          if (this.lastPosition) this.map.setView(this.lastPosition, Math.max(this.map.getZoom(), 17));
        });
        return button;
      },
    });
    new Recenter({ position: 'topright' }).addTo(this.map);
  }
}

export function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${m.toFixed(m < 10 ? 1 : 0)} m`;
}
