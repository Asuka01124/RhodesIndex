import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicJson(filename: string, value: unknown, move: typeof rename = rename) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await move(temporary, filename);
        break;
      } catch (error) {
        if (
          !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ||
          attempt >= 5
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
