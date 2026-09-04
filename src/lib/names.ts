/**
 * 表示名は自己申告なので、同じ名前の人が同じボードにいることがある。
 *
 * 内部では匿名サインインの参加者 ID（user_id）で区別できているので、
 * 名前がぶつかったときだけ、見分けのつく肩書きを足す。
 * ぶつかっていない人の名前はそのまま残す（余計な括弧を出さない）。
 */
export function buildNameLabels(
  people: { user_id: string; display_name: string }[],
  meId: string,
): Map<string, string> {
  const counts = new Map<string, number>()
  for (const person of people) {
    const name = person.display_name.trim() || '名前なし'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const numbered = new Map<string, number>()
  const labels = new Map<string, string>()

  for (const person of people) {
    const name = person.display_name.trim() || '名前なし'

    if ((counts.get(name) ?? 0) < 2) {
      labels.set(person.user_id, name)
      continue
    }

    if (person.user_id === meId) {
      labels.set(person.user_id, `${name}（この端末）`)
      continue
    }

    const index = (numbered.get(name) ?? 0) + 1
    numbered.set(name, index)
    labels.set(person.user_id, `${name}（${index}）`)
  }

  return labels
}
