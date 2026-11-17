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
  // Name slots are sized by the longest node name in the fleet, so the
  // widest name fits its slot exactly and the centred bar keeps equal
  // left/right margins in the worst case, not just for short names.
  const nameCh = Math.max(1, ...nodes.map((n) => n.name.length))
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
    <div className={cn("stat-bar grid w-full grid-cols-[auto_1px_1fr_1px_auto_1px_auto] items-center gap-x-[2px] text-[10px] [font-weight:700]", offline === 0 && "pr-[15.5px]", className)}>
      {/* Server block: icon + counts on one line. The offline slot renders
          only on dropout (2026-11-17 用户点名文字外边距相等： its ~17px pays
          for the root's right inset, so the counts and the fastest name sit
          the same distance from the card edges). */}
      <div className="flex shrink-0 items-center gap-[3px] whitespace-nowrap" title="在线状态">
        <span aria-hidden="true" className={offline > 0 ? "animate-pulse" : undefined}>🖥️</span>
        <span className="tnum flex items-center">
          {offline > 0 && (
            <>
              <span className="inline-block min-w-[1.75ch] text-center animate-pulse text-[#fb7185]">{offline}</span>
              <span className="mx-px text-[#a1a1aa]">/</span>
            </>
          )}
          <span className="inline-block min-w-[1.75ch] text-center text-[#4ade80]">{online}</span>
          <span className="mx-px text-[#a1a1aa]">/</span>
          <span className="inline-block min-w-[1.75ch] text-center text-[#a78bfa]">{nodes.length}</span>
        </span>
      </div>

      <div className="stat-divider h-2 w-px shrink-0" aria-hidden="true" />

      {/* Traffic on one line: ↑ rate + total, then ↓ rate + total, the pair
          centred in the one flexible cell. That cell absorbs every
          viewport difference, so the fixed blocks at both ends never move
          and the bar can never overflow. All values sit in fixed-width
          right-aligned slots — data changes never resize anything. */}
      <div className="flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap">
        <span className="flex items-center gap-[3px]">
          <span aria-hidden="true" className="text-[11px] leading-none text-[#22d3ee]">↑</span>
          <span title="实时上传速度" className="shine-up tnum inline-block w-[4.25ch] text-right">{compact(txRate)}</span>
          <span title="累计上传流量" className="shine-up tnum inline-block w-[4.75ch] text-right">{compact(txTotal)}</span>
        </span>
        <span className="flex items-center gap-[3px]">
          <span aria-hidden="true" className="text-[11px] leading-none text-[#fde047]">↓</span>
          <span title="实时下载速度" className="shine-down tnum inline-block w-[4.25ch] text-right">{compact(rxRate)}</span>
          <span title="累计下载流量" className="shine-down tnum inline-block w-[4.75ch] text-right">{compact(rxTotal)}</span>
        </span>
      </div>

      <div className="stat-divider h-2 w-px shrink-0" aria-hidden="true" />

      {/* Busiest: flame + name. The name slot is sized by the longest node
          name in the fleet (nameCh) and right-aligned, so the widest name
          fits exactly, glyphs hug the divider side, and the block never
          resizes when the busiest node changes. */}
      <div className="flex shrink-0 items-center gap-[3px] whitespace-nowrap" title="最忙节点：CPU 最高">
        <span aria-hidden="true" className={cn(busiest && busiest.cpu > 15 && "animate-pulse")}>🔥</span>
        <span className="shine-busy inline-block truncate text-right" style={{ width: `${nameCh}ch` }}>{busiest?.name ?? "-"}</span>
      </div>

      <div className="stat-divider h-2 w-px shrink-0" aria-hidden="true" />

      {/* Fastest: bolt + name, same fixed-slot treatment. */}
      <div className="flex shrink-0 items-center gap-[3px] whitespace-nowrap" title="最快节点：下载最快">
        <span aria-hidden="true" className={cn(fastest && fastest.rx > 1.5 * 1024 * 1024 && "animate-pulse")}>⚡</span>
        <span className="shine-fast inline-block truncate text-right" style={{ width: `${nameCh}ch` }}>{fastest?.name ?? "-"}</span>
      </div>
    </div>
  )
}
