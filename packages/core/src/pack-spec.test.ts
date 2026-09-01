import { describe, expect, it } from 'vitest';

import { parseRegionBuildSpec, regionFromSpec, type RegionBuildSpec } from './pack-spec.js';

const INPUTS = {
  basemap: { path: 'tiles/norway.pmtiles', required: true },
  osm: { path: 'valhalla/norway-latest.osm.pbf', required: true },
  outdoor: { path: 'tiles/outdoor.pmtiles', required: false },
  nvdb: { path: 'nvdb/nvdb.sqlite', required: false },
  admins: { path: 'valhalla/admins.sqlite', required: true },
  timezones: { path: 'valhalla/timezones.sqlite', required: true },
  assets: { path: 'assets', required: true },
};

const spec = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'norway',
  name: 'Norway',
  bounds: { sw: { lat: 57.5, lng: 4 }, ne: { lat: 71.5, lng: 31.5 } },
  countries: ['NO'],
  inputs: INPUTS,
  regions: [
    {
      id: 'oslo',
      name: 'Oslo',
      bbox: { sw: { lat: 59.7, lng: 10.4 }, ne: { lat: 60.1, lng: 11 } },
      smoke: {
        search: ['Oslo S'],
        route: { from: { lat: 59.91, lng: 10.75 }, to: { lat: 59.95, lng: 10.79 } },
      },
    },
  ],
  ...overrides,
});

const region = (overrides: Record<string, unknown>) =>
  spec({ regions: [{ ...(spec().regions as Record<string, unknown>[])[0], ...overrides }] });

describe('parseRegionBuildSpec', () => {
  it('parses a complete spec', () => {
    const parsed: RegionBuildSpec = parseRegionBuildSpec(spec());
    expect(parsed.id).toBe('norway');
    expect(parsed.inputs.outdoor).toEqual({ path: 'tiles/outdoor.pmtiles', required: false });
    expect(parsed.regions[0]!.smoke.search).toEqual(['Oslo S']);
  });

  it('names the field that is wrong', () => {
    expect(() => parseRegionBuildSpec(spec({ bounds: { sw: { lat: 'x' } } }))).toThrow(
      /spec\.bounds\.sw\.lat/,
    );
  });

  it('rejects a region the masters do not cover', () => {
    // The one that costs hours: a Scottish bbox against the Norwegian masters
    // cuts a valid, empty archive — pmtiles and osmium both succeed.
    const outside = region({
      id: 'skye',
      bbox: { sw: { lat: 57.1, lng: -6.5 }, ne: { lat: 57.7, lng: -5.9 } },
    });
    expect(() => parseRegionBuildSpec(outside)).toThrow(/not inside norway's bounds/);
  });

  it('rejects an inverted bbox', () => {
    const inverted = region({
      bbox: { sw: { lat: 60.1, lng: 10.4 }, ne: { lat: 59.7, lng: 11 } },
    });
    expect(() => parseRegionBuildSpec(inverted)).toThrow(/must be north of/);
  });

  it('rejects smoke routing points outside the region', () => {
    const away = region({
      smoke: {
        search: ['Oslo S'],
        route: { from: { lat: 59.91, lng: 10.75 }, to: { lat: 63.43, lng: 10.39 } },
      },
    });
    expect(() => parseRegionBuildSpec(away)).toThrow(/route\.to.*outside oslo's bbox/);
  });

  it('requires every input slot to be declared', () => {
    const { outdoor: _dropped, ...rest } = INPUTS;
    expect(() => parseRegionBuildSpec(spec({ inputs: rest }))).toThrow(/inputs\.outdoor/);
  });

  it('rejects an input name nothing reads', () => {
    // A misspelt slot would otherwise be an ignored line and a silently
    // missing dataset.
    expect(() =>
      parseRegionBuildSpec(
        spec({ inputs: { ...INPUTS, outdoors: { path: 'x', required: false } } }),
      ),
    ).toThrow(/unknown input/);
  });

  it('accepts a source that has no such dataset at all', () => {
    const parsed = parseRegionBuildSpec(
      spec({ inputs: { ...INPUTS, nvdb: { path: null, required: false } } }),
    );
    expect(parsed.inputs.nvdb.path).toBeNull();
  });

  it('rejects a spec that makes a load-bearing input optional', () => {
    expect(() =>
      parseRegionBuildSpec(
        spec({
          inputs: { ...INPUTS, admins: { path: 'valhalla/admins.sqlite', required: false } },
        }),
      ),
    ).toThrow(/required for every source/);
  });

  it('rejects a required input declared as absent', () => {
    expect(() =>
      parseRegionBuildSpec(
        spec({ inputs: { ...INPUTS, basemap: { path: null, required: true } } }),
      ),
    ).toThrow(/required input cannot be null/);
  });

  it('rejects a country code the admin check could not use', () => {
    expect(() => parseRegionBuildSpec(spec({ countries: ['Norway'] }))).toThrow(
      /not an ISO 3166-1 alpha-2 code/,
    );
  });

  it('rejects an input path that escapes the data dir', () => {
    expect(() =>
      parseRegionBuildSpec(
        spec({ inputs: { ...INPUTS, nvdb: { path: '/etc/passwd', required: false } } }),
      ),
    ).toThrow(/relative to the data dir/);
  });

  it('rejects duplicate region ids', () => {
    const twice = spec({
      regions: [(spec().regions as unknown[])[0], (spec().regions as unknown[])[0]],
    });
    expect(() => parseRegionBuildSpec(twice)).toThrow(/duplicate region id/);
  });

  it('requires a search smoke check', () => {
    expect(() => parseRegionBuildSpec(region({ smoke: { search: [] } }))).toThrow(
      /at least one place name/,
    );
  });
});

describe('regionFromSpec', () => {
  it('lists what the spec defines when the id is unknown', () => {
    const parsed = parseRegionBuildSpec(spec());
    expect(() => regionFromSpec(parsed, 'bergen')).toThrow(/defines: oslo/);
  });
});
