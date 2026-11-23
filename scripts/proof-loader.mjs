import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const host = resolve(process.env.BTW_HOST_DIR ?? '../openchamber');
await import(pathToFileURL(resolve(host, 'packages/web/scripts/register-server-sources.mjs')).href);
const source = resolve(host, 'packages/ui/src');
registerHooks({ resolve(specifier, context, nextResolve) {
  const candidate = specifier.startsWith('@/') ? resolve(source, specifier.slice(2))
    : specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(source).href)
      ? fileURLToPath(new URL(specifier, context.parentURL)) : null;
  if (candidate && !extname(candidate)) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      if (existsSync(candidate + suffix)) return nextResolve(pathToFileURL(candidate + suffix).href, context);
    }
  }
  return nextResolve(specifier, context);
} });
