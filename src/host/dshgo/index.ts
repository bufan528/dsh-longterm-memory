/**
 * DSH Go native-UI adaptation (host half).
 *
 * Only loaded by the host when the DSH Go bridge is present; all exports are
 * pure or side-effect-free until `installDshGoBridge` is called.
 *
 * @module dsh-longterm-memory/host/dshgo
 */

export { buildSnapshot, installDshGoBridge, installNativeToolCards, withNativeCard, NATIVE_PANELS, CARD_TOOLS } from './bridge.js'
export { inboxPanelView, memoryGetView, memorySaveView, memorySearchView, memoryForgetView, overviewPanelView, remindersPanelView, stripData, toolCard, toolResultView, viewLang } from './views.js'
export { EMPTY_SNAPSHOT } from './types.js'
export type { DshGoBridgeDeps, DshGoInstallResult, NativePanelId, ReminderSurfaceLike } from './bridge.js'
export type { NativeCaps, NativeEffect, NativeEvent, NativeScope, NativeSnapshot, NativeView } from './types.js'
