import type { Node } from "@/lib/api"
import { compact } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Compact fleet stat bar, transplanted from the Prism (v190) header bar —
 * layout, data and colours alike: two 17px rows at weight 900; server block
 * (🖥 over offline/online/total, the offline slot always reserved so a
 * dropout never shifts the bar; online #4ade80, total #a78bfa); traffic
 * block (live rate left, cumulative total right; up row over down row) in
 * the flowing shine-up / shine-down gradients; then the busiest (🔥) and
 * fastest (⚡) nodes in shine-busy / shine-fast, divided by aurora lines.
 * The list mirrors the two names with the same gradients (see ServerTable),
 * so a change of busiest/fastest recolours bar and rows together.
 * Mobile only (max-md): the busiest/fastest blocks collapse to bare
 * icons (no names or values) and the bar stays one line; desktop keeps
 * both blocks with full data and both variants.
 */
export function StatBar({ nodes, className, variant = "stack" }: { nodes: Node[]; className?: string; variant?: "stack" | "line" }) {
  let online = 0
  let rxTotal = 0
  let txTotal = 0
  let rxRate = 0
  let txRate = 0
  let busiest: { name: string; cpu: number } | null = null
  let fastest: { name: string; rx: number } | null = null
  for (const node of nodes) {
    rxTotal += node.total_rx
    txTotal += node.total_tx
    if (!node.online) continue
    online++
    const m = node.metrics
    if (!m) continue
    rxRate += m.net_rx
    txRate += m.net_tx
    if (!busiest || m.cpu > busiest.cpu) busiest = { name: node.name, cpu: m.cpu }
    if (!fastest || m.net_rx > fastest.rx) fastest = { name: node.name, rx: m.net_rx }
  }
  const offline = nodes.length - online
  const sameNode = busiest && fastest && busiest.name === fastest.name
  if (variant === "line") {
    // One-line edition for the group bar on wide screens: same data and shine
    // colours as the stacked bar, laid out flat — count, rates and totals with
    // their ↑↓, then busiest and fastest, aurora dividers between blocks.
    return (
      <div className={cn("stat-bar flex flex-nowrap items-center text-xs [font-weight:900]", className)}>
        <div className="flex shrink-0 items-center whitespace-nowrap" title="在线状态">
          <span aria-hidden="true">🖥️</span>
          {/* The offline slot is always reserved, like the stacked bar: a
              dropout fills it in place instead of shoving the bar sideways. */}
          <span className={cn("tnum ml-1.5 inline-block min-w-[2ch] text-center", offline > 0 && "animate-pulse text-[#fb7185]")}>{offline > 0 ? offline : ""}</span>
          <span className={cn("mx-px text-[#a1a1aa]", offline === 0 && "invisible")}>/</span>
          <span className="tnum inline-block min-w-[2ch] text-center text-[#4ade80]">{online}</span>
          <span className="mx-px text-[#a1a1aa]">/</span>
          <span className="tnum inline-block min-w-[2ch] text-center text-[#a78bfa]">{nodes.length}</span>
        </div>

        <div className="stat-divider mx-2.5 h-4 w-px shrink-0" aria-hidden="true" />

        <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden="true" className="text-[15px] leading-none text-[#22d3ee]">↑</span>
          <span title="实时上传速度" className="shine-up tnum inline-block min-w-[6ch]">{compact(txRate)}</span>
          <span title="累计上传流量" className="shine-up tnum inline-block min-w-[6ch]">{compact(txTotal)}</span>
          <span aria-hidden="true" className="ml-1.5 text-[15px] leading-none text-[#fde047]">↓</span>
          <span title="实时下载速度" className="shine-down tnum inline-block min-w-[6ch]">{compact(rxRate)}</span>
          <span title="累计下载流量" className="shine-down tnum inline-block min-w-[6ch]">{compact(rxTotal)}</span>
        </div>

        <div className="stat-divider mx-2.5 h-4 w-px shrink-0" aria-hidden="true" />

        <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap" title="最忙节点：CPU 最高">
          <span aria-hidden="true" className={cn(busiest && busiest.cpu > 15 && "animate-pulse")}>🔥</span>
          <span className="shine-busy inline-block w-[8ch] truncate">{busiest?.name ?? "-"}</span>
          <span className="shine-busy tnum inline-block min-w-[5ch]">{busiest ? `${busiest.cpu.toFixed(1)}%` : "-"}</span>
        </div>

        <div className="stat-divider mx-2.5 h-4 w-px shrink-0" aria-hidden="true" />

        <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap" title="最快节点：下载最快">
          <span aria-hidden="true" className={cn(fastest && fastest.rx > 1.5 * 1024 * 1024 && "animate-pulse")}>⚡</span>
          <span className="shine-fast inline-block w-[8ch] truncate">{fastest?.name ?? "-"}</span>
          <span aria-hidden="true" className="text-[15px] leading-none text-[#fde047]">↓</span>
          <span className="shine-fast tnum inline-block min-w-[6ch]">{fastest ? compact(fastest.rx) : "-"}</span>
        </div>
      </div>
    )
  }
  return (
    <div className={cn("stat-bar flex flex-nowrap items-center justify-center text-xs [font-weight:700] max-md:text-[10px]", className)}>
      <div className="flex shrink-0 flex-col items-end leading-[17px] max-md:flex-row max-md:items-center max-md:gap-1" title="在线状态">
        <div aria-hidden="true" className={offline > 0 ? "animate-pulse" : undefined}>🖥️</div>
        <div className="tnum flex items-center whitespace-nowrap">
          <span className={cn("inline-block min-w-[2ch] text-center", offline > 0 && "animate-pulse text-[#fb7185]")}>{offline > 0 ? offline : ""}</span>
          <span className={cn("mx-px text-[#a1a1aa]", offline === 0 && "invisible")}>/</span>
          <span className="inline-block min-w-[2ch] text-center text-[#4ade80]">{online}</span>
          <span className="mx-px text-[#a1a1aa]">/</span>
          <span className="inline-block min-w-[2ch] text-center text-[#a78bfa]">{nodes.length}</span>
        </div>
      </div>

      <div className="stat-divider mx-3 h-6 max-md:h-2 w-px shrink-0 max-md:mx-0.5" aria-hidden="true" />

      <div className="flex shrink-0 flex-col leading-[17px] max-md:flex-row max-md:items-center max-md:gap-1">
        <div className="flex items-center gap-2 whitespace-nowrap max-md:gap-1">
          <span aria-hidden="true" className="text-[11px] leading-none text-[#22d3ee]">↑</span>
          <span title="实时上传速度" className="shine-up tnum inline-block min-w-[6ch] max-md:min-w-[5ch] max-md:w-[5ch]">{compact(txRate)}</span>
          <span title="累计上传流量" className="shine-up tnum inline-block min-w-[6ch] max-md:min-w-[5ch] max-md:w-[5ch]">{compact(txTotal)}</span>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap max-md:gap-1">
          <span aria-hidden="true" className="text-[11px] leading-none text-[#fde047]">↓</span>
          <span title="实时下载速度" className="shine-down tnum inline-block min-w-[6ch] max-md:min-w-[5ch] max-md:w-[5ch]">{compact(rxRate)}</span>
          <span title="累计下载流量" className="shine-down tnum inline-block min-w-[6ch] max-md:min-w-[5ch] max-md:w-[5ch]">{compact(rxTotal)}</span>
        </div>
      </div>

      <div className="stat-divider mx-3 h-6 w-px shrink-0 max-md:mx-1.5 max-md:hidden" aria-hidden="true" />

      <div className="grid shrink-0 grid-cols-[auto_minmax(0,auto)] grid-rows-[17px_17px] items-center gap-x-[3px] max-md:hidden" title="最忙节点：CPU 最高">
        <span aria-hidden="true" className={cn("col-start-1 row-start-1 justify-self-center", busiest && busiest.cpu > 15 && "animate-pulse")}>🔥</span>
        <span className="shine-busy col-start-2 row-start-1 w-[7ch] truncate max-md:w-[6ch]">{busiest?.name ?? "-"}</span>
        <span className="shine-busy tnum col-start-2 row-start-2">{busiest ? `${busiest.cpu.toFixed(1)}%` : "-"}</span>
      </div>

      <div className="stat-divider mx-3 h-6 w-px shrink-0 max-md:mx-1.5 max-md:hidden" aria-hidden="true" />

      <div className="grid shrink-0 grid-cols-[auto_minmax(0,auto)] grid-rows-[17px_17px] items-center gap-x-[3px] max-md:hidden" title="最快节点：下载最快">
        <span aria-hidden="true" className={cn("col-start-1 row-start-1 justify-self-center", fastest && fastest.rx > 1.5 * 1024 * 1024 && "animate-pulse")}>⚡</span>
        <span className="shine-fast col-start-2 row-start-1 w-[7ch] truncate max-md:w-[6ch]">{fastest?.name ?? "-"}</span>
        <span aria-hidden="true" className="col-start-1 row-start-2 justify-self-center text-[15px] leading-none text-[#fde047]">↓</span>
        <span className="shine-fast tnum col-start-2 row-start-2">{fastest ? compact(fastest.rx) : "-"}</span>
      </div>

      {/* Mobile only: busiest/fastest markers with fixed-width names,
          no values, so the bar stays one line. */}
      <div className="stat-divider mx-0.5 h-2 w-px shrink-0 md:hidden" aria-hidden="true" />

      <div className="flex shrink-0 items-center gap-1 whitespace-nowrap md:hidden" title="最忙节点：CPU 最高">
        <span aria-hidden="true" className={cn(busiest && busiest.cpu > 15 && "animate-pulse", sameNode && "scale-50")}>🔥</span>
        <span className="shine-busy inline-block w-[6ch] text-center">{busiest?.name ?? "-"}</span>
      </div>

      <div className="stat-divider mx-0.5 h-2 w-px shrink-0 md:hidden" aria-hidden="true" />

      <div className="flex shrink-0 items-center gap-1 whitespace-nowrap md:hidden" title="最快节点：下载最快">
        <span aria-hidden="true" className={cn(fastest && fastest.rx > 1.5 * 1024 * 1024 && "animate-pulse", sameNode && "scale-50")}>⚡</span>
        <span className="shine-fast inline-block w-[6ch] text-center">{fastest?.name ?? "-"}</span>
      </div>
    </div>
  )
}
