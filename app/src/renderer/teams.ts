import { useCallback, useState } from 'react';
import type { Team } from '../shared/agent-order';

const KEY = 'amw.teams.expanded';

function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * Which teams are expanded: a team with something going on (or used in the last days) opens by
 * itself, others stay folded; a team the user opened or folded keeps that choice on this machine.
 */
export function useTeamExpansion() {
  const [choice, setChoice] = useState<Record<string, boolean>>(load);
  const expanded = useCallback((team: Team) => choice[team.project.projectId] ?? team.active, [choice]);
  const toggle = useCallback(
    (team: Team) =>
      setChoice((cur) => {
        const next = { ...cur, [team.project.projectId]: !(cur[team.project.projectId] ?? team.active) };
        localStorage.setItem(KEY, JSON.stringify(next));
        return next;
      }),
    [],
  );
  return { expanded, toggle };
}
