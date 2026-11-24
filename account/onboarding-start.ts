import type { OnboardingView } from './contracts';
import type { SetupStep } from './OnboardingJourney';
import catalog from './onboarding-catalog.json';

/** Presentation groups, not additional server stages or a saved local plan. */
export const setupTasks = catalog.initial_groups;

export function setupSteps(input: { accountReady: boolean; companySelected: boolean;
  accountProgress: OnboardingView | null; progress: OnboardingView | null }): SetupStep[] {
  const allDone = (source: OnboardingView | null, ids: string[]) =>
    ids.length > 0 && source?.status === 'available' &&
    ids.every(id => source.onboarding.marks[id]?.state === 'done');
  // Account connection history can describe the technical start. It never
  // credits company-specific space/profile/work stages or authorizes company access.
  const accountStages = setupTasks.find(task => task.id === 'account')?.stages ?? [];
  const accountConnected = (source: OnboardingView | null) => allDone(source, accountStages);
  const nativeConnected = accountConnected(input.accountProgress) || accountConnected(input.progress);
  const complete = setupTasks.map(task => {
    if (task.id === 'workplace') return nativeConnected;
    if (task.id === 'account') return input.accountReady && nativeConnected;
    return input.companySelected && allDone(input.progress, task.stages) &&
      (task.id !== 'space' || accountConnected(input.progress));
  });
  const current = complete.findIndex(value => !value);
  return setupTasks.map((task, index) => ({ id: task.id, title: task.title, detail: task.detail,
    ...(complete[index] && task.id === 'workplace' ? { doneLabel: 'Подключение пройдено',
      detail: 'Подключение подтверждено ранее. Текущие плагины и хуки агент проверит при продолжении.' } : {}),
    ...(complete[index] && task.id === 'account' ? { doneLabel: 'Вход подтверждён',
      detail: 'Вход кабинета сохранён. Доступ агента был подтверждён при подключении.' } : {}),
    ...(complete[index] && task.id === 'space' ? { doneLabel: 'Рабочая папка проверена' } : {}),
    state: complete[index] ? 'done' : index === current ? 'current' : 'upcoming' }));
}
