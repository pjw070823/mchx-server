// Minecraft Hex — board rendering + spectator client.
//
// Two public entrypoints:
//   - mountSpectator(container, roomCode): live WS spectator (existing UI)
//   - renderStaticBoard(svgEl, { board, claimed, missions, onHover, onLeave }):
//       static replay rendering for the match-detail page.

const SVG_NS = "http://www.w3.org/2000/svg";
const HEX_R = 32;
const HEX_W = HEX_R * 2;
const HEX_H = HEX_R * Math.sqrt(3);
const COL_DX = HEX_R * 1.5;

const WS_PORT = 8787;
function defaultWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.hostname}:${WS_PORT}/ws`;
}

async function loadMissions() {
  const res = await fetch("/api/missions");
  const { missions } = await res.json();
  const map = new Map();
  for (const m of missions) map.set(m.id, m);
  return map;
}

function vAbs(q, r, vIdx) {
  const p = pixelFor(q, r);
  const angle = (Math.PI / 3) * vIdx;
  return { x: p.x + HEX_R * Math.cos(angle), y: p.y + HEX_R * Math.sin(angle) };
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

function hexPath() {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const x = HEX_R * Math.cos(angle);
    const y = HEX_R * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}

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

function labelLines(name) {
  const MAX_LINE = 7;
  if (!name) return ["", ""];
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

/**
 * Renders the board into an existing SVG element. Pure: clears and redraws.
 *   svgEl: SVGSVGElement
 *   board: Array<{ tileId, q, r, difficulty, missionId }>
 *   claimed: Array<{ tileId, side, missionId, claimedAt }>
 *   missions: Map<id, { displayName, ... }>
 *   onHover(tileId, MouseEvent), onLeave()
 */
export function renderBoardSvg(svgEl, { board, claimed, missions, onHover, onLeave } = {}) {
  svgEl.innerHTML = "";
  svgEl.setAttribute("viewBox", "-300 -200 600 400");
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  drawBoundary(svgEl);

  const claimedMap = new Map();
  for (const c of claimed ?? []) claimedMap.set(c.tileId, c);

  for (const tile of board ?? []) {
    const { x, y } = pixelFor(tile.q, tile.r);
    const claim = claimedMap.get(tile.tileId);

    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("transform", `translate(${x}, ${y})`);

    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", hexPath());
    let cls = `hex ${tile.difficulty}`;
    if (claim) cls += ` claimed-${claim.side.toLowerCase()}`;
    poly.setAttribute("class", cls);
    poly.dataset.tileId = tile.tileId;
    group.appendChild(poly);

    const m = missions?.get(tile.missionId);
    const [line1, line2] = labelLines((m?.displayName ?? tile.missionId).trim());

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

    if (onHover) poly.addEventListener("mousemove", (ev) => onHover(tile.tileId, ev));
    if (onLeave) poly.addEventListener("mouseleave", onLeave);

    svgEl.appendChild(group);
  }
}

/**
 * Mounts the live spectator UI into a container element and connects to the
 * room. Returns a `cleanup()` function that closes the WS and detaches DOM.
 */
export function mountSpectator(container, roomCode) {
  container.innerHTML = `
    <div class="spectator">
      <div class="spectator-bar">
        <a href="#/" class="back">← 홈으로</a>
        <div class="spec-meta">
          <span id="conn-state">연결 대기</span>
          <span id="room-info"></span>
          <span id="match-state"></span>
        </div>
      </div>

      <div class="spec-grid">
        <aside class="spec-side">
          <div class="player side-a" data-side="A" title="클릭하면 내 진영으로 지정">
            <span class="badge">A</span>
            <span class="name" data-bind="player-a">—</span>
            <span class="me-badge">나</span>
            <span class="claimed" data-bind="claimed-a">0</span>
          </div>
          <div class="player side-b" data-side="B" title="클릭하면 내 진영으로 지정">
            <span class="badge">B</span>
            <span class="name" data-bind="player-b">—</span>
            <span class="me-badge">나</span>
            <span class="claimed" data-bind="claimed-b">0</span>
          </div>
          <div class="legend">
            <div class="legend-row">
              <span class="chip easy">Easy</span>
              <span class="chip medium">Medium</span>
              <span class="chip hard">Hard</span>
            </div>
            <div class="legend-row">
              <span class="chip claimed-a">A 점유</span>
              <span class="chip claimed-b">B 점유</span>
            </div>
          </div>
        </aside>

        <div class="board-wrap">
          <svg id="board"></svg>
          <div id="hex-tooltip" class="hex-tooltip"></div>
        </div>

        <section class="claim-log">
          <h3>최근 클레임</h3>
          <ol id="log"></ol>
        </section>
      </div>
    </div>
  `;

  const $ = (sel) => container.querySelector(sel);

  const state = {
    ws: null,
    url: defaultWsUrl(),
    roomCode,
    missions: new Map(),
    board: [],
    claimed: [],
    status: "waiting",
    players: { A: null, B: null },
  };

  function setConn(text, cls = "") {
    const el = $(".spec-meta");
    el.classList.remove("connected", "error");
    if (cls) el.classList.add(cls);
    $("#conn-state").textContent = text;
  }

  function showTooltip(tileId, ev) {
    const tooltip = $("#hex-tooltip");
    const tile = state.board.find((t) => t.tileId === tileId);
    if (!tile) return;
    const mission = state.missions.get(tile.missionId);
    const name = mission?.displayName ?? tile.missionId;
    const claim = state.claimed.find((c) => c.tileId === tileId);
    const claimInfo = claim ? `<span class="claim-info">[${claim.side} 점유]</span>` : "";
    tooltip.innerHTML =
      `<span class="difficulty ${tile.difficulty}">${tile.difficulty.toUpperCase()}</span>` +
      `${escapeHtml(name)}${claimInfo}`;
    const wrap = $(".board-wrap");
    const rect = wrap.getBoundingClientRect();
    tooltip.style.left = `${ev.clientX - rect.left + 12}px`;
    tooltip.style.top = `${ev.clientY - rect.top + 12}px`;
    tooltip.classList.add("visible");
  }

  function hideTooltip() {
    $("#hex-tooltip").classList.remove("visible");
  }

  function rerender() {
    renderBoardSvg($("#board"), {
      board: state.board,
      claimed: state.claimed,
      missions: state.missions,
      onHover: showTooltip,
      onLeave: hideTooltip,
    });
    $("#room-info").textContent = state.roomCode ? `방 ${state.roomCode}` : "";
    $("#match-state").textContent = matchStateLabel(state.status);
    const a = state.players.A;
    const b = state.players.B;
    $('[data-bind="player-a"]').textContent = a?.name ?? "—";
    $('[data-bind="player-b"]').textContent = b?.name ?? "—";
    let ca = 0, cb = 0;
    for (const c of state.claimed) (c.side === "A" ? ca++ : cb++);
    $('[data-bind="claimed-a"]').textContent = String(ca);
    $('[data-bind="claimed-b"]').textContent = String(cb);
    const me = mySide();
    container.querySelectorAll(".player").forEach((el) => {
      el.classList.toggle("is-me", el.dataset.side === me);
    });
  }

  function pushLog(claim) {
    const ul = $("#log");
    if (!ul) return;
    const li = document.createElement("li");
    li.classList.add(`side-${claim.side.toLowerCase()}`);
    const m = state.missions.get(claim.missionId);
    const time = new Date(claim.claimedAt).toLocaleTimeString("ko-KR", { hour12: false });
    li.textContent = `${time}  [${claim.side}] ${m?.displayName ?? claim.missionId}`;
    ul.prepend(li);
    while (ul.children.length > 40) ul.lastElementChild.remove();
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
        rerender();
        return;
      case "match_start":
        state.status = "playing";
        state.board = msg.board;
        state.claimed = msg.claimed;
        rerender();
        return;
      case "tile_claimed":
        state.claimed = state.claimed.filter((c) => c.tileId !== msg.tileId);
        state.claimed.push({
          tileId: msg.tileId, side: msg.side, missionId: msg.missionId, claimedAt: msg.claimedAt,
        });
        rerender();
        pushLog(msg);
        return;
      case "match_end":
        state.status = "ended";
        rerender();
        const winner = msg.winner ? `${msg.winner} 승리` : "종료";
        $("#match-state").textContent = `${winner} (${msg.reason})`;
        return;
      case "pong":
      default:
        return;
    }
  }

  function connect() {
    if (state.ws) { try { state.ws.close(); } catch {} }
    setConn("연결 중…");
    const ws = new WebSocket(state.url);
    state.ws = ws;
    ws.onopen = () => {
      setConn("연결됨", "connected");
      ws.send(JSON.stringify({ type: "spectate", roomCode: state.roomCode }));
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => setConn("연결 끊김");
    ws.onerror = () => setConn("연결 오류", "error");
  }

  container.querySelectorAll(".player").forEach((el) => {
    el.addEventListener("click", () => {
      const side = el.dataset.side;
      if (!side) return;
      const current = mySide();
      setMySide(current === side ? null : side);
      rerender();
    });
  });

  loadMissions().then((m) => {
    state.missions = m;
    rerender();
    connect();
  }).catch((err) => setConn(`미션 로드 실패: ${err.message}`, "error"));

  return () => {
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
  };
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export { loadMissions, escapeHtml };
