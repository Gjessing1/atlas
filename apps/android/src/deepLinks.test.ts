import { describe, expect, it } from 'vitest';

import appJson from '../app.json';
import { DEFAULT_SERVER_ORIGIN } from './config';

/**
 * The Android App Links registration (ROADMAP §7 — "open a shared Atlas link").
 *
 * Three facts about it live in `app.json`, where nothing else would notice them
 * going wrong, and all three are silent failures: a link that opens the browser
 * instead of the app looks like a link the sender got wrong.
 */

interface IntentFilterData {
  scheme?: string;
  host?: string;
  path?: string;
}

const filters = (appJson.expo.android.intentFilters ?? []) as {
  action: string;
  autoVerify?: boolean;
  category?: string[];
  data?: IntentFilterData[];
}[];

const httpsLinks = filters
  .flatMap((filter) => (filter.data ?? []).map((data) => ({ filter, data })))
  .filter(({ data }) => data.scheme === 'https');

describe('https intent filter', () => {
  it('registers the host the app actually talks to', () => {
    // The filter is compiled into the manifest, so it cannot follow the
    // runtime-configurable server origin (Settings). It must at least match the
    // default one — the instance whose links people share.
    expect(httpsLinks.map(({ data }) => data.host)).toEqual([new URL(DEFAULT_SERVER_ORIGIN).host]);
  });

  it('claims only the share-link path', () => {
    // Not the whole host: the in-app APK download is an https URL on this same
    // host (`/app/atlas-<version>.apk`, opened with Linking.openURL). Claiming
    // every path would route that download back into Atlas, which would decode
    // it as a map link, find no `map=` fragment, and do nothing at all.
    expect(httpsLinks.map(({ data }) => data.path)).toEqual(['/']);
  });

  it('asks Android to verify the domain', () => {
    // Without autoVerify — and the /.well-known/assetlinks.json the backend
    // serves to answer it — Android 12+ never offers the app for a web link,
    // and the filter is inert.
    for (const { filter } of httpsLinks) {
      expect(filter.autoVerify).toBe(true);
      expect(filter.action).toBe('VIEW');
      expect(filter.category).toEqual(expect.arrayContaining(['BROWSABLE', 'DEFAULT']));
    }
    expect(httpsLinks).toHaveLength(1);
  });
});
