/**
 * Snow for the Christmas theme: flakes drifting down over the page, nearer ones bigger, brighter and faster. It sits
 * in front of the page but never in the way (clicks go through it, and it stays under the header and dialogs). One
 * canvas, a few dozen flakes; the browser pauses it while the tab is hidden, and people who ask their system for
 * reduced motion get none.
 */
import { onCleanup, onMount, Show } from 'solid-js';
import { ab } from '../lib/experiments';

interface Flake {
  x: number;
  y: number;
  r: number;
  fall: number;
  sway: number;
  swaySpeed: number;
  swayWidth: number;
  alpha: number;
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Snowfall() {
  return (
    <Show when={ab.variant('theme') === 'christmas' && !reducedMotion()}>
      <Snow />
    </Show>
  );
}

function Snow() {
  let canvas: HTMLCanvasElement | undefined;
  onMount(() => {
    const el = canvas;
    const g = el?.getContext('2d');
    if (!el || !g) return;
    let width = 0;
    let height = 0;
    const flakes: Flake[] = [];
    // About one flake per 20,000 px² (fewer on a phone), up to 80.
    const count = () => Math.round(Math.min(80, Math.max(25, (width * height) / 20000)));
    // A new size (a rotated phone, a window that opened small) spreads the snow over it, with as many flakes as fit.
    const resize = () => {
      const [oldWidth, oldHeight] = [width, height];
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const f of flakes) {
        if (oldWidth > 0 && oldHeight > 0) {
          f.x *= width / oldWidth;
          f.y *= height / oldHeight;
        } else Object.assign(f, flake(true));
      }
      while (flakes.length < count()) flakes.push(flake(true));
      flakes.length = Math.min(flakes.length, count());
    };

    const flake = (anywhere: boolean): Flake => {
      const near = Math.random(); // 0 far away .. 1 close
      return {
        x: Math.random() * width,
        y: anywhere ? Math.random() * height : -6,
        r: 0.8 + near * 2.2,
        fall: 16 + near * 38,
        sway: Math.random() * Math.PI * 2,
        swaySpeed: 0.3 + Math.random() * 0.7,
        swayWidth: 5 + near * 14,
        alpha: 0.3 + near * 0.5,
      };
    };
    resize();
    const wind = 6;

    let last = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      g.clearRect(0, 0, width, height);
      g.fillStyle = '#ffffff';
      for (const f of flakes) {
        f.y += f.fall * dt;
        f.x += wind * dt;
        f.sway += f.swaySpeed * dt;
        if (f.y - f.r > height) Object.assign(f, flake(false));
        if (f.x > width + 20) f.x -= width + 40;
        g.globalAlpha = f.alpha;
        g.beginPath();
        g.arc(f.x + Math.sin(f.sway) * f.swayWidth, f.y, f.r, 0, Math.PI * 2);
        g.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    });
  });
  return <canvas ref={(el) => (canvas = el)} aria-hidden="true" class="pointer-events-none fixed inset-0 z-30 size-full" />;
}
