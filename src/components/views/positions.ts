/** Locally saved modeled positions (from Trade Lab). Never sent anywhere; simulation only. */
export interface SavedPosition {
  side: "long" | "short";
  qty: number;
  entry: number;
  liq: number;
  stop: number | null;
  savedAt: number;
}

const KEY = "atlas.positions.v1";

export function loadPositions(): SavedPosition[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedPosition[]) : [];
  } catch {
    return [];
  }
}

export function savePositions(p: SavedPosition[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
