// Shared state of the stash page, so the modules (view, actions, dialogs, triage) can stay separate.

import { getState, DEFAULT_SETTINGS } from './common.js';
import { undoLast } from './model.js';
import { toast } from './ui.js';

export const app = {
  state: { items: [], groups: [], orders: {} },
  settings: { ...DEFAULT_SETTINGS },
  ui: {
    progress: null, // thumbnail fetching progress from the background
    view: 'all', // 'all' | 'none' | group id
    query: '',
    filters: { site: '', age: 0, note: false, link: '' },
    selected: new Set(),
    anchor: null,
    order: [], // item ids in on-screen order (first occurrence)
    cursor: null, // 'itemId|sectionKey' of the keyboard-highlighted card
    noneCollapsed: false,
  },
  render: () => {}, // set by stash.js
};

export const byId = (id) => app.state.items.find((i) => i.id === id);
export const groupOf = (id) => app.state.groups.find((g) => g.id === id);

export async function refresh() {
  app.state = await getState();
  app.render();
}

// Re-read the data, then tell the user what happened (with Undo).
export async function done(msg) {
  await refresh();
  if (msg) toast(msg, { label: 'Undo', onClick: doUndo });
}

export async function doUndo() {
  const label = await undoLast();
  await refresh();
  toast(label ? `Undone: ${label}` : 'Nothing to undo');
}

export const selectedItems = () => [...app.ui.selected].map(byId).filter(Boolean);
