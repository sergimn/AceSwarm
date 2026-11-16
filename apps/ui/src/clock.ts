const TICK_MS = 1000;

const clocks = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const ticker: { timer?: ReturnType<typeof setInterval> } = {};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The browser's local time as HH:MM on a 24-hour clock. */
export function formatClock(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function tick(): void {
  const text = formatClock(new Date());
  for (const clock of clocks) {
    if (clock.textContent !== text) {
      clock.textContent = text;
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Keeps each element showing the current time. One shared timer drives all of them. */
export function startClock(...elements: HTMLElement[]): void {
  for (const element of elements) {
    clocks.add(element);
    element.textContent = formatClock(new Date());
  }
  ticker.timer ??= setInterval(tick, TICK_MS);
}

/** Calls `listener` every second, on the clocks' timer. */
export function onTick(listener: () => void): void {
  listeners.add(listener);
  ticker.timer ??= setInterval(tick, TICK_MS);
}
