import { describe, expect, it } from 'vitest';
import { WorkspaceFlow, workspace } from './workspaceFlow';

describe('WorkspaceFlow', () => {
  it('starts with mat setup, then intro, browse and work', () => {
    const flow = new WorkspaceFlow();
    flow.start(true);
    expect(flow.phase).toBe('setup');
    flow.matPlaced();
    expect(flow.phase).toBe('intro');
    flow.introDone();
    expect(flow.phase).toBe('browse');
    flow.startWork();
    expect(flow.phase).toBe('work');
    flow.stopWork();
    expect(flow.phase).toBe('browse');
  });

  it('skips the mat without one', () => {
    const flow = new WorkspaceFlow();
    flow.start(false);
    expect(flow.phase).toBe('intro');
  });

  it('ignores steps out of order', () => {
    const flow = new WorkspaceFlow();
    flow.start(true);
    flow.startWork();
    flow.introDone();
    expect(flow.phase).toBe('setup');
    flow.matPlaced();
    flow.startWork();
    expect(flow.phase).toBe('intro');
  });

  it('does not introduce Buddy again after a redraw', () => {
    const flow = new WorkspaceFlow();
    flow.start(true);
    flow.matPlaced();
    flow.introDone();
    flow.matRemoved();
    expect(flow.phase).toBe('setup');
    flow.matPlaced();
    expect(flow.phase).toBe('browse');
  });

  it('bumps the version and restarts the clock on each change only', () => {
    const flow = new WorkspaceFlow();
    flow.start(true);
    const v = flow.version;
    flow.update(2);
    expect(flow.time).toBe(2);
    flow.introDone(); // not allowed in setup: no change
    expect(flow.version).toBe(v);
    flow.matPlaced();
    expect(flow.version).toBe(v + 1);
    expect(flow.time).toBe(0);
  });

  it('a new session forgets the intro', () => {
    const flow = new WorkspaceFlow();
    flow.start(true);
    flow.matPlaced();
    flow.introDone();
    flow.start(true);
    flow.matPlaced();
    expect(flow.phase).toBe('intro');
  });
});

describe('workspace messages', () => {
  it('dismisses only the message it was given', () => {
    const first = workspace.notify('A');
    const second = workspace.notify('B');
    workspace.dismiss(first);
    expect(workspace.message.title).toBe('B');
    workspace.dismiss(second);
    expect(workspace.message.title).toBe('');
  });
});
