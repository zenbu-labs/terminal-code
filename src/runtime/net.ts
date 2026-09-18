import tls from "node:tls";

/** The part of node:tls the merge needs. Older runtimes are missing it, and a
 * test can hand in a store of its own. */
export interface CertificateStore {
  getCACertificates?(type: "default" | "system"): readonly string[];
  setDefaultCACertificates?(certificates: readonly string[]): void;
}

/** What openssl reports when it cannot build a chain to a root it trusts. */
const UNTRUSTED = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
]);

function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let at: unknown = error; at instanceof Error && !chain.includes(at); at = at.cause) {
    chain.push(at);
  }
  return chain;
}

export function untrustedCertificate(error: unknown): boolean {
  return causes(error).some((link) => {
    const code = (link as { code?: unknown }).code;
    return typeof code === "string" && UNTRUSTED.has(code);
  });
}

/** Node verifies TLS against the CA list it bundles, never the machine's, so a
 * TLS-inspecting proxy fails every download: it signs with a root only the OS
 * trust store knows. Merging rather than swapping keeps the bundled roots for
 * hosts the OS store was never told about. */
export function includeSystemCertificates(store: CertificateStore = tls): void {
  if (!store.getCACertificates || !store.setDefaultCACertificates) return;
  try {
    const roots = new Set(store.getCACertificates("default"));
    for (const root of store.getCACertificates("system")) roots.add(root);
    store.setDefaultCACertificates([...roots]);
  } catch {
    // a store this runtime cannot read leaves the bundled roots as they were
  }
}

let systemCertificatesMerged = false;

/** Every download tode makes goes through here. Reading the OS trust store
 * costs ~100ms on macOS, so a launch pays it once, and only if it downloads
 * something at all. */
export function fetchTrusting(url: string | URL, init?: RequestInit): Promise<Response> {
  if (!systemCertificatesMerged) {
    includeSystemCertificates();
    systemCertificatesMerged = true;
  }
  return fetch(url, init);
}

/** A failed lookup or handshake reaches us as a bare "fetch failed" with the
 * reason hidden on `cause`, which leaves the user nothing to act on. */
export function explain(error: unknown): string {
  const chain = causes(error);
  if (!chain.length) return String(error);
  const said = chain.map((link) => {
    const code = (link as { code?: unknown }).code;
    return typeof code === "string" && !link.message.includes(code)
      ? `${link.message} (${code})`
      : link.message;
  });
  if (untrustedCertificate(error)) {
    said.push(
      "no trusted certificate chain, even with this machine's own roots. If a proxy" +
        " inspects your TLS, point NODE_EXTRA_CA_CERTS at its root certificate",
    );
  }
  return said.join(": ");
}
