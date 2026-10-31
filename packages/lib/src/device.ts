const STORAGE_KEY = 'web-video-streamer-device-id';

let sessionId: string | undefined;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `device-${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
}

/**
 * This browser's device ID: the relay maps it to a UDP output, so the same
 * device keeps the same output. Generated once and kept in localStorage
 * (browsers expose no hardware ID or local IP). `persistent` is false when
 * storage is unavailable and the ID only lasts for this page load.
 */
export function getDeviceId(): { id: string; persistent: boolean } {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return { id, persistent: true };
  } catch {
    sessionId ??= randomId();
    return { id: sessionId, persistent: false };
  }
}
