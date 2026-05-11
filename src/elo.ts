// Standard ELO with games-played-tiered K-factor.
// Score is 1 (win), 0.5 (draw), 0 (loss). Expected = 1/(1 + 10^((opp-me)/SCALE)).
// New rating = round(old + K * (score - expected)).

const SCALE = 400;

export function kFactor(gamesPlayed: number): number {
  if (gamesPlayed < 30) return 40;
  if (gamesPlayed < 100) return 24;
  return 16;
}

export function expectedScore(myElo: number, oppElo: number): number {
  return 1 / (1 + Math.pow(10, (oppElo - myElo) / SCALE));
}

export interface EloUpdate {
  before: number;
  after: number;
  delta: number;
}

export function computeNewElo(
  myElo: number,
  oppElo: number,
  myGamesPlayed: number,
  score: 0 | 0.5 | 1,
): EloUpdate {
  const k = kFactor(myGamesPlayed);
  const expected = expectedScore(myElo, oppElo);
  const after = Math.round(myElo + k * (score - expected));
  return { before: myElo, after, delta: after - myElo };
}
