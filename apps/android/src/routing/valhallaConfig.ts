/**
 * Valhalla runtime config for the embedded on-device engine.
 *
 * DEFAULTS is the unabridged output of `valhalla_build_config` from image
 * ghcr.io/valhalla/valhalla:3.8.2 (keep in step with infrastructure/valhalla
 * and the JNI module's libvalhalla), with server-only filesystem paths
 * blanked. The actor validates nodes eagerly at open() (e.g.
 * service_limits.isochrone.max_contours), so shipping the engine's own
 * defaults wholesale is the only shape that is guaranteed to load; mobile
 * tuning is applied as explicit overrides in makeValhallaConfig instead of
 * by trimming.
 */
const DEFAULTS = {
  additional_data: {
    elevation: '',
  },
  httpd: {
    service: {
      drain_seconds: 28,
      interrupt: 'ipc:///tmp/interrupt',
      listen: 'tcp://*:8002',
      loopback: 'ipc:///tmp/loopback',
      shutdown_seconds: 1,
      timeout_seconds: -1,
    },
  },
  logging: {
    color: false,
    type: 'std_out',
  },
  loki: {
    actions: [
      'locate',
      'route',
      'height',
      'sources_to_targets',
      'optimized_route',
      'isochrone',
      'trace_route',
      'trace_attributes',
      'transit_available',
      'expansion',
      'centroid',
      'status',
      'tile',
    ],
    service: {
      proxy: 'ipc:///tmp/loki',
    },
    service_defaults: {
      heading_tolerance: 60,
      minimum_reachability: 50,
      mvt_cache_min_zoom: 11,
      mvt_max_age: '1800',
      mvt_min_zoom_road_class: [7, 7, 8, 11, 11, 12, 13, 14],
      node_snap_tolerance: 5,
      radius: 0,
      search_cutoff: 35000,
      street_side_max_distance: 1000,
      street_side_tolerance: 5,
    },
    use_connectivity: true,
  },
  meili: {
    auto: {
      search_radius: 50,
      turn_penalty_factor: 200,
    },
    bicycle: {
      turn_penalty_factor: 140,
    },
    customizable: [
      'mode',
      'search_radius',
      'turn_penalty_factor',
      'gps_accuracy',
      'interpolation_distance',
      'sigma_z',
      'beta',
      'max_route_distance_factor',
      'max_route_time_factor',
    ],
    default: {
      beta: 3,
      breakage_distance: 2000,
      geometry: false,
      gps_accuracy: 5.0,
      interpolation_distance: 10,
      max_route_distance_factor: 5,
      max_route_time_factor: 5,
      max_search_radius: 100,
      route: true,
      search_radius: 50,
      sigma_z: 4.07,
      turn_penalty_factor: 0,
    },
    grid: {
      cache_size: 100240,
      size: 500,
    },
    mode: 'auto',
    multimodal: {
      turn_penalty_factor: 70,
    },
    pedestrian: {
      search_radius: 50,
      turn_penalty_factor: 100,
    },
    service: {
      proxy: 'ipc:///tmp/meili',
    },
    verbose: false,
  },
  mjolnir: {
    admin: '',
    data_processing: {
      allow_alt_name: false,
      apply_country_overrides: true,
      build_bounding_circles: true,
      grid_divisions_within_tile: 32,
      infer_internal_intersections: true,
      infer_turn_channels: true,
      scan_tar: false,
      use_admin_db: true,
      use_direction_on_ways: false,
      use_rest_area: false,
      use_urban_tag: false,
    },
    global_synchronized_cache: false,
    hierarchy: true,
    id_table_size: 1300000000,
    import_bike_share_stations: false,
    include_bicycle: true,
    include_construction: false,
    include_driveways: true,
    include_driving: true,
    include_pedestrian: true,
    include_platforms: false,
    keep_all_osm_node_ids: false,
    keep_osm_node_ids: false,
    landmarks: '/data/valhalla/landmarks.sqlite',
    lru_mem_cache_hard_control: false,
    // Not in valhalla_build_config's output; added so the mobile override
    // below has a typed home. The engine reads it at open().
    concurrency: 1,
    max_cache_size: 1000000000,
    max_concurrent_reader_users: 1,
    reclassify_links: true,
    shortcuts: true,
    tile_dir: '',
    tile_extract: '',
    timezone: '',
    traffic_extract: '',
    transit_dir: '/data/valhalla/transit',
    transit_feeds_dir: '/data/valhalla/transit_feeds',
    transit_pbf_limit: 20000,
    use_lru_mem_cache: false,
    use_simple_mem_cache: false,
  },
  odin: {
    markup_formatter: {
      markup_enabled: false,
      phoneme_format:
        '<TEXTUAL_STRING> (<span class=<QUOTES>phoneme<QUOTES>>/<VERBAL_STRING>/</span>)',
    },
    service: {
      proxy: 'ipc:///tmp/odin',
    },
  },
  service_limits: {
    allow_hard_exclusions: false,
    auto: {
      max_distance: 5000000.0,
      max_locations: 20,
      max_matrix_distance: 400000.0,
      max_matrix_location_pairs: 2500,
    },
    auto_pedestrian: {
      max_distance: 5000000.0,
      max_matrix_distance: 400000.0,
      max_matrix_location_pairs: 2500,
    },
    bicycle: {
      max_distance: 500000.0,
      max_locations: 50,
      max_matrix_distance: 200000.0,
      max_matrix_location_pairs: 2500,
    },
    bikeshare: {
      max_distance: 500000.0,
      max_locations: 50,
      max_matrix_distance: 200000.0,
      max_matrix_location_pairs: 2500,
    },
    bus: {
      max_distance: 5000000.0,
      max_locations: 50,
      max_matrix_distance: 400000.0,
      max_matrix_location_pairs: 2500,
    },
    centroid: {
      max_distance: 200000.0,
      max_locations: 5,
    },
    hierarchy_limits: {
      allow_modification: false,
      bidirectional_astar: {
        max_allowed_up_transitions: {
          '1': 400,
          '2': 100,
        },
        max_expand_within_distance: {
          '0': 100000000.0,
          '1': 20000,
          '2': 5000,
        },
      },
      costmatrix: {
        max_allowed_up_transitions: {
          '1': 400,
          '2': 100,
        },
        max_expand_within_distance: {
          '0': 100000000.0,
          '1': 100000,
          '2': 5000,
        },
      },
      unidirectional_astar: {
        max_allowed_up_transitions: {
          '1': 400,
          '2': 100,
        },
        max_expand_within_distance: {
          '0': 100000000.0,
          '1': 100000,
          '2': 5000,
        },
      },
    },
    isochrone: {
      max_contours: 4,
      max_distance: 25000.0,
      max_distance_contour: 200,
      max_locations: 1,
      max_time_contour: 120,
    },
    max_alternates: 2,
    max_distance_disable_hierarchy_culling: 0,
    max_exclude_locations: 50,
    max_exclude_polygons_length: 10000,
    max_linear_cost_edges: 50000,
    max_radius: 200,
    max_reachability: 100,
    max_timedep_distance: 500000,
    max_timedep_distance_matrix: 0,
    min_linear_cost_factor: 1,
    motor_scooter: {
      max_distance: 500000.0,
      max_locations: 50,
      max_matrix_distance: 200000.0,
      max_matrix_location_pairs: 2500,
    },
    motorcycle: {
      max_distance: 500000.0,
      max_locations: 50,
      max_matrix_distance: 200000.0,
      max_matrix_location_pairs: 2500,
    },
    multimodal: {
      max_distance: 500000.0,
      max_locations: 50,
      max_matrix_distance: 0.0,
      max_matrix_location_pairs: 0,
    },
    pedestrian: {
      max_distance: 250000.0,
      max_locations: 50,
      max_matrix_distance: 200000.0,
      max_matrix_location_pairs: 2500,
      max_multimodal_walking_distance: 10000,
      min_multimodal_walking_distance: 1,
    },
    skadi: {
      max_shape: 750000,
      min_resample: 10.0,
    },
    status: {
      allow_verbose: false,
    },
    taxi: {
      max_distance: 5000000.0,
      max_locations: 20,
      max_matrix_distance: 400000.0,
      max_matrix_location_pairs: 2500,
    },
    trace: {
      max_alternates: 3,
      max_alternates_shape: 100,
      max_distance: 200000.0,
      max_gps_accuracy: 100.0,
      max_search_radius: 100.0,
      max_shape: 16000,
    },
    transit: {
      max_distance: 500000.0,
      max_locations: 50,
      max_matrix_distance: 200000.0,
      max_matrix_location_pairs: 2500,
    },
    truck: {
      max_distance: 5000000.0,
      max_locations: 20,
      max_matrix_distance: 400000.0,
      max_matrix_location_pairs: 2500,
    },
  },
  statsd: {
    batch_size: 500,
    port: 8125,
    prefix: 'valhalla',
  },
  thor: {
    bidirectional_astar: {
      alternative_cost_extend: 1.2,
      alternative_iterations_delta: 100000,
      hierarchy_limits: {
        expand_within_distance: {
          '0': 100000000.0,
          '1': 20000,
          '2': 5000,
        },
        max_up_transitions: {
          '1': 400,
          '2': 100,
        },
      },
      threshold_delta: 420.0,
    },
    clear_reserved_memory: false,
    costmatrix: {
      allow_second_pass: false,
      check_reverse_connection: true,
      hierarchy_limits: {
        expand_within_distance: {
          '0': 100000000.0,
          '1': 20000,
          '2': 5000,
        },
        max_up_transitions: {
          '1': 400,
          '2': 100,
        },
      },
      max_iterations: 2800,
      max_reserved_locations: 25,
      min_iterations: 100,
    },
    extended_search: false,
    max_reserved_labels_count_astar: 2000000,
    max_reserved_labels_count_bidir_astar: 1000000,
    max_reserved_labels_count_bidir_dijkstras: 2000000,
    max_reserved_labels_count_dijkstras: 4000000,
    service: {
      proxy: 'ipc:///tmp/thor',
    },
    source_to_target_algorithm: 'select_optimal',
    unidirectional_astar: {
      hierarchy_limits: {
        expand_within_distance: {
          '0': 100000000.0,
          '1': 100000,
          '2': 5000,
        },
        max_up_transitions: {
          '1': 400,
          '2': 100,
        },
      },
    },
  },
};

/** Full config JSON for one region pack's tile extract, tuned for mobile. */
export function makeValhallaConfig(tileExtractPath: string): string {
  const config = structuredClone(DEFAULTS);
  config.mjolnir.tile_extract = tileExtractPath;
  // Mobile: cap the in-memory tile cache well below the default 1 GB, and
  // keep the engine single-threaded — phone memory and cores are shared
  // with the UI.
  config.mjolnir.max_cache_size = 268435456;
  config.mjolnir.concurrency = 1;
  return JSON.stringify(config);
}
