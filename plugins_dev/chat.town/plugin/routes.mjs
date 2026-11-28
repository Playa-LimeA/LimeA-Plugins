function link(graph, from, to) {
  const neighbors = graph.get(from);
  if (neighbors) neighbors.push(to);
  else graph.set(from, [to]);
}

export function findWalk(edges, start, finish) {
  if (start === finish) return [];
  const graph = new Map();
  for (const [from, to] of edges) {
    link(graph, from, to);
    link(graph, to, from);
  }
  const previous = new Map([[start, null]]);
  const queue = [start];
  for (let index = 0; index < queue.length && !previous.has(finish); index++) {
    const point = queue[index];
    for (const neighbor of graph.get(point) ?? []) {
      if (previous.has(neighbor)) continue;
      previous.set(neighbor, point);
      queue.push(neighbor);
    }
  }
  if (!previous.has(finish)) throw new Error(`No walking route from ${start} to ${finish}`);
  const points = [];
  for (let point = finish; point !== start; point = previous.get(point)) points.push(point);
  return points.reverse();
}

// The street is the public junction; all other locations have one public door.
export function nextStop(locations, current, destination) {
  if (current === destination) return { point: locations[current].visit };
  if (current !== 'street_corner') return { point: 'exit_to_street', next: 'street_corner' };
  return { point: locations[destination].streetDoor, next: destination };
}

export function getPortal(markers, point, expectedScene) {
  const marker = markers.get(point);
  if (
    marker?.connection_ready === false ||
    marker?.target_scene !== expectedScene ||
    typeof marker.arrival_point !== 'string'
  ) {
    throw new Error(`The doorway ${point} is disconnected`);
  }
  return marker.arrival_point;
}
