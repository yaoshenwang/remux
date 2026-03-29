const FEEDBACK_TARGET_SELECTORS = [
  "[data-testid='terminal-host']",
  ".inspect-layer.is-active",
  "main",
];

const isVisible = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect();
  const computedStyle = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    !element.hidden
    && computedStyle?.display !== "none"
    && computedStyle?.visibility !== "hidden"
    && (rect.width > 0 || rect.height > 0 || element.isConnected)
  );
};

export const resolveRemuxFeedbackTarget = (doc: Document = document): HTMLElement | null => {
  for (const selector of FEEDBACK_TARGET_SELECTORS) {
    const candidate = doc.querySelector(selector);
    if (candidate instanceof HTMLElement && isVisible(candidate)) {
      return candidate;
    }
  }

  return doc.body instanceof HTMLBodyElement ? doc.body : null;
};

export const openRemuxFeedbackDialog = (doc: Document = document): boolean => {
  const target = resolveRemuxFeedbackTarget(doc);
  if (!target) {
    return false;
  }

  const rect = target.getBoundingClientRect();
  const clientX = Math.round(rect.left + (rect.width > 0 ? rect.width / 2 : 20));
  const clientY = Math.round(rect.top + (rect.height > 0 ? rect.height / 2 : 20));
  target.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    clientX,
    clientY,
  }));

  return true;
};
