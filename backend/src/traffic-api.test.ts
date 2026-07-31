import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { StatusRegistry } from './status.js';
import { registerTrafficApi } from './traffic-api.js';

const xml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:mc="http://datex2.eu/schema/3/messageContainer"
 xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:loc="http://datex2.eu/schema/3/locationReferencing"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><mc:payload xsi:type="sit:SituationPublication" lang="no">
 <publicationTime>2026-07-31T10:00:00+02:00</publicationTime><sit:situation id="closure">
 <sit:overallSeverity>high</sit:overallSeverity><sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="r1">
 <sit:validity><validityTimeSpecification><overallStartTime>2026-07-31T08:00:00+02:00</overallStartTime>
 <overallEndTime>2026-07-31T18:00:00+02:00</overallEndTime></validityTimeSpecification></sit:validity>
 <sit:generalPublicComment><sit:comment><values><value lang="no">Vegen er stengt.</value></values></sit:comment></sit:generalPublicComment>
 <sit:locationReference><loc:locationContainedInGroup><loc:coordinatesForDisplay>
 <loc:latitude>59.905</loc:latitude><loc:longitude>10.7</loc:longitude></loc:coordinatesForDisplay>
 <loc:supplementaryPositionalDescription><loc:locationDescription><values><value lang="no">E18 ved Oslo</value></values>
 </loc:locationDescription></loc:supplementaryPositionalDescription></loc:locationContainedInGroup></sit:locationReference>
 <sit:roadOrCarriagewayOrLaneManagementType>roadClosed</sit:roadOrCarriagewayOrLaneManagementType>
 </sit:situationRecord></sit:situation></mc:payload></messageContainer>`;

describe('DATEX traffic API', () => {
  it('stays absent without credentials', async () => {
    const app = Fastify();
    expect(registerTrafficApi(app, new StatusRegistry(), {})).toEqual({ enabled: false });
    await app.ready();
    expect((await app.inject('/api/overlay/traffic/features')).statusCode).toBe(404);
    await app.close();
  });

  it('serves features and only closures touching a route', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Authorization']).toMatch(/^Basic /);
      return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } });
    }) as typeof fetch;
    const app = Fastify();
    expect(
      registerTrafficApi(app, new StatusRegistry(), {
        username: 'user',
        password: 'secret',
        fetchImpl,
        now: () => new Date('2026-07-31T10:00:00+02:00'),
      }).enabled,
    ).toBe(true);
    await app.ready();
    const features = await app.inject('/api/overlay/traffic/features');
    expect(features.statusCode).toBe(200);
    expect(features.json().features[0]).toMatchObject({
      properties: { kind: 'closure', message: 'Vegen er stengt.', location: 'E18 ved Oslo' },
    });
    const on = await app.inject({
      method: 'POST',
      url: '/api/traffic/closures',
      payload: {
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ],
      },
    });
    expect(on.json().closures).toHaveLength(1);
    const off = await app.inject({
      method: 'POST',
      url: '/api/traffic/closures',
      payload: {
        points: [
          { lat: 59.9, lng: 10.8 },
          { lat: 59.91, lng: 10.8 },
        ],
      },
    });
    expect(off.json().closures).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
