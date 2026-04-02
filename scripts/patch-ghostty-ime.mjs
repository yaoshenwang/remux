#!/usr/bin/env node
/**
 * Patch ghostty-web to fix IME composition event binding.
 *
 * Problem: ghostty-web binds compositionstart/update/end listeners on the
 * container element, but the browser fires these events on the focused element
 * (the textarea). So the handlers never fire. (coder/ghostty-web#120)
 *
 * Fix: Change the attach() method to bind composition listeners on the textarea
 * (obtained from the container after open()) instead of the container itself.
 * Since attach() runs before the textarea exists, we defer the composition
 * binding to happen when the textarea is added to the container.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const file = join(
  process.cwd(),
  "node_modules",
  "ghostty-web",
  "dist",
  "ghostty-web.js",
);

let code = readFileSync(file, "utf8");

// The original attach() binds composition events on this.container.
// Replace those three addEventListener calls to use a MutationObserver that
// waits for the textarea to appear, then binds on the textarea instead.
const oldCompositionBinding = [
  'this.compositionStartListener = this.handleCompositionStart.bind(this), this.container.addEventListener("compositionstart", this.compositionStartListener)',
  'this.compositionUpdateListener = this.handleCompositionUpdate.bind(this), this.container.addEventListener("compositionupdate", this.compositionUpdateListener)',
  'this.compositionEndListener = this.handleCompositionEnd.bind(this), this.container.addEventListener("compositionend", this.compositionEndListener)',
].join(", ");

const newCompositionBinding = [
  "this.compositionStartListener = this.handleCompositionStart.bind(this)",
  "this.compositionUpdateListener = this.handleCompositionUpdate.bind(this)",
  "this.compositionEndListener = this.handleCompositionEnd.bind(this)",
  // Bind on textarea via MutationObserver (textarea doesn't exist yet during attach())
  'this._bindCompTA = () => { const ta = this.container.querySelector("textarea"); return ta ? (ta.addEventListener("compositionstart", this.compositionStartListener), ta.addEventListener("compositionupdate", this.compositionUpdateListener), ta.addEventListener("compositionend", this.compositionEndListener), !0) : !1; }',
  '(this._bindCompTA() || (this._compObs = new MutationObserver(() => { this._bindCompTA() && this._compObs.disconnect(); }), this._compObs.observe(this.container, { childList: !0 })))',
].join(", ");

if (!code.includes(oldCompositionBinding)) {
  if (code.includes("_bindCompositionOnTextarea")) {
    console.log("[patch-ghostty-ime] already patched, skipping");
    process.exit(0);
  }
  console.error("[patch-ghostty-ime] cannot find composition binding pattern — ghostty-web may have been updated");
  process.exit(1);
}

code = code.replace(oldCompositionBinding, newCompositionBinding);

// Also fix the detach/dispose method to remove from textarea instead of container
code = code.replace(
  'this.compositionStartListener && (this.container.removeEventListener("compositionstart", this.compositionStartListener)',
  'this.compositionStartListener && ((this.container.querySelector("textarea") || this.container).removeEventListener("compositionstart", this.compositionStartListener)',
);
code = code.replace(
  'this.compositionUpdateListener && (this.container.removeEventListener("compositionupdate", this.compositionUpdateListener)',
  'this.compositionUpdateListener && ((this.container.querySelector("textarea") || this.container).removeEventListener("compositionupdate", this.compositionUpdateListener)',
);
code = code.replace(
  'this.compositionEndListener && (this.container.removeEventListener("compositionend", this.compositionEndListener)',
  'this.compositionEndListener && ((this.container.querySelector("textarea") || this.container).removeEventListener("compositionend", this.compositionEndListener)',
);

writeFileSync(file, code);
console.log("[patch-ghostty-ime] patched composition event binding: container → textarea");
