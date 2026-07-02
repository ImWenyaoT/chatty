export function normalizeNumber(value: number) {
  return Number(value.toFixed(1))
}

export function inferWeightUnit(raw: string, explicitUnit?: string) {
  if (explicitUnit) {
    return /斤/i.test(explicitUnit) ? 'jin' : 'kg'
  }

  const value = Number(raw)
  if (!Number.isFinite(value)) {
    return undefined
  }

  return value >= 140 ? 'jin' : 'kg'
}

export function parseMetricValue(raw: string) {
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    return undefined
  }
  return normalizeNumber(value)
}

export function parseWeightValue(raw: string, unit?: string) {
  const value = parseMetricValue(raw)
  if (value === undefined) {
    return undefined
  }

  if (inferWeightUnit(raw, unit) === 'jin') {
    return normalizeNumber(value / 2)
  }

  return value
}

export function looksLikeDateContext(text: string) {
  return /年|月|日|档期|租赁时间|开始时间|结束时间|起租|归还|到|至/.test(text)
}

export function isReasonableHeight(value?: number) {
  return value !== undefined && value >= 80 && value <= 250
}

export function isReasonableWeight(value?: number) {
  return value !== undefined && value >= 20 && value <= 250
}

export function extractHeightWeightFromText(text: string) {
  const normalized = text
    .replace(/，/g, ',')
    .replace(/：/g, ':')
    .replace(/厘米/g, 'cm')
    .replace(/公斤/g, 'kg')
    .replace(/\s+/g, ' ')
    .trim()
  const heightMatch = normalized.match(
    /身高(?:是|为|改成|改为|修改成|更新为)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:cm|厘米)?/i,
  )
  const weightMatch = normalized.match(
    /体重(?:是|为|改成|改为|修改成|更新为)?\s*([0-9]+(?:\.[0-9]+)?)\s*(kg|公斤|斤)?/i,
  )
  const hasHeightLabel = /身高/i.test(normalized)
  const hasWeightLabel = /体重/i.test(normalized)
  const hasDateContext = looksLikeDateContext(normalized)

  let heightCm = heightMatch ? parseMetricValue(heightMatch[1]) : undefined
  let weightKg = weightMatch ? parseWeightValue(weightMatch[1], weightMatch[2]) : undefined
  let inferredWeightUnit: 'kg' | 'jin' | undefined = weightMatch
    ? inferWeightUnit(weightMatch[1], weightMatch[2])
    : undefined

  // "181.70公斤" 这类用句号拼接的「身高.体重」写法（真实会话观察，见 CLAUDE.md §3）。
  // 保护条件：整数部分 >=140 才拆（140 以下可能是 "65.5公斤" 这种真小数体重），
  // 且小数部分按体重解析必须落在合理区间，否则回落到常规解析路径。
  if (
    !hasHeightLabel &&
    !hasWeightLabel &&
    !hasDateContext &&
    heightCm === undefined &&
    weightKg === undefined
  ) {
    const compact = normalized.replace(/\s+/g, '')
    const dottedPair = compact.match(/^([0-9]{3})\.([0-9]{2,3})(kg|斤)?$/i)
    if (dottedPair) {
      const pairedHeight = parseMetricValue(dottedPair[1])
      const pairedWeight = parseWeightValue(dottedPair[2], dottedPair[3])
      if (
        pairedHeight !== undefined &&
        pairedHeight >= 140 &&
        isReasonableHeight(pairedHeight) &&
        isReasonableWeight(pairedWeight)
      ) {
        heightCm = pairedHeight
        weightKg = pairedWeight
        inferredWeightUnit = inferWeightUnit(dottedPair[2], dottedPair[3])
      }
    }
  }

  if (
    !hasHeightLabel &&
    !hasWeightLabel &&
    !hasDateContext &&
    (heightCm === undefined || weightKg === undefined)
  ) {
    const compact = normalized.replace(/\s+/g, '')
    const pairMatch = compact.match(
      /([0-9]+(?:\.[0-9]+)?)(cm)?[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)(kg|斤)?/i,
    )
    if (pairMatch) {
      const parsedHeight = parseMetricValue(pairMatch[1])
      const inferredUnit =
        pairMatch[4] || inferWeightUnit(pairMatch[3], pairMatch[2] ? undefined : '斤')
      const parsedWeight = parseWeightValue(pairMatch[3], inferredUnit)

      if (heightCm === undefined && isReasonableHeight(parsedHeight)) {
        heightCm = parsedHeight
      }
      if (weightKg === undefined && isReasonableWeight(parsedWeight)) {
        weightKg = parsedWeight
        inferredWeightUnit = inferWeightUnit(pairMatch[3], inferredUnit)
      }
    }
  }

  if (!hasHeightLabel && heightCm === undefined) {
    const heightOnlyMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*cm/i)
    if (heightOnlyMatch) {
      const parsedHeight = parseMetricValue(heightOnlyMatch[1])
      if (isReasonableHeight(parsedHeight)) {
        heightCm = parsedHeight
      }
    }
  }

  if (!hasWeightLabel && weightKg === undefined) {
    const weightOnlyMatch = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(kg|斤)/i)
    if (weightOnlyMatch) {
      const parsedWeight = parseWeightValue(weightOnlyMatch[1], weightOnlyMatch[2])
      if (isReasonableWeight(parsedWeight)) {
        weightKg = parsedWeight
        inferredWeightUnit = inferWeightUnit(weightOnlyMatch[1], weightOnlyMatch[2])
      }
    }
  }

  if (heightCm !== undefined && !isReasonableHeight(heightCm)) {
    heightCm = undefined
  }

  if (weightKg !== undefined && !isReasonableWeight(weightKg)) {
    weightKg = undefined
    inferredWeightUnit = undefined
  }

  return {
    heightCm,
    weightKg,
    inferredWeightUnit,
  }
}

const CN_NUMBER_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  俩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

// 抽取用户消息里指定的件数，比如 "我要租 2 件" / "拍两套" / "数量 3" / "要 2 件"。
// 不命中身高/体重/日期数字（需要件量量词或"数量/件数"明示）。
export function extractQuantityFromText(rawText: string): number | undefined {
  if (!rawText) return undefined
  const text = rawText.replace(/，/g, ',').replace(/：/g, ':').replace(/\s+/g, '')
  // "数量X" / "数量是X" / "件数X"
  const explicitLabel = text.match(
    /(?:数量|件数)(?:是|:|=)?\s*([0-9一二两俩三四五六七八九十]{1,3})/,
  )
  if (explicitLabel) {
    const n = toQuantityNumber(explicitLabel[1])
    if (n !== undefined) return n
  }
  // "X件" / "X套" / "X条" / "X身" / "X个" / "X对" + 量词；前面数字 1-99
  const measureWord = text.match(
    /(?:^|[^.0-9])([0-9]{1,2}|[一二两俩三四五六七八九十])\s*(件|套|条|身|个|对)/,
  )
  if (measureWord) {
    // 把"一件衣服""一套西装"中没有租赁/购买动词的零意图过滤掉——只在动词上下文下才认为是数量
    const hasIntentVerb = /(?:要|想|租|拍|买|下|来|订|拿|预订|定|加|拍下|拿|要租|想租)/.test(text)
    if (hasIntentVerb) {
      const n = toQuantityNumber(measureWord[1])
      if (n !== undefined) return n
    }
  }
  return undefined
}

function toQuantityNumber(token: string): number | undefined {
  if (/^[0-9]+$/.test(token)) {
    const n = Number(token)
    if (Number.isFinite(n) && n >= 1 && n <= 99) return n
    return undefined
  }
  const mapped = CN_NUMBER_MAP[token]
  if (mapped !== undefined && mapped >= 1 && mapped <= 99) return mapped
  return undefined
}
