// The texts of Settings' feature switches (#596): watches, decisions, the away journal, and under
// Threads case files and verified done, each with one line on what it does and, where it applies,
// that sessions already running learn it at their next start; what Off leaves behind (watches no
// longer checked, defaults that will not run); and the refusals of POST /api/feature-settings.
// English and Russian; strings.ts merges them into the dictionaries.
import type { Lang } from '../types.ts'

export const FEATURE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'set.feature.off': 'Off',
    'set.feature.on': 'On',
    'set.watches': 'Watches',
    'set.watches.note':
      'Wakes a waiting session only when its probe fires. Sessions already running learn it at their next start.',
    'set.watches.offNote': [
      '{n} watch stops being checked until this is on again',
      '{n} watches stop being checked until this is on again',
    ],
    'set.decisions': 'Decisions',
    'set.decisions.note':
      'Questions with options and a default, in one queue. Sessions already running learn it at their next start.',
    'set.decisions.offNote': ['{n} default will not run', '{n} defaults will not run'],
    'set.decisions.defaults': 'Default answers allowed',
    'set.decisions.noDefaults': 'No default answers',
    'set.journal': 'Away journal',
    'set.journal.note': 'Shows what changed while you were away.',
    'set.journal.error': 'On, but nothing is recorded: {error}',
    'set.cases': 'Case files',
    'set.cases.note':
      "A thread keeps a case's reference, state and sessions. Sessions already running learn it at their next start.",
    'set.verify': 'Verified done',
    'set.verify.note': "A worker's done counts once a new session has checked it.",
    'feature.err.setting': 'Not a setting of watches, decisions or the away journal',
    'feature.err.decisionsOff': 'Decisions are off (config.json: "decisions")',
  },
  ru: {
    'set.feature.off': 'Выключено',
    'set.feature.on': 'Включено',
    'set.watches': 'Наблюдения',
    'set.watches.note':
      'Будит ждущую сессию, только когда сработала её проба. Уже запущенные сессии узнают об этом при следующем старте.',
    'set.watches.offNote': [
      '{n} наблюдение не будет проверяться, пока наблюдения выключены',
      '{n} наблюдения не будут проверяться, пока наблюдения выключены',
      '{n} наблюдений не будут проверяться, пока наблюдения выключены',
    ],
    'set.decisions': 'Решения',
    'set.decisions.note':
      'Вопросы с вариантами и ответом по умолчанию. Уже запущенные сессии узнают об этом при следующем старте.',
    'set.decisions.offNote': [
      '{n} ответ по умолчанию не сработает',
      '{n} ответа по умолчанию не сработают',
      '{n} ответов по умолчанию не сработают',
    ],
    'set.decisions.defaults': 'Ответ по умолчанию разрешён',
    'set.decisions.noDefaults': 'Без ответов по умолчанию',
    'set.journal': 'Журнал отсутствия',
    'set.journal.note': 'Показывает, что менялось, пока вас не было.',
    'set.journal.error': 'Включено, но ничего не записывается: {error}',
    'set.cases': 'Кейсы',
    'set.cases.note':
      'Тред хранит ссылку, состояние и сессии кейса. Уже запущенные сессии узнают об этом при следующем старте.',
    'set.verify': 'Проверка готовности',
    'set.verify.note': 'Готово засчитывается после проверки новой сессией.',
    'feature.err.setting': 'Это не настройка наблюдений, решений или журнала отсутствия',
    'feature.err.decisionsOff': 'Решения выключены (config.json: "decisions")',
  },
}
