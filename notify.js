// System notifications (shown by the operating system, so they appear even when no TabDepot page is open).
// One switch in Settings turns all of them off.

import { getSettings } from './common.js';

const icon = () => chrome.runtime.getURL('icons/icon128.png');

export async function notify(id, title, message, { buttons = [] } = {}) {
  try {
    if (!chrome.notifications || !(await getSettings()).notifications) return false;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: icon(),
      title,
      message,
      priority: 1,
      ...(buttons.length ? { buttons: buttons.map((title) => ({ title })) } : {}),
    });
    return true;
  } catch (e) {
    console.warn('notification failed', e);
    return false;
  }
}
