import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each file runs its own app with its own temp data: a few at once.
    fileParallelism: true,
    maxWorkers: 4,
    // The app under test stays in the background: no window on screen, never takes the keyboard.
    env: { AMW_BACKGROUND: '1' },
  },
});
