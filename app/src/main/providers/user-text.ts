// User turns in a saved Claude Code / Codex session carry harness markup next to
// what the person typed: reminders, slash-command wrappers, Codex's environment
// and AGENTS.md preamble. Show what the person said; drop the plumbing.

const DROP = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

/** Returns the visible text of a user turn, or '' when it is only harness context. */
export function cleanUserText(raw: string): string {
  let text = raw;
  // Codex prepends repository instructions as a user message.
  if (/^\s*# AGENTS\.md instructions for /.test(text)) return '';
  // "/review src" from <command-name>/review</command-name><command-args>src</command-args>
  text = text.replace(/<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/g, (_m, name: string, args?: string) =>
    `\`${[name.trim(), args?.trim()].filter(Boolean).join(' ')}\``,
  );
  text = text.replace(/<command-args>[\s\S]*?<\/command-args>/g, '');
  for (const re of DROP) text = text.replace(re, '');
  // Output of a local slash command becomes a code block.
  text = text.replace(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g, (_m, _k, out: string) => (out.trim() ? `\n\`\`\`\n${out.trim()}\n\`\`\`\n` : ''));
  return text.trim();
}
