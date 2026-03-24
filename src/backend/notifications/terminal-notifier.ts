/**
 * Terminal output monitor for notification triggers.
 *
 * Watches terminal data streams for events that should trigger
 * push notifications:
 * - Bell character (\x07)
 * - Session exit
 */

import type { NotificationManager } from "./push-manager.js";

/**
 * Create a terminal data handler that detects notification-worthy events.
 */
export function createTerminalNotifier(
  sessionName: string,
  notifications: NotificationManager
): {
  /** Call with each chunk of terminal output data. */
  onData: (data: string) => void;
  /** Call when the session process exits. */
  onExit: (code: number) => void;
} {
  let bellCooldown = false;

  return {
    onData(data: string) {
      // Detect bell character.
      if (data.includes("\x07") && !bellCooldown) {
        bellCooldown = true;
        void notifications.notifyBell(sessionName);

        // Cooldown: don't spam notifications for rapid bells.
        setTimeout(() => {
          bellCooldown = false;
        }, 5000);
      }
    },

    onExit(code: number) {
      void notifications.notifySessionExit(sessionName, code);
    },
  };
}
