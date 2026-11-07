export type HiddenByPlatform = Record<string, string[]>;

export function normalizeHiddenByPlatform(stored: unknown): HiddenByPlatform {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return {};
  }
  const result: HiddenByPlatform = {};
  for (const [platform, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const valid = [
      ...new Set(
        value.filter((item): item is string => typeof item === 'string' && item.length > 0),
      ),
    ];
    if (valid.length > 0) {
      result[platform] = valid;
    }
  }
  return result;
}

export function isOperatorHidden(
  hiddenSet: ReadonlySet<string>,
  operatorId: string,
  sharedIds?: readonly string[],
): boolean {
  if (!hiddenSet.size) return false;
  const members = sharedIds?.length ? sharedIds : [operatorId];
  return members.some((id) => hiddenSet.has(id));
}

export function toggleHiddenOperator(
  current: HiddenByPlatform,
  platform: string,
  operatorId: string,
  sharedIds?: readonly string[],
): { next: HiddenByPlatform; hidden: boolean } {
  const list = current[platform] ?? [];
  const members = sharedIds?.length ? sharedIds : [operatorId];
  const memberSet = new Set(members);
  const currentlyHidden = list.some((id) => memberSet.has(id));

  if (currentlyHidden) {
    const nextList = list.filter((id) => !memberSet.has(id));
    const next = { ...current };
    if (nextList.length > 0) {
      next[platform] = nextList;
    } else {
      delete next[platform];
    }
    return { next, hidden: false };
  }

  return {
    next: {
      ...current,
      [platform]: [...list, operatorId],
    },
    hidden: true,
  };
}

export function restoreHiddenOperator(
  current: HiddenByPlatform,
  platform: string,
  operatorId: string,
  sharedIds?: readonly string[],
): HiddenByPlatform {
  const list = current[platform] ?? [];
  const members = sharedIds?.length ? sharedIds : [operatorId];
  const memberSet = new Set(members);
  const nextList = list.filter((id) => !memberSet.has(id));
  if (nextList.length === list.length) return current;
  const next = { ...current };
  if (nextList.length > 0) {
    next[platform] = nextList;
  } else {
    delete next[platform];
  }
  return next;
}

export function clearHiddenOperators(
  current: HiddenByPlatform,
  platform: string,
): HiddenByPlatform {
  if (!current[platform]?.length) return current;
  const next = { ...current };
  delete next[platform];
  return next;
}
