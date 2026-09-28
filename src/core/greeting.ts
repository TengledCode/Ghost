// What Ghost says when it starts up. Scripted (no model call), and varied so it isn't always
// "good morning": plain presence, time of day, how long Aaron has been away, and the day itself.

export interface GreetingInput {
  now: Date;
  lastSeen?: number; // ms epoch of the last activity before this launch
  lastGreeting?: string;
  facts?: string[]; // memory facts, searched for a birthday
  userName: string;
  assistantName: string;
  random?: () => number;
}

const PLAIN = [
  'At your service, {u}.',
  "I'm here, {u}.",
  '{me}, standing by.',
  'Online and ready, {u}.',
  'Good to see you, {u}.',
  "Ready when you are, {u}.",
];

const TIME: Record<'morning' | 'afternoon' | 'evening' | 'late', string[]> = {
  morning: ['Good morning, {u}.', 'Morning, {u}. I trust you slept well.', 'A new day, {u}. I\'m at your service.'],
  afternoon: ['Good afternoon, {u}.', 'Afternoon, {u}. What can I do for you?', 'Good afternoon, {u}. I\'m here if you need me.'],
  evening: ['Good evening, {u}.', 'Evening, {u}. I\'m at your service.', 'Good evening, {u}. How was the day?'],
  late: ['Burning the midnight oil, {u}?', 'Still up, {u}? I\'m here.', 'A late one, {u}. I\'m at your service.'],
};

const RETURN = {
  soon: ['Back so soon, {u}?', 'Here again, {u}. Where were we?', 'Welcome back, {u}. That was quick.'],
  hours: ['Welcome back, {u}.', 'Good to have you back, {u}.', 'Welcome back, {u}. I\'m ready when you are.'],
  days: ["It's been a few days, {u}. Good to have you back.", 'Welcome back, {u}. It\'s been a little while.', 'There you are, {u}. It\'s been a few days.'],
};

const OCCASION = {
  monday: ['A fresh week, {u}. I\'m here when you need me.', 'Monday again, {u}. Let\'s make it a good one.'],
  friday: ['Friday at last, {u}.', 'It\'s Friday, {u}. Nearly there.'],
  weekend: ['A weekend, {u}. I\'m around if you need me.', 'Enjoying the weekend, {u}? I\'m here.'],
  birthday: ['Happy birthday, {u}. At your service, as ever.', 'Many happy returns, {u}.'],
};

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export function pickGreeting(i: GreetingInput): string {
  const random = i.random ?? Math.random;
  const fill = (l: string) => l.replace(/\{u\}/g, i.userName).replace(/\{me\}/g, i.assistantName);
  const pools: { lines: string[]; weight: number }[] = [];

  if (isBirthday(i.now, i.facts ?? [])) pools.push({ lines: OCCASION.birthday, weight: 100 });
  else {
    const gap = i.lastSeen ? i.now.getTime() - i.lastSeen : undefined;
    if (gap !== undefined && gap < 20 * MIN) pools.push({ lines: RETURN.soon, weight: 3 });
    else if (gap !== undefined && gap >= 3 * DAY) pools.push({ lines: RETURN.days, weight: 4 });
    else if (gap !== undefined && gap >= 4 * HOUR) pools.push({ lines: RETURN.hours, weight: 0.8 });
    const soon = gap !== undefined && gap < 20 * MIN;
    if (!soon) pools.push({ lines: TIME[period(i.now)], weight: 1 });
    pools.push({ lines: PLAIN, weight: 1 });
    const day = i.now.getDay();
    if (!soon && day === 1 && i.now.getHours() < 14) pools.push({ lines: OCCASION.monday, weight: 0.7 });
    if (!soon && day === 5) pools.push({ lines: OCCASION.friday, weight: 0.7 });
    if (!soon && (day === 0 || day === 6)) pools.push({ lines: OCCASION.weekend, weight: 0.6 });
  }

  const total = pools.reduce((a, p) => a + p.weight, 0);
  let r = random() * total;
  let pool = pools[pools.length - 1];
  for (const p of pools) { if ((r -= p.weight) < 0) { pool = p; break; } }
  let options = pool.lines.map(fill).filter(l => l !== i.lastGreeting);
  if (!options.length) options = PLAIN.map(fill).filter(l => l !== i.lastGreeting);
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}

function period(d: Date): 'morning' | 'afternoon' | 'evening' | 'late' {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'late';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Finds a birthday in memory facts ("Aaron's birthday is 14 March", "born on 1990-03-14", "birthday: March 14th"). */
export function birthdayFrom(facts: string[]): { month: number; day: number } | null {
  for (const f of facts) {
    if (!/birthday|\bborn\b/i.test(f)) continue;
    const iso = f.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (iso) return { month: +iso[2] - 1, day: +iso[3] };
    const dm = f.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/i);
    if (dm) { const m = MONTHS.indexOf(dm[2].slice(0, 3).toLowerCase()); if (m >= 0) return { month: m, day: +dm[1] }; }
    const md = f.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
    if (md) { const m = MONTHS.indexOf(md[1].slice(0, 3).toLowerCase()); if (m >= 0) return { month: m, day: +md[2] }; }
  }
  return null;
}

function isBirthday(now: Date, facts: string[]): boolean {
  const b = birthdayFrom(facts);
  return !!b && b.month === now.getMonth() && b.day === now.getDate();
}
