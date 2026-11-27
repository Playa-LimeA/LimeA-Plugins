export const templates = {
  lobby: { asset: 'lobby', name: ['招待大厅', 'Reception lobby'] },
  office: { asset: 'standard-floor', metadata: 'standard-scene', name: ['通用办公层', 'Office floor'] },
  executive: { asset: 'executive', name: ['总裁层', 'Executive floor'] },
};

export function getFloors(members, capacity) {
  const offices = [[]];
  let assistant;
  for (const member of members) {
    if (member.isAssistant) {
      assistant ??= member;
    } else if (Number.isInteger(member.seatIndex) && member.seatIndex >= 0) {
      const index = Math.floor(member.seatIndex / capacity);
      (offices[index] ??= []).push(member);
    }
  }

  const lobby = { id: 'lobby', kind: 'lobby', members: [] };
  const executive = {
    id: 'executive',
    kind: 'executive',
    members: assistant ? [assistant] : [],
  };
  return [
    lobby,
    ...Array.from({ length: offices.length }, (_, index) => ({
      id: 'office:' + index,
      kind: 'office',
      members: (offices[index] ?? []).sort((a, b) => a.seatIndex - b.seatIndex),
    })),
    executive,
  ].map((floor, index) => ({ ...floor, code: String(index + 1).padStart(2, '0') + 'F' }));
}
