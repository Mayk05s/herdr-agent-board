// The texts of Settings' feature switches (#596): watches, decisions, the away journal, and under
// Threads case files and verified done, each with one line on what it does and, where it applies,
// that sessions learn it when they start; and the refusals of POST /api/feature-settings. English
// and Russian; strings.ts merges them into the dictionaries.
import type { Lang } from '../types.ts'

export const FEATURE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'set.feature.off': 'Off',
    'set.feature.on': 'On',
    'set.watches': 'Watches',
    'set.watches.note':
      'A waiting session is woken only when its check command says it happened. New sessions learn it.',
    'set.decisions': 'Decisions',
    'set.decisions.note': 'Questions with options and a recommended answer, in one queue. New sessions learn it.',
    'set.decisions.defaults': 'Default answers allowed',
    'set.decisions.noDefaults': 'No default answers',
    'set.journal': 'Away journal',
    'set.journal.note': 'Notes what changed while you were away and shows it when you come back.',
    'set.cases': 'Case files',
    'set.cases.note': "A thread keeps a case's reference, state and sessions. New sessions learn it.",
    'set.verify': 'Verified done',
    'set.verify.note': "A worker's done counts only after a fresh session has checked it.",
    'feature.err.setting': 'Not a setting of watches, decisions or the away journal',
    'feature.err.decisionsOff': 'Decisions are off (config.json: "decisions")',
  },
  ru: {
    'set.feature.off': 'Выключено',
    'set.feature.on': 'Включено',
    'set.watches': 'Наблюдения',
    'set.watches.note':
      'Ждущую сессию будят, только когда её команда проверки скажет, что дождались. Новые сессии узнают о них.',
    'set.decisions': 'Решения',
    'set.decisions.note': 'Вопросы с вариантами и рекомендованным ответом, в одной очереди. Новые сессии узнают о них.',
    'set.decisions.defaults': 'Ответ по умолчанию разрешён',
    'set.decisions.noDefaults': 'Без ответов по умолчанию',
    'set.journal': 'Журнал отсутствия',
    'set.journal.note': 'Записывает, что менялось, пока вас не было, и показывает это, когда вы вернётесь.',
    'set.cases': 'Кейсы',
    'set.cases.note': 'Тред хранит ссылку кейса, где он сейчас и его сессии. Новые сессии узнают о них.',
    'set.verify': 'Проверка готовности',
    'set.verify.note': 'Готово от исполнителя засчитывается, только когда его проверит свежая сессия.',
    'feature.err.setting': 'Это не настройка наблюдений, решений или журнала отсутствия',
    'feature.err.decisionsOff': 'Решения выключены (config.json: "decisions")',
  },
}
