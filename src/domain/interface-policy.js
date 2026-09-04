const VIRTUAL_INTERFACE = /^(lo|loopback\d*|docker\d*|veth|br-|cni|flannel|cilium|virbr)/i;

export function defaultInterfacePolicy(name, state = "UNKNOWN") {
  const virtual = VIRTUAL_INTERFACE.test(String(name ?? ""));
  const up = String(state ?? "UNKNOWN").toUpperCase() !== "DOWN";
  return {
    map: !virtual && up,
    identity: !virtual,
    scan: !virtual && up,
  };
}

export function resolveInterfacePolicy(name, state, settings = {}) {
  const defaults = defaultInterfacePolicy(name, state);
  const configured = settings?.interfaces?.[name] ?? settings?.[name] ?? {};
  return {
    map: typeof configured.map === "boolean" ? configured.map : defaults.map,
    identity: typeof configured.identity === "boolean" ? configured.identity : defaults.identity,
    scan: typeof configured.scan === "boolean" ? configured.scan : defaults.scan,
  };
}
