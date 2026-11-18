// A card's model warning (#429), right after its profile tag: the session runs on another model
// family than config.json's `models` expects of it (src/core/model-check.ts). Red, as a wrong
// profile; its menu's "This model is fine here" takes it away. None while the rule is off.
import { familyTitle, modelFamily } from '../../../src/core/model-check.ts'
import type { Item } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'

export function ModelTag({ item }: { item: Pick<Item, 'modelWrong'> }) {
  const t = useT()
  const wrong = item.modelWrong
  if (!wrong) return null
  const want = familyTitle(wrong.want)
  const got = familyTitle(modelFamily(wrong.runs) ?? wrong.runs)
  return (
    <span className="model-tag" title={t('model.wrongHint', { model: wrong.runs, want })}>
      {t('model.wrong', { got, want })}
    </span>
  )
}
