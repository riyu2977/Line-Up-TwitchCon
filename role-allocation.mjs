export function createRoleAllocation(participantCount, random = Math.random) {
  if (!Number.isSafeInteger(participantCount) || participantCount < 0) {
    throw new TypeError('Participant count must be a non-negative safe integer.');
  }
  const saboteurSlots = Math.round(participantCount * 0.3);
  const builderSlots = participantCount - saboteurSlots;
  const slots = [
    ...Array(builderSlots).fill('builder'),
    ...Array(saboteurSlots).fill('saboteur'),
  ];
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const raw = Math.floor(random() * (i + 1));
    const j = Math.max(0, Math.min(i, raw));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  let next = 0;
  let buildersAssigned = 0;
  let saboteursAssigned = 0;

  return {
    draw() {
      if (next >= slots.length) return { status: 'exhausted' };
      const role = slots[next++];
      if (role === 'builder') buildersAssigned += 1;
      else saboteursAssigned += 1;
      return { status: 'assigned', role };
    },
    getCounters() {
      return {
        buildersAssigned,
        saboteursAssigned,
        remaining: slots.length - next,
      };
    },
  };
}
