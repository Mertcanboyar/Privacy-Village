// Small vanilla-DOM helpers for the design-system UI layer (#ui-root).
// No framework — this repo has zero UI-library dependencies, and the
// quest/dialogue/badge components are simple enough not to need one.

export interface ElProps {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.style) Object.assign(node.style, props.style);
  if (props.on) for (const [k, fn] of Object.entries(props.on)) node.addEventListener(k, fn as EventListener);
  for (const child of children) node.append(child);
  return node;
}

export interface TypewriterHandle {
  readonly finished: boolean;
  skip(): void;
}

// Reveals `text` into `target` one character at a time. Handles wrapped
// multi-line body text, which the classic CSS steps() typewriter trick
// can't do. Call .skip() to snap to the full text instantly (e.g. if the
// player presses [E] again before the reveal finishes).
export function typewriter(target: HTMLElement, text: string, msPerChar = 18, onDone?: () => void): TypewriterHandle {
  target.textContent = "";
  let i = 0;
  let finished = false;
  let timer: number | undefined;

  function finish() {
    if (finished) return;
    finished = true;
    if (timer !== undefined) window.clearInterval(timer);
    target.textContent = text;
    onDone?.();
  }

  timer = window.setInterval(() => {
    i++;
    target.textContent = text.slice(0, i);
    if (i >= text.length) finish();
  }, msPerChar);

  return {
    get finished() {
      return finished;
    },
    skip: finish,
  };
}

// Animates a number into `target.textContent` with an ease-out curve —
// used by the badge popup's XP counter.
export function countUp(target: HTMLElement, from: number, to: number, ms = 900, format: (n: number) => string = (n) => String(Math.round(n))) {
  const start = performance.now();
  function frame(now: number) {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    target.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
