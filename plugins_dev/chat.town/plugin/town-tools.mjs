import { locations } from './locations.mjs';
import { activityCatalog } from './town-state.mjs';

function inputKeys(input, keys) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every((key) => keys.includes(key));
}

export function registerTownTools(registry, town) {
  const invalid = { status: 'invalid_input' };
  registry.register('list_residents', (input, context) =>
    inputKeys(input, []) ? town.query(context, () => town.list()) : invalid,
  );
  registry.register('get_resident_state', (input, context) => {
    if (!inputKeys(input, ['resident_id']) ||
        (input.resident_id !== undefined && typeof input.resident_id !== 'string')) return invalid;
    return town.query(context, () => town.residentState(input.resident_id ?? context.characterId));
  });
  registry.register('list_activities', (input, context) => {
    if (!inputKeys(input, ['scene']) || (input.scene !== undefined &&
        (typeof input.scene !== 'string' || !Object.hasOwn(locations, input.scene)))) return invalid;
    return town.query(context, () => ({
      locations: Object.entries(locations)
        .filter(([id]) => input.scene === undefined || id === input.scene)
        .map(([id, location]) => ({ id, name: location.name })),
      activities: Object.entries(activityCatalog)
        .filter(([, activity]) => input.scene === undefined || activity.scene === input.scene)
        .map(([id, { name, scene }]) => ({ id, name, scene })),
    }));
  });
  registry.register('go_to', (input, context) => {
    if (!inputKeys(input, ['location']) ||
        typeof input.location !== 'string' || !Object.hasOwn(locations, input.location)) return invalid;
    return town.action(context, { scene: input.location, point: locations[input.location].visit });
  });
  registry.register('visit_resident', (input, context) => {
    if (!inputKeys(input, ['resident_id']) || typeof input.resident_id !== 'string' ||
        !input.resident_id.trim() || input.resident_id.length > 128) return invalid;
    return town.action(context, { resident_id: input.resident_id });
  });
  registry.register('do_activity', (input, context) => {
    if (!inputKeys(input, ['activity']) ||
        typeof input.activity !== 'string' || !Object.hasOwn(activityCatalog, input.activity)) return invalid;
    const { scene, point } = activityCatalog[input.activity];
    return town.action(context, { scene, point, activity: input.activity });
  });
}
