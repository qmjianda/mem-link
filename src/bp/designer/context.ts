import { createContext, useContext } from 'react';
import type { BinaryLayout, LayoutAnalysis, LayoutBuild, LayoutProblem } from '../layouts';
import type { LayoutUsageIndex } from './usage';
import type { FieldInput, FieldPatch, LayoutPatch } from './operations';
import type { BitOrder, RowBytes } from './geometry';

export type DesignerView = 'byte' | 'bit';
export type DesignerPane = 'inspect' | 'problems';

export type DesignerSelection =
  | { kind: 'none' }
  | { kind: 'layout' }
  | { kind: 'fields'; primary: string; ids: string[] }
  | { kind: 'bitsGroup'; key: string; member?: string };

export interface DesignerDialog {
  kind: 'import' | 'export' | 'templates';
}

export interface DesignerConfirm {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: 'danger' | 'normal';
  onConfirm: () => void;
}

export interface DesignerState {
  layouts: BinaryLayout[];
  current?: BinaryLayout;
  build?: LayoutBuild;
  analysis: LayoutAnalysis;
  usage: LayoutUsageIndex;
  view: DesignerView;
  rowBytes: RowBytes;
  bitOrder: BitOrder;
  zoom: number;
  pan: { x: number; y: number };
  selection: DesignerSelection;
  problemsPane: DesignerPane;
  tableOpen: boolean;
  sessionDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  armed: FieldInput | null;
  problems: LayoutProblem[];
  fitSignal: number;
}

export interface DesignerActions {
  selectFields(ids: readonly string[], primary?: string): void;
  toggleField(id: string): void;
  selectGroup(key: string, member?: string): void;
  selectLayout(): void;
  clearSelection(): void;
  openLayout(id: string): void;
  createLayout(): void;
  duplicateLayout(): void;
  deleteLayout(): void;
  enterLayout(id: string): void;
  back(): void;
  close(): void;
  setView(view: DesignerView): void;
  setRowBytes(rowBytes: RowBytes): void;
  setBitOrder(order: BitOrder): void;
  setZoom(zoom: number): void;
  zoomBy(delta: number): void;
  fit(): void;
  setPan(pan: { x: number; y: number }): void;
  toggleTable(): void;
  setProblemsPane(pane: DesignerPane): void;
  setArmed(spec: FieldInput | null): void;
  createField(spec: FieldInput, offset: number): boolean;
  moveFields(ids: readonly string[], target: number, anchorId?: string): boolean;
  moveBit(id: string, bit: number): boolean;
  resizeBit(id: string, width: number): boolean;
  setBitRange(id: string, bit: number, width: number): boolean;
  resizeField(id: string, size: number): boolean;
  reorderFields(ids: readonly string[], index: number): boolean;
  anchorFields(ids: readonly string[]): boolean;
  restoreAuto(ids: readonly string[]): boolean;
  deleteFields(ids: readonly string[]): void;
  duplicateFields(ids: readonly string[]): void;
  copyFields(ids: readonly string[]): void;
  pasteFields(target?: number): void;
  patchField(id: string, patch: FieldPatch): boolean;
  patchFields(ids: readonly string[], patch: FieldPatch): boolean;
  patchLayout(patch: LayoutPatch): boolean;
  setBitUnit(key: string, unit: number): boolean;
  addBit(key: string): boolean;
  undo(): void;
  redo(): void;
  restoreSession(): void;
  notify(message: string, tone?: 'ok' | 'error'): void;
  applyImported(next: BinaryLayout[]): boolean;
  openDialog(dialog: DesignerDialog): void;
  confirm(request: DesignerConfirm): void;
  openContextMenu(request: { x: number; y: number; fieldId?: string; bitsKey?: string; offset?: number }): void;
  registerGestureCancel(cancel: (() => boolean) | null): void;
  hasClipboard: boolean;
  clipboardCount: number;
}

export interface DesignerContextValue {
  state: DesignerState;
  actions: DesignerActions;
}

export const DesignerContext = createContext<DesignerContextValue | null>(null);

export function useDesigner(): DesignerContextValue {
  const value = useContext(DesignerContext);
  if (!value) throw new Error('useDesigner must be used inside DesignerContext');
  return value;
}
