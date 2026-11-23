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

/* ================================================================= links === */
/* Memory Graph workbench.

   The page is a three-column tool, not a dashboard: a filter rail, the canvas
   (the only place allowed to be dramatic) and a detail rail. Surfaces are mixed
   from the label colour so one rule works on both themes; the canvas gets depth
   from a faint dotted field and a single low-opacity brand wash, never glow or
   particles. */
.lmv-wb{flex:1 1 auto;min-height:0;min-width:0;display:flex;flex-direction:column;gap:10px;padding:2px 14px 14px;overflow:hidden;position:relative}
.lmv-wb-state{justify-content:center;align-items:stretch;overflow:auto;padding:24px}
.lmv-wb-empty{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;border-radius:var(--lmv-r-lg);border:1px solid var(--lmv-border);background:var(--lmv-tray)}

/* Top bar: identity, search, scope and the two page-level modes. */
.lmv-wb-top{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:var(--lmv-r-lg);background:var(--lmv-tray);border:1px solid var(--lmv-border);min-width:0;flex-wrap:wrap}
.lmv-wb-ident{display:flex;flex-direction:column;gap:0;min-width:0;flex:0 1 auto;max-width:230px}
.lmv-wb-title{font-size:16px;font-weight:650;line-height:1.25;letter-spacing:-.012em}
.lmv-wb-subtitle{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-wb-stat{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-wb-search{position:relative;flex:1 1 220px;min-width:170px;max-width:390px;display:flex;align-items:center}
.lmv-wb-search .lmv-input{padding-left:29px;padding-right:28px;height:30px}
.lmv-wb-search-icon{position:absolute;left:9px;top:50%;transform:translateY(-50%);display:inline-flex;color:var(--dsw-alias-label-tertiary,#8a8a8a);pointer-events:none}
.lmv-wb-search-clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;cursor:pointer}
.lmv-wb-search-clear:hover{color:var(--dsw-alias-label-primary,#e6e6e6);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 7%, transparent)}
.lmv-wb-search-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:30;display:flex;flex-direction:column;gap:2px;padding:5px;border-radius:var(--lmv-r-md);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#252526) 97%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 14%, transparent);box-shadow:var(--lmv-shadow-2);backdrop-filter:blur(12px) saturate(130%)}
.lmv-wb-search-empty{padding:9px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-wb-search-item{appearance:none;font:inherit;text-align:left;display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--lmv-r-sm);border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;min-width:0}
.lmv-wb-search-item:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent);border-color:var(--lmv-border)}
.lmv-wb-search-item-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.lmv-wb-search-item-title{font-size:12px;font-weight:540;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-wb-search-item-meta{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}
.lmv-wb-search-hint{padding:3px 8px 2px;font-size:9.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);border-top:1px solid var(--lmv-border);margin-top:2px}
.lmv-wb-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.lmv-wb-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 5%, transparent);border:1px solid var(--lmv-border)}
.lmv-wb-seg-block{display:flex;width:100%;border-radius:var(--lmv-r-sm);padding:3px}
.lmv-wb-seg-btn{appearance:none;font:inherit;font-size:11px;font-weight:500;padding:3px 9px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer;transition:color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-fast) var(--lmv-ease-out)}
.lmv-wb-seg-block .lmv-wb-seg-btn{flex:1 1 0;border-radius:var(--lmv-r-xs);padding:4px 5px;text-align:center}
.lmv-wb-seg-btn:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.lmv-wb-seg-btn.is-on{background:var(--dsw-alias-bg-layer-2,#2d2d2e);color:var(--dsw-alias-label-primary,#f2f2f2);box-shadow:var(--lmv-shadow-1)}
.lmv-wb-chip-btn{appearance:none;font:inherit;font-size:11.5px;font-weight:500;display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;border:1px solid var(--lmv-border);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 3%, transparent);color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;transition:color var(--lmv-fast) var(--lmv-ease-out),border-color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-fast) var(--lmv-ease-out)}
.lmv-wb-chip-btn:hover{color:var(--dsw-alias-label-primary,#f2f2f2);border-color:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 24%, transparent)}
.lmv-wb-chip-btn.is-on{color:var(--dsw-alias-brand-primary,#4a8cff);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 44%, transparent);background:var(--lmv-tint)}
.lmv-wb-icon-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);width:26px;height:26px;border-radius:var(--lmv-r-sm);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;transition:color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-fast) var(--lmv-ease-out)}
.lmv-wb-icon-btn:hover{color:var(--dsw-alias-label-primary,#e6e6e6);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 7%, transparent)}
.lmv-wb-only-narrow{display:none}

/* Three columns. Everything inside is min-height:0 so the rails scroll rather
   than push the canvas or overflow the window. */
.lmv-wb-cols{position:relative;flex:1 1 auto;min-height:0;min-width:0;display:grid;grid-template-columns:232px minmax(0,1fr) 312px;gap:10px;overflow:hidden}

/* ------------------------------------------------------------ filter rail */
.lmv-wb-left,.lmv-wb-right{display:flex;flex-direction:column;min-height:0;min-width:0;border-radius:var(--lmv-r-lg);border:1px solid var(--lmv-border);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#252526) 86%, transparent);box-shadow:var(--lmv-shadow-1);overflow:hidden}
.lmv-wb-left-head,.lmv-wb-right-head{flex:0 0 auto;display:flex;align-items:center;gap:7px;padding:11px 12px 7px;min-width:0}
.lmv-wb-rail-title{font-size:13px;font-weight:620;letter-spacing:-.005em;margin-right:auto}
.lmv-wb-facets{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 11px 10px;display:flex;flex-direction:column;gap:13px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 16%, transparent) transparent}
.lmv-wb-facet{display:flex;flex-direction:column;gap:6px;min-width:0}
.lmv-wb-chips{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.lmv-wb-chip{appearance:none;font:inherit;font-size:11px;line-height:1.4;display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;border:1px solid var(--lmv-border);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 3%, transparent);color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;max-width:100%;min-width:0;transition:color var(--lmv-fast) var(--lmv-ease-out),border-color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-fast) var(--lmv-ease-out)}
.lmv-wb-chip:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 22%, transparent)}
.lmv-wb-chip.is-on{color:var(--dsw-alias-label-primary,#f2f2f2);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 52%, transparent);background:var(--lmv-tint)}
.lmv-wb-chip-count{font-size:9.5px;font-weight:600;padding:0 4px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 8%, transparent);color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}
.lmv-wb-dot{width:6.5px;height:6.5px;border-radius:50%;background:var(--lmv-tone, var(--dsw-alias-label-tertiary,#8a8a8a));flex:0 0 auto}
.lmv-wb-switch{appearance:none;font:inherit;font-size:11px;display:flex;align-items:center;gap:7px;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);text-align:left;cursor:pointer;min-width:0}
.lmv-wb-switch:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.lmv-wb-switch-track{position:relative;width:27px;height:15px;border-radius:999px;border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 20%, transparent);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent);flex:0 0 auto;transition:background var(--lmv-base) var(--lmv-ease-out),border-color var(--lmv-base) var(--lmv-ease-out)}
.lmv-wb-switch-track span{position:absolute;top:2px;left:2px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8a8a);transition:left var(--lmv-base) var(--lmv-ease-spring),background var(--lmv-base) var(--lmv-ease-out)}
.lmv-wb-switch.is-on .lmv-wb-switch-track{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 48%, transparent);background:var(--lmv-tint)}
.lmv-wb-switch.is-on .lmv-wb-switch-track span{left:13px;background:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-wb-struct{display:flex;flex-direction:column;gap:1px}
.lmv-wb-struct-row{appearance:none;font:inherit;font-size:11.5px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;border:1px solid transparent;border-radius:var(--lmv-r-xs);background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;transition:background var(--lmv-fast) var(--lmv-ease-out)}
.lmv-wb-struct-row:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent)}
.lmv-wb-struct-row span:last-child{font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-wb-struct-row.is-on{color:var(--dsw-alias-label-primary,#f2f2f2);background:var(--lmv-tint);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 32%, transparent)}
.lmv-wb-hint{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8a8a);min-width:0}
.lmv-wb-left-foot{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:9px 11px 11px;border-top:1px solid var(--lmv-border);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 2%, transparent)}
.lmv-wb-mini-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.lmv-wb-mini-stat{display:flex;flex-direction:column;gap:0;min-width:0;padding:3px 4px;border-radius:var(--lmv-r-xs);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 3.5%, transparent)}
.lmv-wb-mini-stat b{font-size:12.5px;font-weight:620;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6)}
.lmv-wb-mini-stat span{font-size:9px;line-height:1.25;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-wb-foot-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}

/* ----------------------------------------------------------- node tones */
/* One custom property per type family keeps the node, the legend dot and the
   filter chip in sync while leaving the text neutral. */
.lmv-wb-tone-blue{--lmv-tone:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 74%, var(--dsw-alias-label-secondary,#b8b8b8))}
.lmv-wb-tone-green{--lmv-tone:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 66%, var(--dsw-alias-label-secondary,#b8b8b8))}
.lmv-wb-tone-amber{--lmv-tone:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 72%, var(--dsw-alias-label-secondary,#b8b8b8))}
.lmv-wb-tone-orange{--lmv-tone:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 38%, var(--dsw-alias-state-error-primary,#e5534b))}
.lmv-wb-tone-teal{--lmv-tone:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 48%, var(--dsw-alias-state-success-primary,#3fb950))}
.lmv-wb-tone-violet{--lmv-tone:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 62%, var(--dsw-alias-state-error-primary,#e5534b))}
.lmv-wb-tone-muted{--lmv-tone:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 46%, transparent)}

/* ---------------------------------------------------------------- canvas */
.lmv-wb-stage{position:relative;min-width:0;min-height:0;border-radius:var(--lmv-r-lg);border:1px solid var(--lmv-border);overflow:hidden;background:
  radial-gradient(68% 56% at 50% 42%, color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 6%, transparent), transparent 72%),
  radial-gradient(120% 90% at 50% 110%, color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 3%, transparent), transparent 70%),
  var(--dsw-alias-bg-base,#1e1e1e);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 3%, transparent),var(--lmv-shadow-1)}
.lmv-wb-stage::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.55;background-image:radial-gradient(circle, color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 11%, transparent) .7px, transparent 1px);background-size:26px 26px;-webkit-mask-image:radial-gradient(ellipse at 50% 45%, black 26%, transparent 82%);mask-image:radial-gradient(ellipse at 50% 45%, black 26%, transparent 82%)}
.lmv-wb-svg{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;user-select:none}
.lmv-wb-bg{fill:transparent;cursor:grab}
.lmv-wb-bg:active{cursor:grabbing}
.lmv-wb-viewport{transform-origin:0 0}
.lmv-wb-viewport.is-animating{transition:transform 320ms var(--lmv-ease-out)}
.lmv-wb-arrow-shape{fill:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 68%, transparent)}

/* Edges stay under the nodes: thin, low contrast, and only the selected
   neighbourhood receives the accent colour. */
.lmv-wb-edge{fill:none;stroke:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 22%, transparent);stroke-width:1;pointer-events:none;transition:stroke 200ms var(--lmv-ease-out),opacity 200ms var(--lmv-ease-out),stroke-width 200ms var(--lmv-ease-out)}
.lmv-wb-edge.is-auto{stroke:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 30%, transparent);stroke-dasharray:3 4}
.lmv-wb-edge.is-derived{stroke:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 23%, transparent);stroke-dasharray:1 5;stroke-linecap:round}
.lmv-wb-edge.is-hot{stroke:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 64%, transparent);stroke-width:1.5}
.lmv-wb-edge.is-path{stroke:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 82%, transparent);stroke-width:2.2;stroke-dasharray:none}
.lmv-wb-edge.is-dim{opacity:.1}

.lmv-wb-hull{fill:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 1.4%, transparent);stroke:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 5%, transparent);stroke-width:1;stroke-linejoin:round;cursor:pointer;transition:fill var(--lmv-base) var(--lmv-ease-out),stroke var(--lmv-base) var(--lmv-ease-out)}
.lmv-wb-hull:hover{fill:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 3.5%, transparent);stroke:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 11%, transparent)}

.lmv-wb-node{color:var(--lmv-tone, var(--dsw-alias-label-secondary,#b8b8b8));cursor:pointer;outline:none;transition:opacity 180ms var(--lmv-ease-out)}
.lmv-wb-halo{fill:currentColor;opacity:.045;transition:opacity 180ms var(--lmv-ease-out)}
.lmv-wb-core{fill:color-mix(in srgb, currentColor 30%, var(--dsw-alias-bg-base,#1e1e1e));stroke:color-mix(in srgb, currentColor 76%, transparent);stroke-width:1.1;transition:fill 180ms var(--lmv-ease-out),stroke 180ms var(--lmv-ease-out),stroke-width 180ms var(--lmv-ease-out)}
.lmv-wb-ring{fill:none;stroke:currentColor;stroke-width:1.2;opacity:.6;stroke-dasharray:2 3;pointer-events:none}
.lmv-wb-hollow{fill:none;stroke:color-mix(in srgb, currentColor 60%, transparent);stroke-width:1;stroke-dasharray:2 3;pointer-events:none}
.lmv-wb-node:hover .lmv-wb-halo,.lmv-wb-node.is-hover .lmv-wb-halo,.lmv-wb-node:focus-visible .lmv-wb-halo{opacity:.16}
.lmv-wb-node:hover .lmv-wb-core,.lmv-wb-node.is-hover .lmv-wb-core,.lmv-wb-node.is-neighbour .lmv-wb-core{stroke:currentColor;fill:color-mix(in srgb, currentColor 46%, var(--dsw-alias-bg-base,#1e1e1e))}
.lmv-wb-node.is-selected .lmv-wb-core{fill:color-mix(in srgb, currentColor 62%, var(--dsw-alias-bg-base,#1e1e1e));stroke:currentColor;stroke-width:1.5}
.lmv-wb-node.is-match .lmv-wb-core{stroke-width:1.8}
.lmv-wb-node.is-path .lmv-wb-core{stroke:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 86%, currentColor);stroke-width:1.9}
.lmv-wb-node.is-dim{opacity:.14}
.lmv-wb-node:focus-visible .lmv-wb-core{stroke-width:2.2}
.lmv-wb-label{font-size:11.5px;font-weight:500;letter-spacing:.004em;text-anchor:middle;fill:var(--dsw-alias-label-secondary,#b8b8b8);paint-order:stroke;stroke:var(--dsw-alias-bg-base,#1e1e1e);stroke-width:3.4px;stroke-linejoin:round;pointer-events:none}
.lmv-wb-node.is-selected .lmv-wb-label,.lmv-wb-node.is-hover .lmv-wb-label{fill:var(--dsw-alias-label-primary,#f2f2f2);font-weight:620;font-size:12px}
.lmv-wb-label-hint{fill:var(--dsw-alias-label-tertiary,#8a8a8a)!important;font-weight:450;font-size:10.5px}

/* Overlay chrome: legend, zoom, banners. */
.lmv-wb-legend{position:absolute;left:11px;bottom:10px;z-index:4;display:flex;align-items:center;gap:11px;flex-wrap:wrap;pointer-events:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);padding:4px 9px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-bg-base,#1e1e1e) 62%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 7%, transparent);backdrop-filter:blur(8px)}
.lmv-wb-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.lmv-wb-legend-line{display:inline-block;width:17px;height:0;border-top:1px solid color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 42%, transparent)}
.lmv-wb-legend-line.is-auto{border-top-style:dashed}
.lmv-wb-legend-line.is-derived{border-top-style:dotted}
.lmv-wb-legend-hollow{width:7px;height:7px;border-radius:50%;border:1px dashed color-mix(in srgb, var(--dsw-alias-label-secondary,#b8b8b8) 58%, transparent)}
.lmv-wb-zoombar{position:absolute;right:11px;bottom:11px;z-index:4;display:flex;flex-direction:column;gap:1px;padding:3px;border-radius:var(--lmv-r-md);background:color-mix(in srgb, var(--dsw-alias-bg-base,#1e1e1e) 66%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 9%, transparent);backdrop-filter:blur(10px) saturate(120%);box-shadow:var(--lmv-shadow-1)}
.lmv-wb-zoombar button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);width:27px;height:27px;border-radius:var(--lmv-r-xs);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:color var(--lmv-fast) var(--lmv-ease-out),background var(--lmv-fast) var(--lmv-ease-out)}
.lmv-wb-zoombar button:hover{color:var(--dsw-alias-label-primary,#f2f2f2);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 9%, transparent)}
.lmv-wb-note{position:absolute;z-index:4;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);pointer-events:none;padding:3px 8px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-bg-base,#1e1e1e) 62%, transparent);border:1px solid var(--lmv-border)}
.lmv-wb-note-top{right:11px;top:11px}
.lmv-wb-compat-chip{position:absolute;left:11px;top:11px;z-index:4;font-size:10px;padding:3px 8px;border-radius:999px;color:var(--dsw-alias-state-warn-primary,#d29922);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 12%, var(--dsw-alias-bg-base,#1e1e1e));border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 38%, transparent);cursor:help}
.lmv-wb-pathbar{position:absolute;left:50%;top:11px;transform:translateX(-50%);z-index:5;display:flex;align-items:center;gap:8px;padding:5px 6px 5px 11px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#252526) 94%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 34%, transparent);box-shadow:var(--lmv-shadow-2);font-size:11px;color:var(--dsw-alias-label-secondary,#b8b8b8);max-width:calc(100% - 24px);backdrop-filter:blur(10px)}
.lmv-wb-pathbar svg{color:var(--dsw-alias-brand-primary,#4a8cff);flex:0 0 auto}
.lmv-wb-pathbar-clear{appearance:none;font:inherit;font-size:10.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--lmv-border);background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer;white-space:nowrap}
.lmv-wb-pathbar-clear:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 24%, transparent)}
.lmv-wb-stage.is-compat .lmv-wb-zero,.lmv-wb-stage.is-compat .lmv-wb-pathbar{top:44px}
.lmv-wb-zero{position:absolute;left:50%;top:11px;transform:translateX(-50%);z-index:4;display:flex;align-items:center;gap:12px;padding:8px 10px 8px 12px;border-radius:var(--lmv-r-md);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#252526) 94%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 12%, transparent);box-shadow:var(--lmv-shadow-2);max-width:calc(100% - 30px);backdrop-filter:blur(10px)}
.lmv-wb-zero-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.lmv-wb-zero-text b{font-size:11.5px;font-weight:620;color:var(--dsw-alias-label-primary,#e6e6e6);white-space:nowrap}
.lmv-wb-zero-text span{font-size:10px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.lmv-wb-no-results{position:absolute;inset:0;z-index:4;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:none}
.lmv-wb-tip{position:absolute;z-index:6;transform:translate(-50%,calc(-100% - 14px));pointer-events:none;display:flex;flex-direction:column;gap:2px;max-width:270px;padding:8px 10px;border-radius:var(--lmv-r-md);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#252526) 96%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 15%, transparent);box-shadow:var(--lmv-shadow-2);backdrop-filter:blur(12px) saturate(130%)}
.lmv-wb-tip.is-below{transform:translate(-50%,16px)}
.lmv-wb-tip-title{font-size:12px;font-weight:620;overflow-wrap:anywhere}
.lmv-wb-tip-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-wb-tip-preview{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary,#b8b8b8);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.lmv-wb-tip-hint{font-size:9.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);opacity:.85}

/* --------------------------------------------------------------- details */
.lmv-wb-detail{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 13px 15px;display:flex;flex-direction:column;gap:9px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 16%, transparent) transparent}
.lmv-wb-detail-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:18px 0}
.lmv-wb-detail-title-row{display:flex;align-items:flex-start;gap:8px;min-width:0}
.lmv-wb-detail-title{font-size:15.5px;font-weight:640;line-height:1.35;letter-spacing:-.01em;margin:0;overflow-wrap:anywhere;min-width:0}
.lmv-wb-detail-title-row .lmv-wb-dot{margin-top:7px}
.lmv-wb-detail-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.lmv-wb-detail-preview{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#b8b8b8);margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.lmv-wb-detail-meta{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}
.lmv-wb-detail-tags{display:flex;flex-wrap:wrap;gap:3px}
.lmv-wb-tag{appearance:none;font:inherit;font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 28%, transparent);background:var(--lmv-tint);color:var(--dsw-alias-brand-primary,#4a8cff);cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-wb-tag:hover{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#4a8cff) 56%, transparent)}
.lmv-wb-detail-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:7px 0;border-top:1px solid var(--lmv-border);border-bottom:1px solid var(--lmv-border)}
.lmv-wb-detail-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.lmv-wb-rel-group{display:flex;flex-direction:column;gap:4px;padding-top:7px;border-top:1px solid var(--lmv-border);min-width:0}
.lmv-wb-rel-head{display:flex;align-items:center;gap:6px}
.lmv-wb-rel-list{display:flex;flex-direction:column;gap:1px}
.lmv-wb-rel{appearance:none;font:inherit;text-align:left;display:flex;align-items:flex-start;gap:7px;padding:5px 6px;border-radius:var(--lmv-r-xs);border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;min-width:0;transition:background var(--lmv-fast) var(--lmv-ease-out),border-color var(--lmv-fast) var(--lmv-ease-out)}
.lmv-wb-rel:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent);border-color:var(--lmv-border)}
.lmv-wb-rel-dir{flex:0 0 auto;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-wb-rel-dir-out{color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-wb-rel-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.lmv-wb-rel-title{display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:540;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-wb-rel-meta{font-size:10px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#8a8a8a);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.lmv-wb-badge{flex:0 0 auto;font-size:8.5px;font-weight:600;line-height:1.5;padding:0 4px;border-radius:999px;color:var(--dsw-alias-label-tertiary,#8a8a8a);background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 8%, transparent)}
.lmv-wb-path-panel{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:var(--lmv-r-md);background:var(--lmv-tray);border:1px solid var(--lmv-border)}
.lmv-wb-path-count{font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-wb-path-list{display:flex;flex-direction:column;gap:2px;max-height:190px;overflow:auto}
.lmv-wb-path-node{appearance:none;font:inherit;font-size:11px;text-align:left;display:flex;align-items:center;gap:7px;padding:3px 5px;border:1px solid transparent;border-radius:var(--lmv-r-xs);background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;min-width:0}
.lmv-wb-path-node:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary,#e6e6e6) 6%, transparent);border-color:var(--lmv-border);color:var(--dsw-alias-label-primary,#e6e6e6)}
.lmv-wb-path-index{flex:0 0 auto;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;background:var(--lmv-tint);color:var(--dsw-alias-brand-primary,#4a8cff);font-variant-numeric:tabular-nums}
.lmv-wb-path-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}

/* ------------------------------------------------------------ responsive */
@media (max-width:1240px){
  .lmv-wb-cols{grid-template-columns:minmax(0,1fr) 300px}
  .lmv-wb-left{position:absolute;left:0;top:0;bottom:0;width:252px;z-index:22;transform:translateX(-104%);transition:transform var(--lmv-base) var(--lmv-ease-out);box-shadow:var(--lmv-shadow-3);background:var(--dsw-alias-bg-layer-1,#252526)}
  .lmv-wb.is-filters-open .lmv-wb-left{transform:none}
  .lmv-wb-only-narrow{display:inline-flex}
}
@media (max-width:980px){
  .lmv-wb-cols{grid-template-columns:minmax(0,1fr)}
  .lmv-wb-right{position:absolute;right:0;top:0;bottom:0;width:min(330px,88%);z-index:23;transform:translateX(104%);transition:transform var(--lmv-base) var(--lmv-ease-out);box-shadow:var(--lmv-shadow-3);background:var(--dsw-alias-bg-layer-1,#252526)}
  .lmv-wb.is-detail-open .lmv-wb-right{transform:none}
  .lmv-wb-right-head .lmv-wb-only-narrow{display:inline-flex}
  .lmv-wb-top{gap:8px;padding:8px 9px}
  .lmv-wb-ident{max-width:none}
}
@media (min-width:981px){
  .lmv-wb-right-head .lmv-wb-only-narrow{display:none}
}
@media (max-width:720px){
  .lmv-wb{padding:0 8px 8px}
  .lmv-wb-title{font-size:14.5px}
  .lmv-wb-subtitle,.lmv-wb-stat{display:none}
  .lmv-wb-search{order:5;flex-basis:100%;max-width:none}
  .lmv-wb-actions{order:4;margin-left:auto}
  .lmv-wb-legend{left:8px;bottom:8px;gap:8px;font-size:9.5px;padding:3px 7px}
  .lmv-wb-legend-item:nth-child(n+3){display:none}
  .lmv-wb-zoombar{right:8px;bottom:8px;flex-direction:row}
  .lmv-wb-zero{left:8px;right:8px;top:8px;bottom:auto;transform:none;max-width:none;gap:8px}
  .lmv-wb-zero-text span{display:none}
  .lmv-wb-pathbar{left:8px;right:8px;transform:none;max-width:none}
}
@media (prefers-reduced-motion:reduce){
  .lmv-wb-viewport.is-animating,.lmv-wb-left,.lmv-wb-right{transition:none}
}

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

/* Coarse pointers get real hit targets. Desktop keeps its density.
   DSH Go's WebView applies a 44px floor to native buttons; match it here so our
   custom controls are no smaller than the host's own touch targets. */
@media (pointer:coarse){
  .lmv-btn,.lmv-btn-sm{min-height:44px;padding:9px 14px}
  .lmv-icon-btn{width:44px;min-height:44px}
  .lmv-nav-btn{min-height:40px;padding:9px 14px}
  .lmv-sticker-actions .lmv-btn{min-height:44px;padding:8px 12px}
  .lmv-seg-btn{min-height:40px;padding:9px 14px}
  .lmv-reminder-actions{opacity:1}
  /* Give text controls room to be tapped without the on-screen keyboard
     covering them; the host owns the keyboard, we only reserve the space. */
  .lmv-input,.lmv-textarea,.lmv-search-input{min-height:44px}
  /* Memory Graph controls: the canvas is dense, so every chrome control gets a
     real touch target even when the visible glyph is small. */
  .lmv-wb-seg-btn,.lmv-wb-chip,.lmv-wb-chip-btn,.lmv-wb-struct-row,.lmv-wb-switch,
  .lmv-wb-search-clear,.lmv-wb-pathbar-clear,.lmv-wb-rel,.lmv-wb-path-node,.lmv-wb-tag{min-height:40px}
  .lmv-wb-icon-btn{width:44px;height:44px}
  .lmv-wb-zoombar button{width:44px;height:44px}
  .lmv-wb-search .lmv-input{height:44px}
  .lmv-wb-rel{padding:8px 7px}
  .lmv-wb-tag{padding:6px 10px}
  .lmv-wb-chip{padding:6px 10px}
}
/* Respect display cut-outs and gesture bars on DSH Go's edge-to-edge WebView.
   Fall back to the plain padding used above when env() is unavailable. */
@supports(padding:env(safe-area-inset-left)){
  .lmv-page{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}
  .lmv-head{padding-top:calc(14px + env(safe-area-inset-top))}
  .lmv-main{padding-bottom:calc(32px + env(safe-area-inset-bottom))}
  .lmv-wb{padding-bottom:calc(14px + env(safe-area-inset-bottom))}
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
  .lmv-wb{padding-bottom:calc(8px + env(safe-area-inset-bottom))}
  .lmv-wb-legend{display:none}
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
