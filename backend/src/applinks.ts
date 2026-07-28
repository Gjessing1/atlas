import type { FastifyInstance } from 'fastify';

/**
 * Android App Links verification (`/.well-known/assetlinks.json`).
 *
 * The Android app registers an intent filter for this server's host so a shared
 * Atlas link opens the map instead of a browser tab. On Android 12+ that only
 * happens when the *domain* vouches for the app: the system fetches this
 * document over https and checks that it names the app's package and the
 * signing certificate the installed APK actually carries. Without it the filter
 * is inert — links keep opening the browser and nothing says why — which is why
 * this ships in the same release as the intent filter.
 *
 * It has to be a route rather than a file in `public/`: unknown paths fall
 * through to the SPA shell, so a missing document answers 200 with HTML and the
 * verifier reports malformed JSON instead of "not found".
 */

/** The Android app this server vouches for — `expo.android.package`. */
const PACKAGE_NAME = 'io.gjessing.atlas';

/**
 * SHA-256 fingerprint of the release signing certificate
 * (`~/.config/atlas/atlas-release.keystore`, alias `atlas`). Public by nature —
 * it is readable from any copy of the APK — so it is a constant rather than a
 * secret, and self-hosters signing their own build override it with
 * `ANDROID_CERT_SHA256`.
 */
const RELEASE_CERT_SHA256 =
  'D3:A6:95:8D:99:98:96:F5:FD:62:7A:C4:E9:48:DB:1D:9F:8B:DE:05:46:C4:DA:17:C5:33:8E:A4:42:C5:BB:81';

export interface AssetLinkStatement {
  relation: string[];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

/**
 * The Digital Asset Links statement list. `handle_all_urls` is the relation
 * Android requires for App Links; the intent filter in `app.json` is what
 * actually narrows which URLs are handed over (the share-link path, not the
 * whole host — the in-app APK download is an https URL on this same host and
 * must keep going to the downloader).
 */
export function assetLinks(certSha256 = RELEASE_CERT_SHA256): AssetLinkStatement[] {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: PACKAGE_NAME,
        sha256_cert_fingerprints: certSha256.split(',').map((f) => f.trim().toUpperCase()),
      },
    },
  ];
}

export function registerAppLinks(app: FastifyInstance, certSha256?: string): void {
  const statements = assetLinks(certSha256?.trim() || undefined);
  app.get('/.well-known/assetlinks.json', async (_request, reply) => {
    // Short cache: Android re-verifies on install and after updates, and a
    // fingerprint that changes (a re-signed build) must not stay wrong for a day.
    return reply
      .type('application/json')
      .header('cache-control', 'public, max-age=300')
      .send(statements);
  });
}
