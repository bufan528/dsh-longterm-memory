/**
 * Every stylesheet rule this plugin owns, as one string.
 *
 * Hard constraints taken from the official DSH plugin guide:
 * - colour, background and border come **only** from `--dsw-alias-*` theme
 *   tokens, each with a literal fallback so the page also renders when a token
 *   is missing. Anything that needs transparency derives it with `color-mix()`
 *   from a token, never from a literal `rgba()`;
 * - every class is prefixed `lmv-`;
 * - `.lmv-page` is a full-height flex column whose body scrolls internally;
 * - nothing but the injected `<style>` element touches the document.
 *
 * The visual language is deliberately borrowed from two places:
 *
 * 1. **Apple's HIG** — clarity (one obvious primary action per view), deference
 *    (chrome recedes, content keeps the contrast), depth (surfaces sit on
 *    layers instead of being outlined boxes). Concretely: an 8pt spacing grid,
 *    grouped cards, a restrained accent used only for interaction, and a
 *    sidebar instead of a second row of tabs.
 * 2. **Disney's animation principles** — anticipation (a button compresses
 *    before it acts), staging (dimmed backdrop, one thing moving at a time),
 *    follow-through (a spring overshoot on entry, never on exit), slow-in and
 *    slow-out (no linear motion), secondary action (the shadow grows while the
 *    card lifts), and restraint: nothing over 400ms, nothing decorative.
 *
 * `prefers-reduced-motion` removes every non-essential transition.
 *
 * @module dsh-longterm-memory/client/styles
 */

/** The complete plugin CSS. */
export const CLIENT_CSS = `
/* ============================================================== tokens === */
.lmv-page{
  --lmv-r-xs:6px; --lmv-r-sm:8px; --lmv-r-md:12px; --lmv-r-lg:16px; --lmv-r-xl:22px;
  --lmv-ease-out:cubic-bezier(.16,1,.3,1);
  --lmv-ease-in-out:cubic-bezier(.4,0,.2,1);
  --lmv-ease-spring:cubic-bezier(.34,1.28,.64,1);
  --lmv-fast:130ms; --lmv-base:220ms; --lmv-slow:360ms;
  --lmv-hairline:var(--dsw-alias-border-l1,#2e2e2e);
  --lmv-line-strong:var(--dsw-alias-border-l2,#3a3a3a);
  --lmv-surface:var(--dsw-alias-bg-layer-1,#252526);
  --lmv-surface-2:var(--dsw-alias-bg-layer-2,#2d2d2e);
  --lmv-ink:var(--dsw-alias-label-primary,#e6e6e6);
  --lmv-ink-2:var(--dsw-alias-label-secondary,#b8b8b8);
  --lmv-ink-3:var(--dsw-alias-label-tertiary,#8a8a8a);
  --lmv-accent:var(--dsw-alias-brand-primary,#4a8cff);
  --lmv-tint:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 12%, transparent);
  --lmv-tint-strong:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 20%, transparent);
  --lmv-hover:var(--dsw-alias-interactive-bg-hover,#383838);
  /* Surfaces are mixed *relative to the label colour*, so one rule works in both
     themes: mixing toward the text colour darkens a white card and lightens a
     dark one. Absolute tokens cannot do that — in light mode layer-1 and the page
     are the same white, which is why cards had no visible edge. */
  --lmv-tray:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 5%, var(--dsw-alias-bg-layer-1,#252526));
  --lmv-border:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 11%, transparent);
  --lmv-lift:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 7%, transparent),0 10px 24px -20px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 30%, transparent);
  --lmv-shadow-1:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 10%, transparent);
  --lmv-shadow-2:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 9%, transparent),0 14px 34px -18px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 55%, transparent);
  --lmv-shadow-3:0 2px 6px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 12%, transparent),0 32px 64px -28px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 70%, transparent);
}
.lmv-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,#1e1e1e);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}
.lmv-page *{box-sizing:border-box}
.lmv-page button,.lmv-page input,.lmv-page select,.lmv-page textarea{font-family:inherit}
.lmv-page :focus-visible{outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 72%, transparent);outline-offset:2px;border-radius:var(--lmv-r-xs)}
/* Polished chrome: themed text selection, hairline scrollbars and a soft
   focus halo. Apple's restraint is mostly about what you remove — the default
   OS scrollbar and bright blue selection were the loudest things left. */
.lmv-page ::selection{background:var(--lmv-tint-strong);color:var(--dsw-alias-label-primary,#e6e6e6)}
.lmv-main,.lmv-life,.lmv-side,.lmv-pre,.lmv-modal-body,.lmv-chips-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 18%, transparent) transparent}
.lmv-main::-webkit-scrollbar,.lmv-life::-webkit-scrollbar,.lmv-side::-webkit-scrollbar,.lmv-pre::-webkit-scrollbar,.lmv-modal-body::-webkit-scrollbar,.lmv-chips-scroll::-webkit-scrollbar{width:8px;height:8px}
.lmv-main::-webkit-scrollbar-thumb,.lmv-life::-webkit-scrollbar-thumb,.lmv-side::-webkit-scrollbar-thumb,.lmv-pre::-webkit-scrollbar-thumb,.lmv-modal-body::-webkit-scrollbar-thumb,.lmv-chips-scroll::-webkit-scrollbar-thumb{border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 16%, transparent);border:2px solid transparent;background-clip:padding-box}
.lmv-main::-webkit-scrollbar-thumb:hover,.lmv-life::-webkit-scrollbar-thumb:hover,.lmv-pre::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 30%, transparent);border:2px solid transparent;background-clip:padding-box}

/* ================================================================ shell === */
.lmv-head{display:flex;align-items:flex-end;gap:16px;padding:18px 24px 12px;flex:0 0 auto;min-width:0}
.lmv-head-titles{display:flex;flex-direction:column;gap:3px;min-width:0}
.lmv-title{font-size:21px;line-height:1.2;font-weight:650;letter-spacing:-.015em;margin:0;text-wrap:balance}
.lmv-subtitle{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:7px;min-width:0}
.lmv-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;opacity:.9}
.lmv-build{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.01em;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:help;flex:none;opacity:.85}
.lmv-dot{opacity:.45}
.lmv-head-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}

/* Health capsules: the four numbers that answer "is anything wrong?". */
.lmv-health{display:flex;align-items:center;gap:6px;padding:3px;border-radius:999px;background:var(--lmv-tray);border:1px solid var(--lmv-border)}
.lmv-pill{display:inline-flex;align-items:baseline;gap:5px;padding:3px 10px;border-radius:999px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;transition:background var(--lmv-base) var(--lmv-ease-out)}
.lmv-pill-value{font-size:12px;font-weight:620;color:var(--dsw-alias-label-primary,#e6e6e6);font-variant-numeric:tabular-nums}
.lmv-pill-warn .lmv-pill-value{color:var(--dsw-alias-state-warn-primary,#d29922)}
.lmv-pill-error .lmv-pill-value{color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-pill-ok .lmv-pill-value{color:var(--dsw-alias-state-success-primary,#3fb950)}
.lmv-pill-ok .lmv-pill-label{color:var(--dsw-alias-state-success-primary,#3fb950)}

/* Segmented control. The active segment lifts onto its own surface. */
.lmv-nav{display:flex;gap:2px;margin:0 24px 14px;padding:4px;border-radius:var(--lmv-r-md);background:var(--lmv-tray);border:1px solid var(--lmv-border);flex:0 0 auto;overflow-x:auto;scrollbar-width:none}
.lmv-nav::-webkit-scrollbar{display:none}
.lmv-nav-btn{appearance:none;font:inherit;font-size:12.5px;font-weight:500;display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);padding:5px 12px;border-radius:var(--lmv-r-sm);cursor:pointer;white-space:nowrap;transition:color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-base) var(--lmv-ease-out),transform var(--lmv-fast) var(--lmv-ease-out)}
.lmv-nav-btn:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent);color:var(--dsw-alias-label-primary,#f5f5f5)}
.lmv-nav-btn:active{transform:scale(.97)}
.lmv-nav-btn svg{opacity:.75;flex:0 0 auto}
.lmv-nav-btn-on{background:var(--dsw-alias-bg-layer-2,#2d2d2e);color:var(--dsw-alias-label-primary,#f5f5f5);border-color:var(--dsw-alias-border-l2,#3a3a3a);box-shadow:var(--lmv-shadow-1),inset 0 -1px 0 color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 45%, transparent)}
.lmv-nav-btn-on svg{opacity:1;color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-nav-count{font-size:10.5px;font-weight:600;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 22%, transparent);color:var(--dsw-alias-state-warn-primary,#d29922);font-variant-numeric:tabular-nums}

.lmv-body{flex:1 1 auto;min-height:0;display:flex}
.lmv-fade{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;animation:lmv-fade var(--lmv-base) var(--lmv-ease-out) both}
/* Directional navigation (arcs + anticipation): forward enters from the
   right, back from the left. Small travel so it reads as depth, not a slide. */
.lmv-fade[data-dir="forward"]{animation:lmv-enter-forward var(--lmv-base) var(--lmv-ease-out) both}
.lmv-fade[data-dir="back"]{animation:lmv-enter-back var(--lmv-base) var(--lmv-ease-out) both}
@keyframes lmv-enter-forward{from{opacity:0;transform:translate3d(10px,0,0)}to{opacity:1;transform:none}}
@keyframes lmv-enter-back{from{opacity:0;transform:translate3d(-10px,0,0)}to{opacity:1;transform:none}}
.lmv-life-body[data-dir="forward"]{animation:lmv-enter-forward var(--lmv-base) var(--lmv-ease-out) both}
.lmv-life-body[data-dir="back"]{animation:lmv-enter-back var(--lmv-base) var(--lmv-ease-out) both}
.lmv-main{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;scrollbar-gutter:stable;overscroll-behavior:contain;padding:4px 24px 40px;display:flex;flex-direction:column;gap:14px}
.lmv-main>*{animation:lmv-rise var(--lmv-slow) var(--lmv-ease-out) both}
.lmv-main>*:nth-child(2){animation-delay:34ms}
.lmv-main>*:nth-child(3){animation-delay:68ms}
.lmv-main>*:nth-child(4){animation-delay:102ms}
.lmv-main>*:nth-child(n+5){animation-delay:132ms}
.lmv-side{flex:0 0 264px;min-height:0;overflow:auto;overscroll-behavior:contain;border-right:1px solid var(--dsw-alias-border-l1,#2e2e2e);padding:14px;display:flex;flex-direction:column;gap:10px}

/* ================================================================= card === */
.lmv-card{background:var(--dsw-alias-bg-layer-1,#252526);border:1px solid var(--lmv-border);border-radius:var(--lmv-r-lg);padding:16px 18px 18px;display:flex;flex-direction:column;gap:12px;min-width:0;box-shadow:var(--lmv-lift)}
.lmv-card-head{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}
.lmv-card-title{font-size:13.5px;font-weight:620;letter-spacing:-.005em;display:flex;align-items:center;gap:7px}
.lmv-card-title svg{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-card-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
/* Disclosure: one glyph, one continuous turn (no icon swap). */
.lmv-chev{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;transition:transform var(--lmv-base) var(--lmv-ease-spring)}
.lmv-chev-open{transform:rotate(90deg)}
.lmv-kicker{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-weight:600}
.lmv-kicker-row{display:flex;align-items:center;gap:7px;margin-top:5px;min-width:0}
.lmv-kicker-count{font-size:10px;font-weight:600;letter-spacing:0;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 11%, transparent);color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}
.lmv-kicker-warn{color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-kicker-warn .lmv-kicker-count{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 18%, transparent);color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-subhead{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:-4px 0 2px}

.lmv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:8px}
.lmv-grid-wide{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;align-items:start}
.lmv-stat{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 72%, transparent);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:var(--lmv-r-md);padding:10px 12px;display:flex;flex-direction:column;gap:1px;min-width:0;transition:transform var(--lmv-base) var(--lmv-ease-spring),border-color var(--lmv-base) var(--lmv-ease-out)}
.lmv-stat:hover{transform:translateY(-1px);border-color:var(--dsw-alias-border-l2,#3a3a3a)}
.lmv-stat-value{font-size:20px;line-height:1.15;font-weight:640;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.lmv-stat-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:14px;align-items:start;min-width:0}
/* Purpose-built form rows. auto-fit with a 310px minimum produced three
   columns plus one orphan on a 1044px card — an even split is the whole point. */
.lmv-form-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 14px;min-width:0}
.lmv-form-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 14px;min-width:0}
@media (max-width:1180px){.lmv-form-4{grid-template-columns:repeat(2,minmax(0,1fr))}.lmv-form-3{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.lmv-form-4,.lmv-form-3{grid-template-columns:minmax(0,1fr)}}

/* Overview hero: path, state, and the one primary action, all on one band. */
.lmv-hero{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;padding:16px 18px;border-radius:var(--lmv-r-xl);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:linear-gradient(132deg, var(--lmv-tint), transparent 56%), var(--dsw-alias-bg-layer-1,#252526);box-shadow:var(--lmv-shadow-1);min-width:0}
.lmv-hero-main{flex:1 1 330px;min-width:0;display:flex;flex-direction:column;gap:6px}
.lmv-hero-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere;line-height:1.5}
.lmv-hero-facts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.lmv-hero-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.lmv-hero-full{flex-basis:100%;min-width:0}

/* Attention strip: only the numbers that imply an action get a colour. */
.lmv-attn{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:9px}
.lmv-attn-cell{appearance:none;font:inherit;text-align:left;display:flex;flex-direction:column;gap:2px;padding:11px 13px;border-radius:var(--lmv-r-md);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 50%, transparent);color:var(--dsw-alias-label-primary,#e6e6e6);min-width:0;transition:border-color var(--lmv-base) var(--lmv-ease-out),transform var(--lmv-base) var(--lmv-ease-spring),box-shadow var(--lmv-base) var(--lmv-ease-out)}
button.lmv-attn-cell{cursor:pointer}
button.lmv-attn-cell:hover{transform:translateY(-1px);border-color:var(--dsw-alias-border-l2,#3a3a3a);box-shadow:var(--lmv-shadow-2)}
.lmv-attn-value{font-size:22px;line-height:1.1;font-weight:640;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.lmv-attn-label{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-attn-warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 38%, transparent)}
.lmv-attn-warn .lmv-attn-value{color:var(--dsw-alias-state-warn-primary,#d29922)}
.lmv-attn-error{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 42%, transparent)}
.lmv-attn-error .lmv-attn-value{color:var(--dsw-alias-state-error-primary,#e5534b)}

/* Distribution: proportions read faster as bars than as eight boxes. */
.lmv-dist{display:flex;flex-direction:column;gap:7px;min-width:0}
.lmv-dist-row{display:grid;grid-template-columns:minmax(62px,5.6em) minmax(0,1fr) 2.6em;gap:10px;align-items:center;font-size:12px;min-width:0}
.lmv-dist-label{color:var(--dsw-alias-label-secondary,#b8b8b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-dist-track{height:7px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 8%, transparent);overflow:hidden;min-width:0}
.lmv-dist-fill{height:100%;border-radius:999px;background:linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 58%, transparent), var(--dsw-alias-brand-primary,#4a8cff));transform-origin:left center;animation:lmv-grow var(--lmv-slow) var(--lmv-ease-out) both}
.lmv-dist-zero .lmv-dist-label{color:var(--dsw-alias-label-tertiary,#8a8a8a);opacity:.66}
.lmv-dist-value{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums;text-align:right}

/* =============================================================== button === */
.lmv-btn{appearance:none;font:inherit;font-size:12.5px;font-weight:520;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:5px 13px;border-radius:var(--lmv-r-sm);cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#2d2d2e);color:var(--dsw-alias-label-primary,#e6e6e6);white-space:nowrap;position:relative;overflow:hidden;transition:background var(--lmv-fast) var(--lmv-ease-out),border-color var(--lmv-fast) var(--lmv-ease-out),transform var(--lmv-fast) var(--lmv-ease-out),box-shadow var(--lmv-fast) var(--lmv-ease-out)}
/* Ripple (squash & stretch's accomplice): the press compresses, the ripple
   blooms outward from the finger — the eye reads one continuous gesture. */
.lmv-ripple{position:absolute;border-radius:50%;pointer-events:none;background:currentColor;opacity:.18;transform:scale(0);animation:lmv-ripple 320ms var(--lmv-ease-out) forwards}
@keyframes lmv-ripple{to{transform:scale(1);opacity:0}}
.lmv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#383838)}
/* The lift is for standalone actions only. In a dense row or a sticker tray a
   1px hop on every icon button reads as jitter, so small controls keep colour
   feedback and skip the movement. */
.lmv-btn:not(.lmv-btn-sm):not(.lmv-icon-btn):hover:not(:disabled){transform:translateY(-1px);box-shadow:var(--lmv-shadow-2)}
/* Explicit opt-out beats a complex :not() — one unsupported selector there would
   drop the whole rule and silently remove the lift everywhere. */
.lmv-sticker-actions .lmv-btn:hover:not(:disabled){transform:none;box-shadow:none}
.lmv-btn:active:not(:disabled){transform:translateY(0) scale(.965);box-shadow:none}
/* Secondary action: the lift shadow melts away while pressed — the button is
   physically down, not just smaller. */
.lmv-btn-primary:active:not(:disabled){box-shadow:none}
.lmv-btn:disabled{opacity:.42;cursor:not-allowed}
.lmv-btn svg{flex:0 0 auto;transition:transform var(--lmv-base) var(--lmv-ease-out)}
.lmv-btn:hover:not(:disabled) svg{transform:translateX(1px)}
.lmv-btn-primary{background:linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-button-primary-fill,#3b6fd4) 84%, var(--dsw-alias-label-primary-foreground,#fff)), var(--dsw-alias-button-primary-fill,#3b6fd4));border-color:color-mix(in srgb, var(--dsw-alias-button-primary-fill,#3b6fd4) 70%, var(--dsw-alias-border-l2,#3a3a3a));color:var(--dsw-alias-label-primary-foreground,#ffffff);box-shadow:var(--lmv-shadow-1)}
.lmv-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4a8cff);border-color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-btn-ghost:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 7%, transparent);color:var(--dsw-alias-label-primary,#f5f5f5)}
.lmv-btn-danger{background:transparent;border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 45%, transparent);color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-btn-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 14%, transparent)}
.lmv-btn-sm{min-height:26px;padding:3px 9px;font-size:11.5px;border-radius:var(--lmv-r-xs)}
.lmv-icon-btn{width:30px;min-height:30px;padding:0;border-radius:var(--lmv-r-sm);background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-icon-btn:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 8%, transparent);color:var(--dsw-alias-label-primary,#f5f5f5)}

/* ================================================================ input === */
.lmv-input,.lmv-select,.lmv-textarea{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#2d2d2e);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--lmv-r-sm);padding:5px 9px;min-height:30px;min-width:0;max-width:100%;transition:border-color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-fast) var(--lmv-ease-out)}
.lmv-input:hover,.lmv-select:hover,.lmv-textarea:hover{border-color:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 26%, var(--dsw-alias-border-l2,#3a3a3a))}
.lmv-input:focus,.lmv-select:focus,.lmv-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a8cff);box-shadow:0 0 0 3px var(--lmv-tint)}
.lmv-input::placeholder,.lmv-textarea::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-input-block{width:100%}
.lmv-textarea{line-height:1.6;resize:vertical;width:100%;padding:8px 10px}
.lmv-textarea-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.lmv-number{width:108px;font-variant-numeric:tabular-nums}
.lmv-page input[type="date"],.lmv-page input[type="datetime-local"]{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#2d2d2e);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--lmv-r-sm);padding:5px 9px;min-height:30px;color-scheme:dark light}
.lmv-page input[type="file"]{font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b8b8b8);max-width:100%}
.lmv-page input[type="file"]::file-selector-button{font:inherit;font-size:11.5px;margin-right:8px;padding:4px 10px;border-radius:var(--lmv-r-xs);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#2d2d2e);color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer}
.lmv-check{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;user-select:none;min-height:26px}
.lmv-check input{accent-color:var(--dsw-alias-brand-primary,#4a8cff);margin:0;width:14px;height:14px}
.lmv-field{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1 1 170px}
/* A checkbox inside a field sits where an input would: same 30px baseline, so a
   row of mixed controls reads as one line instead of two. */
.lmv-field .lmv-check{min-height:30px}
.lmv-field-label{font-size:11px;font-weight:560;color:var(--dsw-alias-label-tertiary,#8a8a8a);letter-spacing:.01em}
.lmv-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.lmv-toolbar>.lmv-field{flex:0 1 auto}

/* ============================================================== surfaces === */
.lmv-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.lmv-row{display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:var(--lmv-r-md);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 55%, transparent);min-width:0;transition:border-color var(--lmv-base) var(--lmv-ease-out),background var(--lmv-base) var(--lmv-ease-out),transform var(--lmv-fast) var(--lmv-ease-out);animation:lmv-slide-in 170ms var(--lmv-ease-out) both}
/* Slide, never fade: a row is interactive the moment it exists. An opacity-0
   first frame made freshly added candidates invisible-and-unclickable for a
   few hundred ms, which the real-browser E2E caught. */
@keyframes lmv-slide-in{from{transform:translateY(7px)}to{transform:none}}
/* Entrance wave across list rows, capped so long lists land quickly. */
.lmv-row:nth-child(2){animation-delay:24ms}
.lmv-row:nth-child(3){animation-delay:28ms}
.lmv-row:nth-child(4){animation-delay:42ms}
.lmv-row:nth-child(5){animation-delay:56ms}
.lmv-row:nth-child(n+6){animation-delay:62ms}
.lmv-list>.lmv-row:hover{border-color:var(--dsw-alias-border-l2,#3a3a3a)}
button.lmv-row:active{transform:scale(.994);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 78%, transparent)}
.lmv-row-click{cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%;background:transparent;border:0;padding:0;border-radius:var(--lmv-r-xs);display:flex;gap:9px;align-items:flex-start}
.lmv-row-click:hover .lmv-row-title{color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-row-on{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 65%, transparent);background:var(--lmv-tint)}
/* An overdue reminder is the one row that must win attention at a glance. */
.lmv-row-overdue{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 55%, transparent);box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.lmv-row-title{font-size:13px;font-weight:540;overflow-wrap:anywhere;transition:color var(--lmv-fast) var(--lmv-ease-out)}
.lmv-row-preview{font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lmv-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);min-width:0}
/* Skeleton: a list that is arriving should look like the list, not like a
   spinner. The shimmer is a single travelling highlight (slow-in/slow-out), so
   the eye reads "content is on its way" without a rotating distraction. */
.lmv-skel{position:relative;overflow:hidden;border-radius:var(--lmv-r-sm);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 7%, transparent)}
.lmv-skel::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 11%, transparent),transparent);animation:lmv-shimmer 1.2s var(--lmv-ease-in-out) infinite}
.lmv-skel-line{height:9px}
.lmv-skel-title{height:12px;width:36%}
.lmv-skel-card{padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:var(--lmv-r-lg);background:var(--dsw-alias-bg-layer-1,#252526);display:flex;flex-direction:column;gap:9px}
.lmv-skel-row{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:var(--lmv-r-md)}
.lmv-skel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.lmv-skel-tile{aspect-ratio:1/1;border-radius:var(--lmv-r-md)}
@keyframes lmv-shimmer{to{transform:translateX(100%)}}

.lmv-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-secondary,#b8b8b8);white-space:nowrap;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 60%, transparent)}
.lmv-badge-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 45%, transparent)}
.lmv-badge-warn{color:var(--dsw-alias-state-warn-primary,#d29922);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 45%, transparent)}
.lmv-badge-error{color:var(--dsw-alias-state-error-primary,#e5534b);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 45%, transparent)}
.lmv-badge-brand{color:var(--dsw-alias-brand-primary,#4a8cff);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 45%, transparent);background:var(--lmv-tint)}
/* Context, not a count: no border, so "今晚" stops competing with the numbers. */
.lmv-badge-quiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);padding-left:2px}
.lmv-tag{cursor:pointer;font:inherit;font-size:11.5px;padding:2px 10px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 70%, transparent);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-secondary,#b8b8b8);transition:color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-fast) var(--lmv-ease-out),border-color var(--lmv-fast) var(--lmv-ease-out),transform var(--lmv-fast) var(--lmv-ease-out)}
.lmv-tag:hover{color:var(--dsw-alias-label-primary,#f5f5f5);background:var(--dsw-alias-interactive-bg-hover,#383838)}
.lmv-tag:active{transform:scale(.96)}
.lmv-tag:disabled{opacity:.38;cursor:not-allowed;transform:none}
.lmv-tag:disabled:hover{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 70%, transparent);color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-tag-on{color:var(--dsw-alias-label-primary-foreground,#ffffff);background:var(--dsw-alias-button-primary-fill,#3b6fd4);border-color:var(--dsw-alias-button-primary-fill,#3b6fd4)}
.lmv-chips{display:flex;flex-wrap:wrap;gap:5px}
.lmv-chips-scroll{max-height:136px;overflow:auto}
.lmv-kv{display:grid;grid-template-columns:minmax(96px,auto) minmax(0,1fr);gap:7px 14px;font-size:12.5px;align-items:baseline}
.lmv-kv-key{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-kv-val{overflow-wrap:anywhere;min-width:0}
.lmv-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere}
.lmv-pre{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:var(--lmv-r-md);background:var(--dsw-alias-bg-layer-2,#2d2d2e);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}
.lmv-prose{display:flex;flex-direction:column;gap:7px;font-size:13px;min-width:0;line-height:1.7}
.lmv-prose-h{margin:6px 0 0;font-size:12.5px;font-weight:620;color:var(--dsw-alias-label-primary,#f0f0f0)}
.lmv-prose-p{margin:0;overflow-wrap:anywhere}
.lmv-prose-ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:3px}

/* ============================================================== feedback === */
.lmv-notice{display:flex;gap:9px;align-items:flex-start;padding:9px 12px;border-radius:var(--lmv-r-md);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere;background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 45%, transparent)}
.lmv-notice-icon{flex:0 0 auto;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 10%, transparent);margin-top:1px}
.lmv-notice-error{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 45%, transparent);color:var(--dsw-alias-state-error-primary,#e5534b);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 9%, transparent)}
.lmv-notice-error .lmv-notice-icon{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 20%, transparent)}
.lmv-notice-warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 45%, transparent);color:var(--dsw-alias-state-warn-primary,#d29922);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 9%, transparent)}
.lmv-notice-warn .lmv-notice-icon{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 20%, transparent)}
.lmv-notice-ok{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 45%, transparent);color:var(--dsw-alias-state-success-primary,#3fb950);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 9%, transparent)}
.lmv-notice-ok .lmv-notice-icon{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 20%, transparent)}
.lmv-empty{padding:18px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-empty-state{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 16px;text-align:center}
.lmv-empty-icon{width:44px;height:44px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a8a8a);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);animation:lmv-float 4s var(--lmv-ease-in-out) 1 both}
@keyframes lmv-float{0%{transform:translateY(0)}38%{transform:translateY(-4px)}100%{transform:translateY(0)}}
.lmv-empty-title{font-size:13px;font-weight:580;color:var(--dsw-alias-label-primary,#e6e6e6);text-wrap:balance}
.lmv-empty-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);max-width:44ch;line-height:1.6}
.lmv-empty-action{margin-top:4px}
.lmv-loading{display:flex;gap:9px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);padding:8px 0}
.lmv-spin{width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,#3a3a3a);border-top-color:var(--dsw-alias-brand-primary,#4a8cff);animation:lmv-spin .75s linear infinite;flex:0 0 auto}
.lmv-backdrop{position:fixed;inset:0;background:color-mix(in srgb, var(--dsw-alias-bg-base,#1e1e1e) 82%, transparent);backdrop-filter:blur(6px) saturate(120%);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px;animation:lmv-fade var(--lmv-base) var(--lmv-ease-out) both}
.lmv-modal{background:var(--dsw-alias-bg-layer-1,#252526);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:var(--lmv-r-xl);max-width:620px;width:100%;max-height:82vh;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#e6e6e6);min-width:0;box-shadow:var(--lmv-shadow-3);animation:lmv-sheet var(--lmv-slow) var(--lmv-ease-spring) both}
.lmv-modal-head{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2e2e);font-size:13.5px;font-weight:620;display:flex;align-items:center;gap:8px}
.lmv-modal-body{padding:16px;overflow:auto;display:flex;flex-direction:column;gap:11px;min-height:0}
.lmv-modal-foot{padding:13px 16px;border-top:1px solid var(--dsw-alias-border-l1,#2e2e2e);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.lmv-toasts{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:8px;z-index:70;max-width:380px;pointer-events:none}
.lmv-toast{pointer-events:auto}
.lmv-toast{display:flex;align-items:flex-start;gap:8px;padding:10px 14px;border-radius:var(--lmv-r-md);font-size:12.5px;background:var(--dsw-alias-bg-layer-2,#2d2d2e);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-primary,#e6e6e6);overflow-wrap:anywhere;box-shadow:var(--lmv-shadow-2);animation:lmv-toast var(--lmv-slow) var(--lmv-ease-spring) both}
.lmv-toast-error{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 55%, transparent);color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-toast-ok{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 55%, transparent);color:var(--dsw-alias-state-success-primary,#3fb950)}
/* Follow-through: the exit is a motion, not a disappearance. */
.lmv-toast-out{animation:lmv-toast-out 260ms var(--lmv-ease-in-out) forwards;pointer-events:none}
@keyframes lmv-toast-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(6px) scale(.98)}}
.lmv-history{display:flex;flex-direction:column;gap:8px}
.lmv-history-item{border-left:2px solid var(--dsw-alias-border-l2,#3a3a3a);padding-left:10px;display:flex;flex-direction:column;gap:3px;font-size:12px;min-width:0}

/* ============================================================== helpers === */
.lmv-hr{height:1px;background:var(--dsw-alias-border-l1,#2e2e2e);border:0;margin:3px 0}
.lmv-wrap{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
.lmv-stack{display:flex;flex-direction:column;gap:10px;min-width:0}
.lmv-grow{flex:1 1 auto;min-width:0}
.lmv-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lmv-sep{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-inline{display:inline-flex;align-items:center;gap:5px;min-width:0}
/* Compatibility: older panes still render these two wrappers. */
.lmv-page-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:12px;padding:2px 24px 34px;overflow:auto}
.lmv-tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center}

/* ============================================================ companion === */
.lmv-life{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:206px minmax(0,1fr);gap:20px;padding:2px 24px 34px;overflow:auto;overscroll-behavior:contain;align-items:start}
.lmv-life-nav{display:flex;flex-direction:column;gap:2px;position:sticky;top:2px;padding:6px;border-radius:var(--lmv-r-md);background:var(--lmv-tray);border:1px solid var(--lmv-border)}
.lmv-life-nav .lmv-nav-btn{justify-content:flex-start;width:100%;padding:7px 10px;border-radius:var(--lmv-r-sm);font-size:12.5px}
.lmv-life-nav .lmv-nav-btn-on{background:var(--lmv-tint);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 34%, transparent);color:var(--dsw-alias-label-primary,#f5f5f5);box-shadow:none}
.lmv-life-nav .lmv-nav-btn-on svg{color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-life-body{min-width:0;display:flex;flex-direction:column;gap:14px;animation:lmv-fade var(--lmv-base) var(--lmv-ease-out) both}
/* Staging (Disney): the pane fades in as a backdrop, then the content rises
   card by card — a wave, not a wall. Replacing the old double-rise. */
.lmv-life-body>*{animation:lmv-rise var(--lmv-slow) var(--lmv-ease-out) both}
.lmv-life-body>*:nth-child(2){animation-delay:30ms}
.lmv-life-body>*:nth-child(3){animation-delay:60ms}
.lmv-life-body>*:nth-child(n+4){animation-delay:90ms}
.lmv-life-lead{display:flex;flex-direction:column;gap:3px;padding:2px 2px 0}
.lmv-life-lead h2{margin:0;font-size:16px;font-weight:640;letter-spacing:-.01em;text-wrap:balance}
.lmv-life-lead p{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.6}

/* Persona: the preview is the content, the form is the editor. */
.lmv-persona-hero{display:flex;gap:14px;align-items:center;padding:14px 16px;border-radius:var(--lmv-r-lg);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:linear-gradient(135deg, var(--lmv-tint), transparent 62%), var(--dsw-alias-bg-layer-1,#252526);min-width:0}
.lmv-avatar{flex:0 0 auto;width:46px;height:46px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary-foreground,#ffffff);background:linear-gradient(160deg, var(--dsw-alias-brand-primary,#4a8cff), color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 45%, var(--dsw-alias-bg-layer-2,#2d2d2e)));box-shadow:var(--lmv-shadow-1)}
.lmv-persona-hero-main{min-width:0;display:flex;flex-direction:column;gap:3px;flex:1 1 auto}
.lmv-persona-name{font-size:15px;font-weight:640;letter-spacing:-.01em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* The unsaved badge pops in — a quiet anticipation beat before the savebar
   rises from below. */
.lmv-persona-hero .lmv-badge-warn{animation:lmv-pop var(--lmv-base) var(--lmv-ease-spring) both}
.lmv-persona-line{font-size:12.5px;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere}
.lmv-preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:9px}
.lmv-preset{appearance:none;font:inherit;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:4px;padding:11px 13px;border-radius:var(--lmv-r-md);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 45%, transparent);color:var(--dsw-alias-label-primary,#e6e6e6);transition:transform var(--lmv-base) var(--lmv-ease-spring),border-color var(--lmv-base) var(--lmv-ease-out),background var(--lmv-base) var(--lmv-ease-out),box-shadow var(--lmv-base) var(--lmv-ease-out);position:relative}
.lmv-preset:hover{transform:translateY(-2px);border-color:var(--dsw-alias-border-l2,#3a3a3a);box-shadow:var(--lmv-shadow-2)}
.lmv-preset:active{transform:translateY(-1px) scale(.99)}
.lmv-preset-on{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 60%, transparent);background:var(--lmv-tint);box-shadow:var(--lmv-shadow-1)}
.lmv-preset-armed{border-color:var(--dsw-alias-state-warn-primary,#d29922);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 10%, transparent)}
.lmv-preset-name{font-size:12.5px;font-weight:620;display:flex;align-items:center;gap:6px}
.lmv-preset-tag{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lmv-preset-flag{font-size:10.5px;font-weight:600;color:var(--dsw-alias-state-warn-primary,#d29922)}
.lmv-anchors{display:flex;flex-direction:column;gap:10px;padding:12px 13px;border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:var(--lmv-r-md);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 40%, transparent)}
.lmv-anchors-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-example{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;padding:9px;border-radius:var(--lmv-r-md);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#252526) 60%, transparent)}
.lmv-example-index{grid-column:1/-1;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-weight:600}
/* Persona preview: two chat bubbles say more than six form fields. */
.lmv-chat{display:flex;flex-direction:column;gap:12px;min-width:0}
.lmv-chat-turn{display:flex;flex-direction:column;gap:5px;min-width:0}
.lmv-bubble{max-width:88%;padding:7px 11px;border-radius:var(--lmv-r-md);font-size:12.5px;line-height:1.65;overflow-wrap:anywhere;white-space:pre-wrap;animation:lmv-pop var(--lmv-base) var(--lmv-ease-spring) both}
.lmv-bubble-user{align-self:flex-start;border-bottom-left-radius:var(--lmv-r-xs);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 78%, transparent);color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-bubble-assistant{align-self:flex-end;border-bottom-right-radius:var(--lmv-r-xs);border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 32%, transparent);background:var(--lmv-tint);color:var(--dsw-alias-label-primary,#e6e6e6);animation-delay:70ms}
/* Self-check rows: a dot carries the severity, so the text stays plain. */
.lmv-check-row{display:flex;gap:9px;align-items:flex-start;padding:8px 11px;border-radius:var(--lmv-r-md);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 42%, transparent);min-width:0}
/* Persona budget: one glance answers "can I still write?". */
.lmv-budget{height:6px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 8%, transparent);overflow:hidden;flex:0 0 auto}
.lmv-budget-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4a8cff);transition:width var(--lmv-base) var(--lmv-ease-out),background var(--lmv-base) var(--lmv-ease-out)}
.lmv-budget-warn .lmv-budget-fill{background:var(--dsw-alias-state-warn-primary,#d29922)}
.lmv-budget-error .lmv-budget-fill{background:var(--dsw-alias-state-error-primary,#e5534b)}
/* Collapsible group heads (settled reminders): clickable, quiet until hovered. */
button.lmv-kicker-toggle{appearance:none;font:inherit;cursor:pointer;background:transparent;border:0;padding:0;text-align:left}
button.lmv-kicker-toggle:hover{color:var(--dsw-alias-label-primary,#f5f5f5)}
button.lmv-kicker-toggle:hover .lmv-kicker-count{background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 18%, transparent)}
.lmv-check-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;margin-top:5px;background:var(--dsw-alias-label-tertiary,#8a8a8a)}
/* An accepted suggestion is settled, not pending: green, no pulse. */
.lmv-check-dot-ok{background:var(--dsw-alias-state-success-primary,#3fb950)}
.lmv-check-error{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 42%, transparent)}
.lmv-check-error .lmv-check-dot{background:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-check-warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 40%, transparent)}
.lmv-check-warn .lmv-check-dot{background:var(--dsw-alias-state-warn-primary,#d29922)}
.lmv-check-tip .lmv-check-dot{background:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-check-title{display:block;font-size:12.5px;font-weight:580;line-height:1.5}
.lmv-check-hint{display:block;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.55}

/* Stickers: a library, so a grid with real previews. */
.lmv-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:18px;border-radius:var(--lmv-r-lg);border:1.5px dashed var(--dsw-alias-border-l2,#3a3a3a);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 30%, transparent);text-align:center;transition:border-color var(--lmv-base) var(--lmv-ease-out),background var(--lmv-base) var(--lmv-ease-out),transform var(--lmv-fast) var(--lmv-ease-out);cursor:pointer}
.lmv-drop:hover{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 55%, transparent);background:var(--lmv-tint)}
.lmv-drop-on{border-color:var(--dsw-alias-brand-primary,#4a8cff);background:var(--lmv-tint-strong);transform:scale(1.004)}
.lmv-drop-title{font-size:12.5px;font-weight:580;color:var(--dsw-alias-label-primary,#e6e6e6)}
/* Once the library has content the drop zone is a secondary action, not an
   onboarding hero: collapse it to one quiet row so the stickers start higher. */
.lmv-drop-compact{flex-direction:row;justify-content:flex-start;align-items:center;text-align:left;padding:10px 14px;gap:10px;border-style:solid;border-width:1px;border-color:var(--lmv-border)}
.lmv-drop-compact .lmv-drop-hint{display:none}
.lmv-drop-compact .lmv-drop-title::before{content:"+";margin-right:8px;font-weight:600;color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-drop-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-seg{display:inline-flex;padding:3px;gap:2px;border-radius:var(--lmv-r-sm);background:var(--lmv-tray);border:1px solid var(--lmv-border)}
.lmv-seg-btn{appearance:none;font:inherit;font-size:11.5px;padding:3px 10px;border-radius:var(--lmv-r-xs);border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer;transition:background var(--lmv-fast) var(--lmv-ease-out),color var(--lmv-fast) var(--lmv-ease-out),transform var(--lmv-fast) var(--lmv-ease-out)}
.lmv-seg-btn:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.lmv-seg-btn:active{transform:scale(.95)}
.lmv-seg-btn-on{background:var(--dsw-alias-bg-layer-1,#252526);color:var(--dsw-alias-label-primary,#f5f5f5);box-shadow:var(--lmv-shadow-1)}
.lmv-sticker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.lmv-sticker{display:flex;flex-direction:column;gap:8px;padding:9px;border-radius:var(--lmv-r-md);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 42%, transparent);min-width:0;transition:transform var(--lmv-base) var(--lmv-ease-spring),border-color var(--lmv-base) var(--lmv-ease-out),box-shadow var(--lmv-base) var(--lmv-ease-out);animation:lmv-slide-in var(--lmv-base) var(--lmv-ease-out) both}
/* Entrance wave across the grid: one delay step per tile, capped so a big
   library does not turn into a slow parade. */
.lmv-sticker:nth-child(2){animation-delay:20ms}
.lmv-sticker:nth-child(3){animation-delay:40ms}
.lmv-sticker:nth-child(4){animation-delay:60ms}
.lmv-sticker:nth-child(5){animation-delay:80ms}
.lmv-sticker:nth-child(6){animation-delay:100ms}
.lmv-sticker:nth-child(7){animation-delay:120ms}
.lmv-sticker:nth-child(n+8){animation-delay:140ms}
.lmv-sticker:hover{transform:translateY(-2px);border-color:var(--dsw-alias-border-l2,#3a3a3a);box-shadow:var(--lmv-shadow-2)}
.lmv-sticker-off{opacity:.55}
.lmv-sticker-art{position:relative;aspect-ratio:1/1;border-radius:var(--lmv-r-sm);background:repeating-conic-gradient(color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent) 0% 25%, transparent 0% 50%) 50%/14px 14px;display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-sticker-art img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.lmv-sticker-ext{position:absolute;right:4px;bottom:4px;font-size:9.5px;letter-spacing:.05em;padding:0 4px;border-radius:4px;background:color-mix(in srgb, var(--dsw-alias-bg-base,#1e1e1e) 78%, transparent);color:var(--dsw-alias-label-tertiary,#8a8a8a);text-transform:uppercase}
.lmv-sticker-name{font-size:11.5px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-sticker-tags{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:14px}
/* Provenance chip: quiet enough to ignore, precise enough to explain where a
   sticker came from. Tint only — no icon, no border, no shouting. */
.lmv-src{display:inline-block;margin-right:6px;padding:0 5px;border-radius:4px;font-size:9.5px;line-height:15px;letter-spacing:.02em;vertical-align:1px;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 10%, transparent);color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-src-incoming{background:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 20%, transparent);color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 55%, var(--dsw-alias-label-primary,#e6e6e6))}
.lmv-src-stolen{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 20%, transparent);color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 62%, var(--dsw-alias-label-primary,#e6e6e6))}
.lmv-sticker-foot{display:flex;align-items:center;gap:4px;justify-content:space-between}
.lmv-sticker-actions{display:flex;gap:2px;align-items:center}
.lmv-sticker-actions .lmv-btn{min-height:24px;padding:2px 6px;font-size:11px}
.lmv-sticker-edit{display:flex;flex-direction:column;gap:5px;min-width:0}
.lmv-sticker-edit .lmv-input{min-height:26px;font-size:11.5px;padding:3px 7px;border-radius:var(--lmv-r-xs)}

/* Settings: the save action follows you to the bottom of the page. */
.lmv-savebar{position:sticky;bottom:6px;display:flex;gap:9px;align-items:center;padding:9px 13px;border-radius:var(--lmv-r-md);border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 36%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#252526) 93%, transparent);backdrop-filter:blur(8px);box-shadow:var(--lmv-shadow-2);z-index:4;font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);min-width:0;animation:lmv-sheet var(--lmv-slow) var(--lmv-ease-spring) both}
.lmv-savebar-idle{border-color:var(--dsw-alias-border-l1,#2e2e2e);box-shadow:none;color:var(--dsw-alias-label-tertiary,#8a8a8a)}

/* Collapse: height transitions via grid rows — any content, no measuring.
   Visibility is delayed on close so the content stays paintable through the
   exit (and unfocusable the moment it is shut). */
.lmv-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows var(--lmv-base) var(--lmv-ease-in-out)}
.lmv-collapse-open{grid-template-rows:1fr}
.lmv-collapse-inner{overflow:hidden;min-height:0;visibility:hidden;transition:visibility 0s linear var(--lmv-base)}
.lmv-collapse-open .lmv-collapse-inner{visibility:visible;transition:visibility 0s}

/* Detail: title and the one contextual action share a head band. */
.lmv-detail-head{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:var(--lmv-r-lg);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:linear-gradient(132deg, var(--lmv-tint), transparent 58%), var(--dsw-alias-bg-layer-1,#252526);min-width:0;box-shadow:var(--lmv-shadow-1)}
.lmv-detail-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:5px}
.lmv-detail-title{margin:0;font-size:17px;line-height:1.35;font-weight:640;letter-spacing:-.012em;overflow-wrap:anywhere;text-wrap:balance}
.lmv-detail-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.lmv-action-group{display:flex;flex-direction:column;gap:7px;min-width:0}
.lmv-action-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center;min-width:0}
.lmv-action-row .lmv-btn{min-height:26px;padding:3px 10px;font-size:11.5px;border-radius:var(--lmv-r-xs)}

/* Reminders: one capture field, one list, actions on hover. */.lmv-capture{display:flex;gap:9px;align-items:center}
.lmv-capture .lmv-input{flex:1 1 auto;min-height:40px;font-size:14px;border-radius:var(--lmv-r-md);padding:8px 12px}
.lmv-capture .lmv-btn{min-height:40px;padding:0 16px;border-radius:var(--lmv-r-md)}
.lmv-chipbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:20px}
/* One row, scrolled: twelve chips over two rows pushed the library itself below
   the fold, which is the opposite of what this card is for. */
.lmv-chipbar-scroll{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding-bottom:2px}
.lmv-chipbar-scroll::-webkit-scrollbar{display:none}
.lmv-chipbar-scroll .lmv-kicker{position:sticky;left:0;flex:0 0 auto;padding-right:6px;background:var(--dsw-alias-bg-layer-1,#252526)}
.lmv-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:2px 9px;border-radius:999px;background:var(--lmv-tint);border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 38%, transparent);color:var(--dsw-alias-brand-primary,#4a8cff);animation:lmv-pop var(--lmv-base) var(--lmv-ease-spring) both}
.lmv-chip-warn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 40%, transparent);color:var(--dsw-alias-state-warn-primary,#d29922)}
button.lmv-chip{cursor:pointer;font:inherit;font-size:11.5px;transition:background var(--lmv-fast) var(--lmv-ease-out),border-color var(--lmv-fast) var(--lmv-ease-out),transform var(--lmv-fast) var(--lmv-ease-out)}
button.lmv-chip:hover{background:var(--lmv-tint-strong)}
button.lmv-chip:active{transform:scale(.95)}
button.lmv-chip.lmv-chip-warn:hover{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 20%, transparent)}
.lmv-reminder{display:flex;gap:11px;align-items:center;padding:11px 13px;border-radius:var(--lmv-r-md);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 42%, transparent);transition:border-color var(--lmv-base) var(--lmv-ease-out),background var(--lmv-base) var(--lmv-ease-out);animation:lmv-slide-in var(--lmv-base) var(--lmv-ease-out) both}
.lmv-reminder:hover{border-color:var(--dsw-alias-border-l2,#3a3a3a);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#2d2d2e) 62%, transparent)}
.lmv-reminder-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4a8cff);box-shadow:0 0 0 3px var(--lmv-tint)}
.lmv-reminder-soon .lmv-reminder-dot{background:var(--dsw-alias-state-warn-primary,#d29922);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 18%, transparent)}
.lmv-reminder-overdue .lmv-reminder-dot{background:var(--dsw-alias-state-error-primary,#e5534b);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5534b) 18%, transparent)}
.lmv-reminder-done .lmv-reminder-dot{background:var(--dsw-alias-label-tertiary,#8a8a8a);box-shadow:none}
.lmv-reminder-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.lmv-reminder-title{font-size:13px;font-weight:540;overflow-wrap:anywhere}
.lmv-reminder-done .lmv-reminder-title{color:var(--dsw-alias-label-tertiary,#8a8a8a);text-decoration:line-through}
.lmv-reminder-when{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.lmv-reminder-due{color:var(--dsw-alias-label-secondary,#b8b8b8);font-variant-numeric:tabular-nums}
.lmv-reminder-overdue .lmv-reminder-due{color:var(--dsw-alias-state-error-primary,#e5534b);font-weight:560}
/* How overdue a reminder is, in days. This class existed in the markup with no
   rule behind it, so the one number that says "this is bad now" rendered as
   ordinary grey text. */
.lmv-reminder-late{color:var(--dsw-alias-state-error-primary,#e5534b);font-weight:560;font-variant-numeric:tabular-nums}
.lmv-reminder-actions{display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end;opacity:.55;transition:opacity var(--lmv-base) var(--lmv-ease-out)}
.lmv-reminder:hover .lmv-reminder-actions,.lmv-reminder:focus-within .lmv-reminder-actions{opacity:1}

/* QQ matrix keeps its own dense table. */
.lmv-qq-group{display:flex;flex-direction:column;gap:9px;min-width:0}
.lmv-qq-evidence{font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere;min-width:0}
.lmv-qq-matrix-wrap{overflow-x:auto;min-width:0}
.lmv-qq-matrix{display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(100px,.9fr) minmax(130px,1.1fr) repeat(3,minmax(76px,.6fr));gap:7px 10px;align-items:center;min-width:560px;font-size:12px}
.lmv-qq-matrix-head{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;font-weight:600}
.lmv-qq-cell{min-width:0;overflow-wrap:anywhere}

/* ============================================================== motion === */
@keyframes lmv-fade{from{opacity:0}to{opacity:1}}
@keyframes lmv-rise{from{opacity:0;transform:translateY(7px) scale(.995)}to{opacity:1;transform:none}}
@keyframes lmv-pop{0%{opacity:0;transform:scale(.94)}62%{opacity:1;transform:scale(1.015)}100%{transform:scale(1)}}
@keyframes lmv-toast{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
@keyframes lmv-sheet{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@keyframes lmv-spin{to{transform:rotate(360deg)}}
@keyframes lmv-grow{from{transform:scaleX(.02)}to{transform:scaleX(1)}}

/* Coarse pointers get real hit targets. Desktop keeps its density. */
@media (pointer:coarse){
  .lmv-btn,.lmv-btn-sm{min-height:34px;padding:6px 12px}
  .lmv-icon-btn{width:34px;min-height:34px}
  .lmv-nav-btn{padding:8px 13px}
  .lmv-sticker-actions .lmv-btn{min-height:32px;padding:4px 8px}
  .lmv-seg-btn{padding:6px 11px}
  .lmv-reminder-actions{opacity:1}
}
/* No hover: hover-revealed actions must simply be visible. */
@media (hover:none){
  .lmv-reminder-actions{opacity:1}
}
@media (max-width:720px){
  .lmv-head{padding:14px 16px 8px;align-items:flex-start;flex-direction:column;gap:10px}
  .lmv-head-actions{margin-left:0}
  .lmv-nav{margin:0 16px 10px}
  .lmv-main{padding:2px 16px 32px}
  .lmv-life{grid-template-columns:minmax(0,1fr);padding:2px 16px 28px;gap:12px}
  .lmv-nav{-webkit-mask-image:linear-gradient(90deg,transparent 0,black 12px,black calc(100% - 12px),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,black 12px,black calc(100% - 12px),transparent 100%)}
  .lmv-life-nav{position:static;flex-direction:row;flex-wrap:wrap}
  .lmv-life-nav .lmv-nav-btn{width:auto}
  .lmv-example{grid-template-columns:minmax(0,1fr)}
  .lmv-health{order:2}
  .lmv-hero{padding:14px;gap:12px}
  .lmv-hero-actions{justify-content:flex-start;width:100%}
}
@media (prefers-reduced-motion:reduce){
  .lmv-page *,.lmv-page *::before,.lmv-page *::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}
  .lmv-main>*,.lmv-life-body>*,.lmv-row,.lmv-sticker,.lmv-reminder{animation:none}
  /* The collapse relies on a delayed visibility flip; without the delay an
     opened panel would be visible for one frame while still height:0. */
  .lmv-collapse-inner{transition:visibility 0s linear .15s!important}
  .lmv-collapse-open .lmv-collapse-inner{transition-delay:0s!important}
  .lmv-skel::after{animation:none;opacity:0}
}
`
