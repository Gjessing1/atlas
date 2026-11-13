// Independent screen recipes: each starts from a cold launch, with existing app data retained.
const menu = (id) => [{ tap: 'open-menu' }, { tap: id }];
const collections = [...menu('open-favorites'), { tap: 'favorites-sheet-handle' }];
const settings = menu('open-settings');
const point = [{ mapPoint: true }];
export const TOUR = [
  {
    area: 'Map',
    screens: [
      { name: 'home', title: 'Map and primary controls', steps: [] },
      {
        name: 'menu',
        title: 'Main menu',
        steps: [{ tap: 'open-menu' }],
        expect: 'main-menu-sheet',
      },
      { name: 'place', title: 'Picked place card', steps: point, expect: 'destination-sheet' },
    ],
  },
  {
    area: 'Search',
    screens: [
      {
        name: 'search',
        title: 'Search and recent places with keyboard',
        steps: [{ tap: 'search-open' }],
        expect: 'search-input',
      },
    ],
  },
  {
    area: 'Collections',
    screens: [
      {
        name: 'places',
        title: 'Places and folders',
        steps: [...collections, { tap: 'collections-view-folders' }],
        expect: 'collections-scroll',
      },
      {
        name: 'routes',
        title: 'Routes and courses',
        steps: [...collections, { tap: 'collections-view-courses' }],
        expect: 'collections-scroll',
      },
      {
        name: 'activities',
        title: 'Activities',
        steps: [...collections, { tap: 'collections-view-activities' }],
        expect: 'collections-scroll',
      },
    ],
  },
  {
    area: 'Explore',
    screens: [
      {
        name: 'categories',
        title: 'Nearby categories',
        steps: menu('open-explore'),
        expect: 'explore-more',
      },
      {
        name: 'more',
        title: 'All Explore categories',
        steps: [...menu('open-explore'), { tap: 'explore-more' }],
        expect: 'explore-reset-shortcuts',
      },
    ],
  },
  {
    area: 'Planner',
    screens: [
      {
        name: 'destination',
        title: 'Plan to a picked point',
        steps: [...point, { tap: 'destination-navigate' }],
        expect: 'route-sheet',
        note: 'The start may be empty when the emulator has no GPS fix. No navigation is started.',
      },
    ],
  },
  {
    area: 'Layers',
    screens: [
      {
        name: 'catalog',
        title: 'Map layer catalog',
        steps: menu('open-layers'),
        expect: 'layers-sheet',
      },
    ],
  },
  {
    area: 'Settings',
    screens: [
      { name: 'menu', title: 'Settings sections', steps: settings, expect: 'settings-close' },
      ...['appearance', 'profiles', 'navigation', 'offline', 'account', 'system'].map(
        (section) => ({
          name: section,
          title: `${section[0].toUpperCase()}${section.slice(1)} settings`,
          steps: [
            ...settings,
            { tap: 'settings-sheet-handle' },
            { scrollTo: `settings-open-${section}`, within: 'settings-sheet' },
          ],
          expect: 'settings-back',
        }),
      ),
    ],
  },
];
