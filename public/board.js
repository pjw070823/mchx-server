// Minecraft Hex — spectator board (vanilla ES module)
// Layout rotated 90° from the spec image: Hard column (q+r=4) is vertical, anti-diagonals
// are columns indexed left→right as d goes 0..8.

const SVG_NS = "http://www.w3.org/2000/svg";
const HEX_R = 32;                       // vertex radius
const HEX_W = HEX_R * 2;                // flat-top width
const HEX_H = HEX_R * Math.sqrt(3);     // flat-top height
const COL_DX = HEX_R * 1.5;             // horizontal step between columns

const $ = (sel) => document.querySelector(sel);

const state = {
  ws: null,
  url: defaultWsUrl(),
  roomCode: null,
  missions: new Map(),
  board: new Map(),
  claimed: new Map(),
  status: "waiting",
  players: { A: null, B: null },
};

// WS lives on a separate port from the spectator static files. We always reach the same
// host but switch ports: 8000 serves this page, 8787 serves the WS endpoint.
const WS_PORT = 8787;

function defaultWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.hostname}:${WS_PORT}/ws`;
}

async function loadMissions() {
  const res = await fetch("/api/missions");
  const { missions } = await res.json();
  for (const m of missions) state.missions.set(m.id, m);
}

/**
 * Build 4 continuous polylines that trace the rhombus's outer perimeter, alternating
 * Side A and Side B. Each polyline runs through every shared vertex along its arc so
 * `stroke-linejoin: miter` produces clean joins at every hex corner.
 *
 * Counter-clockwise ordering (in SVG y-down):
 *   chain 1 — lower-left edge,  Side A, r=0 tiles, sides 2 then 1 of each tile
 *   chain 2 — lower-right edge, Side B, q=4 tiles, sides 1 then 0 of each tile
 *   chain 3 — upper-right edge, Side A, r=4 tiles, sides 5 then 4 of each tile
 *   chain 4 — upper-left edge,  Side B, q=0 tiles, sides 4 then 3 of each tile
 *
 * Corners (4,0) and (0,4) have side-1/4 contested between A and B. A wins, so the
 * adjacent B chain skips the contested vertex and starts from the next one — chain 2
 * begins at (4,0).v1 (= chain 1 endpoint) and traverses only (4,0)'s side 0; chain 4
 * begins at (0,4).v4 and traverses only (0,4)'s side 3.
 */
function buildBoundaryChains() {
  const c1 = [vAbs(0, 0, 3)];
  for (let q = 0; q <= 4; q++) {
    c1.push(vAbs(q, 0, 2));
    c1.push(vAbs(q, 0, 1));
  }

  const c2 = [vAbs(4, 0, 1), vAbs(4, 0, 0)];
  for (let r = 1; r <= 4; r++) {
    c2.push(vAbs(4, r, 1));
    c2.push(vAbs(4, r, 0));
  }

  const c3 = [vAbs(4, 4, 0)];
  for (let q = 4; q >= 0; q--) {
    c3.push(vAbs(q, 4, 5));
    c3.push(vAbs(q, 4, 4));
  }

  const c4 = [vAbs(0, 4, 4), vAbs(0, 4, 3)];
  for (let r = 3; r >= 0; r--) {
    c4.push(vAbs(0, r, 4));
    c4.push(vAbs(0, r, 3));
  }

  return [
    { points: c1, side: "a" },
    { points: c2, side: "b" },
    { points: c3, side: "a" },
    { points: c4, side: "b" },
  ];
}

function drawBoundary(svg) {
  for (const chain of buildBoundaryChains()) {
    const pts = chain.points
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ");
    const polyline = document.createElementNS(SVG_NS, "polyline");
    polyline.setAttribute("points", pts);
    polyline.setAttribute("class", `boundary side-${chain.side}`);
    svg.appendChild(polyline);
  }
}

function vAbs(q, r, vIdx) {
  const p = pixelFor(q, r);
  const angle = (Math.PI / 3) * vIdx;
  return {
    x: p.x + HEX_R * Math.cos(angle),
    y: p.y + HEX_R * Math.sin(angle),
  };
}

function pixelFor(q, r) {
  const d = q + r;
  const qMin = Math.max(0, d - 4);
  const qMax = Math.min(d, 4);
  const num = qMax - qMin + 1;
  const colIndex = q - qMin;
  const x = (d - 4) * COL_DX;
  const y = (colIndex - (num - 1) / 2) * HEX_H;
  return { x, y };
}

function hexPath(cx, cy) {
  // Flat-top: vertices at angles 0°, 60°, 120°, 180°, 240°, 300°.
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const x = cx + HEX_R * Math.cos(angle);
    const y = cy + HEX_R * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

function renderBoard() {
  const svg = $("#board");
  svg.innerHTML = "";
  drawBoundary(svg);

  for (const [tileId, tile] of state.board) {
    const { x, y } = pixelFor(tile.q, tile.r);
    const claim = state.claimed.get(tileId);

    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("transform", `translate(${x}, ${y})`);

    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", hexPath(0, 0));
    let cls = `hex ${tile.difficulty}`;
    if (claim) cls += ` claimed-${claim.side.toLowerCase()}`;
    poly.setAttribute("class", cls);
    poly.dataset.tileId = tileId;
    group.appendChild(poly);

    const [line1, line2] = labelLines(tile);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "hex-label");
    label.setAttribute("x", "0");
    label.setAttribute("y", "0");
    label.setAttribute("text-anchor", "middle");

    const top = document.createElementNS(SVG_NS, "tspan");
    top.setAttribute("x", "0");
    top.setAttribute("dy", line2 ? "-2" : "0");
    top.textContent = line1;
    label.appendChild(top);

    if (line2) {
      const bot = document.createElementNS(SVG_NS, "tspan");
      bot.setAttribute("x", "0");
      bot.setAttribute("dy", "10");
      bot.textContent = line2;
      label.appendChild(bot);
    }

    group.appendChild(label);

    poly.addEventListener("mousemove", (ev) => showTooltip(tileId, ev));
    poly.addEventListener("mouseleave", hideTooltip);

    svg.appendChild(group);
  }
}

function showTooltip(tileId, ev) {
  const tooltip = $("#hex-tooltip");
  const tile = state.board.get(tileId);
  if (!tile) return;
  const mission = state.missions.get(tile.missionId);
  const name = mission?.displayName ?? tile.missionId;
  const claim = state.claimed.get(tileId);
  const claimInfo = claim ? `<span class="claim-info">[${claim.side} 점유]</span>` : "";
  tooltip.innerHTML =
    `<span class="difficulty ${tile.difficulty}">${tile.difficulty.toUpperCase()}</span>` +
    `${escapeHtml(name)}${claimInfo}`;
  const wrap = $("#board-wrap");
  const rect = wrap.getBoundingClientRect();
  const x = ev.clientX - rect.left + 12;
  const y = ev.clientY - rect.top + 12;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.classList.add("visible");
}

function hideTooltip() {
  $("#hex-tooltip").classList.remove("visible");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * Split a mission display name into two roughly balanced lines.
 * Prefers splitting at whitespace or "·" near the midpoint; falls back to a hard cut.
 * Each line is truncated to MAX_LINE_CHARS and given an ellipsis if longer.
 */
function labelLines(tile) {
  const m = state.missions.get(tile.missionId);
  const name = (m?.displayName ?? tile.missionId).trim();
  const MAX_LINE = 7;

  // Short names: keep on one line.
  if (name.length <= MAX_LINE) return [name, ""];

  const mid = Math.ceil(name.length / 2);
  const breakChars = new Set([" ", "·", ",", "/"]);
  let bestSplit = -1;
  let bestDist = Infinity;
  for (let i = 1; i < name.length - 1; i++) {
    if (breakChars.has(name[i])) {
      const dist = Math.abs(i - mid);
      if (dist < bestDist) {
        bestDist = dist;
        bestSplit = i;
      }
    }
  }

  let l1, l2;
  if (bestSplit > 0) {
    l1 = name.slice(0, bestSplit).trim();
    l2 = name.slice(bestSplit + 1).trim();
  } else {
    l1 = name.slice(0, mid);
    l2 = name.slice(mid);
  }

  if (l1.length > MAX_LINE) l1 = l1.slice(0, MAX_LINE - 1) + "…";
  if (l2.length > MAX_LINE) l2 = l2.slice(0, MAX_LINE - 1) + "…";
  return [l1, l2];
}

function setConn(stateText, cls = "") {
  const el = $("#status");
  el.classList.remove("connected", "error");
  if (cls) el.classList.add(cls);
  $("#conn-state").textContent = stateText;
}

function renderHeader() {
  $("#room-info").textContent = state.roomCode ? `방 ${state.roomCode}` : "";
  $("#match-state").textContent = matchStateLabel(state.status);
  const a = state.players.A;
  const b = state.players.B;
  $('[data-bind="player-a"]').textContent = a?.name ?? "—";
  $('[data-bind="player-b"]').textContent = b?.name ?? "—";
  let ca = 0, cb = 0;
  for (const c of state.claimed.values()) (c.side === "A" ? ca++ : cb++);
  $('[data-bind="claimed-a"]').textContent = String(ca);
  $('[data-bind="claimed-b"]').textContent = String(cb);
  const me = mySide();
  document.querySelectorAll(".player").forEach((el) => {
    el.classList.toggle("is-me", el.dataset.side === me);
  });
}

function matchStateLabel(s) {
  switch (s) {
    case "waiting": return "대기 중";
    case "starting": return "시작 중";
    case "playing": return "진행 중";
    case "ended": return "종료";
    default: return s;
  }
}

function pushLog(claim) {
  const ul = $("#log");
  const li = document.createElement("li");
  li.classList.add(`side-${claim.side.toLowerCase()}`);
  const m = state.missions.get(claim.missionId);
  const time = new Date(claim.claimedAt).toLocaleTimeString("ko-KR", { hour12: false });
  li.textContent = `${time}  [${claim.side}] ${m?.displayName ?? claim.missionId}`;
  ul.prepend(li);
  while (ul.children.length > 40) ul.lastElementChild.remove();
}

function connect(roomCode) {
  if (state.ws) {
    try { state.ws.close(); } catch {}
  }
  setConn("연결 중…");
  const ws = new WebSocket(state.url);
  state.ws = ws;
  ws.onopen = () => {
    setConn("연결됨", "connected");
    ws.send(JSON.stringify({ type: "spectate", roomCode }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => setConn("연결 끊김");
  ws.onerror = () => setConn("연결 오류", "error");
}

function handle(msg) {
  switch (msg.type) {
    case "error":
      setConn(`서버 오류: ${msg.message}`, "error");
      return;

    case "room_state":
      state.roomCode = msg.roomCode;
      state.status = msg.status;
      if (msg.you) state.players[msg.you.side] = msg.you;
      if (msg.opponent) state.players[msg.opponent.side] = msg.opponent;
      renderHeader();
      return;

    case "match_start":
      state.status = "playing";
      state.board.clear();
      for (const t of msg.board) state.board.set(t.tileId, t);
      state.claimed.clear();
      for (const c of msg.claimed) state.claimed.set(c.tileId, c);
      renderBoard();
      renderHeader();
      return;

    case "tile_claimed":
      state.claimed.set(msg.tileId, {
        side: msg.side, missionId: msg.missionId, claimedAt: msg.claimedAt,
      });
      renderBoard();
      renderHeader();
      pushLog(msg);
      return;

    case "match_end":
      state.status = "ended";
      renderHeader();
      const winner = msg.winner ? `${msg.winner} 승리` : "종료";
      $("#match-state").textContent = `${winner} (${msg.reason})`;
      return;

    case "pong":
      return;
  }
}

function init() {
  $("#join").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = $("#code").value.trim().toUpperCase();
    if (code.length !== 4) return;
    location.hash = `room=${code}`;
    connect(code);
  });

  document.querySelectorAll(".player").forEach((el) => {
    el.addEventListener("click", () => {
      const side = el.dataset.side;
      if (!side) return;
      // Toggle: clicking same side again clears, otherwise set.
      const current = mySide();
      setMySide(current === side ? null : side);
      renderHeader();
    });
  });

  const m = location.hash.match(/room=([A-Z0-9]{4})/i);
  if (m) {
    $("#code").value = m[1].toUpperCase();
    connect(m[1].toUpperCase());
  } else {
    setConn("방 코드를 입력하세요");
  }
}

function mySide() {
  if (!state.roomCode) return null;
  return localStorage.getItem(`mchx.me.${state.roomCode}`);
}

function setMySide(side) {
  if (!state.roomCode) return;
  const key = `mchx.me.${state.roomCode}`;
  if (side) localStorage.setItem(key, side);
  else localStorage.removeItem(key);
}

loadMissions().then(init).catch((err) => {
  setConn(`미션 로드 실패: ${err.message}`, "error");
});
