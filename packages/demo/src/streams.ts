/** "Relay streams" panel: the relay's device → UDP output table, with editing. */

interface StreamInfo {
  deviceId: string;
  name?: string;
  target: string;
  assigned: 'auto' | 'manual';
  connected: boolean;
  transport?: string;
  peer?: string;
  lastSeen?: string;
  bitrate: number;
  bytes: number;
}

interface Row {
  el: HTMLLIElement;
  title: HTMLElement;
  status: HTMLElement;
  meta: HTMLElement;
  input: HTMLInputElement;
  forget: HTMLButtonElement;
  message: HTMLElement;
  /** The relay's value when the input was last synced; edits differ from it. */
  synced: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

function ago(iso?: string): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export class StreamsPanel {
  private readonly rows = new Map<string, Row>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly list: HTMLOListElement,
    private readonly status: HTMLElement,
    /** Base URL of the relay's HTTP API, e.g. "/relay". */
    private readonly base: string,
    private readonly ownDeviceId: () => string,
    private readonly token: () => string,
  ) {}

  start(intervalMs = 2000) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    let body: { streams: StreamInfo[]; allow: string[] };
    try {
      const res = await this.request('GET', '/streams');
      if (!res.ok) throw new Error(await errorText(res));
      body = (await res.json()) as typeof body;
    } catch (err) {
      this.status.textContent = `Could not load relay streams: ${(err as Error).message}`;
      this.status.dataset.level = 'error';
      return;
    }
    const live = body.streams.filter((s) => s.connected).length;
    this.status.textContent = `${body.streams.length} device(s), ${live} live. Allowed outputs: ${body.allow.join(', ') || 'none'}`;
    delete this.status.dataset.level;
    this.render(body.streams);
  }

  private render(streams: StreamInfo[]) {
    const seen = new Set<string>();
    const own = this.ownDeviceId();
    for (const s of streams) {
      seen.add(s.deviceId);
      const row = this.rows.get(s.deviceId) ?? this.createRow(s.deviceId);
      row.title.replaceChildren(el('code', undefined, s.deviceId));
      if (s.name) row.title.append(` ${s.name}`);
      if (s.deviceId === own) row.title.append(el('span', 'tag', 'this device'));
      row.status.textContent = s.connected ? 'live' : 'offline';
      row.status.dataset.live = String(s.connected);
      row.meta.textContent = [
        s.peer ?? 'unknown IP',
        s.connected ? `${s.transport} · ${(s.bitrate / 1000).toFixed(0)} kbps` : `last seen ${ago(s.lastSeen)}`,
        s.assigned === 'auto' ? 'auto-assigned' : 'set manually',
      ].join(' · ');
      // Leave the field alone while it is being edited.
      if (document.activeElement !== row.input && row.input.value === row.synced) row.input.value = s.target;
      row.synced = s.target;
      row.forget.hidden = s.connected;
      this.list.append(row.el); // keeps the relay's order (live first)
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }
  }

  private createRow(deviceId: string): Row {
    const li = el('li', 'stream');
    li.dataset.device = deviceId;
    const head = el('div', 'stream-head');
    const title = el('div', 'stream-title');
    const status = el('span', 'stream-status');
    head.append(title, status);
    const meta = el('div', 'stream-meta');

    const form = el('form', 'stream-edit');
    const input = el('input');
    input.name = 'target';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'udp://host:port';
    input.setAttribute('aria-label', `UDP output for ${deviceId}`);
    const save = el('button', undefined, 'Save');
    save.type = 'submit';
    const forget = el('button', 'secondary', 'Forget');
    forget.type = 'button';
    form.append(input, save, forget);
    const message = el('p', 'hint stream-message');

    li.append(head, meta, form, message);
    const row: Row = { el: li, title, status, meta, input, forget, message, synced: '' };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.change(row, deviceId, 'PUT', { target: input.value.trim() }, 'Output updated');
    });
    forget.addEventListener('click', async () => {
      if (!confirm(`Forget ${deviceId}? It will get a new auto-assigned output next time it connects.`)) return;
      await this.change(row, deviceId, 'DELETE', undefined, 'Forgotten');
    });
    this.rows.set(deviceId, row);
    return row;
  }

  private async change(row: Row, deviceId: string, method: 'PUT' | 'DELETE', body: object | undefined, done: string) {
    row.message.textContent = '';
    delete row.message.dataset.level;
    try {
      const res = await this.request(method, `/streams/${encodeURIComponent(deviceId)}`, body);
      if (!res.ok) throw new Error(await errorText(res));
      if (method === 'PUT') {
        const info = (await res.json()) as StreamInfo;
        row.input.value = row.synced = info.target;
      }
      row.message.textContent = done;
    } catch (err) {
      row.message.textContent = (err as Error).message;
      row.message.dataset.level = 'error';
    }
    await this.refresh();
  }

  private request(method: string, path: string, body?: object) {
    const token = this.token();
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
  return body?.error ?? `HTTP ${res.status}`;
}
