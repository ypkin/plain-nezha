/**
 * Deployed services per node, keyed by panel node name.
 * Source: fleet records (2026-11-03). Entries marked "?" are unknown and
 * must not be guessed: the column renders "—" for them until confirmed.
 * nezha-agent is listed only where the node is known to report to the
 * panel; every online panel node runs it, so it is safe to include.
 */
export const NODE_SERVICES: Record<string, string[]> = {
  R1: ["软路由", "PassWall", "Lucky", "nezha-agent"],
  R2: [],
  R3: [],
  home: [],
  CDT: ["hy2", "nezha-agent"],
  sailor: ["hy2", "nezha-agent", "WARP", "rkm", "x-ui"],
  haruka: ["哪吒面板", "hy2", "sing-box", "nezha-agent", "nginx"],
  kuroit: ["博客", "hy2", "nezha-agent", "DNS解锁", "tabby", "sing-box"],
  exact: ["邮箱", "前端", "nezha-agent", "hy2"],
  cheap1: ["hy2", "nezha-agent"],
  cheap2: ["hy2", "nezha-agent"],
  cc: ["hy2", "nezha-agent"],
  hw: ["hy2", "nezha-agent"],
  alice: ["nezha-agent", "hy2", "WARP"],
  amd1: ["nginx", "图床", "nezha-agent", "hy2"],
  amd2: ["nezha-agent", "hy2"],
}

export function nodeServices(name: string): string[] {
  return NODE_SERVICES[name] ?? []
}

/** Nezha panel ids of the fleet nodes that run check-services.py. */
export const SERVICE_CHECK_IDS = new Set([101, 110, 116, 121, 134, 138, 145, 148, 149, 150, 151, 153])

/**
 * Table column text: the static list, minus services the live check
 * explicitly says stopped. Unknown stays listed (the probe could not
 * tell); with no live data the static list is shown unchanged.
 */
export function liveServicesList(name: string, live?: Record<string, string> | null): string[] {
  const list = nodeServices(name)
  if (!live) return list
  return list.filter((s) => live[s] !== "stopped")
}
