/** The fields an agent is found by. */
interface Named {
  alias: string;
  name: string;
}

/**
 * An agent by what someone called it: its alias ("小王", "Bob"), its name with the alias, or its
 * name alone when no other agent has that name.
 */
export function findAgentIn<T extends Named>(tasks: T[], ref: string): T | undefined {
  const n = ref.trim().toLowerCase();
  if (!n) return undefined;
  const exact = tasks.find((t) => t.alias.toLowerCase() === n || `${t.name} ${t.alias}`.toLowerCase() === n || `${t.name}${t.alias}`.toLowerCase() === n);
  if (exact) return exact;
  const byName = tasks.filter((t) => t.name.toLowerCase() === n);
  return byName.length === 1 ? byName[0] : undefined;
}

/** How to refer to an agent in a message: its name when that finds it, else its alias. */
export function agentRefName<T extends Named>(tasks: T[], task: T): string {
  return findAgentIn(tasks, task.name) === task ? task.name : task.alias;
}
