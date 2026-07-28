import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";

const PORT = Number(process.env.ANALYSIS_PORT || 5175);
const HOST = process.env.ANALYSIS_HOST || "127.0.0.1";
const ANALYSIS_ROOT = resolve(process.cwd(), "exports", "analysis", "latest");
const DATASET_PATH = resolve(process.cwd(), "public", "data", "items.json");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(finite(value) * scale) / scale;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const group = groups.get(key) || [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function regression(points) {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (clean.length < 2) return null;
  const xMean = mean(clean.map((point) => point.x));
  const yMean = mean(clean.map((point) => point.y));
  const numerator = clean.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0);
  const denominator = clean.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0);
  if (!denominator) return null;
  const slope = numerator / denominator;
  return { slope, intercept: yMean - slope * xMean };
}

function familyName(family) {
  return family === "wall_planter" ? "Wall planter" : family === "wall_hook" ? "Wall hook" : "Snowman";
}

function localFile(pathname) {
  const clean = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  return resolve(ANALYSIS_ROOT, normalize(clean));
}

function buildDashboardData() {
  const analysis = readJson(resolve(ANALYSIS_ROOT, "analysis.json"));
  const dataset = readJson(DATASET_PATH);
  const items = new Map(dataset.items.map((item) => [item.id, item]));
  const rankingRows = analysis.rankingsClean || [];
  const points = rankingRows
    .map((row) => {
      const item = items.get(row.item_id);
      if (!item) return null;
      return {
        id: row.item_id,
        title: row.title || item.title,
        family: item.family,
        familyLabel: item.familyLabel || familyName(item.family),
        detail: finite(item.specificityLevel, null),
        repetition: finite(item.repetition, 0),
        seedId: item.seedId || row.seed_id,
        elo: finite(row.elo, 0),
        rank: row.rank,
        battles: finite(row.battles, 0),
        wins: finite(row.wins, 0),
        draws: finite(row.draws, 0),
      };
    })
    .filter((point) => point && Number.isFinite(point.detail) && Number.isFinite(point.elo));

  const detailGroups = [...groupBy(points, (point) => point.detail).entries()]
    .map(([detail, rows]) => ({
      detail: Number(detail),
      elo: round(mean(rows.map((row) => row.elo))),
      count: rows.length,
    }))
    .sort((left, right) => left.detail - right.detail);

  const familyDetail = [...groupBy(points, (point) => `${point.family}|${point.detail}`).entries()]
    .map(([key, rows]) => {
      const [family, detail] = key.split("|");
      return {
        family,
        familyLabel: familyName(family),
        detail: Number(detail),
        elo: round(mean(rows.map((row) => row.elo))),
        count: rows.length,
      };
    })
    .sort((left, right) => left.family.localeCompare(right.family) || left.detail - right.detail);

  const familyGroups = groupBy(points, (point) => point.family);
  const familyMeans = new Map(
    [...familyGroups.entries()].map(([family, rows]) => [family, mean(rows.map((row) => row.elo))]),
  );
  const normalized = points.map((row) => {
    const familyMean = familyMeans.get(row.family) ?? row.elo;
    return { ...row, normalizedElo: row.elo - familyMean };
  });
  const normalizedDetail = [...groupBy(normalized, (point) => point.detail).entries()]
    .map(([detail, rows]) => ({
      detail: Number(detail),
      normalizedElo: round(mean(rows.map((row) => row.normalizedElo))),
      count: rows.length,
    }))
    .sort((left, right) => left.detail - right.detail);

  const combinedRegression = regression(points.map((point) => ({ x: point.detail, y: point.elo })));
  const normalizedRegression = regression(normalized.map((point) => ({ x: point.detail, y: point.normalizedElo })));
  const familyRegressions = [...groupBy(points, (point) => point.family).entries()]
    .map(([family, rows]) => {
      const line = regression(rows.map((point) => ({ x: point.detail, y: point.elo })));
      return line
        ? { family, familyLabel: familyName(family), slope: round(line.slope, 3), intercept: round(line.intercept, 3) }
        : null;
    })
    .filter(Boolean);

  const convergenceRows = (analysis.eloConvergenceRows || []).map((row) => ({
    voteIndex: finite(row.vote_index, 0),
    move: finite(row.mean_abs_elo_delta, 0),
    spread: finite(row.elo_spread, 0),
    leaderTitle: row.leader_title,
  }));
  const sampleEvery = Math.max(1, Math.ceil(convergenceRows.length / 180));
  const convergence = convergenceRows.filter(
    (_, index) => index % sampleEvery === 0 || index === convergenceRows.length - 1,
  );

  return {
    generatedAtUtc: analysis.generatedAtUtc,
    totals: analysis.totals,
    points,
    detailGroups,
    familyDetail,
    normalizedDetail,
    convergence,
    trend: {
      combinedSlope: combinedRegression ? round(combinedRegression.slope, 3) : 0,
      normalizedSlope: normalizedRegression ? round(normalizedRegression.slope, 3) : 0,
      familySlopes: familyRegressions,
    },
  };
}

function html() {
  const data = buildDashboardData();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CadBattle Trend Graphs</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17211d;
      --muted: #607068;
      --panel: rgba(255,255,255,.88);
      --line: #cfdcd1;
      --paper: #f7fbf4;
      --deep: #16352d;
      --accent: #d8f06d;
      --hook: #3c89b8;
      --planter: #36a875;
      --snow: #c26a4b;
      --combined: #151b18;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #d6f0e8 0, #f6fbf2 38%, #eef5fa 100%);
    }
    header {
      padding: 28px clamp(18px, 5vw, 52px) 22px;
      background: #16352d;
      color: white;
      border-bottom: 1px solid rgba(255,255,255,.15);
    }
    .topline {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: end;
      max-width: 1320px;
      margin: 0 auto;
    }
    h1, h2, h3, p { margin: 0; }
    h1 {
      font-size: clamp(32px, 5vw, 62px);
      letter-spacing: 0;
      line-height: .95;
    }
    .stamp { color: #cfe5dc; font-size: 13px; text-align: right; }
    main {
      width: min(1320px, calc(100% - 28px));
      margin: 0 auto;
      padding: 18px 0 42px;
      display: grid;
      gap: 14px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 46px rgba(24, 45, 38, .10);
    }
    .metric { padding: 14px 16px; }
    .metric span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .02em;
      text-transform: uppercase;
    }
    .metric strong {
      display: block;
      margin-top: 6px;
      font: 800 28px/1 Cascadia Mono, Consolas, monospace;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(340px, .82fr);
      gap: 14px;
      align-items: start;
    }
    .panel { padding: 16px; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      margin-bottom: 10px;
    }
    h2 { font-size: 18px; letter-spacing: 0; }
    .note { color: var(--muted); font-size: 13px; }
    .legend {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
    }
    .legend i {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      margin-right: 5px;
      vertical-align: -1px;
    }
    svg { display: block; width: 100%; height: auto; overflow: visible; }
    .axis text { fill: #5c6b63; font-size: 12px; }
    .axis line, .axis path, .grid line { stroke: #d8e1da; stroke-width: 1; }
    .grid line { opacity: .75; }
    .point { cursor: default; transition: opacity .15s ease, r .15s ease; }
    .point:hover { opacity: 1; r: 7; }
    .tooltip {
      position: fixed;
      z-index: 10;
      pointer-events: none;
      opacity: 0;
      transform: translate(12px, 12px);
      background: #122720;
      color: white;
      border: 1px solid rgba(255,255,255,.15);
      border-radius: 8px;
      padding: 9px 10px;
      min-width: 190px;
      box-shadow: 0 12px 38px rgba(0,0,0,.22);
      font-size: 12px;
      line-height: 1.35;
    }
    .tooltip strong { display: block; font-size: 13px; margin-bottom: 3px; }
    .signal-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .signal {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid #e4ece5;
      font-size: 14px;
    }
    .signal:last-child { border-bottom: 0; }
    .signal b { font-family: Cascadia Mono, Consolas, monospace; }
    .downloads {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .downloads a {
      color: #15332b;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 9px;
      text-decoration: none;
      background: rgba(255,255,255,.64);
      font-size: 13px;
      font-weight: 750;
    }
    @media (max-width: 920px) {
      .topline { align-items: start; flex-direction: column; }
      .stamp { text-align: left; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .layout { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      main { width: min(100% - 18px, 1320px); }
      .metrics { grid-template-columns: 1fr; }
      .panel { padding: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <div>
        <h1>Trend Graphs</h1>
        <p class="note" style="color:#cfe5dc;margin-top:8px">Detail, family, rating movement</p>
      </div>
      <p class="stamp">Updated ${new Date(data.generatedAtUtc).toLocaleString()}<br />CadBattle local analysis</p>
    </div>
  </header>
  <main>
    <section class="metrics">
      <div class="metric"><span>Clean votes</span><strong>${data.totals.cleanVotes}</strong></div>
      <div class="metric"><span>Models</span><strong>${data.points.length}</strong></div>
      <div class="metric"><span>Detail slope</span><strong>${data.trend.combinedSlope > 0 ? "+" : ""}${data.trend.combinedSlope}</strong></div>
      <div class="metric"><span>Family adjusted</span><strong>${data.trend.normalizedSlope > 0 ? "+" : ""}${data.trend.normalizedSlope}</strong></div>
    </section>

    <section class="layout">
      <article class="panel">
        <div class="panel-head">
          <h2>Detail vs Elo</h2>
          <div class="legend">
            <span><i style="background:var(--planter)"></i>Planter</span>
            <span><i style="background:var(--hook)"></i>Hook</span>
            <span><i style="background:var(--snow)"></i>Snowman</span>
            <span><i style="background:var(--combined);border-radius:2px"></i>Trend</span>
          </div>
        </div>
        <div id="scatter"></div>
      </article>
      <aside class="panel">
        <div class="panel-head">
          <h2>Current Signals</h2>
        </div>
        <div id="signals" class="signal-list"></div>
        <div class="downloads">
          <a href="/analysis.json">analysis.json</a>
          <a href="/rankings_clean.csv">rankings_clean.csv</a>
          <a href="/elo_convergence.csv">elo_convergence.csv</a>
        </div>
      </aside>
      <article class="panel">
        <div class="panel-head">
          <h2>Family Detail Trend</h2>
          <p class="note">Mean Elo by detail level</p>
        </div>
        <div id="familyTrend"></div>
      </article>
      <article class="panel">
        <div class="panel-head">
          <h2>Family-Adjusted Detail Lift</h2>
          <p class="note">Elo after removing each family average</p>
        </div>
        <div id="normalizedTrend"></div>
      </article>
      <article class="panel wide">
        <div class="panel-head">
          <h2>Elo Convergence</h2>
          <p class="note">Rating movement per clean vote</p>
        </div>
        <div id="convergence"></div>
      </article>
    </section>
  </main>
  <div id="tooltip" class="tooltip"></div>
  <script>
    const data = ${JSON.stringify(data)};
    const colors = { wall_planter: "#36a875", wall_hook: "#3c89b8", snowman: "#c26a4b", combined: "#151b18" };
    const details = [...new Set(data.points.map((point) => point.detail))].sort((a, b) => a - b);
    const tooltip = document.getElementById("tooltip");

    function hash(value) {
      let out = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        out ^= value.charCodeAt(index);
        out = Math.imul(out, 16777619);
      }
      return (out >>> 0) / 4294967295;
    }
    function fmt(value, digits = 1) {
      return Number(value).toFixed(digits).replace(/\\.0$/, "");
    }
    function extent(values, pad = 0) {
      const clean = values.filter(Number.isFinite);
      const min = Math.min(...clean);
      const max = Math.max(...clean);
      if (min === max) return [min - 1, max + 1];
      return [min - pad, max + pad];
    }
    function scale(domainMin, domainMax, rangeMin, rangeMax) {
      return (value) => rangeMin + ((value - domainMin) / (domainMax - domainMin || 1)) * (rangeMax - rangeMin);
    }
    function svgEl(name, attrs = {}) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", name);
      Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
      return el;
    }
    function makeSvg(parentId, height = 430) {
      const parent = document.getElementById(parentId);
      parent.innerHTML = "";
      const svg = svgEl("svg", { viewBox: "0 0 900 " + height, role: "img" });
      parent.appendChild(svg);
      return { svg, width: 900, height, margin: { top: 20, right: 28, bottom: 48, left: 58 } };
    }
    function axes(svg, chart, xTicks, yTicks, x, y, xLabel, yLabel) {
      const { width, height, margin } = chart;
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;
      const grid = svgEl("g", { class: "grid" });
      yTicks.forEach((tick) => {
        const yy = y(tick);
        grid.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: yy, y2: yy }));
      });
      svg.appendChild(grid);
      const axis = svgEl("g", { class: "axis" });
      axis.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: height - margin.bottom, y2: height - margin.bottom }));
      axis.appendChild(svgEl("line", { x1: margin.left, x2: margin.left, y1: margin.top, y2: height - margin.bottom }));
      xTicks.forEach((tick) => {
        const xx = x(tick);
        axis.appendChild(svgEl("line", { x1: xx, x2: xx, y1: height - margin.bottom, y2: height - margin.bottom + 6 }));
        const text = svgEl("text", { x: xx, y: height - margin.bottom + 24, "text-anchor": "middle" });
        text.textContent = tick;
        axis.appendChild(text);
      });
      yTicks.forEach((tick) => {
        const yy = y(tick);
        axis.appendChild(svgEl("line", { x1: margin.left - 6, x2: margin.left, y1: yy, y2: yy }));
        const text = svgEl("text", { x: margin.left - 10, y: yy + 4, "text-anchor": "end" });
        text.textContent = fmt(tick);
        axis.appendChild(text);
      });
      const xl = svgEl("text", { x: margin.left + plotW / 2, y: height - 8, "text-anchor": "middle", fill: "#607068", "font-size": "12" });
      xl.textContent = xLabel;
      const yl = svgEl("text", { x: -margin.top - plotH / 2, y: 16, transform: "rotate(-90)", "text-anchor": "middle", fill: "#607068", "font-size": "12" });
      yl.textContent = yLabel;
      axis.appendChild(xl);
      axis.appendChild(yl);
      svg.appendChild(axis);
    }
    function pathFrom(points, x, y) {
      return points.map((point, index) => (index ? "L" : "M") + x(point.x) + " " + y(point.y)).join(" ");
    }
    function showTip(event, point) {
      tooltip.innerHTML = "<strong>" + point.title + "</strong>" + point.familyLabel + " | detail " + point.detail + "<br />Elo " + fmt(point.elo, 2) + " | rank " + point.rank;
      tooltip.style.left = event.clientX + "px";
      tooltip.style.top = event.clientY + "px";
      tooltip.style.opacity = "1";
    }
    function hideTip() {
      tooltip.style.opacity = "0";
    }
    function drawScatter() {
      const chart = makeSvg("scatter", 470);
      const { svg, width, height, margin } = chart;
      const [yMin, yMax] = extent(data.points.map((point) => point.elo), 8);
      const x = scale(0.5, 10.5, margin.left, width - margin.right);
      const y = scale(yMin, yMax, height - margin.bottom, margin.top);
      const yTicks = [Math.ceil(yMin / 10) * 10, Math.round((yMin + yMax) / 2), Math.floor(yMax / 10) * 10].filter((v, i, a) => a.indexOf(v) === i);
      axes(svg, chart, details, yTicks, x, y, "Detail level", "Elo");
      if (data.trend.combinedSlope) {
        const x1 = Math.min(...details);
        const x2 = Math.max(...details);
        const yMean = data.points.reduce((sum, p) => sum + p.elo, 0) / data.points.length;
        const xMean = data.points.reduce((sum, p) => sum + p.detail, 0) / data.points.length;
        const intercept = yMean - data.trend.combinedSlope * xMean;
        svg.appendChild(svgEl("line", {
          x1: x(x1), y1: y(intercept + data.trend.combinedSlope * x1),
          x2: x(x2), y2: y(intercept + data.trend.combinedSlope * x2),
          stroke: colors.combined, "stroke-width": 3, "stroke-linecap": "round"
        }));
      }
      data.points.forEach((point) => {
        const jitter = (hash(point.id) - .5) * .48;
        const circle = svgEl("circle", {
          class: "point",
          cx: x(point.detail + jitter),
          cy: y(point.elo),
          r: 4 + Math.min(2, point.battles / 8),
          fill: colors[point.family],
          opacity: .72,
          stroke: "rgba(255,255,255,.85)",
          "stroke-width": 1.2
        });
        circle.addEventListener("mousemove", (event) => showTip(event, point));
        circle.addEventListener("mouseleave", hideTip);
        svg.appendChild(circle);
      });
    }
    function drawFamilyTrend() {
      const chart = makeSvg("familyTrend", 350);
      const { svg, width, height, margin } = chart;
      const values = data.familyDetail;
      const [yMin, yMax] = extent(values.map((row) => row.elo), 8);
      const x = scale(0.5, 10.5, margin.left, width - margin.right);
      const y = scale(yMin, yMax, height - margin.bottom, margin.top);
      axes(svg, chart, details, [Math.ceil(yMin / 10) * 10, Math.round((yMin + yMax) / 2), Math.floor(yMax / 10) * 10], x, y, "Detail level", "Mean Elo");
      ["wall_planter", "wall_hook", "snowman"].forEach((family) => {
        const rows = values.filter((row) => row.family === family).map((row) => ({ x: row.detail, y: row.elo }));
        if (rows.length < 2) return;
        svg.appendChild(svgEl("path", {
          d: pathFrom(rows, x, y),
          fill: "none",
          stroke: colors[family],
          "stroke-width": 3,
          "stroke-linecap": "round",
          "stroke-linejoin": "round"
        }));
        rows.forEach((row) => svg.appendChild(svgEl("circle", { cx: x(row.x), cy: y(row.y), r: 4.5, fill: colors[family], stroke: "white", "stroke-width": 1 })));
      });
    }
    function drawNormalizedTrend() {
      const chart = makeSvg("normalizedTrend", 350);
      const { svg, width, height, margin } = chart;
      const rows = data.normalizedDetail.map((row) => ({ x: row.detail, y: row.normalizedElo }));
      const [yMin, yMax] = extent(rows.map((row) => row.y), 5);
      const x = scale(0.5, 10.5, margin.left, width - margin.right);
      const y = scale(yMin, yMax, height - margin.bottom, margin.top);
      axes(svg, chart, details, [Math.floor(yMin), 0, Math.ceil(yMax)].filter((v, i, a) => a.indexOf(v) === i), x, y, "Detail level", "Relative Elo");
      svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y(0), y2: y(0), stroke: "#7e8c84", "stroke-dasharray": "5 6" }));
      svg.appendChild(svgEl("path", { d: pathFrom(rows, x, y), fill: "none", stroke: "#151b18", "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      rows.forEach((row) => svg.appendChild(svgEl("circle", { cx: x(row.x), cy: y(row.y), r: 5, fill: "#d8f06d", stroke: "#151b18", "stroke-width": 1.4 })));
    }
    function drawConvergence() {
      const chart = makeSvg("convergence", 280);
      const { svg, width, height, margin } = chart;
      const rows = data.convergence.map((row) => ({ x: row.voteIndex, y: row.move }));
      const xMax = Math.max(...rows.map((row) => row.x), 1);
      const [yMin, yMax] = extent(rows.map((row) => row.y), 1);
      const x = scale(1, xMax, margin.left, width - margin.right);
      const y = scale(Math.min(0, yMin), yMax, height - margin.bottom, margin.top);
      axes(svg, chart, [1, Math.round(xMax / 2), xMax], [0, Math.round(yMax / 2), Math.ceil(yMax)], x, y, "Vote index", "Mean Elo move");
      svg.appendChild(svgEl("path", { d: pathFrom(rows, x, y), fill: "none", stroke: "#3c89b8", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    }
    function renderSignals() {
      const strongest = [...data.trend.familySlopes].sort((a, b) => Math.abs(b.slope) - Math.abs(a.slope))[0];
      const latest = data.convergence[data.convergence.length - 1];
      const signals = [
        ["Overall detail slope", (data.trend.combinedSlope > 0 ? "+" : "") + data.trend.combinedSlope + " Elo/detail"],
        ["Family-adjusted slope", (data.trend.normalizedSlope > 0 ? "+" : "") + data.trend.normalizedSlope + " Elo/detail"],
        ["Strongest family slope", strongest ? strongest.familyLabel + " " + (strongest.slope > 0 ? "+" : "") + strongest.slope : "n/a"],
        ["Latest Elo move", latest ? fmt(latest.move, 2) : "n/a"],
      ];
      document.getElementById("signals").innerHTML = signals.map(([label, value]) => '<div class="signal"><span>' + label + '</span><b>' + value + '</b></div>').join("");
    }
    drawScatter();
    drawFamilyTrend();
    drawNormalizedTrend();
    drawConvergence();
    renderSignals();
  </script>
</body>
</html>`;
}

function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/" || url.pathname === "/trends") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html());
    return;
  }
  if (url.pathname === "/classic") {
    const classic = resolve(ANALYSIS_ROOT, "index.html");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(readFileSync(classic));
    return;
  }
  const path = localFile(url.pathname);
  if (!path.startsWith(ANALYSIS_ROOT) || !existsSync(path)) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  response.setHeader("content-type", contentTypes.get(extname(path)) || "text/plain; charset=utf-8");
  response.end(readFileSync(path));
}

createServer(serveStatic).listen(PORT, HOST, () => {
  console.log(`trend graphs http://${HOST}:${PORT}/`);
});
