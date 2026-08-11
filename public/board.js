// Minecraft Hex — 보드 렌더링 + 관전 클라이언트.
//
// 화면 구성과 보드는 목업을 그대로 옮겼습니다. 육각형은 clip-path 를 쓴 div 이고,
// 마름모 바깥 변만 절대 배치한 SVG 로 겹쳐 그립니다.

/** 모드가 붙는 API+WebSocket 포트. 관전 보드(:80)와는 다른 포트입니다. */
const API_PORT = 8787;

/**
 * 관전 소켓 주소.
 *
 * 같은 Node 프로세스가 두 포트로 서비스합니다 — API+WS 는 [API_PORT], 관전 보드는 :80.
 * 페이지가 :80 에서 왔으면 소켓은 다른 포트로 붙어야 하고, 그 외 포트에서 왔으면
 * 그 포트가 곧 API 포트입니다(개발 중 임의 포트로 띄우는 경우).
 */
function defaultWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const port = location.port;
  const wsPort = port && port !== "80" && port !== "443" ? port : API_PORT;
  return `${proto}://${location.hostname}:${wsPort}/ws`;
}

async function loadMissions() {
  const res = await fetch("/api/missions");
  const { missions } = await res.json();
  const map = new Map();
  for (const m of missions) map.set(m.id, m);
  return map;
}

/* ------------------------------------------------------------ 보드 그리기 */

/** 칸 색 — 목업 그대로. 난이도는 색으로 구분하지 않습니다. */
const TILE_COLORS = {
  none: { ring: "#252A32", bg: "#161A20", fg: "#8F98A4" },
  A: { ring: "#7BA0FC", bg: "#4A7BFA", fg: "#0B0D10" },
  B: { ring: "#DAA8FC", bg: "#C77CFA", fg: "#0B0D10" },
};
const SELECTED_RING = "#FFFFFF";

/**
 * 마름모 바깥 변. 좌표는 목업의 폴리라인을 그대로 옮긴 것이고(칸 너비 100 = --w),
 * 색만 실제 규칙에 맞췄습니다 — A 는 r=0 ↔ r=4(위아래), B 는 q=0 ↔ q=4(좌우).
 */
const BOUNDS = [
  { side: "a", points: "197.75,22.37 259,-12.99 311.25,17.18 363.5,-12.99 415.75,17.18 468,-12.99 520.25,17.18 572.5,-12.99 624.75,17.18 677,-12.99 738.25,22.37" },
  { side: "b", points: "738.25,22.37 738.25,93.1 686,123.26 686,183.59 633.75,213.76 633.75,274.09 581.5,304.25 581.5,364.58 529.25,394.75 529.25,455.08 468,490.44" },
  { side: "a", points: "468,490.44 415.75,460.27 363.5,490.44 311.25,460.27 259,490.44 206.75,460.27 154.5,490.44 102.25,460.27 50,490.44 -11.25,455.08" },
  { side: "b", points: "-11.25,455.08 -11.25,384.35 41,354.19 41,293.86 93.25,263.69 93.25,203.36 145.5,173.2 145.5,112.87 197.75,82.7 197.75,22.37" },
];

/**
 * 보드를 `holder` 안에 그립니다. 보드가 아직 없으면(대기 중인 방) 비워 둡니다 —
 * 빈 마름모 윤곽만 떠 있으면 매치가 시작된 것처럼 보입니다.
 */
export function renderBoard(holder, { board, claimed, missions, selected, onSelect } = {}) {
  holder.innerHTML = "";
  if (!board || board.length === 0) return;

  const claimedMap = new Map();
  for (const c of claimed ?? []) claimedMap.set(c.tileId, c);

  const rows = new Map();
  for (const tile of board) {
    if (!rows.has(tile.r)) rows.set(tile.r, []);
    rows.get(tile.r).push(tile);
  }
  const rowKeys = [...rows.keys()].sort((a, b) => a - b);
  for (const k of rowKeys) rows.get(k).sort((a, b) => a.q - b.q);

  const grid = document.createElement("div");
  grid.className = "hexgrid";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "board-bounds");
  svg.setAttribute("viewBox", "-34 -34 795 546");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  for (const b of BOUNDS) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", b.points);
    line.setAttribute("class", b.side);
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(line);
  }
  grid.appendChild(svg);

  // 목업과 같이 행들은 따로 감쌉니다. 경계선 SVG 가 절대 배치라 형제로 두면 첫 행의
  // 겹침 오프셋을 지우는 `:first-child` 가 SVG 쪽에 걸립니다.
  const stack = document.createElement("div");
  grid.appendChild(stack);

  rowKeys.forEach((k, idx) => {
    const row = document.createElement("div");
    row.className = "hrow";
    // 아래 행일수록 왼쪽으로 밀립니다. 5행이면 목업의 2.09 / 1.5675 / 1.045 / 0.5225 / 0.
    const shift = ((rowKeys.length - 1 - idx) * 0.5225).toFixed(4);
    row.style.marginLeft = `calc(var(--w) * ${shift})`;

    for (const tile of rows.get(k)) {
      const claim = claimedMap.get(tile.tileId);
      const color = TILE_COLORS[claim?.side ?? "none"] ?? TILE_COLORS.none;

      const cell = document.createElement("div");
      cell.className = "hcell";
      cell.style.background = selected === tile.tileId ? SELECTED_RING : color.ring;

      const inner = document.createElement("i");
      inner.style.background = color.bg;
      inner.style.color = color.fg;
      inner.textContent = (missions?.get(tile.missionId)?.displayName ?? tile.missionId).trim();

      cell.appendChild(inner);
      if (onSelect) cell.addEventListener("click", () => onSelect(tile.tileId));
      row.appendChild(cell);
    }
    stack.appendChild(row);
  });

  holder.appendChild(grid);
}

/* ---------------------------------------------------------------- 관전 */

/**
 * 관전 UI 를 붙이고 방에 접속합니다. 정리 함수를 돌려줍니다.
 *
 * `L` 은 app.js 의 문구 사전, `lang` 은 시간 표기용입니다.
 */
export function mountSpectator(container, roomCode, L, lang) {
  const s = {
    ws: null,
    roomCode,
    missions: new Map(),
    board: [],
    claimed: [],
    status: "waiting",
    seed: null,
    startedAt: null,
    players: { A: null, B: null },
    selected: null,
    conn: "",
    winner: null,
    log: [],
    tick: null,
  };

  const esc = escapeHtml;
  const nameOf = (side) => s.players[side]?.name ?? "—";
  const eloOf = (side) => (s.players[side]?.elo != null ? `${s.players[side].elo} ELO · ` : "");

  function counts() {
    let a = 0, b = 0;
    for (const c of s.claimed) (c.side === "A" ? a++ : b++);
    return { a, b };
  }

  function clockText() {
    if (!s.startedAt || s.status !== "playing") return "--:--";
    const t = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }

  function selectedInfo() {
    if (!s.selected) return { label: L.pickTile, detail: "", coord: "", owner: "", ownerCls: "" };
    const tile = s.board.find((t) => t.tileId === s.selected);
    if (!tile) return { label: L.pickTile, detail: "", coord: "", owner: "", ownerCls: "" };
    const m = s.missions.get(tile.missionId);
    const claim = s.claimed.find((c) => c.tileId === s.selected);
    return {
      label: m?.displayName ?? tile.missionId,
      detail: tile.difficulty.toUpperCase(),
      coord: tile.tileId,
      owner: claim ? `${claim.side} ${L.claimedVerb.replace("·", "").trim()}` : L.unclaimed,
      ownerCls: claim ? claim.side.toLowerCase() : "",
    };
  }

  function draw() {
    const { a, b } = counts();
    const total = s.board.length || 25;
    const sel = selectedInfo();

    container.innerHTML = `
      <a class="back" href="#/live">${L.backLive}</a>
      <div class="spec">
        <div class="spec-main">
          <div class="spec-head">
            <div class="spec-vs">
              <div class="spec-p">
                <div class="nm"><span class="dot a"></span><span>${esc(nameOf("A"))}</span></div>
                <div class="sub">${eloOf("A")}${L.dirA}</div>
              </div>
              <div class="vs">vs</div>
              <div class="spec-p">
                <div class="nm"><span class="dot b"></span><span>${esc(nameOf("B"))}</span></div>
                <div class="sub">${eloOf("B")}${L.dirB}</div>
              </div>
            </div>
            <div class="spec-clock">
              <b>${clockText()}</b>
              <span>${s.seed != null ? L.seedWord + esc(String(s.seed)) : esc(s.conn)}</span>
            </div>
          </div>

          <div class="board-hold" id="board"></div>

          ${s.winner ? `<div class="winner"><span class="dot" style="background:${s.winner.side === "B" ? "#C77CFA" : "#4A7BFA"}"></span><span>${esc(s.winner.text)}</span></div>` : ""}
        </div>

        <div class="spec-side">
          <div class="spec-sec">
            <div class="spec-k">${L.selTile}</div>
            <div class="sel-name">${esc(sel.label)}</div>
            ${sel.detail ? `<div class="sel-detail">${esc(sel.detail)}</div>` : ""}
            ${sel.coord ? `<div class="sel-chips"><span class="chip">${esc(sel.coord)}</span><span class="chip ${sel.ownerCls}">${esc(sel.owner)}</span></div>` : ""}
          </div>
          <div class="counts">
            <div>
              <div class="spec-k">${L.claimedK}</div>
              <div class="n"><span class="a">${a}</span><span class="s">/</span><span class="b">${b}</span></div>
            </div>
            <div class="prog">
              <div class="spec-k">${L.chainK}</div>
              <div class="bar"><i style="width:${Math.round(((a + b) / total) * 100)}%"></i></div>
              <div class="lbl">${total - a - b} / ${total}</div>
            </div>
          </div>
          <div class="log">
            <div class="spec-k">${L.eventLog}</div>
            <ol>${s.log.map(logRow).join("")}</ol>
          </div>
        </div>
      </div>
    `;

    renderBoard(container.querySelector("#board"), {
      board: s.board,
      claimed: s.claimed,
      missions: s.missions,
      selected: s.selected,
      onSelect: (id) => { s.selected = id; draw(); },
    });
  }

  function logRow(e) {
    const side = e.side.toLowerCase();
    return `
      <li>
        <span class="t">${esc(e.time)}</span>
        <span class="dot ${side}"></span>
        <span class="msg"><span class="who ${side}">${esc(e.who)}</span> ${esc(L.claimedVerb)} <span class="what">${esc(e.label)}</span></span>
      </li>`;
  }

  function pushLog(claim) {
    const m = s.missions.get(claim.missionId);
    s.log.unshift({
      time: new Date(claim.claimedAt).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" }),
      side: claim.side,
      who: s.players[claim.side]?.name ?? claim.side,
      label: m?.displayName ?? claim.missionId,
    });
    if (s.log.length > 40) s.log.pop();
  }

  function handle(msg) {
    switch (msg.type) {
      case "error":
        s.conn = msg.message; draw(); return;
      case "room_state":
        s.roomCode = msg.roomCode;
        s.status = msg.status;
        if (msg.you) s.players[msg.you.side] = msg.you;
        if (msg.opponent) s.players[msg.opponent.side] = msg.opponent;
        draw(); return;
      case "match_start":
        s.status = "playing";
        s.board = msg.board;
        s.claimed = msg.claimed ?? [];
        s.seed = msg.seed;
        s.startedAt = msg.startsAt;
        s.winner = null;
        draw(); return;
      case "tile_claimed":
        s.claimed = s.claimed.filter((c) => c.tileId !== msg.tileId);
        s.claimed.push({ tileId: msg.tileId, side: msg.side, missionId: msg.missionId, claimedAt: msg.claimedAt });
        pushLog(msg);
        draw(); return;
      case "match_end": {
        s.status = "ended";
        const who = msg.winner ? (s.players[msg.winner]?.name ?? msg.winner) : null;
        s.winner = {
          side: msg.winner ?? "A",
          text: who
            ? (lang === "ko" ? `${who} 승리 — 경기 종료 (${msg.reason})` : `${who} wins — match over (${msg.reason})`)
            : (lang === "ko" ? `경기 종료 (${msg.reason})` : `Match over (${msg.reason})`),
        };
        draw(); return;
      }
      default:
        return;
    }
  }

  function connect() {
    s.conn = lang === "ko" ? "연결 중…" : "connecting…";
    const ws = new WebSocket(defaultWsUrl());
    s.ws = ws;
    ws.onopen = () => {
      s.conn = "";
      ws.send(JSON.stringify({ type: "spectate", roomCode: s.roomCode }));
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => { s.conn = lang === "ko" ? "연결 끊김" : "disconnected"; draw(); };
    ws.onerror = () => { s.conn = lang === "ko" ? "연결 오류" : "connection error"; draw(); };
  }

  draw();
  loadMissions()
    .then((m) => { s.missions = m; draw(); connect(); })
    .catch(() => { s.conn = lang === "ko" ? "미션 목록 로드 실패" : "failed to load objectives"; draw(); });

  // 경과 시간만 1초마다 갱신합니다.
  s.tick = setInterval(() => {
    const el = container.querySelector(".spec-clock b");
    if (el) el.textContent = clockText();
  }, 1000);

  return () => {
    if (s.tick) clearInterval(s.tick);
    if (s.ws) { try { s.ws.close(); } catch {} s.ws = null; }
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export { loadMissions, escapeHtml };
