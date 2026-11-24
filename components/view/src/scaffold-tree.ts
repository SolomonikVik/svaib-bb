import type { TreeConfig, TreeItem } from './scaffold-tree-model';
import manifest from './scaffold-catalog.json';

const NOTES: Record<string, string> = {
  '00_компания': 'обязательный объект: компания как целое', 'README.md': 'файл навигации', 'AGENTS.md': 'рабочая инструкция AI-агента',
  'CLAUDE.md': 'подключение инструкции для Claude Code', '_вводная.md': 'что это, кто отвечает, куда идёт',
  'видение.md': 'кто мы и зачем: миссия, образ будущего, ценности', 'цели.md': 'куда идём и к какому сроку',
  'оргструктура.md': 'кто за что отвечает и кто кому подчиняется', 'ключевые-показатели.md': 'ключевые показатели бизнеса',
  '_входящее': 'неразобранное', '_архив': 'то, что уже не действует', '.svaib': 'служебная папка помощника',
  '00_стратегия': 'курс компании', '00_команда': 'команда уровня компании', '00_показатели': 'ключевые показатели компании',
  'findings.md': 'находки о расхождениях с каноном', 'usage': 'учёт использования скиллов; ведёт плагин',
  'space.json': 'версия и след поставки; заполняет space-scaffold',
};
function role(path: string, name: string): TreeItem['role'] {
  if (path === '00_компания') return 'unit';
  if (/^00_/.test(name)) return 'aspect';
  if (/^_(вводная|делаем|планы|хроника|решения)\.md$/.test(name)) return 'kit';
  if (/^(_входящее|_архив|_встречи|_личное|\.svaib|usage|источники|extractors)$/.test(name)) return 'infrastructure';
  return 'root';
}

// Стартовое дерево нового пространства: шаблоны `templates/root/`; шаблон назван так же, как файл в пространстве.
export function initialTreeConfig(companyName: string): TreeConfig {
  const root: TreeItem = { id: 'root', parentId: null, name: 'пространство', type: 'folder', note: 'корень пространства компании', role: 'root', locked: true,
    fixedName: false, placeholder: false, proposed: false, acceptsBlocks: false, projectContainer: false, clientContainer: false, template: null, viewKind: null };
  const entries = new Map<string, TreeItem>([['', root]]);
  function add(path: string, folder: boolean, template: string | null): TreeItem {
    const existing = entries.get(path); if (existing) return existing;
    const parts = path.split('/'); const name = parts.pop()!; const parent = add(parts.join('/'), true, null);
    const company = path === '00_компания';
    const item: TreeItem = { id: company ? 'company' : 'item-' + entries.size, parentId: parent.id, name, type: folder ? 'folder' : 'file',
      note: NOTES[name] ?? '', role: role(path, name), locked: true, fixedName: false, placeholder: false, proposed: false,
      acceptsBlocks: company, projectContainer: false, clientContainer: false, template, viewKind: company ? 'unit' : null };
    entries.set(path, item); return item;
  }
  for (const template of manifest.templates.filter(file => file.path.startsWith('templates/root/'))) {
    add(template.path.slice('templates/root/'.length), false, template.path);  // путь шаблона и есть путь в пространстве
  }
  add('.svaib/space.json', false, null);
  return { schemaVersion: 2, catalogVersion: manifest.version, canonSnapshot: manifest.canonSnapshot, companyName, tree: [...entries.values()] };
}
