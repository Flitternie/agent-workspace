/**
 * The official one-line installers: a standalone binary in ~/.local/bin, with no Node.js or sudo
 * (Mac and Linux alike). Shown to copy, and run over SSH when the user asks the app to install.
 */
export const INSTALL_SCRIPT = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
} as const;
