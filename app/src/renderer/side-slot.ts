import { createContext } from 'react';

/**
 * The column on the right of the stage, full height beside the agent's header, conversation and
 * the voice bar (as DeepSeek Harness lays out its side panel). The agent view renders its preview
 * and memory panels into it; empty, it takes no room.
 */
export const SideSlot = createContext<HTMLElement | null>(null);
