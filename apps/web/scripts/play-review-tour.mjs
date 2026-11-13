const button = (name) => ({ role: 'button', name });
const settings = [button('Settings')];
const collections = [button('Collections')];
const point = [{ mapPoint: true }];
export const TOUR = [
  {
    area: 'Map',
    screens: [
      { name: 'home', title: 'Map and primary controls', steps: [] },
      { name: 'place', title: 'Picked place card', steps: point, expect: '.place-card' },
    ],
  },
  {
    area: 'Search',
    screens: [
      {
        name: 'search',
        title: 'Search field',
        steps: [{ focus: 'Search places' }],
        expect: '.searchbox',
      },
    ],
  },
  {
    area: 'Collections',
    screens: [
      ...['Places', 'Routes', 'Activities'].map((name) => ({
        name: name.toLowerCase(),
        title: name,
        steps: [...collections, { role: 'tab', name }],
        expect: '.sidebar',
      })),
    ],
  },
  {
    area: 'Explore',
    screens: [
      {
        name: 'categories',
        title: 'Nearby categories and results',
        steps: [button('Explore nearby places')],
        expect: '.explore-panel',
      },
      {
        name: 'more',
        title: 'All Explore categories',
        steps: [button('Explore nearby places'), button('More…')],
        expect: '.explore-panel',
      },
    ],
  },
  {
    area: 'Planner',
    screens: [
      {
        name: 'destination',
        title: 'Plan to a picked point',
        steps: [...point, button('Directions')],
        expect: '.route-panel',
        note: 'One destination with no GPS start. No navigation is started.',
      },
    ],
  },
  {
    area: 'Layers',
    screens: [
      {
        name: 'catalog',
        title: 'Map layer catalog',
        steps: [...settings, { role: 'tab', name: 'Map layers' }],
        expect: '.settings-panel',
      },
    ],
  },
  {
    area: 'Settings',
    screens: [
      ...['Appearance', 'Activity profiles', 'Navigation', 'Account & data', 'System'].map(
        (name) => ({
          name: name.split(' ')[0].toLowerCase(),
          title: `${name} settings`,
          steps: [...settings, { role: 'tab', name }],
          expect: '.settings-panel',
        }),
      ),
    ],
  },
];
