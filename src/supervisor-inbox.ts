import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const SUPERVISOR_INBOX_HEADER = 'SUPERVISOR DIRECTIVES (unacked):';
export const DIRECTIVE_MAX_LINES = 40;

export function supervisorInboxDir(workspace: string): string {
  return join(workspace, '.pi', 'durable-swarm', 'supervisor-inbox');
}

export type SupervisorDirective = { file: string; text: string };

export async function readSupervisorDirectives(workspace: string): Promise<SupervisorDirective[]> {
  const dir = supervisorInboxDir(workspace);
  await mkdir(dir, { recursive: true });
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.startsWith('SUP-') && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
  const out: SupervisorDirective[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      out.push({ file, text: raw.split('\n').slice(0, DIRECTIVE_MAX_LINES).join('\n') });
    } catch {
      // Best-effort: unreadable directive is skipped, never breaks a tool call.
    }
  }
  return out;
}

export function formatSupervisorDirectives(directives: readonly SupervisorDirective[]): string {
  if (!directives.length) return '';
  const body = directives.map((d) => `--- ${d.file} ---\n${d.text}`).join('\n');
  return `${SUPERVISOR_INBOX_HEADER}\n${body}`;
}

export async function prependSupervisorDirectives(workspace: string, text: string): Promise<string> {
  try {
    const prefix = formatSupervisorDirectives(await readSupervisorDirectives(workspace));
    return prefix ? `${prefix}\n\n${text}` : text;
  } catch {
    return text;
  }
}

export async function ackSupervisorDirective(workspace: string, file: string): Promise<string> {
  if (!file || file !== basename(file) || file.includes('/') || file.includes('\\') || file === '.' || file === '..' || !file.startsWith('SUP-') || !file.endsWith('.md')) {
    throw new Error(`Invalid supervisor directive file: ${file}. Pass a plain SUP-*.md file name from the supervisor inbox.`);
  }
  const dir = supervisorInboxDir(workspace);
  const ackedDir = join(dir, 'acked');
  await mkdir(ackedDir, { recursive: true });
  const dest = join(ackedDir, file);
  await rename(join(dir, file), dest);
  return dest;
}
