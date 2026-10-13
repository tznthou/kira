import { Fragment, memo } from "react";
import type { LineColor } from "@/lib/routeMap";
import {
  CASING_W,
  FLAKE_R,
  LW,
  hexPoints,
  pathD,
  ringRadius,
  shinePoints,
  terminusD,
  tickD,
  type Geometry,
  type StationMark,
} from "@/lib/routeGeometry";

const lc = (color: LineColor) => `var(--l-${color})`;

/**
 * 軌道：套管一組、線一組，都照 geometry.edges 的順序（基準 drawMap 1131-1133、1161）。挖洞的 mask 在前；
 * 截斷時整組包進淡出 mask（1163-1167）。分組不能改成每條線「套管 + 線」成對：橋與匯流靠的就是這個層次
 */
const Tracks = memo(function Tracks({ geometry }: { geometry: Geometry }) {
  const { width: W, height: H, edges, holes, fadeFrom } = geometry;
  const masks = [...holes].map(([n, cuts]) => (
    <mask key={n} id={`kg-hole-${n}`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
      <rect width={W} height={H} fill="#fff" />
      {cuts.map((h, i) => (
        <path key={i} d={pathD(h.cut)} stroke="#000" strokeWidth={CASING_W} />
      ))}
    </mask>
  ));
  const tracks = (
    <>
      {masks.length > 0 && <defs>{masks}</defs>}
      <g>
        {edges.map((e, i) => (
          <path key={i} d={pathD(e.pts)} fill="none" stroke="var(--sheet)" strokeWidth={CASING_W} strokeLinejoin="round" />
        ))}
      </g>
      <g>
        {edges.map((e, i) => (
          <path
            key={i}
            d={pathD(e.pts)}
            fill="none"
            stroke={lc(e.color)}
            strokeWidth={LW}
            strokeLinejoin="round"
            strokeLinecap="round"
            mask={holes.has(i) ? `url(#kg-hole-${i})` : undefined}
          />
        ))}
      </g>
    </>
  );
  if (fadeFrom === null) return tracks;
  return (
    <>
      <defs>
        <linearGradient id="kg-run-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="kg-run-on" maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
          <rect width={W} height={fadeFrom} fill="#fff" />
          <rect y={fadeFrom} width={W} height={H - fadeFrom} fill="url(#kg-run-g)" />
        </mask>
      </defs>
      <g mask="url(#kg-run-on)">{tracks}</g>
    </>
  );
});

/**
 * 車站（基準 1143-1159）。金箔外那圈漣漪以 pulseKey 當 key：HEAD 換了（開 repo、checkout、detach、
 * commit）就重掛、重播一次；同一個 HEAD 的 refresh 不重播。減少動態由 v8.css 的 media query 處理
 */
const Stations = memo(function Stations({ stations, pulseKey }: { stations: StationMark[]; pulseKey: string }) {
  return (
    <g>
      {stations.map(({ oid, x: cx, y: cy, kind, color }) => {
        if (kind === "head") {
          return (
            <Fragment key={oid}>
              <circle
                key={pulseKey}
                className="here-pulse"
                cx={cx}
                cy={cy}
                r="8"
                fill="none"
                stroke="var(--gold-leaf)"
                strokeWidth="2"
                opacity="0"
              />
              <circle cx={cx} cy={cy} r="10.5" fill="var(--sheet)" opacity="0.92" />
              <polygon
                points={hexPoints(cx, cy, FLAKE_R)}
                fill="var(--gold-leaf)"
                stroke="var(--flake-edge)"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <polygon points={shinePoints(cx, cy)} fill="oklch(1 0 0 / 0.5)" />
            </Fragment>
          );
        }
        if (kind === "interchange") {
          return (
            <circle key={oid} cx={cx} cy={cy} r="5.6" fill="var(--sheet-hi)" stroke="var(--l-trunk)" strokeWidth="2.2" />
          );
        }
        const d = kind === "terminus" ? terminusD(cx, cy) : tickD(cx, cy);
        return <path key={oid} d={d} stroke={lc(color)} strokeWidth={LW} strokeLinecap="round" />;
      })}
    </g>
  );
});

/** 路線層（`svg.lanes`）：疊在列上面、不吃滑鼠（v8.css），對螢幕閱讀器隱藏——列自己會念 */
export function RouteLayer({
  geometry,
  pulseKey,
  selected,
}: {
  geometry: Geometry;
  pulseKey: string;
  /** 選取的那站；不在視窗內就不畫圈（基準 1177-1178） */
  selected: StationMark | null;
}) {
  const { width: W, height: H } = geometry;
  return (
    <svg className="lanes" aria-hidden="true" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <Tracks geometry={geometry} />
      <Stations stations={geometry.stations} pulseKey={pulseKey} />
      <g>
        {selected && (
          <circle
            cx={selected.x}
            cy={selected.y}
            r={ringRadius(selected.kind === "head")}
            fill="none"
            stroke="var(--line)"
            strokeWidth="1.75"
          />
        )}
      </g>
    </svg>
  );
}
