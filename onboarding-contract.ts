import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function onboardingContract(root: string) {
  const skill = join(root, 'skills', 'onboarding');
  const info = await lstat(join(skill, 'SKILL.md'));
  if (!info.isFile() || !info.size || info.size > 262144) throw new Error('Не удалось проверить установленный скилл onboarding.');
  const catalogPath = join(skill, 'references', 'stages.json');
  const metadata = await lstat(catalogPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('В Harness нет каталога онбординга. Обнови Harness в выбранном профиле.');
    throw error;
  });
  if (!metadata.isFile() || !metadata.size || metadata.size > 262144) throw new Error('Не удалось прочитать каталог онбординга Harness.');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  // Catalog 4 introduced the initial route shared with the cabinet.
  if (!Number.isSafeInteger(catalog?.catalog) || catalog.catalog < 4)
    throw new Error('Для этого маршрута нужен каталог онбординга 4 или новее. Обнови Harness в выбранном профиле.');
}
