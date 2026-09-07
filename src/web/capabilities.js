// Controls declare their required capability on themselves or a containing form.
export function setControlDisabled(control, disabled, capabilities) {
  const required = control.closest("[data-capability]")?.dataset.capability;
  const denied = required !== undefined && capabilities[required] !== true;
  control.disabled = Boolean(disabled || denied);
  if (denied) {
    control.title = "Static demo: available in a local Boushun installation.";
    control.setAttribute("aria-disabled", "true");
  }
}

export function applyCapabilities(root, capabilities) {
  for (const control of root.querySelectorAll("button, input, select, textarea")) {
    setControlDisabled(control, control.disabled, capabilities);
  }
}
