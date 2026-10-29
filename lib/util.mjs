const REDACTED = '••••••••';
const SECRET = /authorization|api[-_]?key|access.?token|secret|cookie|credential/i;

export function appendPath(base, path) {
  return new URL(path.replace(/^\//, ''), `${base.replace(/\/$/, '')}/`).toString();
}

export function redactSecrets(value, key = '') {
  if (SECRET.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map(item => redactSecrets(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey, redactSecrets(child, childKey)
  ]));
}

export function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  let start = end - 1;
  while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start--;
  if (start >= 0) {
    const lead = bytes[start];
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (width > end - start) end = start;
  }
  return bytes.subarray(0, end).toString('utf8');
}

export function appendText(current, value, cap) {
  const combined = current + value;
  if (Buffer.byteLength(combined) <= cap) return { value: combined, truncated: false };
  return { value: utf8Prefix(combined, cap), truncated: true };
}
