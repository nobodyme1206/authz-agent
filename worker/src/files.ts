import { lstat, realpath, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
export async function safePath(root: string, relative: string, directory = false) {
  const base = await realpath(root);
  if ((!relative && !directory) || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(x => x === '..' || (x === '' && relative !== ''))) throw new Error('invalid_relative_path');
  let current = base;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlinks_not_allowed');
  }
  const resolved = await realpath(current);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('path_escape');
  const stat = await lstat(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('invalid_file_kind');
  return resolved;
}
export async function listFiles(root: string, directory = '') {
  const file = await safePath(root, directory, true);
  const entries = (await readdir(file, { withFileTypes: true })).filter(x=>!x.isSymbolicLink()).sort((a,b)=>a.name.localeCompare(b.name));
  return {entries: entries.slice(0,100).map(x=>({name:x.name,directory:x.isDirectory()})),truncated:entries.length>100};
}
export async function readLines(root: string, file: string, start: number, end: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end-start >= 100) throw new Error('invalid_line_range');
  const resolved = await safePath(root, file);
  if ((await lstat(resolved)).size > 8*1024*1024) throw new Error('file_too_large');
  const bytes=await readFile(resolved);
  const lines = new TextDecoder('utf-8', {fatal:true}).decode(bytes).split(/\r?\n/);
  if (lines.at(-1)==='') lines.pop();
  if (end > lines.length) throw new Error('line_out_of_range');
  const content=lines.slice(start-1,end).join('\n');
  if(Buffer.byteLength(content)>65536) throw new Error('evidence_too_large');
  return {file,start_line:start,end_line:end,total_lines:lines.length,content};
}
export function redact(value: string, secrets: string[]) {
  let result=value;
  for (const secret of secrets) if(secret) result=result.split(secret).join('[REDACTED]');
  return result.replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
}
export function classifyError(error: unknown) {
  const text=String(error);
  if (/401|403|authentication|api.?key/i.test(text)) return 'model_authentication_failed';
  if (/timeout|timed out/i.test(text)) return 'model_timeout';
  if (/429|rate.?limit/i.test(text)) return 'model_rate_limited';
  if (/model_not_configured/.test(text)) return 'model_not_configured';
  if (/probe_requires_tool_call/.test(text)) return 'probe_requires_tool_call';
  if (/budget/.test(text)) return 'tool_or_turn_budget_exceeded';
  if (/400|404|unsupported|tool.?call|not found/i.test(text)) return 'model_interface_incompatible';
  return 'model_or_worker_error';
}
