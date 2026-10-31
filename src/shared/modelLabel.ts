/** "gemini-3.8-flash-high" → "Gemini 3.8 Flash (high)", "claude-opus-4-6-thinking" → "Claude Opus 4.6 (thinking)". */
export function modelLabel(id: string): string {
  const parts = id.split('-');
  const suffix = /^(low|medium|high|thinking|max|minimal)$/.test(parts.at(-1) ?? '') ? parts.pop() : undefined;
  const words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // Claude's versions come as separate numbers ("4-6" → "4.6").
    if (/^\d+$/.test(p) && /^\d+$/.test(parts[i + 1] ?? '')) { words.push(`${p}.${parts[++i]}`); continue; }
    words.push(p === 'gpt' || p === 'oss' ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1));
  }
  const name = words.join(' ').replace('GPT OSS', 'GPT-OSS');
  return suffix ? `${name} (${suffix})` : name;
}
