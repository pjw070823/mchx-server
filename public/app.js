// Minecraft Hex — SPA router & view renderers.
// Hash-based routing keeps everything as a single static page; views fetch
// against the existing REST endpoints under /api/* (served on both 8787 and 80).

import { mountSpectator, renderBoardSvg, loadMissions, escapeHtml } from "/board.js";

const view = document.getElementById("view");

// Skin avatar / body — mc-heads.net handles UUID → texture without API keys.
function avatarUrl(uuid, size = 64) {
  if (!uuid) return `https://mc-heads.net/avatar/MHF_Steve/${size}`;
  return `https://mc-heads.net/avatar/${uuid}/${size}`;
}
function bodyUrl(uuid, size = 128) {
  if (!uuid) return `https://mc-heads.net/body/MHF_Steve/${size}`;
  return `https://mc-heads.net/body/${uuid}/${size}`;
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("ko-KR", { hour12: false });
}
function fmtDuration(start, end) {
  if (!start || !end) return "—";
  const ms = end - start;
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}분 ${s}초`;
}
function winrate(w, l, d) {
  const total = (w ?? 0) + (l ?? 0) + (d ?? 0);
  if (total === 0) return "—";
  return `${Math.round(((w ?? 0) / total) * 100)}%`;
}
function statusBadge(status) {
  const labels = {
    waiting: "대기", starting: "시작 중", playing: "진행 중", ended: "종료",
  };
  return `<span class="status-badge status-${status}">${labels[status] ?? status}</span>`;
}

// ---- fetch helpers ----------------------------------------------------------

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ---- view: loading / error shells ------------------------------------------

function showLoading() {
  view.innerHTML = `<div class="loading">불러오는 중…</div>`;
}
function showError(err) {
  view.innerHTML = `<div class="error-pane">오류: ${escapeHtml(err?.message ?? String(err))}</div>`;
}

// ---- view: HOME -------------------------------------------------------------

async function renderHome() {
  view.innerHTML = `
    <section class="page page-home">
      <div class="hero">
        <h1>관전하기</h1>
        <p class="sub">진행 중인 매치를 관전하거나, 방 코드로 직접 접속하세요.</p>
        <form id="spec-form" class="spec-form">
          <input id="spec-code" maxlength="4" placeholder="방 코드 (예: AB23)"
                 autocomplete="off" />
          <button type="submit">관전</button>
        </form>
      </div>

      <div class="section-header">
        <h2>활성 방 목록</h2>
        <button id="refresh-rooms" class="ghost-btn">새로고침</button>
      </div>
      <div id="rooms-list" class="rooms-list">불러오는 중…</div>
    </section>
  `;

  view.querySelector("#spec-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = view.querySelector("#spec-code").value.trim().toUpperCase();
    if (code.length !== 4) return;
    location.hash = `#/board/${code}`;
  });

  view.querySelector("#refresh-rooms").addEventListener("click", refreshRooms);

  await refreshRooms();

  async function refreshRooms() {
    const target = view.querySelector("#rooms-list");
    if (!target) return;
    target.textContent = "불러오는 중…";
    try {
      const { rooms } = await api("/api/rooms");
      if (!rooms?.length) {
        target.innerHTML = `<div class="empty">현재 활성화된 방이 없습니다.</div>`;
        return;
      }
      target.innerHTML = rooms.map(roomCard).join("");
    } catch (err) {
      target.innerHTML = `<div class="error-pane">방 목록을 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function roomCard(room) {
  const ratedTag = room.settings?.rated ? `<span class="tag tag-rated">랭크</span>` : "";
  const players = (room.players ?? []).map((p) => {
    const sideCls = p.side === "A" ? "side-a" : "side-b";
    return `
      <div class="rcard-player ${sideCls}">
        <img src="${avatarUrl(p.uuid, 32)}" alt="" class="avatar-32" loading="lazy" />
        <div class="rcard-pname">
          <span class="name">${escapeHtml(p.name)}</span>
          <span class="sub">${p.side} · ELO ${p.elo ?? "—"}${p.isHost ? " · 방장" : ""}</span>
        </div>
      </div>
    `;
  }).join("");
  const empty = (room.players?.length ?? 0) < room.capacity ?
    `<div class="rcard-player empty-slot">빈 자리</div>` : "";
  return `
    <a class="room-card" href="#/board/${room.code}">
      <div class="rcard-head">
        <span class="rcard-code">${room.code}</span>
        ${statusBadge(room.status)}
        ${ratedTag}
      </div>
      <div class="rcard-players">
        ${players}
        ${empty}
      </div>
      <div class="rcard-spec">관전 →</div>
    </a>
  `;
}

// ---- view: LEADERBOARD ------------------------------------------------------

async function renderLeaderboard() {
  showLoading();
  try {
    const { players } = await api("/api/leaderboard?limit=100");
    view.innerHTML = `
      <section class="page page-leaderboard">
        <div class="section-header">
          <h1>리더보드</h1>
          <span class="sub">상위 ${players.length}명</span>
        </div>
        ${players.length === 0
          ? `<div class="empty">아직 기록된 플레이어가 없습니다.</div>`
          : `<table class="data-table">
              <thead>
                <tr>
                  <th class="rank">#</th>
                  <th>플레이어</th>
                  <th class="num">ELO</th>
                  <th class="num">전적</th>
                  <th class="num">승률</th>
                </tr>
              </thead>
              <tbody>
                ${players.map((p, i) => `
                  <tr>
                    <td class="rank">${i + 1}</td>
                    <td>
                      <a class="player-link" href="#/players/${encodeURIComponent(p.uuid)}">
                        <img src="${avatarUrl(p.uuid, 28)}" alt="" class="avatar-28" loading="lazy" />
                        <span>${escapeHtml(p.name)}</span>
                      </a>
                    </td>
                    <td class="num elo">${p.elo}</td>
                    <td class="num">${p.wins}승 ${p.losses}패 ${p.draws}무</td>
                    <td class="num">${winrate(p.wins, p.losses, p.draws)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>`}
      </section>
    `;
  } catch (err) {
    showError(err);
  }
}

// ---- view: MATCHES LIST -----------------------------------------------------

async function renderMatchesList() {
  const params = new URLSearchParams((location.hash.split("?")[1] ?? ""));
  const player = params.get("player") ?? "";
  const offset = Math.max(0, Number(params.get("offset") ?? 0));
  const LIMIT = 20;

  view.innerHTML = `
    <section class="page page-matches">
      <div class="section-header">
        <h1>경기 기록</h1>
      </div>
      <form id="matches-search" class="search-form">
        <input id="match-q" placeholder="플레이어 이름으로 검색" value="${escapeHtml(player)}" />
        <button type="submit">검색</button>
        ${player ? `<a class="ghost-btn" href="#/matches">전체 보기</a>` : ""}
      </form>
      <div id="matches-body">불러오는 중…</div>
    </section>
  `;

  view.querySelector("#matches-search").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = view.querySelector("#match-q").value.trim();
    location.hash = q ? `#/matches?player=${encodeURIComponent(q)}` : "#/matches";
  });

  try {
    const qs = new URLSearchParams();
    qs.set("limit", String(LIMIT));
    qs.set("offset", String(offset));
    if (player) qs.set("player", player);
    const { matches, total } = await api(`/api/matches?${qs.toString()}`);

    const body = view.querySelector("#matches-body");
    if (!matches.length) {
      body.innerHTML = `<div class="empty">조건에 맞는 경기가 없습니다.</div>`;
      return;
    }
    body.innerHTML = `
      <ul class="match-list">
        ${matches.map(matchListItem).join("")}
      </ul>
      ${paginationControls(offset, LIMIT, total, player)}
    `;
  } catch (err) {
    view.querySelector("#matches-body").innerHTML =
      `<div class="error-pane">경기 목록을 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
  }
}

function matchListItem(m) {
  const winner = m.winner_side;
  const aWon = winner === "A";
  const bWon = winner === "B";
  const ratedTag = m.rated ? `<span class="tag tag-rated">랭크</span>` : "";

  const aEloDelta = (m.player_a_elo_before != null && m.player_a_elo_after != null)
    ? (m.player_a_elo_after - m.player_a_elo_before) : null;
  const bEloDelta = (m.player_b_elo_before != null && m.player_b_elo_after != null)
    ? (m.player_b_elo_after - m.player_b_elo_before) : null;

  return `
    <li class="match-row">
      <a class="match-link" href="#/matches/${m.id}">
        <div class="match-time">
          ${fmtDate(m.ended_at)}
          ${ratedTag}
        </div>
        <div class="match-vs">
          <div class="vs-player vs-a ${aWon ? "won" : ""}">
            <img src="${avatarUrl(m.player_a_uuid, 28)}" alt="" class="avatar-28" />
            <span class="vs-name">${escapeHtml(m.player_a_name ?? "—")}</span>
            ${eloDeltaPill(aEloDelta, m.player_a_elo_after)}
          </div>
          <div class="vs-sep">vs</div>
          <div class="vs-player vs-b ${bWon ? "won" : ""}">
            <img src="${avatarUrl(m.player_b_uuid, 28)}" alt="" class="avatar-28" />
            <span class="vs-name">${escapeHtml(m.player_b_name ?? "—")}</span>
            ${eloDeltaPill(bEloDelta, m.player_b_elo_after)}
          </div>
        </div>
        <div class="match-outcome">
          ${winner
            ? `<span class="winner-tag winner-${winner.toLowerCase()}">${winner} 승리</span>`
            : `<span class="winner-tag winner-draw">무승부</span>`}
          <span class="reason">${escapeHtml(m.reason ?? "")}</span>
        </div>
      </a>
    </li>
  `;
}

function eloDeltaPill(delta, after) {
  if (delta == null) return `<span class="elo-pill">—</span>`;
  const sign = delta > 0 ? "+" : "";
  const cls = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return `<span class="elo-pill ${cls}">${after} (${sign}${delta})</span>`;
}

function paginationControls(offset, limit, total, player) {
  const hasPrev = offset > 0;
  const hasNext = total == null ? false : offset + limit < total;
  if (!hasPrev && !hasNext) return "";
  const baseHash = player ? `#/matches?player=${encodeURIComponent(player)}&` : "#/matches?";
  const prevHash = `${baseHash}offset=${Math.max(0, offset - limit)}`;
  const nextHash = `${baseHash}offset=${offset + limit}`;
  return `
    <div class="pagination">
      ${hasPrev ? `<a class="ghost-btn" href="${prevHash}">← 이전</a>` : `<span class="ghost-btn disabled">← 이전</span>`}
      <span class="page-info">${total != null ? `${offset + 1}–${Math.min(offset + limit, total)} / ${total}` : ""}</span>
      ${hasNext ? `<a class="ghost-btn" href="${nextHash}">다음 →</a>` : `<span class="ghost-btn disabled">다음 →</span>`}
    </div>
  `;
}

// ---- view: MATCH DETAIL -----------------------------------------------------

async function renderMatchDetail(id) {
  showLoading();
  try {
    const [match, missions] = await Promise.all([
      api(`/api/matches/${id}`),
      loadMissions(),
    ]);
    const settings = match.settings_json ? JSON.parse(match.settings_json) : {};
    const board = match.board_json ? JSON.parse(match.board_json) : [];
    const claimed = match.claimed_json ? JSON.parse(match.claimed_json) : [];

    const aWon = match.winner_side === "A";
    const bWon = match.winner_side === "B";

    const aDelta = (match.player_a_elo_before != null && match.player_a_elo_after != null)
      ? (match.player_a_elo_after - match.player_a_elo_before) : null;
    const bDelta = (match.player_b_elo_before != null && match.player_b_elo_after != null)
      ? (match.player_b_elo_after - match.player_b_elo_before) : null;

    let caClaimed = 0, cbClaimed = 0;
    for (const c of claimed) (c.side === "A" ? caClaimed++ : cbClaimed++);

    view.innerHTML = `
      <section class="page page-match-detail">
        <a class="back-link" href="#/matches">← 경기 기록</a>

        <div class="match-head">
          <div class="mh-meta">
            <span class="match-id">#${match.id}</span>
            ${match.rated ? `<span class="tag tag-rated">랭크</span>` : `<span class="tag">캐주얼</span>`}
            <span class="sub">${fmtDate(match.ended_at)}</span>
            ${match.started_at ? `<span class="sub">· ${fmtDuration(match.started_at, match.ended_at)}</span>` : ""}
          </div>
          <div class="mh-result">
            ${match.winner_side
              ? `<span class="winner-tag winner-${match.winner_side.toLowerCase()}">${match.winner_side} 승리</span>`
              : `<span class="winner-tag winner-draw">무승부</span>`}
            <span class="reason">${escapeHtml(match.reason ?? "")}</span>
          </div>
        </div>

        <div class="vs-card">
          <div class="vs-side vs-a ${aWon ? "won" : ""}">
            ${match.player_a_uuid
              ? `<a class="player-link big" href="#/players/${encodeURIComponent(match.player_a_uuid)}">
                  <img src="${bodyUrl(match.player_a_uuid, 96)}" alt="" class="body-96" loading="lazy" />
                  <div>
                    <div class="vs-name">${escapeHtml(match.player_a_name ?? "—")}</div>
                    ${eloLine(match.player_a_elo_before, match.player_a_elo_after, aDelta)}
                  </div>
                </a>`
              : `<div class="player-link big">
                  <img src="${bodyUrl(null, 96)}" alt="" class="body-96" />
                  <div><div class="vs-name">—</div></div>
                </div>`}
            <div class="claim-count">${caClaimed}칸</div>
          </div>
          <div class="vs-versus">vs</div>
          <div class="vs-side vs-b ${bWon ? "won" : ""}">
            ${match.player_b_uuid
              ? `<a class="player-link big" href="#/players/${encodeURIComponent(match.player_b_uuid)}">
                  <img src="${bodyUrl(match.player_b_uuid, 96)}" alt="" class="body-96" loading="lazy" />
                  <div>
                    <div class="vs-name">${escapeHtml(match.player_b_name ?? "—")}</div>
                    ${eloLine(match.player_b_elo_before, match.player_b_elo_after, bDelta)}
                  </div>
                </a>`
              : `<div class="player-link big">
                  <img src="${bodyUrl(null, 96)}" alt="" class="body-96" />
                  <div><div class="vs-name">—</div></div>
                </div>`}
            <div class="claim-count">${cbClaimed}칸</div>
          </div>
        </div>

        <div class="match-body">
          <div class="board-wrap board-static">
            <svg id="match-board"></svg>
            <div id="hex-tooltip" class="hex-tooltip"></div>
          </div>
          <aside class="match-side">
            <h3>설정</h3>
            <ul class="kv-list">
              <li><span>레이팅 반영</span><span>${settings.rated ? "예" : "아니오"}</span></li>
              <li><span>인벤토리 유지</span><span>${settings.keepInventory ? "예" : "아니오"}</span></li>
              <li><span>포화 효과</span><span>${settings.saturation ? "예" : "아니오"}</span></li>
              ${match.seed ? `<li><span>시드</span><span class="mono">${escapeHtml(match.seed)}</span></li>` : ""}
              ${match.room_code ? `<li><span>방 코드</span><span class="mono">${escapeHtml(match.room_code)}</span></li>` : ""}
            </ul>
            <h3>점유 목록</h3>
            <ol class="claim-history">
              ${claimed
                .slice()
                .sort((a, b) => a.claimedAt - b.claimedAt)
                .map((c) => {
                  const mname = missions.get(c.missionId)?.displayName ?? c.missionId;
                  return `<li class="side-${c.side.toLowerCase()}">
                    <span class="time">${new Date(c.claimedAt).toLocaleTimeString("ko-KR", { hour12: false })}</span>
                    <span class="side-tag">[${c.side}]</span>
                    <span>${escapeHtml(mname)}</span>
                  </li>`;
                }).join("")}
            </ol>
          </aside>
        </div>
      </section>
    `;

    const tooltipEl = view.querySelector("#hex-tooltip");
    const wrapEl = view.querySelector(".board-static");

    renderBoardSvg(view.querySelector("#match-board"), {
      board, claimed, missions,
      onHover: (tileId, ev) => {
        const tile = board.find((t) => t.tileId === tileId);
        if (!tile) return;
        const m = missions.get(tile.missionId);
        const name = m?.displayName ?? tile.missionId;
        const claim = claimed.find((c) => c.tileId === tileId);
        const claimInfo = claim ? `<span class="claim-info">[${claim.side} 점유]</span>` : "";
        tooltipEl.innerHTML =
          `<span class="difficulty ${tile.difficulty}">${tile.difficulty.toUpperCase()}</span>` +
          `${escapeHtml(name)}${claimInfo}`;
        const rect = wrapEl.getBoundingClientRect();
        tooltipEl.style.left = `${ev.clientX - rect.left + 12}px`;
        tooltipEl.style.top = `${ev.clientY - rect.top + 12}px`;
        tooltipEl.classList.add("visible");
      },
      onLeave: () => tooltipEl.classList.remove("visible"),
    });
  } catch (err) {
    showError(err);
  }
}

function eloLine(before, after, delta) {
  if (after == null) return `<div class="sub">ELO 비반영</div>`;
  if (delta == null) return `<div class="sub">ELO ${after}</div>`;
  const cls = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const sign = delta > 0 ? "+" : "";
  return `<div class="sub">ELO ${before} → <strong>${after}</strong>
            <span class="elo-delta ${cls}">${sign}${delta}</span></div>`;
}

// ---- view: PLAYER SEARCH ----------------------------------------------------

async function renderPlayerSearch() {
  const params = new URLSearchParams((location.hash.split("?")[1] ?? ""));
  const q = params.get("q") ?? "";

  view.innerHTML = `
    <section class="page page-players">
      <div class="section-header">
        <h1>유저 검색</h1>
      </div>
      <form id="player-search" class="search-form">
        <input id="player-q" placeholder="플레이어 이름" value="${escapeHtml(q)}" autofocus />
        <button type="submit">검색</button>
      </form>
      <div id="players-body">${q ? "불러오는 중…" : `<div class="empty">이름을 입력하세요.</div>`}</div>
    </section>
  `;

  view.querySelector("#player-search").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const next = view.querySelector("#player-q").value.trim();
    location.hash = next ? `#/players?q=${encodeURIComponent(next)}` : "#/players";
  });

  if (!q) return;
  try {
    const { players } = await api(`/api/players/search?q=${encodeURIComponent(q)}&limit=50`);
    const body = view.querySelector("#players-body");
    if (!players.length) {
      body.innerHTML = `<div class="empty">검색 결과가 없습니다.</div>`;
      return;
    }
    body.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>플레이어</th>
            <th class="num">ELO</th>
            <th class="num">전적</th>
            <th class="num">승률</th>
          </tr>
        </thead>
        <tbody>
          ${players.map((p) => `
            <tr>
              <td>
                <a class="player-link" href="#/players/${encodeURIComponent(p.uuid)}">
                  <img src="${avatarUrl(p.uuid, 28)}" alt="" class="avatar-28" loading="lazy" />
                  <span>${escapeHtml(p.name)}</span>
                </a>
              </td>
              <td class="num elo">${p.elo}</td>
              <td class="num">${p.wins}승 ${p.losses}패 ${p.draws}무</td>
              <td class="num">${winrate(p.wins, p.losses, p.draws)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    view.querySelector("#players-body").innerHTML =
      `<div class="error-pane">검색 실패: ${escapeHtml(err.message)}</div>`;
  }
}

// ---- view: PLAYER DETAIL ----------------------------------------------------

async function renderPlayerDetail(uuid) {
  showLoading();
  try {
    const [player, matchesRes] = await Promise.all([
      api(`/api/players/${encodeURIComponent(uuid)}`),
      api(`/api/matches?uuid=${encodeURIComponent(uuid)}&limit=20`),
    ]);
    const matches = matchesRes.matches ?? [];

    // Recent ELO trajectory: pull this player's `elo_after` from each recent match
    // (oldest first) — gives a quick mini-chart of the last 20 results.
    const trajectory = matches
      .slice()
      .sort((a, b) => a.ended_at - b.ended_at)
      .map((m) => {
        const isA = m.player_a_uuid === player.uuid;
        const eloAfter = isA ? m.player_a_elo_after : m.player_b_elo_after;
        const eloBefore = isA ? m.player_a_elo_before : m.player_b_elo_before;
        return { eloAfter, eloBefore, ts: m.ended_at };
      })
      .filter((p) => p.eloAfter != null);

    view.innerHTML = `
      <section class="page page-player">
        <a class="back-link" href="#/players">← 유저 검색</a>

        <div class="player-head">
          <img src="${bodyUrl(player.uuid, 160)}" alt="" class="body-160" loading="lazy" />
          <div class="ph-info">
            <h1>${escapeHtml(player.name)}</h1>
            <div class="ph-uuid mono">${escapeHtml(player.uuid)}</div>
            <div class="ph-stats">
              <div class="stat">
                <div class="stat-num">${player.elo}</div>
                <div class="stat-label">현재 ELO</div>
              </div>
              <div class="stat">
                <div class="stat-num">${player.games_played}</div>
                <div class="stat-label">경기 수</div>
              </div>
              <div class="stat">
                <div class="stat-num">${player.wins}–${player.losses}–${player.draws}</div>
                <div class="stat-label">승–패–무</div>
              </div>
              <div class="stat">
                <div class="stat-num">${winrate(player.wins, player.losses, player.draws)}</div>
                <div class="stat-label">승률</div>
              </div>
            </div>
          </div>
        </div>

        ${trajectory.length > 1 ? `
          <div class="elo-chart-wrap">
            <h3>최근 ELO 추이</h3>
            ${renderEloSparkline(trajectory)}
          </div>` : ""}

        <div class="section-header">
          <h2>최근 경기</h2>
        </div>
        ${matches.length === 0
          ? `<div class="empty">아직 경기 기록이 없습니다.</div>`
          : `<ul class="match-list">${matches.map(matchListItem).join("")}</ul>`}
      </section>
    `;
  } catch (err) {
    if (err.message.includes("404")) {
      view.innerHTML = `<div class="error-pane">플레이어를 찾을 수 없습니다.</div>`;
      return;
    }
    showError(err);
  }
}

function renderEloSparkline(points) {
  if (points.length < 2) return "";
  const W = 600;
  const H = 100;
  const PAD = 16;
  const elos = points.map((p) => p.eloAfter);
  const minE = Math.min(...elos);
  const maxE = Math.max(...elos);
  const span = Math.max(1, maxE - minE);
  const dx = (W - PAD * 2) / (points.length - 1);

  const path = points.map((p, i) => {
    const x = PAD + i * dx;
    const y = H - PAD - ((p.eloAfter - minE) / span) * (H - PAD * 2);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const circles = points.map((p, i) => {
    const x = PAD + i * dx;
    const y = H - PAD - ((p.eloAfter - minE) / span) * (H - PAD * 2);
    const dy = i === 0 ? 0 : p.eloAfter - points[i - 1].eloAfter;
    const cls = dy > 0 ? "up" : dy < 0 ? "down" : "flat";
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="dot ${cls}">
      <title>${p.eloAfter} (${new Date(p.ts).toLocaleDateString("ko-KR")})</title>
    </circle>`;
  }).join("");

  return `
    <svg class="elo-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${path}" class="spark-line" />
      ${circles}
      <text x="${PAD}" y="14" class="spark-label">${maxE}</text>
      <text x="${PAD}" y="${H - 2}" class="spark-label">${minE}</text>
    </svg>
  `;
}

// ---- view: BOARD (live spectator) ------------------------------------------

let spectatorCleanup = null;

function renderBoard(code) {
  if (spectatorCleanup) {
    try { spectatorCleanup(); } catch {}
    spectatorCleanup = null;
  }
  view.innerHTML = "";
  spectatorCleanup = mountSpectator(view, code);
}

// ---- router -----------------------------------------------------------------

function dispatch() {
  // Tear down live spectator unless we're staying on the board route.
  const hash = location.hash || "#/";
  const route = hash.split("?")[0];
  if (!route.startsWith("#/board/") && spectatorCleanup) {
    try { spectatorCleanup(); } catch {}
    spectatorCleanup = null;
  }

  setActiveTab(route);

  const matchersDetail = route.match(/^#\/matches\/(\d+)$/);
  const playerDetail = route.match(/^#\/players\/([^/]+)$/);
  const boardRoute = route.match(/^#\/board\/([A-Za-z0-9]{4})$/);

  if (route === "" || route === "#" || route === "#/") {
    renderHome();
  } else if (route === "#/leaderboard") {
    renderLeaderboard();
  } else if (matchersDetail) {
    renderMatchDetail(Number(matchersDetail[1]));
  } else if (route === "#/matches") {
    renderMatchesList();
  } else if (route === "#/players") {
    renderPlayerSearch();
  } else if (playerDetail) {
    renderPlayerDetail(decodeURIComponent(playerDetail[1]));
  } else if (boardRoute) {
    renderBoard(boardRoute[1].toUpperCase());
  } else {
    view.innerHTML = `<div class="error-pane">알 수 없는 경로: ${escapeHtml(route)}</div>`;
  }
}

function setActiveTab(route) {
  const map = {
    home: route === "#/" || route === "" || route === "#",
    leaderboard: route === "#/leaderboard",
    matches: route.startsWith("#/matches"),
    players: route.startsWith("#/players"),
  };
  document.querySelectorAll("#nav a").forEach((a) => {
    const r = a.dataset.route;
    a.classList.toggle("active", !!map[r]);
  });
}

window.addEventListener("hashchange", dispatch);
window.addEventListener("DOMContentLoaded", () => {
  if (!location.hash || location.hash === "#") location.hash = "#/";
  dispatch();
});

// If DOMContentLoaded already fired (module loaded after), kick off now.
if (document.readyState !== "loading") {
  if (!location.hash || location.hash === "#") location.hash = "#/";
  dispatch();
}
