import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Where Ghost may read files without asking. A model that has been tricked (by a web page, a note or
// something on screen) could otherwise read a private file and send it out with a web fetch, so
// reading anywhere else shows a confirm card first.

const isWin = process.platform === 'win32';

/** Ghost's own folders, the Obsidian vault, and the everyday places: Desktop, Documents, Downloads. */
export function safeReadRoots(o: { ghostDirs: string[]; vault?: string | null; home?: string }): string[] {
  const home = o.home ?? homedir();
  return [...o.ghostDirs, ...(o.vault ? [o.vault] : []), join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads')];
}

/** The real, absolute form of a path (symlinks and `..` resolved), for comparing locations. */
export function canonical(path: string): string {
  let full = resolve(path);
  try { full = realpathSync.native(full); } catch { /* doesn't exist (yet): compare the resolved path */ }
  return isWin ? full.toLowerCase() : full;
}

/** True when `path` is inside one of `roots`. UNC paths (\\server\share) never are. */
export function isInside(path: string, roots: string[]): boolean {
  if (!path || /^\\\\|^\/\//.test(path.trim())) return false;
  const target = canonical(path.trim());
  return roots.some(r => {
    const root = canonical(r);
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/**
 * Whether Ghost may read `path` without asking: inside a safe folder, and not inside a folder that
 * always asks (`cardRoots`: the vault while "Let Ghost search and read your notes" is off, wherever
 * the vault sits, even on the Desktop). A safe folder inside one of those (Ghost's own folder in the
 * vault) stays free to read.
 */
export function readsFreely(path: string, safeRoots: string[], cardRoots: string[] = []): boolean {
  if (!isInside(path, safeRoots)) return false;
  const card = cardRoots.filter(c => isInside(path, [c]));
  return card.every(c => safeRoots.some(r => isInside(r, [c]) && isInside(path, [r])));
}

// ---------------------------------------------------------------- private-looking files

// Even inside the safe folders, a file that looks private by its name or type shows a confirm card
// first: Documents and Downloads hold bank statements and password exports as well as everyday
// files, and a brain that has been tricked could otherwise read one and send it out. Only the name
// is looked at, never the contents, so a private file with a bland name ("scan0042.pdf") gets
// through, and a harmless one with a telling name asks once more than it needed to.
// The lists are data, so Antigravity's hook (agyPlugin.ts) applies exactly the same ones.
export const SENSITIVE = {
  /** Matched anywhere in a name ("MyPasswords2024.xlsx"). */
  anywhere: ['password', 'passwd', 'passcode', 'passport', 'credential', 'payslip', 'mnemonic', 'keystore', 'seedphrase', 'recoverykey', 'recoverycode', 'backupcode', 'privatekey', 'apikey', 'secretkey'],
  /** Matched as whole words ("bank statement.pdf", not "embankment.jpg"); two neighbouring words are also tried joined ("api key"). */
  words: ['bank', 'banking', 'tax', 'taxes', 'iras', 'cpf', 'salary', 'payroll', 'secret', 'secrets', 'private', 'confidential', 'wallet', 'medical', 'nric', 'ssn', 'kyc', 'login', 'logins', 'otp', 'totp', '2fa', 'ssh', 'pgp', 'gpg', 'recovery', 'idcard'],
  /** File types: password managers, keys and certificates, connection and environment files. */
  types: ['kdbx', 'kdb', '1pux', 'key', 'pem', 'pfx', 'p12', 'ppk', 'jks', 'asc', 'gpg', 'pgp', 'ovpn', 'rdp', 'env', 'wallet', 'htpasswd'],
  /** Whole file or folder names. */
  names: ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'credentials', 'wallet.dat', '.ssh', '.gnupg', '.aws'],
};
export type SensitiveLists = typeof SENSITIVE;

/** Whether any part of a path looks private by its name or type (see SENSITIVE). */
export function looksSensitive(path: string, lists: SensitiveLists = SENSITIVE): boolean {
  for (const part of path.toLowerCase().split(/[\\/]+/)) {
    if (!part) continue;
    if (lists.names.includes(part) || part.startsWith('.env')) return true;
    if (lists.types.includes(part.slice(part.lastIndexOf('.') + 1)) && part.includes('.')) return true;
    const squeezed = part.replace(/[^a-z0-9]+/g, '');
    if (lists.anywhere.some(w => squeezed.includes(w))) return true;
    const words = part.split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((w, i) => lists.words.includes(w) || lists.words.includes(w + (words[i + 1] ?? '')))) return true;
  }
  return false;
}
