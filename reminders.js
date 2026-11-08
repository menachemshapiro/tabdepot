// Reminders on stashed tabs. An item can have `remindAt` (ms since epoch). When that time comes a
// system notification appears once (`remindFired`); the card keeps showing "Due" until the reminder is
// cleared, snoozed or the tab is opened.

import { getState, mutate } from './common.js';
import { notify } from './notify.js';

export const REMINDER_ALARM = 'reminder';
export const isDue = (it, now = Date.now()) => !!it.remindAt && it.remindAt <= now;

// Time of the next reminder that has not been announced yet, or 0.
export function nextReminder(items) {
  let next = 0;
  for (const it of items) if (it.remindAt && !it.remindFired && (!next || it.remindAt < next)) next = it.remindAt;
  return next;
}

export async function scheduleReminders() {
  const { items } = await getState();
  const when = nextReminder(items);
  await chrome.alarms.clear(REMINDER_ALARM);
  if (when) chrome.alarms.create(REMINDER_ALARM, { when: Math.max(when, Date.now() + 1000) });
}

// Marks everything that is due as announced and shows the notification(s). Returns the items.
export async function fireDueReminders(now = Date.now()) {
  const due = [];
  await mutate((state) => {
    for (const it of state.items) {
      if (it.remindAt && !it.remindFired && it.remindAt <= now) {
        it.remindFired = true;
        due.push(structuredClone(it));
      }
    }
  });
  if (due.length === 1) {
    await notify(`reminder:${due[0].id}`, 'TabDepot reminder', due[0].title || due[0].url, { buttons: ['Open the tab', 'Remind me in 1 hour'] });
  } else if (due.length > 1) {
    const names = due.slice(0, 3).map((i) => i.title || i.url).join('\n');
    await notify('reminder:many', `TabDepot: ${due.length} reminders are due`, names + (due.length > 3 ? '\n…' : ''));
  }
  return due;
}
