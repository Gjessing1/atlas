import { describe, expect, it } from 'vitest';
import {
  buildEnturVehiclesRequest,
  parseEnturVehiclesResponse,
  transitVehicleFeaturesUrl,
  transitVehicleIdentify,
} from './vehicles.js';

const response = {
  data: {
    vehicles: [
      {
        vehicleId: 'RUT:Vehicle:31',
        mode: 'BUS',
        line: { publicCode: '31', lineName: 'Snarøya–Tonsenhagen' },
        operator: { name: 'Ruter' },
        destinationName: 'Tonsenhagen',
        lastUpdated: '2026-08-14T19:18:34Z',
        location: { latitude: 59.91234567, longitude: 10.74684449 },
        bearing: 91.26,
        delay: 181,
        occupancyStatus: 'fewSeatsAvailable',
      },
      { vehicleId: 'bad', mode: 'BUS', location: { latitude: 200, longitude: 10 } },
    ],
  },
};

describe('Entur live vehicles', () => {
  it('builds a viewport-bounded request', () => {
    expect(
      buildEnturVehiclesRequest({ west: 10.6, south: 59.8, east: 10.9, north: 60 }).variables,
    ).toEqual({ box: { minLat: 59.8, minLon: 10.6, maxLat: 60, maxLon: 10.9 } });
  });

  it('snaps proxy bounds outward so nearby clients share cache keys', () => {
    expect(transitVehicleFeaturesUrl('', [10.612, 59.811, 10.888, 59.999])).toBe(
      '/api/overlay/transit-vehicles/features?bbox=10.60,59.80,10.90,60.00',
    );
  });

  it('parses only valid positions into compact map features', () => {
    expect(parseEnturVehiclesResponse(response)).toEqual({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'RUT:Vehicle:31',
          geometry: { type: 'Point', coordinates: [10.746844, 59.912346] },
          properties: {
            id: 'RUT:Vehicle:31',
            mode: 'bus',
            line: '31',
            lineName: 'Snarøya–Tonsenhagen',
            destination: 'Tonsenhagen',
            operator: 'Ruter',
            delayS: 181,
            occupancy: 'fewSeatsAvailable',
            updatedAt: '2026-08-14T19:18:34Z',
            bearing: 91.3,
            markerColor: '#2563eb',
          },
        },
      ],
    });
  });

  it('turns a drawn vehicle into a useful shared tap card', () => {
    const properties = parseEnturVehiclesResponse(response).features[0]!.properties;
    expect(transitVehicleIdentify(properties)).toEqual({
      title: 'Bus 31',
      properties: {
        Route: 'Snarøya–Tonsenhagen',
        Towards: 'Tonsenhagen',
        Running: '3 min late',
        Occupancy: 'Few seats available',
        Operator: 'Ruter',
        'Position updated': '19:18',
      },
    });
  });
});
