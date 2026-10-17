/**
 * Every stylesheet rule this plugin owns, as one string.
 *
 * Hard constraints taken from the official DSH plugin guide:
 * - colour, background and border come **only** from `--dsw-alias-*` theme
 *   tokens, each with a literal fallback so the page also renders when a token
 *   is missing;
 * - every class is prefixed `lmv-`;
 * - `.lmv-page` is a full-height flex column whose body scrolls internally;
 * - nothing but the injected `<style>` element touches the document.
 *
 * @module dsh-longterm-memory/client/styles
 */

/** The complete plugin CSS. */
export const CLIENT_CSS = `
.lmv-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-base,#1e1e1e);font-family:inherit;font-size:13px;line-height:1.5}
.lmv-page *{box-sizing:border-box}
.lmv-head{display:flex;align-items:center;gap:12px;padding:12px 16px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2e2e);flex:0 0 auto;min-width:0}
.lmv-head-titles{display:flex;flex-direction:column;gap:2px;min-width:0}
.lmv-title{font-size:15px;font-weight:600;margin:0}
.lmv-subtitle{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmv-head-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.lmv-nav{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2e2e);flex:0 0 auto;flex-wrap:wrap}
.lmv-nav-btn{appearance:none;font:inherit;font-size:12px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8);padding:4px 10px;border-radius:6px;cursor:pointer}
.lmv-nav-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#333333)}
.lmv-nav-btn-on{background:var(--dsw-alias-interactive-bg-active,#3d3d3d);color:var(--dsw-alias-label-primary,#f5f5f5);border-color:var(--dsw-alias-border-l2,#3a3a3a)}
.lmv-body{flex:1 1 auto;min-height:0;display:flex}
.lmv-main{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:14px 16px 28px;display:flex;flex-direction:column;gap:12px}
.lmv-side{flex:0 0 260px;min-height:0;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1,#2e2e2e);padding:12px;display:flex;flex-direction:column;gap:10px}
.lmv-card{background:var(--dsw-alias-bg-layer-1,#252526);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0}
.lmv-card-head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.lmv-card-title{font-size:13px;font-weight:600}
.lmv-card-actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.lmv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(124px,1fr));gap:8px}
.lmv-grid-wide{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.lmv-stat{background:var(--dsw-alias-bg-layer-2,#2d2d2e);border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;min-width:0}
.lmv-stat-value{font-size:18px;font-weight:600}
.lmv-stat-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-btn{appearance:none;font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#2d2d2e);color:var(--dsw-alias-label-primary,#e6e6e6);white-space:nowrap}
.lmv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#383838)}
.lmv-btn:disabled{opacity:.5;cursor:not-allowed}
.lmv-btn:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#4a8cff);outline-offset:1px}
.lmv-btn-primary{background:var(--dsw-alias-button-primary-fill,#3b6fd4);border-color:var(--dsw-alias-button-primary-fill,#3b6fd4);color:var(--dsw-alias-label-primary-foreground,#ffffff)}
.lmv-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#383838);color:var(--dsw-alias-label-primary,#f5f5f5)}
.lmv-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary,#e5534b);color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-input,.lmv-select,.lmv-textarea{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#2d2d2e);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:6px;padding:4px 8px;min-width:0;max-width:100%}
.lmv-input:focus,.lmv-select:focus,.lmv-textarea:focus{outline:1px solid var(--dsw-alias-brand-primary,#4a8cff);outline-offset:-1px}
.lmv-input::placeholder,.lmv-textarea::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-input-block{width:100%}
.lmv-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;resize:vertical;width:100%}
.lmv-number{width:104px}
.lmv-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;user-select:none}
.lmv-check input{accent-color:var(--dsw-alias-brand-primary,#4a8cff);margin:0}
.lmv-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 160px}
.lmv-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.lmv-row{display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#2d2d2e);min-width:0}
.lmv-row-click{cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%}
.lmv-row-click:hover{background:var(--dsw-alias-interactive-bg-hover,#383838)}
.lmv-row-on{border-color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.lmv-row-title{font-size:13px;font-weight:500;overflow-wrap:anywhere}
.lmv-row-preview{font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere}
.lmv-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);min-width:0}
.lmv-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-secondary,#b8b8b8);white-space:nowrap}
.lmv-badge-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:var(--dsw-alias-state-success-primary,#3fb950)}
.lmv-badge-warn{color:var(--dsw-alias-state-warn-primary,#d29922);border-color:var(--dsw-alias-state-warn-primary,#d29922)}
.lmv-badge-error{color:var(--dsw-alias-state-error-primary,#e5534b);border-color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-badge-brand{color:var(--dsw-alias-brand-primary,#4a8cff);border-color:var(--dsw-alias-brand-primary,#4a8cff)}
.lmv-tag{cursor:pointer;font:inherit;font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#2d2d2e);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-secondary,#b8b8b8)}
.lmv-tag:hover{color:var(--dsw-alias-label-primary,#f5f5f5);background:var(--dsw-alias-interactive-bg-hover,#383838)}
.lmv-tag-on{color:var(--dsw-alias-label-primary-foreground,#ffffff);background:var(--dsw-alias-button-primary-fill,#3b6fd4);border-color:var(--dsw-alias-button-primary-fill,#3b6fd4)}
.lmv-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.lmv-chips{display:flex;flex-wrap:wrap;gap:4px}
.lmv-chips-scroll{max-height:132px;overflow:auto}
.lmv-kv{display:grid;grid-template-columns:minmax(88px,auto) minmax(0,1fr);gap:4px 10px;font-size:12px;align-items:baseline}
.lmv-kv-key{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-kv-val{overflow-wrap:anywhere;min-width:0}
.lmv-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere}
.lmv-pre{margin:0;padding:8px;border:1px solid var(--dsw-alias-border-l1,#2e2e2e);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#2d2d2e);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}
.lmv-prose{display:flex;flex-direction:column;gap:6px;font-size:13px;min-width:0}
.lmv-prose-h{margin:4px 0 0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#f0f0f0)}
.lmv-prose-p{margin:0;overflow-wrap:anywhere}
.lmv-prose-ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}
.lmv-notice{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);overflow-wrap:anywhere}
.lmv-notice-error{border-color:var(--dsw-alias-state-error-primary,#e5534b);color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-notice-warn{border-color:var(--dsw-alias-state-warn-primary,#d29922);color:var(--dsw-alias-state-warn-primary,#d29922)}
.lmv-notice-ok{border-color:var(--dsw-alias-state-success-primary,#3fb950);color:var(--dsw-alias-state-success-primary,#3fb950)}
.lmv-notice-icon{flex:0 0 auto;font-weight:600}
.lmv-empty{padding:16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.lmv-loading{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#b8b8b8);padding:6px 0}
.lmv-spin{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,#3a3a3a);border-top-color:var(--dsw-alias-brand-primary,#4a8cff);animation:lmv-spin .8s linear infinite;flex:0 0 auto}
@keyframes lmv-spin{to{transform:rotate(360deg)}}
.lmv-backdrop{position:fixed;inset:0;background:var(--dsw-alias-bg-base,#1e1e1e);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}
.lmv-modal{background:var(--dsw-alias-bg-layer-1,#252526);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:10px;max-width:600px;width:100%;max-height:82vh;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#e6e6e6);min-width:0}
.lmv-modal-head{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2e2e);font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.lmv-modal-body{padding:14px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:0}
.lmv-modal-foot{padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2e2e2e);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.lmv-toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:70;max-width:360px}
.lmv-toast{padding:8px 12px;border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-layer-2,#2d2d2e);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-primary,#e6e6e6);overflow-wrap:anywhere}
.lmv-toast-error{border-color:var(--dsw-alias-state-error-primary,#e5534b);color:var(--dsw-alias-state-error-primary,#e5534b)}
.lmv-toast-ok{border-color:var(--dsw-alias-state-success-primary,#3fb950);color:var(--dsw-alias-state-success-primary,#3fb950)}
.lmv-history{display:flex;flex-direction:column;gap:6px}
.lmv-history-item{border-left:2px solid var(--dsw-alias-border-l2,#3a3a3a);padding-left:8px;display:flex;flex-direction:column;gap:2px;font-size:12px;min-width:0}
.lmv-hr{height:1px;background:var(--dsw-alias-border-l1,#2e2e2e);border:0;margin:2px 0}
.lmv-wrap{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
.lmv-grow{flex:1 1 auto;min-width:0}
.lmv-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lmv-sep{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
`
