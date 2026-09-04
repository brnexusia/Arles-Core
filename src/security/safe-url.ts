import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

function privateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a,b] = parts as [number,number,number,number];
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function privateIpv6(ip: string): boolean {
  const value = ip.toLowerCase().split('%')[0] || '';
  return value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('2001:db8:') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.');
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version === 6) return privateIpv6(address);
  return true;
}

export async function assertPublicHttpUrl(value: string): Promise<string> {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('EXTERNAL_URL_INVALID'); }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('EXTERNAL_URL_PROTOCOL_REJECTED');
  if (url.username || url.password) throw new Error('EXTERNAL_URL_CREDENTIALS_REJECTED');
  if (!url.hostname || url.hostname.toLowerCase() === 'localhost') throw new Error('EXTERNAL_URL_PRIVATE_REJECTED');

  if (isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error('EXTERNAL_URL_PRIVATE_REJECTED');
  } else {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
      throw new Error('EXTERNAL_URL_PRIVATE_REJECTED');
    }
  }

  url.hash = '';
  return url.toString();
}
