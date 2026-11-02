import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GrabSystem } from '../lib/grab';
import { mentor } from '../lib/mentorAnalysis';
import { woundLink } from '../lib/woundSteps';
import { workspace } from '../lib/workspaceFlow';
import { FramePlacement, XRPanel, panelGrabbable, type PanelRegion } from '../lib/xrPanel';
import {
  UI,
  drawButton,
  drawCard,
  drawIcon,
  drawNote,
  drawSegmented,
  drawSlider,
  drawSwatch,
  drawTitle,
  drawToggle,
  font,
  wrapText,
  type UIState,
} from '../lib/xrPanelStyle';
import { MAT_ACCENTS, SKIN_PRESETS, requestReattach, resetXRPrefs, setXRPrefs, xrPrefs } from '../lib/xrPrefs';
import { uiSound } from '../lib/uiSound';

/**
 * The headset menus, all placed around the material mat (the workspace
 * frame) and kept out of the middle, where the work happens:
 *
 *   ☰ Menu button      front-right corner of the mat → the Main menu above it
 *   Materials chip     above the back-left corner     → Prev / Step by step / Next
 *   Appearance chip    above the back-right corner    → the Opacity and Colour panels
 *   Buddy's actions    under Buddy, left of the mat   → Got it / Start working / Check my work / Pause
 *
 * Only one menu is open at a time; an open one closes after a while untouched.
 * Every panel can be carried with a fist and stays where it's let go.
 */

type MenuId = 'main' | 'materials' | 'appearance';
const menus = { open: null as MenuId | null, idle: 0 };
/** An open menu closes after this long without a finger near it (s). */
const MENU_IDLE_CLOSE = 12;

function toggleMenu(id: MenuId) {
  menus.open = menus.open === id ? null : id;
  menus.idle = 0;
}

const DEFAULT_MAT_OPACITY = 0.85;

// ---------------------------------------------------------------------------
// One workspace panel: an XRPanel placed in the workspace frame.

interface PanelSpec {
  grab: GrabSystem;
  width: number;
  height: number;
  regions: () => PanelRegion[];
  /** Its default spot in frame space, given the mat's width and depth. */
  place: (width: number, depth: number) => [number, number, number];
  shown: () => boolean;
  draw: (ctx: CanvasRenderingContext2D, panel: XRPanel) => void;
  onPress?: (id: string) => void;
  onSlide?: (id: string, value: number, phase: 'start' | 'move' | 'end') => void;
  /** Data it shows: a change redraws it. */
  dataKey?: () => string;
  /** Which menu it belongs to: using it keeps that menu open. */
  menu?: MenuId;
}

function useWorkspacePanel(spec: PanelSpec): XRPanel {
  const gl = useThree((s) => s.gl);
  const specRef = useRef(spec);
  specRef.current = spec;
  const { panel, placement } = useMemo(() => {
    const panel = new XRPanel({
      width: spec.width,
      height: spec.height,
      draw: (ctx, p) => specRef.current.draw(ctx, p),
      onPress: (id) => specRef.current.onPress?.(id),
      onSlide: (id, value, phase) => specRef.current.onSlide?.(id, value, phase),
    });
    return { panel, placement: new FramePlacement() };
  }, []);
  const state = useMemo(() => ({ key: '' }), []);
  useEffect(
    () => () => {
      panel.dispose();
      placement.dispose();
    },
    [panel, placement],
  );
  useEffect(() => spec.grab.add(panelGrabbable(panel, placement, () => true)), [spec.grab, panel, placement]);

  useFrame((_, delta) => {
    const s = specRef.current;
    const show = gl.xr.isPresenting && workspace.frameValid && !workspace.panelsHidden && s.shown();
    if (show !== panel.mesh.visible) {
      panel.mesh.visible = show;
      panel.reset();
      panel.invalidate();
    }
    if (!show) return;
    panel.regions = s.regions();
    if (!panel.held) {
      const [x, y, z] = s.place(workspace.width, workspace.depth);
      placement.setDefault(x, y, z);
      placement.apply(panel.mesh);
    }
    const key = s.dataKey?.() ?? '';
    if (key !== state.key) {
      state.key = key;
      panel.invalidate();
    }
    panel.update(Math.min(delta, 0.1), gl);
    if (s.menu && menus.open === s.menu && panel.idleFor === 0) menus.idle = 0;
  });
  return panel;
}

/** A rectangle region in panel space (metres). */
const region = (id: string, x0: number, x1: number, y0: number, y1: number, extra: Partial<PanelRegion> = {}): PanelRegion => ({
  id,
  x0,
  x1,
  y0,
  y1,
  ...extra,
});

const phaseIs = (...phases: string[]) => phases.includes(workspace.flow.phase);

/** A button's state from the panel's hover/flash and its own on/off. */
function buttonState(panel: XRPanel, id: string, on = false, enabled = true): UIState {
  if (!enabled) return 'unavailable';
  if (panel.pressed === id || on) return 'selected';
  return panel.hover === id ? 'hover' : 'default';
}

// ---------------------------------------------------------------------------
// ☰ Menu button and the Main menu.

function MenuButton({ grab }: { grab: GrabSystem }) {
  const panel = useWorkspacePanel({
    grab,
    width: 0.075,
    height: 0.075,
    regions: () => [region('menu', -0.0375, 0.0375, -0.0375, 0.0375)],
    place: (w, d) => [w / 2 + 0.08, 0.04, d / 2 - 0.03],
    shown: () => phaseIs('intro', 'browse', 'work'),
    dataKey: () => `${menus.open === 'main'}`,
    onPress: () => toggleMenu('main'),
    draw: (ctx, p) => {
      const { width: w, height: h } = p.canvas;
      const open = menus.open === 'main';
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 2 - 6, 0, Math.PI * 2);
      ctx.fillStyle = open ? UI.green : UI.card;
      ctx.fill();
      ctx.lineWidth = p.hover === 'menu' || p.grabState !== 'none' ? 12 : 6;
      ctx.strokeStyle = UI.green;
      ctx.stroke();
      // ☰ drawn as three bars, then the word.
      ctx.fillStyle = open ? UI.white : UI.ink;
      for (let i = 0; i < 3; i++) ctx.fillRect(w / 2 - 58, h * 0.25 + i * 32, 116, 14);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      font(ctx, 52, 700);
      ctx.fillText(open ? 'Close' : 'Menu', w / 2, h * 0.72);
    },
  });
  return <primitive object={panel.mesh} />;
}

const MAIN_W = 0.27;
const MAIN_H = 0.3;

function MainMenu({ grab, woundOpacity, onWoundOpacityChange }: MenuProps) {
  const local = useMemo(() => ({ redrawUntil: 0, now: 0 }), []);
  const regions = useMemo(
    () => [
      region('close', 0.065, 0.125, 0.105, 0.14),
      region('labels', -0.125, 0.125, 0.064, 0.098),
      region('buddy', -0.125, 0.125, 0.026, 0.06),
      region('mesh', -0.125, 0.125, -0.012, 0.022),
      region('hand-left', -0.005, 0.06, -0.052, -0.02),
      region('hand-right', 0.06, 0.125, -0.052, -0.02),
      region('height-down', 0.02, 0.065, -0.092, -0.06),
      region('height-up', 0.075, 0.125, -0.092, -0.06),
      region('calibrate', -0.125, -0.045, -0.14, -0.105),
      region('redraw', -0.04, 0.04, -0.14, -0.105),
      region('reset', 0.045, 0.125, -0.14, -0.105),
    ],
    [],
  );
  useFrame((_, delta) => {
    local.now += delta;
  });
  const panel = useWorkspacePanel({
    grab,
    width: MAIN_W,
    height: MAIN_H,
    menu: 'main',
    regions: () =>
      regions.map((r) =>
        r.id === 'calibrate'
          ? { ...r, enabled: workspace.flow.phase === 'work' }
          : r.id === 'redraw'
            ? { ...r, enabled: workspace.mat !== null }
            : r.id === 'labels'
              ? { ...r, enabled: workspace.mat !== null }
              : r,
      ),
    place: (w, d) => [w / 2 + 0.1, 0.235, d / 2 - 0.08],
    shown: () => menus.open === 'main' && phaseIs('intro', 'browse', 'work'),
    dataKey: () => `${xrPrefs.version}:${workspace.flow.phase}:${local.redrawUntil > local.now}:${workspace.mat !== null}`,
    onPress: (id) => {
      switch (id) {
        case 'close':
          menus.open = null;
          break;
        case 'labels':
          setXRPrefs({ labels: !xrPrefs.labels });
          break;
        case 'buddy':
          setXRPrefs({ buddy: !xrPrefs.buddy });
          break;
        case 'mesh':
          setXRPrefs({ showHandMesh: !xrPrefs.showHandMesh });
          break;
        case 'hand-left':
        case 'hand-right':
          setXRPrefs({ hand: id === 'hand-left' ? 'left' : 'right' });
          workspace.notify(`Wound on your ${xrPrefs.hand} hand`, '', 'ok', 2.5);
          break;
        case 'height-down':
        case 'height-up': {
          const mm = Math.min(Math.max(xrPrefs.skinHeightMm + (id === 'height-up' ? 0.5 : -0.5), -5), 5);
          setXRPrefs({ skinHeightMm: mm });
          break;
        }
        case 'calibrate':
          requestReattach();
          workspace.notify('Calibrating your hand', `Hold your ${xrPrefs.hand} palm flat and still for a moment.`, 'info', 3);
          break;
        case 'redraw':
          if (local.redrawUntil > local.now) {
            local.redrawUntil = 0;
            menus.open = null;
            workspace.mat?.redraw();
          } else {
            local.redrawUntil = local.now + 3;
            workspace.notify('Tap Redraw again to remove the mat', 'Then trace a new one.', 'warn', 3);
          }
          break;
        case 'reset':
          resetXRPrefs();
          FramePlacement.resetAll();
          workspace.buddyLocal = null;
          woundOpacity.current = 1;
          onWoundOpacityChange(1);
          workspace.mat?.setOpacity(DEFAULT_MAT_OPACITY, true);
          workspace.notify('Settings reset', 'Panels and Buddy are back in their places.', 'ok', 3);
          break;
      }
    },
    draw: (ctx, p) => {
      const k = p.k;
      drawCard(ctx, p.canvas.width, p.canvas.height, p.grabState);
      drawTitle(ctx, 0.02 * k, 0.03 * k, 0.2 * k, 'Menu');
      drawButton(ctx, p.rect('close'), 'Close', buttonState(p, 'close'), { px: 32 });
      const hasMat = workspace.mat !== null;
      drawToggle(ctx, p.rect('labels'), hasMat ? 'Material labels' : 'Material labels (no mat)', xrPrefs.labels && hasMat, p.hover === 'labels');
      drawToggle(ctx, p.rect('buddy'), 'Buddy, your mentor', xrPrefs.buddy, p.hover === 'buddy');
      drawToggle(ctx, p.rect('mesh'), 'Hand mesh while working', xrPrefs.showHandMesh, p.hover === 'mesh');
      drawNote(ctx, 0.02 * k, (MAIN_H / 2 + 0.036) * k, 'Wound hand', 'muted', 34);
      const seg = p.rect('hand-left');
      const right = p.rect('hand-right');
      drawSegmented(
        ctx,
        { x: seg.x, y: seg.y, w: right.x + right.w - seg.x, h: seg.h },
        ['Left', 'Right'],
        xrPrefs.hand === 'left' ? 0 : 1,
        p.hover === 'hand-left' ? 0 : p.hover === 'hand-right' ? 1 : -1,
      );
      const mm = xrPrefs.skinHeightMm;
      drawNote(ctx, 0.02 * k, (MAIN_H / 2 + 0.076) * k, `Wound height ${mm > 0 ? '+' : ''}${mm.toFixed(1)} mm`, 'muted', 34);
      drawButton(ctx, p.rect('height-down'), '−', buttonState(p, 'height-down'), { px: 44 });
      drawButton(ctx, p.rect('height-up'), '+', buttonState(p, 'height-up'), { px: 44 });
      drawButton(ctx, p.rect('calibrate'), 'Calibrate', buttonState(p, 'calibrate', false, workspace.flow.phase === 'work'), { px: 30 });
      const confirming = local.redrawUntil > local.now;
      drawButton(ctx, p.rect('redraw'), confirming ? 'Tap again' : 'Redraw mat', buttonState(p, 'redraw', confirming, hasMat), { px: 30 });
      drawButton(ctx, p.rect('reset'), 'Reset all', buttonState(p, 'reset'), { px: 30 });
    },
  });
  return <primitive object={panel.mesh} />;
}

// ---------------------------------------------------------------------------
// The secondary chips and their panels.

function Chip({ grab, id, label, place, shown }: { grab: GrabSystem; id: MenuId; label: string; place: PanelSpec['place']; shown: () => boolean }) {
  const panel = useWorkspacePanel({
    grab,
    width: 0.15,
    height: 0.045,
    menu: id,
    regions: () => [region('chip', -0.075, 0.075, -0.0225, 0.0225)],
    place,
    shown,
    dataKey: () => `${menus.open === id}`,
    onPress: () => toggleMenu(id),
    draw: (ctx, p) => {
      const open = menus.open === id;
      const { width: w, height: h } = p.canvas;
      ctx.clearRect(0, 0, w, h);
      drawButton(ctx, { x: 4, y: 4, w: w - 8, h: h - 8 }, label, open ? 'active' : p.hover === 'chip' || p.grabState !== 'none' ? 'hover' : 'default', {
        px: 64,
      });
    },
  });
  return <primitive object={panel.mesh} />;
}

const MAT_W = 0.28;
const MAT_H = 0.12;

function MaterialsPanel({ grab }: { grab: GrabSystem }) {
  const panel = useWorkspacePanel({
    grab,
    width: MAT_W,
    height: MAT_H,
    menu: 'materials',
    regions: () => {
      const mat = workspace.mat;
      return [
        region('prev', -0.13, -0.055, -0.05, -0.012, { enabled: !!mat?.canPrev }),
        region('step', -0.045, 0.045, -0.05, -0.012),
        region('next', 0.055, 0.13, -0.05, -0.012, { enabled: !!mat?.canNext }),
      ];
    },
    place: (w, d) => [-w / 2 + 0.13, 0.29, -d / 2 - 0.02],
    shown: () => menus.open === 'materials' && workspace.mat !== null && phaseIs('browse', 'work'),
    dataKey: () => {
      const mat = workspace.mat;
      return mat ? `${mat.status}:${mat.stepMode}:${mat.canPrev}:${mat.canNext}` : '';
    },
    onPress: (id) => {
      const mat = workspace.mat;
      if (!mat) return;
      if (id === 'prev') mat.prev();
      else if (id === 'next') mat.next();
      else mat.toggleStep();
    },
    draw: (ctx, p) => {
      const k = p.k;
      const mat = workspace.mat;
      drawCard(ctx, p.canvas.width, p.canvas.height, p.grabState);
      drawTitle(ctx, 0.02 * k, 0.026 * k, 0.24 * k, 'Materials');
      drawNote(ctx, 0.02 * k, 0.058 * k, mat?.status ?? '', 'muted', 32);
      drawButton(ctx, p.rect('prev'), '‹ Prev', buttonState(p, 'prev', false, !!mat?.canPrev), { px: 34 });
      drawButton(ctx, p.rect('step'), 'Step by step', buttonState(p, 'step', !!mat?.stepMode), { px: 32 });
      drawButton(ctx, p.rect('next'), 'Next ›', buttonState(p, 'next', false, !!mat?.canNext), { px: 34 });
    },
  });
  return <primitive object={panel.mesh} />;
}

interface MenuProps {
  grab: GrabSystem;
  woundOpacity: RefObject<number>;
  onWoundOpacityChange: (value: number) => void;
}

const OP_W = 0.27;
const OP_H = 0.17;

/**
 * Opacity: what it changes (the wound or the mat), its value, and three
 * ways to set it — point your index finger and slide along it, − / +, or Reset.
 */
function OpacityPanel({ grab, woundOpacity, onWoundOpacityChange }: MenuProps) {
  const local = useMemo(() => ({ doneFor: 0, sent: -1 }), []);
  const target = () => (xrPrefs.opacityTarget === 'mat' && workspace.mat ? 'mat' : 'wound');
  const value = () => (target() === 'mat' ? (workspace.mat?.opacity ?? DEFAULT_MAT_OPACITY) : (woundOpacity.current ?? 1));
  const set = (v: number, done: boolean) => {
    const clamped = Math.min(Math.max(v, 0), 1);
    if (target() === 'mat') workspace.mat?.setOpacity(clamped, done);
    else {
      woundOpacity.current = clamped;
      const percent = Math.round(clamped * 100);
      if (percent !== local.sent || done) {
        local.sent = percent;
        onWoundOpacityChange(clamped);
      }
    }
  };
  useFrame((_, delta) => {
    local.doneFor = Math.max(local.doneFor - delta, 0);
  });
  const panel = useWorkspacePanel({
    grab,
    width: OP_W,
    height: OP_H,
    menu: 'appearance',
    regions: () => [
      region('wound', -0.125, 0.0, 0.02, 0.046),
      region('mat', 0.0, 0.125, 0.02, 0.046, { enabled: workspace.mat !== null }),
      region('slider', -0.105, 0.105, -0.022, 0.012, { slider: true, needsPoint: true }),
      region('minus', -0.125, -0.075, -0.077, -0.05),
      region('plus', -0.07, -0.02, -0.077, -0.05),
      region('reset', 0.045, 0.125, -0.077, -0.05),
    ],
    place: (w, d) => [w / 2 - 0.05, 0.285, -d / 2 - 0.02],
    shown: () => menus.open === 'appearance' && phaseIs('browse', 'work'),
    dataKey: () => `${Math.round(value() * 100)}:${target()}:${local.doneFor > 0}:${workspace.mat !== null}`,
    onSlide: (_, v, phase) => {
      set(v, phase === 'end');
      if (phase === 'move' && Math.floor(v * 10) !== Math.floor(value() * 10)) uiSound.tick();
      if (phase === 'end') local.doneFor = 2;
      panel.invalidate();
    },
    onPress: (id) => {
      if (id === 'wound' || id === 'mat') setXRPrefs({ opacityTarget: id });
      else if (id === 'minus' || id === 'plus') {
        set(Math.round((value() + (id === 'plus' ? 0.1 : -0.1)) * 10) / 10, true);
        local.doneFor = 2;
      } else if (id === 'reset') {
        set(target() === 'mat' ? DEFAULT_MAT_OPACITY : 1, true);
        local.doneFor = 2;
      }
    },
    draw: (ctx, p) => {
      const k = p.k;
      const v = value();
      const percent = `${Math.round(v * 100)}%`;
      drawCard(ctx, p.canvas.width, p.canvas.height, p.grabState);
      drawTitle(ctx, 0.02 * k, 0.025 * k, 0.23 * k, 'Opacity', percent);
      const a = p.rect('wound');
      const b = p.rect('mat');
      drawSegmented(
        ctx,
        { x: a.x, y: a.y, w: b.x + b.w - a.x, h: a.h },
        workspace.mat ? ['Wound', 'Mat'] : ['Wound', 'Mat (none)'],
        target() === 'wound' ? 0 : 1,
        p.hover === 'wound' ? 0 : p.hover === 'mat' ? 1 : -1,
        32,
      );
      const grip = p.gripState('slider');
      drawSlider(ctx, p.rect('slider'), v, grip, percent);
      const noteY = (OP_H / 2 + 0.036) * k;
      if (grip === 'held') drawNote(ctx, 0.02 * k, noteY, `☝ Sliding · ${percent}`, 'ok', 30);
      else if (local.doneFor > 0) drawNote(ctx, 0.02 * k, noteY, `✓ Set to ${percent}`, 'ok', 30);
      else if (p.pointHint) drawNote(ctx, 0.02 * k, noteY, '☝ Point with just your index finger to slide', 'warn', 30);
      else drawNote(ctx, 0.02 * k, noteY, '☝ Point your index finger and slide along', 'muted', 30);
      drawButton(ctx, p.rect('minus'), '−', buttonState(p, 'minus'), { px: 44 });
      drawButton(ctx, p.rect('plus'), '+', buttonState(p, 'plus'), { px: 44 });
      drawButton(ctx, p.rect('reset'), 'Reset', buttonState(p, 'reset'), { px: 32 });
    },
  });
  return <primitive object={panel.mesh} />;
}

const COL_W = 0.27;
const COL_H = 0.17;
const SWATCH = 0.026;

/** Colour: the skin tone the wound blends into (Auto from the camera, presets, a fine Tone) and the mat's outline colour. */
function ColourPanel({ grab }: { grab: GrabSystem }) {
  const regions = useMemo(
    () => [
      region('reset', 0.06, 0.125, 0.048, 0.076),
      region('auto', -0.125, -0.06, 0.012, 0.04),
      ...SKIN_PRESETS.map((_, i) => region(`skin-${i}`, -0.05 + i * 0.0295, -0.05 + i * 0.0295 + SWATCH, 0.013, 0.039)),
      region('tone', -0.06, 0.12, -0.046, -0.02, { slider: true }),
      ...MAT_ACCENTS.map((_, i) => region(`accent-${i}`, -0.06 + i * 0.034, -0.06 + i * 0.034 + SWATCH, -0.08, -0.056)),
    ],
    [],
  );
  const panel = useWorkspacePanel({
    grab,
    width: COL_W,
    height: COL_H,
    menu: 'appearance',
    regions: () => regions.map((r) => (r.id.startsWith('accent') ? { ...r, enabled: workspace.mat !== null } : r)),
    place: (w, d) => [w / 2 - 0.05, 0.1, -d / 2 - 0.02],
    shown: () => menus.open === 'appearance' && phaseIs('browse', 'work'),
    dataKey: () => `${xrPrefs.version}:${workspace.mat !== null}`,
    onSlide: (_, v) => {
      if (Math.abs(v - xrPrefs.skinFine) > 0.01 || xrPrefs.skinAuto) {
        if (Math.floor(v * 10) !== Math.floor(xrPrefs.skinFine * 10)) uiSound.tick();
        setXRPrefs({ skinFine: v, skinAuto: false });
      }
    },
    onPress: (id) => {
      if (id === 'reset') {
        setXRPrefs({ skinAuto: true, skinPreset: 2, skinFine: 0.5, matAccent: 0 });
        workspace.notify('Colours reset', '', 'ok', 2);
      } else if (id === 'auto') setXRPrefs({ skinAuto: !xrPrefs.skinAuto });
      else if (id.startsWith('skin-')) setXRPrefs({ skinPreset: Number(id.slice(5)), skinAuto: false });
      else if (id.startsWith('accent-')) setXRPrefs({ matAccent: Number(id.slice(7)) });
    },
    draw: (ctx, p) => {
      const k = p.k;
      drawCard(ctx, p.canvas.width, p.canvas.height, p.grabState);
      drawTitle(ctx, 0.02 * k, 0.025 * k, 0.15 * k, 'Colour');
      drawButton(ctx, p.rect('reset'), 'Reset', buttonState(p, 'reset'), { px: 32 });
      drawButton(ctx, p.rect('auto'), 'Auto', buttonState(p, 'auto', xrPrefs.skinAuto), { px: 32 });
      SKIN_PRESETS.forEach((color, i) =>
        drawSwatch(ctx, p.rect(`skin-${i}`), color, !xrPrefs.skinAuto && xrPrefs.skinPreset === i, p.hover === `skin-${i}`),
      );
      const noteY = (COL_H / 2 + 0.005) * k;
      if (!xrPrefs.skinAuto) drawNote(ctx, 0.02 * k, noteY, 'Skin tone: your pick', 'muted', 28);
      else if (xrPrefs.autoWorking) drawNote(ctx, 0.02 * k, noteY, '✓ Skin tone matched from the camera', 'ok', 28);
      else drawNote(ctx, 0.02 * k, noteY, '⚠ No camera access: using a preset (pick one)', 'warn', 28);
      drawNote(ctx, 0.02 * k, (COL_H / 2 + 0.033) * k, 'Tone', 'muted', 30);
      drawSlider(ctx, p.rect('tone'), xrPrefs.skinFine, p.gripState('tone'));
      const hasMat = workspace.mat !== null;
      drawNote(ctx, 0.02 * k, (COL_H / 2 + 0.068) * k, hasMat ? 'Mat' : 'Mat (none)', 'muted', 30);
      MAT_ACCENTS.forEach((accent, i) =>
        drawSwatch(ctx, p.rect(`accent-${i}`), hasMat ? accent.color : '#e4e8e5', hasMat && xrPrefs.matAccent === i, p.hover === `accent-${i}`),
      );
      if (hasMat) drawNote(ctx, (COL_W / 2 + 0.05) * k, (COL_H / 2 + 0.068) * k, MAT_ACCENTS[xrPrefs.matAccent].name, 'muted', 30);
    },
  });
  return <primitive object={panel.mesh} />;
}

// ---------------------------------------------------------------------------
// Buddy's actions: the one next step, always under Buddy.

/** Buddy's spot in frame space: to the left of the mat, mid-height, or where the user put it. */
export function buddyHomeLocal(out: THREE.Vector3) {
  if (workspace.buddyLocal) return out.copy(workspace.buddyLocal);
  return out.set(-workspace.width / 2 - 0.13, 0.17, 0);
}

const ACT_W = 0.2;
const ACT_H = 0.05;
const buddySpot = new THREE.Vector3();

function MentorActions({ grab }: { grab: GrabSystem }) {
  const panel = useWorkspacePanel({
    grab,
    width: ACT_W,
    height: ACT_H,
    regions: () => {
      const phase = workspace.flow.phase;
      if (phase === 'work') {
        return [region('check', -0.095, 0.035, -0.02, 0.02), region('pause', 0.042, 0.095, -0.02, 0.02)];
      }
      return [region(phase === 'intro' ? 'got-it' : 'start', -0.095, 0.095, -0.02, 0.02)];
    },
    place: () => {
      buddyHomeLocal(buddySpot);
      return [buddySpot.x, Math.max(buddySpot.y - 0.1, 0.03), buddySpot.z];
    },
    shown: () => phaseIs('intro', 'browse', 'work'),
    dataKey: () => `${workspace.flow.phase}:${mentor.version}:${mentor.status}:${mentor.available}`,
    onPress: (id) => {
      const flow = workspace.flow;
      if (id === 'got-it') flow.introDone();
      else if (id === 'start') flow.startWork();
      else if (id === 'pause') {
        flow.stopWork();
        workspace.notify('Paused', 'Tap Start working to carry on.', 'info', 3);
      } else if (id === 'check') {
        if (mentor.status === 'processing') return;
        if (mentor.available === null) {
          workspace.notify('Still connecting to the feedback service', 'Try again in a moment.', 'info', 3);
          return;
        }
        if (!mentor.available) {
          workspace.notify('Feedback isn’t available', mentor.reason, 'warn', 5);
          return;
        }
        if (!woundLink.tracked) {
          workspace.notify(`Hold up your ${xrPrefs.hand} hand first`, 'Buddy needs to see your work.', 'warn', 3);
          return;
        }
        const stage = woundLink.flow?.stage ?? 0;
        mentor.stage = stage;
        mentor.captureRequested = true;
        if (!mentor.privacyShown) {
          mentor.privacyShown = true;
          workspace.notify('Taking a photo for Buddy', 'Your photo is sent to the AI service to give feedback.', 'info', 4);
        }
      }
    },
    draw: (ctx, p) => {
      const { width: w, height: h } = p.canvas;
      ctx.clearRect(0, 0, w, h);
      const phase = workspace.flow.phase;
      if (phase === 'work') {
        const state: UIState =
          mentor.status === 'processing'
            ? 'processing'
            : mentor.available === false
              ? 'unavailable'
              : mentor.status === 'done' && p.pressed !== 'check'
                ? p.hover === 'check'
                  ? 'hover'
                  : 'completed'
                : buttonState(p, 'check');
        drawButton(ctx, p.rect('check'), mentor.status === 'processing' ? 'Checking' : 'Check my work', state, { px: 42 });
        drawButton(ctx, p.rect('pause'), 'Pause', buttonState(p, 'pause'), { px: 42 });
      } else {
        const id = phase === 'intro' ? 'got-it' : 'start';
        drawButton(ctx, p.rect(id), phase === 'intro' ? 'Got it' : 'Start working', p.hover === id ? 'hover' : 'default', {
          primary: true,
          px: 48,
        });
      }
    },
  });
  return <primitive object={panel.mesh} />;
}

// ---------------------------------------------------------------------------
// The status board: what just happened, or what to do now.

const BOARD_W = 0.38;
const BOARD_H = 0.1;
/** In front of the eyes and below them, following the head lazily. */
const BOARD_DISTANCE = 0.62;
const BOARD_DROP = 0.2;

function StatusBoard() {
  const gl = useThree((s) => s.gl);
  const board = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(BOARD_W * 4000);
    canvas.height = Math.round(BOARD_H * 4000);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthTest: false, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, BOARD_H), material);
    mesh.renderOrder = 60;
    mesh.visible = false;
    return { canvas, texture, material, mesh };
  }, []);
  const s = useMemo(
    () => ({ id: -1, left: 0, opacity: 0, placed: false, head: new THREE.Vector3(), forward: new THREE.Vector3(), target: new THREE.Vector3() }),
    [],
  );
  useEffect(
    () => () => {
      board.texture.dispose();
      board.material.dispose();
      board.mesh.geometry.dispose();
    },
    [board],
  );

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const m = workspace.message;
    if (m.id !== s.id) {
      s.id = m.id;
      s.left = m.title ? m.seconds : 0;
      if (m.title) drawBoard(board.canvas, m.title, m.detail, m.tone);
      board.texture.needsUpdate = true;
    } else if (s.left !== Infinity) s.left -= dt;
    const wanted = gl.xr.isPresenting && s.left > 0 ? 1 : 0;
    s.opacity += (wanted - s.opacity) * (1 - Math.exp(-10 * dt));
    if (wanted === 0 && s.opacity < 0.01) s.opacity = 0;
    board.material.opacity = s.opacity;
    board.mesh.visible = s.opacity > 0;
    if (!board.mesh.visible) {
      s.placed = false;
      return;
    }
    const head = gl.xr.getCamera();
    head.getWorldPosition(s.head);
    head.getWorldDirection(s.forward);
    s.forward.y = 0;
    if (s.forward.lengthSq() < 1e-6) s.forward.set(0, 0, -1);
    s.forward.normalize();
    s.target.copy(s.head).addScaledVector(s.forward, BOARD_DISTANCE);
    s.target.y -= BOARD_DROP;
    if (!s.placed) board.mesh.position.copy(s.target);
    else board.mesh.position.lerp(s.target, 1 - Math.exp(-3 * dt));
    s.placed = true;
    board.mesh.lookAt(s.head);
  });

  return <primitive object={board.mesh} />;
}

function drawBoard(canvas: HTMLCanvasElement, title: string, detail: string, tone: 'info' | 'ok' | 'warn') {
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = UI.card;
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 48);
  ctx.fill();
  if (tone === 'warn') {
    ctx.lineWidth = 8;
    ctx.strokeStyle = UI.amber;
    ctx.stroke();
  }
  drawIcon(ctx, 92, h / 2, 46, tone);
  const x = 170;
  const maxWidth = w - x - 40;
  font(ctx, 50, 700);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = UI.ink;
  const titleLines = wrapText(ctx, title, maxWidth, 1);
  font(ctx, 36, 500);
  const detailLines = detail ? wrapText(ctx, detail, maxWidth, 2) : [];
  const total = 60 + detailLines.length * 46;
  let y = h / 2 - total / 2 + 30;
  font(ctx, 50, 700);
  ctx.fillStyle = UI.ink;
  ctx.fillText(titleLines[0] ?? '', x, y);
  font(ctx, 36, 500);
  ctx.fillStyle = UI.muted;
  for (const line of detailLines) {
    y += 46;
    ctx.fillText(line, x, y + 8);
  }
}

// ---------------------------------------------------------------------------

/** Closes an open menu after a while untouched (any of its panels counts). */
function MenuTimer() {
  useFrame((_, delta) => {
    if (!menus.open) return;
    menus.idle += Math.min(delta, 0.1);
    if (menus.idle > MENU_IDLE_CLOSE || workspace.flow.phase === 'setup') menus.open = null;
  });
  return null;
}

/** The workspace's menus and status board (headset sessions). */
export function XRMenus({ grab, woundOpacity, onWoundOpacityChange }: MenuProps) {
  const anyPhase = () => phaseIs('browse', 'work');
  return (
    <>
      <StatusBoard />
      <MenuTimer />
      <MenuButton grab={grab} />
      <MainMenu grab={grab} woundOpacity={woundOpacity} onWoundOpacityChange={onWoundOpacityChange} />
      <Chip
        grab={grab}
        id="materials"
        label="Materials"
        place={(w, d) => [-w / 2 + 0.09, 0.4, -d / 2 - 0.02]}
        shown={() => anyPhase() && workspace.mat !== null}
      />
      <MaterialsPanel grab={grab} />
      <Chip grab={grab} id="appearance" label="Appearance" place={(w, d) => [w / 2 - 0.09, 0.4, -d / 2 - 0.02]} shown={anyPhase} />
      <OpacityPanel grab={grab} woundOpacity={woundOpacity} onWoundOpacityChange={onWoundOpacityChange} />
      <ColourPanel grab={grab} />
      <MentorActions grab={grab} />
    </>
  );
}
