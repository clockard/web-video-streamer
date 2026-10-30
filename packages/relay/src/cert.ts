/**
 * Certificates for the WebTransport (HTTP/3) server.
 *
 * Browsers accept a self-signed certificate for WebTransport when the page
 * passes its SHA-256 hash in `serverCertificateHashes`, provided it is ECDSA
 * (or similar) and valid for at most 14 days. We generate one at startup.
 */
// @peculiar/x509 uses tsyringe, which needs this polyfill loaded first.
import 'reflect-metadata';
import { createHash, webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';

export interface ServerCertificate {
  cert: string;
  privateKey: string;
  /** Base64 SHA-256 of the DER certificate, for serverCertificateHashes. */
  sha256: string;
  notAfter: Date;
}

/** Stays under the 14-day maximum for serverCertificateHashes, allowing for clock skew. */
export const SELF_SIGNED_VALIDITY_DAYS = 13;

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const toPem = (der: ArrayBuffer, label: string) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

export function certificateHash(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('base64');
}

export async function generateSelfSignedCertificate(hostnames: string[] = ['localhost']): Promise<ServerCertificate> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(notBefore.getTime() + SELF_SIGNED_VALIDITY_DAYS * 86_400_000);
  const ips = hostnames.filter((h) => /^[\d.]+$|:/.test(h));
  const dns = hostnames.filter((h) => !ips.includes(h));

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString('hex'),
    name: 'CN=web-video-streamer-relay',
    notBefore,
    notAfter,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        ...dns.map((value) => ({ type: 'dns' as const, value })),
        ...ips.map((value) => ({ type: 'ip' as const, value })),
      ]),
    ],
  });

  const certPem = cert.toString('pem');
  return {
    cert: certPem,
    privateKey: toPem(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY'),
    sha256: certificateHash(certPem),
    notAfter,
  };
}
