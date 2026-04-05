import { AdapterRegistry } from "./registry.js";
import { GenericShellAdapter } from "./generic-shell.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";

export const adapterRegistry = new AdapterRegistry();

let initialized = false;

export function initAdapterRuntime(): AdapterRegistry {
  if (initialized) return adapterRegistry;

  adapterRegistry.register(new GenericShellAdapter());

  const claudeAdapter = new ClaudeCodeAdapter((event) => {
    adapterRegistry.emit(event.adapterId, event.type, event.data);
  });
  adapterRegistry.register(claudeAdapter);

  const codexAdapter = new CodexAdapter((event) => {
    adapterRegistry.emit(event.adapterId, event.type, event.data);
  });
  adapterRegistry.register(codexAdapter);

  initialized = true;
  return adapterRegistry;
}
