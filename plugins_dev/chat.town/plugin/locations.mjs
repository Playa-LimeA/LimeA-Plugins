// Each chain follows a clear walking lane between markers in the exported models.
const lanes = (...paths) =>
  paths.flatMap((path) => path.slice(1).map((point, index) => [path[index], point]));

const indoors = (name, streetDoor, ...path) => ({
  name,
  streetDoor,
  visit: path.at(-1),
  edges: lanes(['exit_to_street', 'from_street', ...path]),
});

export const locations = {
  home: {
    name: { zh: '家', en: 'Home' },
    streetDoor: 'enter_home',
    visit: 'home_idle',
    edges: lanes(
      ['exit_to_street', 'from_street', 'foyer_walk', 'living_entry', 'home_idle'],
      ['home_idle', 'home_breakfast_approach', 'home_breakfast'],
      ['home_idle', 'home_sofa_approach', 'home_sofa'],
      ['home_idle', 'home_hall', 'home_bedroom_door', 'home_bed_approach', 'home_bed'],
      [
        'home_idle',
        'home_balcony_living_aisle',
        'home_balcony_table_turn',
        'home_balcony_stool_bypass',
        'home_balcony_threshold',
        'home_balcony',
      ],
      [
        'home_hall',
        'home_computer_door_approach',
        'home_computer_door',
        'home_computer_approach',
        'home_computer',
      ],
    ),
  },
  street_corner: {
    name: { zh: '街角', en: 'Street Corner' },
    visit: 'north_crosswalk',
    edges: lanes(
      [
        'enter_home',
        'from_home',
        'home_door_bypass',
        'south_crosswalk',
        'crosswalk_road_south',
        'crosswalk_road_north',
        'north_crosswalk',
      ],
      ['north_crosswalk', 'from_cafe', 'enter_cafe'],
      [
        'north_crosswalk',
        'north_landing_turn',
        'cafe_promenade_west',
        'cafe_promenade_corner',
        'cafe_promenade_east',
        'street_bike_bypass',
        'furniture_walk_turn',
        'east_sidewalk_junction',
      ],
      ['furniture_walk_turn', 'from_store', 'enter_store'],
      [
        'east_sidewalk_junction',
        'park_walk_turn',
        'park_walk_base',
        'park_walk_mid',
        'from_park',
        'enter_park',
      ],
      [
        'east_sidewalk_junction',
        'east_curb_turn',
        'side_crosswalk_approach',
        'side_crosswalk_west',
        'side_crosswalk_road_west',
        'side_crosswalk_road_east',
        'side_crosswalk_east',
        'from_bakery',
        'market_walk_south',
        'market_tree_bypass',
        'from_supermarket',
        'enter_supermarket',
      ],
      ['from_bakery', 'enter_bakery'],
    ),
  },
  cafe: indoors(
    { zh: '咖啡厅', en: 'Café' },
    'enter_cafe',
    'entry_aisle',
    'counter_turn',
    'wait_for_drink',
    'collect_coffee',
    'order_at_counter',
  ),
  park: indoors(
    { zh: '公园', en: 'Park' },
    'enter_park',
    'park_ring_10',
    'park_lookout_approach',
    'park_lookout',
  ),
  bakery: indoors({ zh: '面包店', en: 'Bakery' }, 'enter_bakery', 'browse_bread'),
  shop: indoors({ zh: '家具店', en: 'Furniture Shop' }, 'enter_store', 'main_aisle', 'shop_sofa'),
  supermarket: indoors(
    { zh: '超市', en: 'Market' },
    'enter_supermarket',
    'market_aisle',
    'browse_produce',
  ),
};

export const destinationOrder = [
  'home',
  'street_corner',
  'cafe',
  'park',
  'bakery',
  'shop',
  'supermarket',
];
