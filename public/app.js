// Minecraft Hex — 웹 UI.
//
// 화면 구성과 문구는 목업(Minecraft Hex.dc.html)을 그대로 옮긴 것이고, 값만 실제
// API 에서 옵니다. 목업이 자리표시자로 채워 둔 숫자(누적 판수, 평균 시간 등)는
// 지어내지 않고 실제로 계산되는 것만 보여줍니다.

import { mountSpectator, mountReplay, escapeHtml, mmss } from "/board.js";

const app = document.getElementById("app");

/* ------------------------------------------------------------------ 상태 */

const state = {
  page: "home",
  lang: localStorage.getItem("mchx.lang") || "ko",
  spectate: null,
  os: detectOs(),
  codeInput: "",
  codeError: false,
  rooms: [],
  replays: [],
  replaysTotal: null,
  ranks: [],
  stats: { pool: "—", players: "—", matches: "—" },
};

function detectOs() {
  const p = navigator.platform || "";
  if (/Mac/i.test(p)) return "mac";
  if (/Linux/i.test(p) && !/Android/i.test(navigator.userAgent)) return "linux";
  return "win";
}

/* ------------------------------------------------------------------- 문구 */

const T = {
  ko: {
    nav1: "소개", nav3: "중계", nav4: "랭킹", nav5: "설치", getMod: "모드 받기",
    eyebrow: "패브릭 모드 · 마인크래프트 26.1.2",
    h1a: "목표 25개를 두고", h1b: "벌이는 1대1 경주.",
    heroP: "헥스는 마인크래프트 목표 25개를 5×5 육각 판에 깔고, 두 사람을 같은 시드의 월드에 떨어뜨립니다. 칸에 적힌 목표를 깨면 그 칸이 내 것이 되고, 자기 변에서 반대편 변까지 칸이 끊김 없이 이어지는 순간 판이 끝납니다.",
    ctaWatch: "중계 보러 가기", ctaDl: "모드 내려받기",
    statPool: "전체 목표", statPlayers: "등록 플레이어", statPlayed: "누적 판수",
    rulesKicker: "규칙", rulesH: "목표 25개짜리 판 하나, 먼저 잇는 쪽이 이깁니다.",
    r1: "64개 목표 중 25개가 뽑혀 5×5 육각 판에 깔립니다. 두 사람 모두 같은 판, 같은 시드로 시작합니다.",
    r2: "목표를 깨면 그 칸이 내 색으로 넘어옵니다. 턴 순서도 없고, 한 번 넘어간 칸은 다시 뺏기지 않습니다.",
    r3: "한쪽은 위아래, 다른 쪽은 좌우를 잇습니다. 자기 두 변이 끊김 없이 연결되는 순간 판이 끝납니다.",
    rulesNote: "목표는 매 판 새로 뽑히기 때문에 같은 판이 두 번 나오는 일은 없습니다. 판이 끝나고 남는 건 레이팅뿐입니다.",
    kLive: "중계", liveH: "진행 중인 판", updated: "방금 갱신", noLive: "지금 열려 있는 판이 없습니다.",
    kPrivate: "비공개 경기", codePh: "코드", codeBtn: "보기",
    codeNote: "비공개 판은 목록에 뜨지 않습니다. 받은 코드를 입력하세요.",
    codeErr: "그 코드로 열린 판이 없습니다.",
    backLive: "← 중계 목록",
    tagRanked: "랭크", tagCasual: "일반", tagWaiting: "대기",
    watch: "보기 →", waiting: "대기 중",
    selTile: "선택한 칸", claimedK: "점령 현황", chainK: "남은 칸", eventLog: "이벤트 로그",
    claimedVerb: "점령 ·", unclaimed: "빈 칸", pickTile: "칸을 누르면 목표가 보입니다.",
    roomWord: "방 ", dirA: "위 ↕ 아래", dirB: "좌 ↔ 우",
    nav6: "리플레이", kReplays: "기록", replaysH: "지난 경기 다시 보기",
    replaysNote: "끝난 판은 처음부터 되감아 볼 수 있습니다. 한 수씩 넘기거나 재생을 눌러 두면 순서대로 놓입니다.",
    noReplays: "아직 끝난 판이 없습니다.",
    backReplays: "← 지난 경기 목록", openReplay: "다시 보기 →",
    play: "재생", pause: "일시정지", loading: "불러오는 중…",
    replayGone: "그 경기 기록을 찾을 수 없습니다.", replayFailed: "기록을 불러오지 못했습니다.",
    drawTag: "무승부", winTag: "승",
    kSeason: "랭킹", ranksH: "레이팅 순위표", noRanks: "아직 기록된 플레이어가 없습니다.",
    thRank: "순위", thPlayer: "플레이어", thWl: "전적", thPct: "승률",
    kInstall: "설치", dlH: "클라이언트 모드 내려받기",
    dlP: "모드는 직접 플레이할 때만 필요합니다. 중계는 아무것도 깔지 않아도 볼 수 있습니다.",
    relLine: "패브릭 · 마인크래프트 26.1.2 · 아직 공개 배포 전입니다",
    dlJar: "저장소 보기", changelog: "커밋 기록",
    requires: "필요한 것", notRequired: "필요 없는 것",
    nr1: "따로 돌릴 서버", nr2: "별도 계정 — 마인크래프트 계정으로 인증합니다", nr3: "중계용 설치",
    footer: "MINECRAFT HEX · 유저 제작 프로젝트 · MOJANG 과 무관합니다", source: "소스",
    stepsTitle: "설치 순서",
  },
  en: {
    nav1: "Overview", nav3: "Live", nav4: "Ranks", nav5: "Install", getMod: "Get the mod",
    eyebrow: "FABRIC CLIENT · MINECRAFT 26.1.2",
    h1a: "A 1v1 race across", h1b: "twenty-five objectives.",
    heroP: "Hex deals twenty-five Minecraft objectives onto a 5×5 hex board and drops both players into the same world seed. Finish what a tile says and the tile is yours. The match ends the moment one player's tiles run unbroken from their own edge to the far side.",
    ctaWatch: "Watch a live match", ctaDl: "Get the client mod",
    statPool: "OBJECTIVE POOL", statPlayers: "RATED PLAYERS", statPlayed: "MATCHES PLAYED",
    rulesKicker: "THE RULES", rulesH: "Twenty-five objectives, one board, two edges to link.",
    r1: "Twenty-five objectives are drawn from a pool of 64 and dealt onto a 5×5 hex board. Both players get the same board and the same world seed.",
    r2: "Finishing an objective claims its tile. There is no turn order, nothing to spend, and a tile cannot be taken back once it is claimed.",
    r3: "One player links top to bottom, the other left to right. First unbroken run of tiles between your own two edges ends the match.",
    rulesNote: "Objectives are drawn fresh for every match, so the same board never comes up twice. Nothing carries over between games except your rating.",
    kLive: "LIVE", liveH: "Live boards", updated: "just updated", noLive: "No boards are running right now.",
    kPrivate: "PRIVATE MATCH", codePh: "CODE", codeBtn: "Watch",
    codeNote: "Private boards are never listed. Enter the code the players gave you.",
    codeErr: "No live board is running on that code.",
    backLive: "← ALL LIVE MATCHES",
    tagRanked: "RANKED", tagCasual: "CASUAL", tagWaiting: "WAITING",
    watch: "Watch →", waiting: "waiting",
    selTile: "SELECTED TILE", claimedK: "CLAIMED", chainK: "TILES LEFT", eventLog: "EVENT LOG",
    claimedVerb: "claimed", unclaimed: "unclaimed", pickTile: "Pick a tile to read its objective.",
    roomWord: "ROOM ", dirA: "top ↕ bottom", dirB: "left ↔ right",
    nav6: "Replays", kReplays: "ARCHIVE", replaysH: "Watch a finished match",
    replaysNote: "Every finished board can be replayed from the first claim. Step through it, or hit play and let it deal itself out.",
    noReplays: "No finished matches yet.",
    backReplays: "← ALL REPLAYS", openReplay: "Replay →",
    play: "Play", pause: "Pause", loading: "Loading…",
    replayGone: "No record of that match.", replayFailed: "Could not load that replay.",
    drawTag: "DRAW", winTag: "WON",
    kSeason: "LADDER", ranksH: "Rated leaderboard", noRanks: "No rated players yet.",
    thRank: "RANK", thPlayer: "PLAYER", thWl: "W / L", thPct: "WIN %",
    kInstall: "INSTALL", dlH: "Get the client mod",
    dlP: "You only need the mod to play. Watching boards on this site needs nothing installed.",
    relLine: "Fabric · Minecraft 26.1.2 · not published yet",
    dlJar: "View repository", changelog: "Commits",
    requires: "REQUIRES", notRequired: "NOT REQUIRED",
    nr1: "A server to host", nr2: "A separate account — your Minecraft account signs you in", nr3: "Anything installed to watch",
    stepsTitle: "INSTALL STEPS",
    footer: "MINECRAFT HEX · COMMUNITY PROJECT · NOT AFFILIATED WITH MOJANG", source: "Source",
  },
};
const t = () => T[state.lang];

const OS_STEPS = {
  ko: {
    win: [
      { n: "01", title: "패브릭 로더 설치", body: "패브릭 인스톨러를 실행하고 26.1.2 를 고르면 런처에 프로필이 하나 새로 생깁니다." },
      { n: "02", title: "의존 모드 두 개 넣기", body: "Fabric API 와 Fabric Language Kotlin 을 mods 폴더에 넣습니다. 둘 중 하나라도 없으면 모드가 로드되지 않습니다.", cmd: "%appdata%\\.minecraft\\mods" },
      { n: "03", title: "mchx 넣기", body: "같은 폴더에 mchx jar 을 추가합니다. 타이틀 화면에 MCHX 로비 버튼이 생기면 정상입니다." },
      { n: "04", title: "접속할 서버 바꾸기 (선택)", body: "기본값은 공식 서버입니다. 직접 띄운 서버를 쓸 때만 고치면 됩니다.", cmd: '{"serverUrl":"ws://내서버:8787/ws"}' },
    ],
    mac: [
      { n: "01", title: "패브릭 로더 설치", body: "패브릭 인스톨러를 실행하고 26.1.2 를 고릅니다." },
      { n: "02", title: "의존 모드 두 개 넣기", body: "Fabric API 와 Fabric Language Kotlin 을 mods 폴더에 넣습니다.", cmd: "~/Library/Application Support/minecraft/mods" },
      { n: "03", title: "mchx 넣기", body: "같은 폴더에 추가합니다. 실행이 막히면 우클릭 후 열기를 한 번만 해 주면 됩니다." },
      { n: "04", title: "접속할 서버 바꾸기 (선택)", body: "config/mchx.json 을 고칩니다.", cmd: '{"serverUrl":"ws://내서버:8787/ws"}' },
    ],
    linux: [
      { n: "01", title: "패브릭 로더 설치", body: "터미널로 깔아도 됩니다. 버전만 명시해 주세요.", cmd: "java -jar fabric-installer.jar client -mcversion 26.1.2" },
      { n: "02", title: "의존 모드 두 개 넣기", body: "Fabric API 와 Fabric Language Kotlin 을 mods 폴더에 넣습니다.", cmd: "~/.minecraft/mods" },
      { n: "03", title: "mchx 넣기", body: "같은 폴더에 mchx jar 을 추가합니다." },
      { n: "04", title: "접속할 서버 바꾸기 (선택)", body: "config/mchx.json 을 고칩니다.", cmd: '{"serverUrl":"ws://내서버:8787/ws"}' },
    ],
  },
  en: {
    win: [
      { n: "01", title: "Install Fabric Loader", body: "Run the Fabric installer and pick Minecraft 26.1.2. It writes a new profile into your launcher." },
      { n: "02", title: "Drop in both dependencies", body: "Fabric API and Fabric Language Kotlin both go in the mods folder. The mod will not load without them.", cmd: "%appdata%\\.minecraft\\mods" },
      { n: "03", title: "Add mchx", body: "Put the mchx jar in the same folder. You'll see an MCHX button on the title screen." },
      { n: "04", title: "Point at another server (optional)", body: "Only needed if you run your own.", cmd: '{"serverUrl":"ws://your-host:8787/ws"}' },
    ],
    mac: [
      { n: "01", title: "Install Fabric Loader", body: "Run the Fabric installer and pick Minecraft 26.1.2." },
      { n: "02", title: "Drop in both dependencies", body: "Fabric API and Fabric Language Kotlin both go in the mods folder.", cmd: "~/Library/Application Support/minecraft/mods" },
      { n: "03", title: "Add mchx", body: "Same folder. If Gatekeeper blocks it, right-click and Open once." },
      { n: "04", title: "Point at another server (optional)", body: "Edit config/mchx.json.", cmd: '{"serverUrl":"ws://your-host:8787/ws"}' },
    ],
    linux: [
      { n: "01", title: "Install Fabric Loader", body: "A headless install works fine. Pass the version explicitly.", cmd: "java -jar fabric-installer.jar client -mcversion 26.1.2" },
      { n: "02", title: "Drop in both dependencies", body: "Fabric API and Fabric Language Kotlin both go in the mods folder.", cmd: "~/.minecraft/mods" },
      { n: "03", title: "Add mchx", body: "Put the mchx jar in the same folder." },
      { n: "04", title: "Point at another server (optional)", body: "Edit config/mchx.json.", cmd: '{"serverUrl":"ws://your-host:8787/ws"}' },
    ],
  },
};

/* ------------------------------------------------------------------ 유틸 */

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function clock(fromMs) {
  if (!fromMs) return "--:--";
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function pct(n, total) {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

/* ------------------------------------------------------- 헤더 / 푸터 / 셸 */

function header() {
  const L = t();
  const on = (p) => (state.page === p ? " on" : "");
  const live = state.rooms.length;
  const label = state.lang === "ko"
    ? (live ? `${live}판 중계 중` : "중계 중인 판 없음")
    : (live ? `${live} LIVE NOW` : "NOTHING LIVE");
  return `
    <div class="hdr">
      <a class="hdr-brand" href="#/">
        <span class="hdr-logo"></span>
        <span class="hdr-word">HEX</span>
        <span class="hdr-sub">MINECRAFT</span>
      </a>
      <nav class="hdr-nav">
        <a href="#/"${on("home") ? ' class="on"' : ""}>${L.nav1}</a>
        <a href="#/live"${on("live") || on("spectate") ? ' class="on"' : ""}>${L.nav3}</a>
        <a href="#/replays"${on("replays") || on("replay") ? ' class="on"' : ""}>${L.nav6}</a>
        <a href="#/ranks"${on("ranks") ? ' class="on"' : ""}>${L.nav4}</a>
        <a href="#/install"${on("install") ? ' class="on"' : ""}>${L.nav5}</a>
      </nav>
      <div class="hdr-right">
        <div class="hdr-live${live ? " on" : ""}"><i></i><span>${label}</span></div>
        <div class="lang">
          <button data-lang="en" class="${state.lang === "en" ? "on" : ""}">EN</button>
          <button data-lang="ko" class="${state.lang === "ko" ? "on" : ""}">한국어</button>
        </div>
        <a class="cta" href="#/install">${L.getMod}</a>
      </div>
    </div>
  `;
}

function footer() {
  const L = t();
  return `
    <div class="ftr">
      <span class="mark"></span>
      <span class="txt">${L.footer}</span>
      <span class="links">
        <a href="https://github.com/pjw070823/mchx" target="_blank" rel="noopener">${L.source}</a>
        <a href="/api/missions" target="_blank" rel="noopener">API</a>
      </span>
    </div>
  `;
}

function render(body) {
  app.innerHTML = header() + body + footer();
  app.querySelectorAll(".lang button").forEach((b) =>
    b.addEventListener("click", () => {
      state.lang = b.dataset.lang;
      localStorage.setItem("mchx.lang", state.lang);
      route();
    }),
  );
}

/* -------------------------------------------------------------- 화면: 소개 */

function heroHexes() {
  // 장식용 격자. 파랑이 세로로, 보라가 가로로 이어지는 모습을 미리 보여줍니다.
  const own = { 6: "a", 12: "a", 13: "a", 7: "b", 2: "b", 18: "b", 19: "b" };
  let rows = "";
  for (let r = 0; r < 5; r++) {
    let cells = "";
    for (let c = 0; c < 5; c++) {
      const o = own[r * 5 + c];
      const ring = o === "a" ? "#4A7BFA" : o === "b" ? "#C77CFA" : "#1E232B";
      const bg = o === "a" ? "#16224a" : o === "b" ? "#2a1c45" : "#0E1116";
      cells += `<div class="hcell" style="background:${ring}"><i style="background:${bg}"></i></div>`;
    }
    rows += `<div class="hrow" style="margin-left:calc((var(--w) + 3px) * ${(4 - r) / 2})">${cells}</div>`;
  }
  return `<div class="hexgrid">${rows}</div>`;
}

function pageHome() {
  const L = t();
  const s = state.stats;
  return `
    <div class="hero">
      <div>
        <div class="hero-eyebrow">${L.eyebrow}</div>
        <h1>${L.h1a}<br /><span>${L.h1b}</span></h1>
        <p>${L.heroP}</p>
        <div class="hero-btns">
          <a class="cta cta-lg" href="#/live">${L.ctaWatch}</a>
          <a class="cta-ghost" href="#/install">${L.ctaDl}</a>
        </div>
        <div class="hero-stats">
          <div><b>${s.pool}</b><span>${L.statPool}</span></div>
          <div><b>${s.matches}</b><span>${L.statPlayed}</span></div>
          <div><b>${s.players}</b><span>${L.statPlayers}</span></div>
        </div>
      </div>
      <div class="hero-art">${heroHexes()}</div>
    </div>

    <div class="rules">
      <div>
        <div class="kick">${L.rulesKicker}</div>
        <h2>${L.rulesH}</h2>
      </div>
      <div class="rules-body">
        <div class="rule"><i>01</i><p>${L.r1}</p></div>
        <div class="rule"><i>02</i><p>${L.r2}</p></div>
        <div class="rule"><i>03</i><p>${L.r3}</p></div>
        <div class="rules-note">${L.rulesNote}</div>
      </div>
    </div>
  `;
}

async function loadStats() {
  const [m, mm, lb] = await Promise.all([
    api("/api/missions").catch(() => null),
    api("/api/matches?limit=1").catch(() => null),
    api("/api/leaderboard?limit=200").catch(() => null),
  ]);
  state.stats = {
    pool: m ? String(m.missions.length) : "—",
    matches: mm && mm.total != null ? String(mm.total) : "—",
    players: lb ? String(lb.players.length) : "—",
  };
}

/* -------------------------------------------------------------- 화면: 중계 */

function matchRow(room) {
  const L = t();
  const a = (room.players ?? []).find((p) => p.side === "A");
  const b = (room.players ?? []).find((p) => p.side === "B");
  const playing = room.status === "playing";
  const size = room.boardSize || 25;
  const tag = !playing ? L.tagWaiting : room.settings?.rated ? L.tagRanked : L.tagCasual;
  const tagCls = !playing ? "private" : room.settings?.rated ? "ranked" : "private";

  const side = (p, cls) => p
    ? `<div class="row-p"><span class="dot ${cls}"></span><span class="nm">${escapeHtml(p.name ?? "")}</span><span class="el">${p.elo ?? "—"}</span></div>`
    : `<div class="row-p"><span class="dot ${cls}" style="opacity:.35"></span><span class="el">${L.waiting}</span></div>`;

  return `
    <a class="row" href="#/board/${encodeURIComponent(room.code)}">
      <div class="row-tag ${tagCls}">${tag}</div>
      <div class="row-players">
        ${side(a, "a")}
        <span class="row-vs">vs</span>
        ${side(b, "b")}
      </div>
      <div class="row-prog">
        <div class="row-bar">
          <div class="a" style="width:${pct(room.claimedA ?? 0, size)}"></div>
          <div class="b" style="width:${pct(room.claimedB ?? 0, size)}"></div>
        </div>
        <div class="row-tiles">${room.claimedA ?? 0}–${room.claimedB ?? 0} · ${size}${state.lang === "ko" ? "칸" : " tiles"}</div>
      </div>
      <div class="row-clock">${playing ? clock(room.startedAt) : "--:--"}</div>
      <div class="row-watch">${L.watch}</div>
    </a>
  `;
}

function pageLive() {
  const L = t();
  const rooms = state.rooms;
  return `
    <div class="wrap">
      <div class="live-top">
        <div>
          <div class="kick live-kick"><span>${L.kLive}</span><span class="bar"></span><span class="upd">${L.updated}</span></div>
          <h2 class="h-lg">${L.liveH}</h2>
        </div>
        <div style="flex:0 1 auto;min-width:0">
          <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.kPrivate}</div>
          <form class="code-row" id="codeForm">
            <input class="code-in${state.codeError ? " bad" : ""}" id="codeIn" maxlength="4"
                   placeholder="${L.codePh}" autocomplete="off" value="${escapeHtml(state.codeInput)}" />
            <button class="code-btn" type="submit">${L.codeBtn}</button>
          </form>
          <div class="code-note${state.codeError ? " bad" : ""}">${state.codeError ? L.codeErr : L.codeNote}</div>
        </div>
      </div>
      ${rooms.length
        ? `<div class="rows">${rooms.map(matchRow).join("")}</div>`
        : `<div class="rows"><div class="row" style="cursor:default"><div class="state" style="width:100%">${L.noLive}</div></div></div>`}
    </div>
  `;
}

function wireLive() {
  const form = document.getElementById("codeForm");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = (document.getElementById("codeIn").value || "").trim().toUpperCase();
    if (code.length !== 4) return;
    state.codeInput = code;
    // 없는 코드로 보내면 관전 화면이 빈 채로 남으므로 미리 확인합니다.
    const exists = state.rooms.some((r) => r.code === code);
    if (!exists) {
      try {
        const { rooms } = await api("/api/rooms");
        state.rooms = rooms ?? [];
      } catch { /* 무시 */ }
    }
    if (state.rooms.some((r) => r.code === code)) {
      state.codeError = false;
      location.hash = `#/board/${code}`;
    } else {
      state.codeError = true;
      route();
    }
  });
}

/* ---------------------------------------------------------- 화면: 리플레이 */

function replayRow(m) {
  const L = t();
  const size = m.boardSize || 25;
  const a = m.players?.A ?? {};
  const b = m.players?.B ?? {};
  const tag = m.rated ? L.tagRanked : L.tagCasual;
  const dur = m.startedAt && m.endedAt ? mmss(m.endedAt - m.startedAt) : "--:--";

  // 승자 쪽 이름에 점을 채워 표시합니다. 목록만 보고도 결과를 알 수 있어야 합니다.
  const side = (p, cls, won) => `
    <div class="row-p">
      <span class="dot ${cls}"${won ? "" : ' style="opacity:.35"'}></span>
      <span class="nm">${escapeHtml(p.name ?? "—")}</span>
      <span class="el">${p.elo ?? "—"}</span>
    </div>`;

  return `
    <a class="row" href="#/replay/${m.id}">
      <div class="row-tag ${m.rated ? "ranked" : "private"}">${tag}</div>
      <div class="row-players">
        ${side(a, "a", m.winnerSide === "A")}
        <span class="row-vs">vs</span>
        ${side(b, "b", m.winnerSide === "B")}
      </div>
      <div class="row-prog">
        <div class="row-bar">
          <div class="a" style="width:${pct(m.claimedA ?? 0, size)}"></div>
          <div class="b" style="width:${pct(m.claimedB ?? 0, size)}"></div>
        </div>
        <div class="row-tiles">${m.claimedA ?? 0}–${m.claimedB ?? 0} · ${size}${state.lang === "ko" ? "칸" : " tiles"}</div>
      </div>
      <div class="row-clock">${dur}</div>
      <div class="row-watch">${L.openReplay}</div>
    </a>
  `;
}

function totalLine() {
  const n = state.replaysTotal;
  if (n == null) return "—";
  return state.lang === "ko" ? `누적 ${n}판` : `${n} played`;
}

function pageReplays() {
  const L = t();
  const rows = state.replays;
  return `
    <div class="wrap">
      <div class="live-top">
        <div>
          <div class="kick live-kick"><span>${L.kReplays}</span><span class="bar"></span><span class="upd">${totalLine()}</span></div>
          <h2 class="h-lg">${L.replaysH}</h2>
        </div>
        <div style="flex:0 1 380px;min-width:0">
          <div class="code-note">${L.replaysNote}</div>
        </div>
      </div>
      ${rows.length
        ? `<div class="rows">${rows.map(replayRow).join("")}</div>`
        : `<div class="rows"><div class="row" style="cursor:default"><div class="state" style="width:100%">${L.noReplays}</div></div></div>`}
    </div>
  `;
}

/* -------------------------------------------------------------- 화면: 랭킹 */

function pageRanks() {
  const L = t();
  const rows = state.ranks;
  if (!rows.length) {
    return `<div class="wrap wrap-narrow"><div class="kick">${L.kSeason}</div><h2 class="h-lg" style="margin-top:12px">${L.ranksH}</h2><div class="state">${L.noRanks}</div></div>`;
  }
  return `
    <div class="wrap wrap-narrow">
      <div class="kick">${L.kSeason}</div>
      <h2 class="h-lg" style="margin-top:12px">${L.ranksH}</h2>
      <div class="rank-head">
        <div>${L.thRank}</div><div>${L.thPlayer}</div>
        <div class="r">ELO</div><div class="r">${L.thWl}</div><div class="r c-pct">${L.thPct}</div>
      </div>
      ${rows.map((p, i) => {
        const total = (p.wins ?? 0) + (p.losses ?? 0) + (p.draws ?? 0);
        const wp = total ? `${Math.round(((p.wins ?? 0) / total) * 100)}%` : "—";
        const top = i < 3 ? ` top${i + 1}` : "";
        return `
          <div class="rank-row${top}">
            <div class="rank-n">${String(i + 1).padStart(2, "0")}</div>
            <div class="rank-p"><span class="dot"></span><span>${escapeHtml(p.name ?? "")}</span></div>
            <div class="rank-elo">${p.elo ?? "—"}</div>
            <div class="rank-num">${p.wins ?? 0} / ${p.losses ?? 0}</div>
            <div class="rank-num c-pct">${wp}</div>
          </div>`;
      }).join("")}
    </div>
  `;
}

/* -------------------------------------------------------------- 화면: 설치 */

function pageInstall() {
  const L = t();
  const steps = OS_STEPS[state.lang][state.os];
  const tab = (id, label) => `<button data-os="${id}" class="${state.os === id ? "on" : ""}">${label}</button>`;
  return `
    <div class="wrap wrap-narrow">
      <div class="kick">${L.kInstall}</div>
      <h2 class="h-lg" style="margin-top:12px">${L.dlH}</h2>
      <p class="dl-hero">${L.dlP}</p>

      <div class="dl-card">
        <div class="rel">
          <b>mchx 0.1.1</b>
          <div class="meta">${L.relLine}</div>
        </div>
        <div class="dl-btns">
          <a class="cta cta-lg" href="https://github.com/pjw070823/mchx" target="_blank" rel="noopener">${L.dlJar}</a>
          <a class="cta-ghost" href="https://github.com/pjw070823/mchx/commits/master" target="_blank" rel="noopener">${L.changelog}</a>
        </div>
      </div>

      <div class="os-tabs">${tab("win", "WINDOWS")}${tab("mac", "MACOS")}${tab("linux", "LINUX")}</div>

      <div class="steps">
        <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.stepsTitle}</div>
        <div class="steps-list">
          ${steps.map((s) => `
            <div class="step">
              <div class="n">${s.n}</div>
              <div class="bd">
                <div class="ti">${escapeHtml(s.title)}</div>
                <div class="tx">${escapeHtml(s.body)}</div>
                ${s.cmd ? `<div class="cmd">${escapeHtml(s.cmd)}</div>` : ""}
              </div>
            </div>`).join("")}
        </div>
      </div>

      <div class="req">
        <div>
          <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.requires}</div>
          <div class="bd">Minecraft 26.1.2<br />Fabric Loader 0.19+<br />Fabric API<br />Fabric Language Kotlin 1.13+</div>
        </div>
        <div>
          <div class="kick" style="font-size:10.5px;letter-spacing:.16em">${L.notRequired}</div>
          <div class="bd">${L.nr1}<br />${L.nr2}<br />${L.nr3}</div>
        </div>
      </div>
    </div>
  `;
}

function wireInstall() {
  document.querySelectorAll(".os-tabs button").forEach((b) =>
    b.addEventListener("click", () => { state.os = b.dataset.os; route(); }),
  );
}

/* ------------------------------------------------------------------ 라우터 */

let cleanup = null;

async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }

  const hash = location.hash || "#/";
  const board = hash.match(/^#\/board\/([A-Za-z0-9]{4})$/);

  if (board) {
    state.page = "spectate";
    render(`<div class="wrap wrap-wide" id="spec"></div>`);
    cleanup = mountSpectator(document.getElementById("spec"), board[1].toUpperCase(), t(), state.lang);
    return;
  }

  const replay = hash.match(/^#\/replay\/(\d+)$/);
  if (replay) {
    state.page = "replay";
    render(`<div class="wrap wrap-wide" id="rep"></div>`);
    cleanup = mountReplay(document.getElementById("rep"), replay[1], t(), state.lang);
    return;
  }

  if (hash === "#/replays") {
    state.page = "replays";
    render(pageReplays());
    try {
      const { replays, total } = await api("/api/replays?limit=50");
      state.replays = replays ?? [];
      state.replaysTotal = total ?? null;
    } catch { state.replays = []; }
    render(pageReplays());
    return;
  }

  if (hash === "#/live") {
    state.page = "live";
    render(pageLive());
    try {
      const { rooms } = await api("/api/rooms");
      state.rooms = rooms ?? [];
    } catch { state.rooms = []; }
    render(pageLive());
    wireLive();
    return;
  }

  if (hash === "#/ranks") {
    state.page = "ranks";
    render(pageRanks());
    try {
      const { players } = await api("/api/leaderboard?limit=100");
      state.ranks = players ?? [];
    } catch { state.ranks = []; }
    render(pageRanks());
    return;
  }

  if (hash === "#/install") {
    state.page = "install";
    render(pageInstall());
    wireInstall();
    return;
  }

  state.page = "home";
  render(pageHome());
  await loadStats();
  render(pageHome());
}

/** 헤더의 중계 표시등만 주기적으로 갱신합니다. */
async function pollRooms() {
  try {
    const { rooms } = await api("/api/rooms");
    const changed = (rooms ?? []).length !== state.rooms.length;
    state.rooms = rooms ?? [];
    const pill = document.querySelector(".hdr-live");
    if (pill) {
      pill.classList.toggle("on", state.rooms.length > 0);
      const n = state.rooms.length;
      pill.querySelector("span").textContent = state.lang === "ko"
        ? (n ? `${n}판 중계 중` : "중계 중인 판 없음")
        : (n ? `${n} LIVE NOW` : "NOTHING LIVE");
    }
    if (changed && state.page === "live") { render(pageLive()); wireLive(); }
  } catch { /* 표시등은 있으면 좋은 것 */ }
}

window.addEventListener("hashchange", route);
route();
pollRooms();
setInterval(pollRooms, 15_000);
