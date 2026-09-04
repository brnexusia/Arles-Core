const IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const AUDIO_MIME = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a'
]);

const SAFE_DOWNLOAD_MIME = new Set([
  ...IMAGE_MIME,
  ...AUDIO_MIME,
  'application/pdf',
  'text/plain'
]);

function normalizedMime(value: unknown): string {
  return String(value ?? '').split(';')[0]!.trim().toLowerCase();
}

function estimatedDecodedBytes(base64: string): number {
  const compact = base64.replace(/\s/g, '');
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('MEDIA_BASE64_INVALID');
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

export function validateImageInput(base64: string, mimeInput: unknown): string {
  const mime = normalizedMime(mimeInput || 'image/jpeg');
  if (!IMAGE_MIME.has(mime)) throw new Error('MEDIA_IMAGE_TYPE_REJECTED');
  if (estimatedDecodedBytes(base64) > 10 * 1024 * 1024) throw new Error('MEDIA_IMAGE_TOO_LARGE');
  return mime;
}

export function validateAudioInput(base64: string, mimeInput: unknown): string {
  const mime = normalizedMime(mimeInput || 'audio/ogg');
  if (!AUDIO_MIME.has(mime)) throw new Error('MEDIA_AUDIO_TYPE_REJECTED');
  if (estimatedDecodedBytes(base64) > 20 * 1024 * 1024) throw new Error('MEDIA_AUDIO_TOO_LARGE');
  return mime;
}

export function safeStoredMediaMime(mimeInput: unknown): string | null {
  const mime = normalizedMime(mimeInput);
  return SAFE_DOWNLOAD_MIME.has(mime) ? mime : null;
}
