// What the first screen does not use stays out of this barrel (the build would load it with the first screen; tests/app/first-screen-budget.test.ts):
// import AuthorFace, Morph, PersonName, useFocusBack and useRowMotion from their own files, as the routes that use them do.
export { Avatar, initials } from './Avatar';
export { SpaceFace, spaceLetter } from './SpaceFace';
export { Button, IconButton, Spinner, type ButtonProps, type ButtonVariant } from './Button';
export { EmptyState } from './EmptyState';
export { ErrorState } from './ErrorState';
export { Icon, type IconName } from './Icon';
export { Input } from './Input';
export { SearchField, type SearchFieldProps } from './SearchField';
export { MEDIA, choosesInPlace, duration, installMotionGuards, isObscured, markMotionReady, motionAllowed, noteChange, play, sendsOnEnter, settle, useArrivals, useLoopPause, useMediaQuery, useMorph, useTravelingHighlight } from './motion';
export { usePop } from './pop';
export { installPress } from './press';
export { DetentSheet, SheetGrabber } from './DetentSheet';
export { ViewFade } from './ViewFade';
export { SizeSwap } from './SizeSwap';
export { prefersReducedMotion } from './motion-preference';
export { Drawer, Overlay, Sheet, focusableIn, trapTab, useStripOnlyModal } from './Overlay';
export { AgentIdentity, AgentTag } from './AgentIdentity';
export { AGENT_HUES, FluxLogo, Kreska, agentHue, type AgentHue, type KreskaExpression } from './Kreska';
export { StatusGlyph, TASK_STATE_WORD } from './StatusGlyph';
export { PanelActions, PanelGlyph, PanelMeta, REVEAL_EVENT, SidePanel, useSidePanelMode, type SidePanelMode } from './SidePanel';
export { BottomNav, Tabs, type BottomNavItem, type TabItem } from './Tabs';
export { publishHighestTopEdge, publishTopEdge } from './edgeInset';
export { ToastProvider, UNDO_MS, useClearOfToast, useLeaveUndoToasts, useToast, useToastScope, useToastTop, type ToastAction, type ToastOptions } from './Toast';
export { Mascot, Opening, OpeningRows, PullToRefresh } from './Moments';
